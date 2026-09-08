/**
 * Student bulk import.
 *
 * The contract the spec demands: never write anything until the school has
 * seen exactly what will happen. So the flow is two calls against the same
 * function:
 *
 *   1. `mode: 'validate'` — parse, resolve grades/sections by name, check every
 *      row, report per-row errors. Nothing is written.
 *   2. `mode: 'commit'`   — re-run the identical validation, then insert only
 *      the rows that passed.
 *
 * Re-validating on commit matters: the file may have been edited, or another
 * user may have taken a student ID in between. The preview is advisory; the
 * commit-time check is the authority.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import { students } from '../../db/schema/people.ts';
import { academicYears, gradeLevels, sections } from '../../db/schema/core.ts';
import { createStudent, generateStudentCode } from '../students/service.ts';
import { createStudentSchema, normalisePhone } from '../students/schema.ts';
import { parseSheet, normaliseHeader, toCsv } from './csv.ts';
import { recordAudit } from '../audit/index.ts';

/**
 * Accepted column names per field. Several spellings and the Amharic label are
 * allowed, because the office staff filling this in should not have to match
 * an exact English string.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  studentCode: ['studentid', 'studentcode', 'id', 'code', 'idno', 'idnumber', 'የተማሪመለያ'],
  givenName: ['givenname', 'firstname', 'name', 'ስም'],
  fatherName: ['fathername', 'father', 'middlename', 'የአባትስም'],
  grandfatherName: ['grandfathername', 'grandfather', 'lastname', 'surname', 'የአያትስም'],
  // Includes the exact spellings our own downloadable template emits.
  givenNameAm: [
    'givennameam',
    'givennameamharic',
    'nameamharic',
    'amharicname',
    'ስምበአማርኛ',
  ],
  fatherNameAm: ['fathernameam', 'fathernameamharic', 'የአባትስምበአማርኛ'],
  grandfatherNameAm: ['grandfathernameam', 'grandfathernameamharic'],
  gender: ['gender', 'sex', 'ጾታ'],
  dateOfBirth: ['dateofbirth', 'dob', 'birthdate', 'የልደትቀን'],
  gradeLevel: ['gradelevel', 'grade', 'class', 'ክፍል'],
  section: ['section', 'sectionname', 'stream'],
  rollNumber: ['rollnumber', 'roll', 'rollno', 'no'],
  phone: ['phone', 'phonenumber', 'mobile', 'ስልክ'],
  email: ['email', 'emailaddress'],
  address: ['address', 'አድራሻ'],
  subCity: ['subcity', 'ክፍለከተማ'],
  woreda: ['woreda', 'ወረዳ'],
  kebele: ['kebele', 'ቀበሌ'],
  emergencyContactName: ['emergencycontactname', 'emergencycontact', 'emergencyname'],
  emergencyContactPhone: ['emergencycontactphone', 'emergencyphone'],
  emergencyContactRelation: ['emergencycontactrelation', 'emergencyrelation'],
  bloodGroup: ['bloodgroup', 'blood'],
  previousSchool: ['previousschool', 'formerschool'],
  admissionDate: ['admissiondate', 'dateofadmission', 'joined'],
  guardianName: ['guardianname', 'parentname', 'guardian', 'የወላጅስም'],
  guardianPhone: ['guardianphone', 'parentphone', 'guardianmobile', 'የወላጅስልክ'],
  guardianRelationship: ['guardianrelationship', 'relationship', 'relation'],
};

/** The template we hand out, in the order the columns should appear. */
export const STUDENT_TEMPLATE_COLUMNS = [
  'Student ID',
  'Given Name',
  'Father Name',
  'Grandfather Name',
  'Given Name (Amharic)',
  'Father Name (Amharic)',
  'Gender',
  'Date of Birth',
  'Grade Level',
  'Section',
  'Roll Number',
  'Phone',
  'Address',
  'Sub City',
  'Woreda',
  'Guardian Name',
  'Guardian Phone',
  'Guardian Relationship',
  'Previous School',
  'Admission Date',
];

export function buildStudentTemplate(): string {
  return toCsv(STUDENT_TEMPLATE_COLUMNS, [
    [
      '',
      'Abebe',
      'Kebede',
      'Tesfaye',
      'አበበ',
      'ከበደ',
      'male',
      '2012-05-14',
      'Grade 5',
      'A',
      '1',
      '0911223344',
      'Bole',
      'Bole',
      '03',
      'Kebede Tesfaye',
      '0911223355',
      'father',
      'Sunshine Academy',
      '2024-09-10',
    ],
  ]);
}

/** Map a parsed row's normalised keys onto our canonical field names. */
function pick(row: Record<string, string | undefined>, field: string): string {
  for (const alias of COLUMN_ALIASES[field] ?? []) {
    const value = row[alias];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

export type ImportRowResult = {
  /** Spreadsheet line number, so the user can find the row in their file. */
  rowNumber: number;
  status: 'ready' | 'error' | 'imported' | 'skipped';
  /** Field-keyed problems; `_` for row-level problems. */
  errors: Record<string, string>;
  /** Non-blocking notes, e.g. "student ID will be generated". */
  warnings: string[];
  preview: {
    studentCode: string;
    name: string;
    gradeLevel: string;
    section: string;
    guardian: string;
  };
};

export type ImportReport = {
  mode: 'validate' | 'commit';
  totalRows: number;
  readyCount: number;
  errorCount: number;
  importedCount: number;
  /** Header cells we did not recognise — usually a typo worth surfacing. */
  unknownColumns: string[];
  missingRequiredColumns: string[];
  rows: ImportRowResult[];
};

const GENDER_MAP: Record<string, 'male' | 'female'> = {
  m: 'male',
  male: 'male',
  boy: 'male',
  ወ: 'male',
  ወንድ: 'male',
  f: 'female',
  female: 'female',
  girl: 'female',
  ሴ: 'female',
  ሴት: 'female',
};

/** True only if the ISO string names a real calendar day. */
function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

/**
 * Accept 2012-05-14, 14/05/2012 and 14-05-2012.
 *
 * Day-first, because that is how dates are written on Ethiopian admission
 * forms. Impossible dates such as 31/31/2013 are rejected rather than being
 * silently rolled forward into the next month.
 */
function parseDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return isRealDate(trimmed) ? trimmed : null;
  }

  const match = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (match) {
    const day = match[1] ?? '';
    const month = match[2] ?? '';
    const year = match[3] ?? '';
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    return isRealDate(iso) ? iso : null;
  }
  return null;
}

export async function importStudents(
  ctx: AuthContext,
  options: {
    fileText: string;
    academicYearId: string;
    mode: 'validate' | 'commit';
    /** Rows the user unticked in the preview. */
    skipRowNumbers?: number[];
  },
): Promise<ImportReport> {
  const { db, schoolId } = ctx;
  const { headers, rows, rowNumbers } = parseSheet(options.fileText);
  const skip = new Set(options.skipRowNumbers ?? []);

  // Which headers did we understand?
  const knownAliases = new Set(Object.values(COLUMN_ALIASES).flat());
  const unknownColumns = headers.filter((header) => !knownAliases.has(normaliseHeader(header)));
  const presentFields = new Set<string>();
  for (const header of headers) {
    const key = normaliseHeader(header);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(key)) presentFields.add(field);
    }
  }

  const missingRequiredColumns: string[] = [];
  if (!presentFields.has('givenName')) missingRequiredColumns.push('Given Name');
  if (!presentFields.has('fatherName')) missingRequiredColumns.push('Father Name');
  if (!presentFields.has('gradeLevel')) missingRequiredColumns.push('Grade Level');

  if (missingRequiredColumns.length > 0 || rows.length === 0) {
    return {
      mode: options.mode,
      totalRows: rows.length,
      readyCount: 0,
      errorCount: 0,
      importedCount: 0,
      unknownColumns,
      missingRequiredColumns,
      rows: [],
    };
  }

  // Resolve grades and sections once, by name, for the current year.
  const [yearRow] = await db
    .select({ ethiopianYear: academicYears.ethiopianYear })
    .from(academicYears)
    .where(
      and(eq(academicYears.schoolId, schoolId), eq(academicYears.id, options.academicYearId)),
    )
    .limit(1);

  const [gradeRows, sectionRows] = await Promise.all([
    db
      .select({ id: gradeLevels.id, name: gradeLevels.name, level: gradeLevels.level })
      .from(gradeLevels)
      .where(eq(gradeLevels.schoolId, schoolId)),
    db
      .select({
        id: sections.id,
        name: sections.name,
        gradeLevelId: sections.gradeLevelId,
        capacity: sections.capacity,
      })
      .from(sections)
      .where(
        and(eq(sections.schoolId, schoolId), eq(sections.academicYearId, options.academicYearId)),
      ),
  ]);

  const gradeByName = new Map<string, { id: string; name: string }>();
  for (const grade of gradeRows) {
    gradeByName.set(grade.name.toLowerCase().replace(/\s+/g, ''), grade);
    // "Grade 5" should also match a bare "5".
    const numeric = grade.name.match(/(\d+)/)?.[1];
    if (numeric && !gradeByName.has(numeric)) gradeByName.set(numeric, grade);
  }

  const sectionByKey = new Map<string, { id: string; name: string }>();
  for (const section of sectionRows) {
    sectionByKey.set(
      `${section.gradeLevelId}:${section.name.toLowerCase().replace(/\s+/g, '')}`,
      section,
    );
  }

  // Existing student codes in this school, to catch duplicates before writing.
  const codesInFile = rows.map((row) => pick(row, 'studentCode')).filter(Boolean);
  const existingCodes = new Set<string>();
  if (codesInFile.length > 0) {
    const found = await db
      .select({ studentCode: students.studentCode })
      .from(students)
      .where(and(eq(students.schoolId, schoolId), inArray(students.studentCode, codesInFile)));
    for (const row of found) existingCodes.add(row.studentCode);
  }

  const seenInFile = new Set<string>();
  const results: ImportRowResult[] = [];

  /**
   * Values resolved during validation, reused by the commit pass below.
   * Deliberately local to this call — a module-level cache would be shared
   * between concurrent imports from different schools.
   */
  const resolved = new Map<number, ResolvedRow>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowNumber = rowNumbers[i]!;
    const errors: Record<string, string> = {};
    const warnings: string[] = [];

    const givenName = pick(row, 'givenName');
    const fatherName = pick(row, 'fatherName');
    const gradeRaw = pick(row, 'gradeLevel');
    const sectionRaw = pick(row, 'section');
    const codeRaw = pick(row, 'studentCode');

    if (!givenName) errors.givenName = 'Given name is required';
    if (!fatherName) errors.fatherName = "Father's name is required";

    // Grade
    const grade = gradeByName.get(gradeRaw.toLowerCase().replace(/\s+/g, ''));
    if (!gradeRaw) {
      errors.gradeLevel = 'Grade is required';
    } else if (!grade) {
      errors.gradeLevel = `No grade called "${gradeRaw}" at this school`;
    }

    // Section is optional — a school may still be placing students.
    let section: { id: string; name: string } | undefined;
    if (sectionRaw && grade) {
      section = sectionByKey.get(`${grade.id}:${sectionRaw.toLowerCase().replace(/\s+/g, '')}`);
      if (!section) {
        errors.section = `No section "${sectionRaw}" in ${grade.name} this year`;
      }
    } else if (!sectionRaw) {
      warnings.push('No section — the student will be admitted without a class');
    }

    // Student code
    let studentCode = codeRaw;
    if (!studentCode) {
      warnings.push('Student ID will be generated automatically');
    } else if (existingCodes.has(studentCode)) {
      errors.studentCode = `Student ID ${studentCode} is already used at this school`;
    } else if (seenInFile.has(studentCode)) {
      errors.studentCode = `Student ID ${studentCode} appears more than once in this file`;
    } else {
      seenInFile.add(studentCode);
    }

    // Gender
    const genderRaw = pick(row, 'gender').toLowerCase();
    let gender: 'male' | 'female' | null = null;
    if (genderRaw) {
      gender = GENDER_MAP[genderRaw] ?? null;
      if (!gender) errors.gender = `Could not read gender "${genderRaw}" — use male or female`;
    }

    // Dates
    const dob = parseDate(pick(row, 'dateOfBirth'));
    if (dob === null) errors.dateOfBirth = 'Use YYYY-MM-DD or DD/MM/YYYY';
    const admissionDate = parseDate(pick(row, 'admissionDate'));
    if (admissionDate === null) errors.admissionDate = 'Use YYYY-MM-DD or DD/MM/YYYY';

    // Phones — normalise rather than reject a locally-written 09… number.
    const phoneRaw = pick(row, 'phone');
    let phone = '';
    if (phoneRaw) {
      const normalised = normalisePhone(phoneRaw);
      if (!normalised) errors.phone = `"${phoneRaw}" is not a valid Ethiopian phone number`;
      else phone = normalised;
    }

    const guardianName = pick(row, 'guardianName');
    const guardianPhoneRaw = pick(row, 'guardianPhone');
    let guardianPhone = '';
    if (guardianPhoneRaw) {
      const normalised = normalisePhone(guardianPhoneRaw);
      if (!normalised) errors.guardianPhone = `"${guardianPhoneRaw}" is not a valid phone number`;
      else guardianPhone = normalised;
    }
    if (guardianPhone && !guardianName) {
      errors.guardianName = 'Guardian phone given without a guardian name';
    }

    const rollRaw = pick(row, 'rollNumber');
    let rollNumber: number | null = null;
    if (rollRaw) {
      const parsedRoll = Number.parseInt(rollRaw, 10);
      if (Number.isNaN(parsedRoll) || parsedRoll < 1 || parsedRoll > 999) {
        errors.rollNumber = 'Roll number must be between 1 and 999';
      } else {
        rollNumber = parsedRoll;
      }
    }

    const preview = {
      studentCode: studentCode || '(auto)',
      name: [givenName, fatherName, pick(row, 'grandfatherName')].filter(Boolean).join(' '),
      gradeLevel: grade?.name ?? gradeRaw,
      section: section?.name ?? sectionRaw,
      guardian: guardianName ? `${guardianName}${guardianPhone ? ` (${guardianPhone})` : ''}` : '',
    };

    const hasErrors = Object.keys(errors).length > 0;

    results.push({
      rowNumber,
      status: hasErrors ? 'error' : skip.has(rowNumber) ? 'skipped' : 'ready',
      errors,
      warnings,
      preview,
    });

    // Stash the resolved values on the result for the commit pass.
    if (!hasErrors) {
      resolved.set(rowNumber, {
        studentCode,
        givenName,
        fatherName,
        grandfatherName: pick(row, 'grandfatherName'),
        givenNameAm: pick(row, 'givenNameAm'),
        fatherNameAm: pick(row, 'fatherNameAm'),
        grandfatherNameAm: pick(row, 'grandfatherNameAm'),
        gender,
        dateOfBirth: dob ?? '',
        gradeLevelId: grade!.id,
        sectionId: section?.id ?? '',
        rollNumber,
        phone,
        email: pick(row, 'email'),
        address: pick(row, 'address'),
        subCity: pick(row, 'subCity'),
        woreda: pick(row, 'woreda'),
        kebele: pick(row, 'kebele'),
        emergencyContactName: pick(row, 'emergencyContactName'),
        emergencyContactPhone: pick(row, 'emergencyContactPhone'),
        emergencyContactRelation: pick(row, 'emergencyContactRelation'),
        bloodGroup: pick(row, 'bloodGroup'),
        previousSchool: pick(row, 'previousSchool'),
        admissionDate: admissionDate ?? '',
        guardianName,
        guardianPhone,
        guardianRelationship: pick(row, 'guardianRelationship') || 'guardian',
      });
    }
  }

  const readyCount = results.filter((r) => r.status === 'ready').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  if (options.mode === 'validate') {
    return {
      mode: 'validate',
      totalRows: rows.length,
      readyCount,
      errorCount,
      importedCount: 0,
      unknownColumns,
      missingRequiredColumns,
      rows: results,
    };
  }

  // ---- Commit ----
  let importedCount = 0;

  for (const result of results) {
    if (result.status !== 'ready') continue;
    const data = resolved.get(result.rowNumber);
    if (!data) continue;

    try {
      const code =
        data.studentCode ||
        (await generateStudentCode(db, schoolId, yearRow?.ethiopianYear ?? null));

      const input = createStudentSchema.parse({
        studentCode: code,
        givenName: data.givenName,
        fatherName: data.fatherName,
        grandfatherName: data.grandfatherName,
        givenNameAm: data.givenNameAm,
        fatherNameAm: data.fatherNameAm,
        grandfatherNameAm: data.grandfatherNameAm,
        gender: data.gender,
        dateOfBirth: data.dateOfBirth,
        phone: data.phone,
        email: data.email,
        address: data.address,
        subCity: data.subCity,
        woreda: data.woreda,
        kebele: data.kebele,
        emergencyContactName: data.emergencyContactName,
        emergencyContactPhone: data.emergencyContactPhone,
        emergencyContactRelation: data.emergencyContactRelation,
        bloodGroup: data.bloodGroup,
        previousSchool: data.previousSchool,
        admissionDate: data.admissionDate,
        status: 'active',
        gradeLevelId: data.gradeLevelId,
        sectionId: data.sectionId,
        rollNumber: data.rollNumber,
        customFields: {},
        ...(data.guardianName
          ? {
              guardian: {
                givenName: data.guardianName.split(/\s+/)[0],
                fatherName: data.guardianName.split(/\s+/).slice(1).join(' '),
                phone: data.guardianPhone,
                relationship: data.guardianRelationship,
              },
            }
          : {}),
      });

      await createStudent(ctx, input, options.academicYearId);
      result.status = 'imported';
      result.preview.studentCode = code;
      importedCount++;
    } catch (error) {
      // One bad row must not abort the rest of the import.
      result.status = 'error';
      result.errors._ =
        error instanceof Error ? error.message : 'Could not import this row';
    }
  }

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'student.import',
    entityType: 'student',
    entityId: null,
    summary: `Imported ${importedCount} student${importedCount === 1 ? '' : 's'} from a file`,
    newValue: {
      totalRows: rows.length,
      imported: importedCount,
      failed: results.filter((r) => r.status === 'error').length,
    },
    ipAddress: ctx.ipAddress,
  });

  return {
    mode: 'commit',
    totalRows: rows.length,
    readyCount,
    errorCount: results.filter((r) => r.status === 'error').length,
    importedCount,
    unknownColumns,
    missingRequiredColumns,
    rows: results,
  };
}

type ResolvedRow = {
  studentCode: string;
  givenName: string;
  fatherName: string;
  grandfatherName: string;
  givenNameAm: string;
  fatherNameAm: string;
  grandfatherNameAm: string;
  gender: 'male' | 'female' | null;
  dateOfBirth: string;
  gradeLevelId: string;
  sectionId: string;
  rollNumber: number | null;
  phone: string;
  email: string;
  address: string;
  subCity: string;
  woreda: string;
  kebele: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
  bloodGroup: string;
  previousSchool: string;
  admissionDate: string;
  guardianName: string;
  guardianPhone: string;
  guardianRelationship: string;
};
