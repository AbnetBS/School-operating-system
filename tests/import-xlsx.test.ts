/**
 * .xlsx import tests.
 *
 * These run against genuine Excel files built by tests/helpers/xlsx-fixture.ts
 * — a real ZIP with a real shared-string table and real date-styled numeric
 * cells — so the parser faces exactly the ambiguities a school's upload will
 * present: Amharic in the shared strings, dates as serial numbers, phone
 * numbers silently converted to numbers by Excel, and genuinely absent cells.
 *
 * The CSV path is exercised alongside at each step, because the whole point of
 * the design is that both formats converge on one validation code path and
 * must therefore produce identical verdicts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import {
  schools,
  users,
  academicYears,
  gradeLevels,
  sections,
  auditLog,
} from '../src/db/schema/core.ts';
import { students, guardians, studentGuardians } from '../src/db/schema/people.ts';
import { importStudents, readUpload } from '../src/lib/import/students.ts';
import {
  parseXlsx,
  cellToString,
  looksLikeXlsx,
  looksLikeLegacyXls,
  SpreadsheetError,
} from '../src/lib/import/xlsx.ts';
import { buildXlsx, type CellValue } from './helpers/xlsx-fixture.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionA: string;
  adminUserId: string;
};

const A: Fixture = {} as Fixture;

function contextFor(fixture: Fixture) {
  const permissions = ['student.import', 'student.create', 'student.view', 'guardian.manage'];
  return {
    db,
    schoolId: fixture.schoolId,
    user: { userId: fixture.adminUserId, givenName: 'Test', fatherName: 'User' },
    ipAddress: '127.0.0.1',
    has: (p: string) => permissions.includes(p),
    hasAny: (...list: string[]) => list.some((p) => permissions.includes(p)),
    displayName: () => 'Test User',
  } as never;
}

const HEADERS = [
  'Student ID',
  'Given Name',
  'Father Name',
  'Given Name (Amharic)',
  'Gender',
  'Date of Birth',
  'Grade Level',
  'Section',
  'Guardian Name',
  'Guardian Phone',
];

before(async () => {
  db = await getDb();
  const [school] = await db
    .insert(schools)
    .values({ code: `xls-${Date.now()}`, name: 'XLSX Test', isActive: true })
    .returning({ id: schools.id });
  A.schoolId = school!.id;

  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId: A.schoolId,
      name: '2018 E.C.',
      ethiopianYear: 2018,
      startDate: '2025-09-11',
      endDate: '2026-07-07',
      isCurrent: true,
    })
    .returning({ id: academicYears.id });
  A.yearId = year!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: A.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  A.gradeId = grade!.id;

  const [section] = await db
    .insert(sections)
    .values({
      schoolId: A.schoolId,
      academicYearId: A.yearId,
      gradeLevelId: A.gradeId,
      name: 'A',
    })
    .returning({ id: sections.id });
  A.sectionA = section!.id;

  const [admin] = await db
    .insert(users)
    .values({ schoolId: A.schoolId, username: 'admin', passwordHash: 'x', givenName: 'Admin' })
    .returning({ id: users.id });
  A.adminUserId = admin!.id;
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await closeDb();
});

async function studentCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(students)
    .where(eq(students.schoolId, A.schoolId));
  return row!.n;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

test('an .xlsx file is recognised by its bytes, not its name', async () => {
  const buffer = buildXlsx([['Given Name'], ['Abebe']]);
  assert.equal(looksLikeXlsx(buffer), true);

  // A workbook mis-named as .csv must still be read as a workbook.
  const parsed = await readUpload({ fileBytes: new Uint8Array(buffer) });
  assert.equal(parsed.format, 'xlsx');
  assert.equal(parsed.rows.length, 1);
});

test('plain CSV bytes are not mistaken for a workbook', async () => {
  const bytes = new TextEncoder().encode('Given Name,Father Name\nAbebe,Kebede\n');
  assert.equal(looksLikeXlsx(bytes), false);
  const parsed = await readUpload({ fileBytes: bytes });
  assert.equal(parsed.format, 'csv');
  assert.equal(parsed.rows[0]!.givenname, 'Abebe');
});

test('a legacy .xls file is refused with instructions rather than garbled', async () => {
  const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  assert.equal(looksLikeLegacyXls(oleHeader), true);

  await assert.rejects(
    () => readUpload({ fileBytes: new Uint8Array(oleHeader) }),
    (error: unknown) =>
      error instanceof SpreadsheetError && /Save As.*\.xlsx/s.test(error.message),
  );
});

test('a PDF renamed .xlsx is named for what it is, not parsed as CSV', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(500, 7)]);
  await assert.rejects(
    () => readUpload({ fileBytes: new Uint8Array(pdf) }),
    (error: unknown) => error instanceof SpreadsheetError && /PDF/.test(error.message),
  );
});

test('images and other binaries are refused rather than half-read', async () => {
  const cases: Array<[string, number[]]> = [
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0]],
    ['PNG', [0x89, 0x50, 0x4e, 0x47]],
    ['GIF', [0x47, 0x49, 0x46, 0x38]],
    ['gzip', [0x1f, 0x8b, 0x08, 0x00]],
  ];

  for (const [label, magic] of cases) {
    const bytes = new Uint8Array([...magic, ...new Array(400).fill(0x41)]);
    await assert.rejects(
      () => readUpload({ fileBytes: bytes }),
      (error: unknown) => error instanceof SpreadsheetError,
      `${label} should be refused`,
    );
  }
});

test('a real CSV is not mistaken for a binary', async () => {
  const bytes = new TextEncoder().encode(
    'Given Name,Father Name,Grade Level\nተስፋዬ,አለሙ,Grade 5\n',
  );
  const parsed = await readUpload({ fileBytes: bytes });
  assert.equal(parsed.format, 'csv');
  assert.equal(parsed.rows[0]!.givenname, 'ተስፋዬ');
});

test('a corrupt workbook produces a clear error, not a crash', async () => {
  // ZIP magic bytes but no workbook inside.
  const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
  await assert.rejects(
    () => parseXlsx(fake),
    (error: unknown) => error instanceof SpreadsheetError,
  );
});

test('a file with more rows than the limit is refused, never half-imported', async () => {
  // 12 data rows against a limit of 5 — the tail must not vanish quietly.
  const rows: CellValue[][] = [['Given Name', 'Father Name', 'Grade Level']];
  for (let i = 1; i <= 12; i++) rows.push([`Student${i}`, 'Test', 'Grade 5']);

  const sheet = await parseXlsx(buildXlsx(rows), { maxRows: 5 });
  assert.equal(sheet.rows.length, 5);
  assert.equal(sheet.truncatedAt, 5, 'truncation must be reported to the caller');

  // And a file within the limit reports nothing.
  const small = await parseXlsx(buildXlsx(rows.slice(0, 4)), { maxRows: 5 });
  assert.equal(small.truncatedAt, undefined);
});

test('an oversized workbook is rejected before parsing', async () => {
  const huge = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(6 * 1024 * 1024),
  ]);
  await assert.rejects(
    () => parseXlsx(huge),
    (error: unknown) => error instanceof SpreadsheetError && /5 MB/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Cell conversion
// ---------------------------------------------------------------------------

test('dates convert using UTC, so the day cannot shift by timezone', () => {
  assert.equal(cellToString(new Date(Date.UTC(2012, 4, 14))), '2012-05-14');
  // Just before UTC midnight: a local-time conversion would report the 13th.
  assert.equal(cellToString(new Date(Date.UTC(2012, 4, 14, 23, 59, 59))), '2012-05-14');
  assert.equal(cellToString(new Date(Date.UTC(2013, 0, 1))), '2013-01-01');
});

test('numbers keep their integer form and never become exponential', () => {
  assert.equal(cellToString(7), '7');
  assert.equal(cellToString(911777001), '911777001');
  assert.equal(cellToString(2.5), '2.5');
  assert.equal(cellToString(0), '0');
  // Large IDs must stay readable rather than collapsing to scientific notation.
  assert.equal(cellToString(100000000000000000000), '100000000000000000000');
});

test('blank and invalid cells become empty strings', () => {
  assert.equal(cellToString(null), '');
  assert.equal(cellToString(undefined), '');
  assert.equal(cellToString(''), '');
  assert.equal(cellToString(new Date('nonsense')), '');
  assert.equal(cellToString(Number.NaN), '');
});

// ---------------------------------------------------------------------------
// Reading a real workbook
// ---------------------------------------------------------------------------

test('Amharic text survives the round trip through a real workbook', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Given Name (Amharic)', 'Father Name'],
    ['Tesfaye', 'ተስፋዬ', 'Alemu'],
    ['Hanna', 'ሃና ግርማ', 'Girma'],
  ]);

  const sheet = await parseXlsx(buffer);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[0]!.givennameamharic, 'ተስፋዬ');
  assert.equal(sheet.rows[1]!.givennameamharic, 'ሃና ግርማ');

  // Ethiopic, not mojibake.
  assert.match(sheet.rows[0]!.givennameamharic!, /[\u1200-\u137F]/);
});

test('an Amharic column heading is matched to the right field', async () => {
  const buffer = buildXlsx([
    ['ስም', 'የአባትስም', 'ክፍል'],
    ['አበበ', 'ከበደ', 'Grade 5'],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.deepEqual(report.missingRequiredColumns, [], 'Amharic headings must be understood');
  assert.equal(report.readyCount, 1);
  assert.equal(report.rows[0]!.preview.name, 'አበበ ከበደ');
});

test('a real date cell is read as a date, not a serial number', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Father Name', 'Grade Level', 'Date of Birth'],
    ['Dated', 'Student', 'Grade 5', new Date(Date.UTC(2012, 4, 14))],
  ]);

  const sheet = await parseXlsx(buffer);
  assert.equal(
    sheet.rows[0]!.dateofbirth,
    '2012-05-14',
    'a date cell must not surface as 41043',
  );

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });
  assert.deepEqual(report.rows[0]!.errors, {});
  assert.equal(report.rows[0]!.status, 'ready');
  assert.equal(
    report.rows[0]!.preview.dateOfBirth,
    '2012-05-14',
    'the preview must show the date so a day/month swap can be spotted',
  );
});

test('the preview shows how an ambiguous date was actually read', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Father Name', 'Grade Level', 'Date of Birth'],
    // 05/03 is a real date either way round; only the preview reveals which.
    ['Ambiguous', 'Student', 'Grade 5', '05/03/2012'],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(
    report.rows[0]!.preview.dateOfBirth,
    '2012-03-05',
    'day-first must be shown unambiguously as ISO',
  );
});

test('a date typed as text is still accepted, in either order', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Father Name', 'Grade Level', 'Date of Birth'],
    ['Iso', 'Student', 'Grade 5', '2012-05-14'],
    ['DayFirst', 'Student', 'Grade 5', '14/05/2012'],
    ['Impossible', 'Student', 'Grade 5', '31/31/2013'],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(report.rows[0]!.status, 'ready');
  assert.equal(report.rows[1]!.status, 'ready');
  assert.ok(report.rows[2]!.errors.dateOfBirth, '31/31 must be rejected');
});

test('empty cells are absent, not the string "null"', async () => {
  const buffer = buildXlsx([
    ['Student ID', 'Given Name', 'Father Name', 'Grade Level', 'Section'],
    [null, 'Blank', 'Cells', 'Grade 5', null],
  ]);

  const sheet = await parseXlsx(buffer);
  assert.equal(sheet.rows[0]!.studentid, '');
  assert.equal(sheet.rows[0]!.section, '');

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });
  assert.equal(report.rows[0]!.status, 'ready');
  assert.ok(
    report.rows[0]!.warnings.some((w) => /without a class/i.test(w)),
    'a missing section should warn, not fail',
  );
});

test('entirely blank rows are skipped but row numbers stay true to the sheet', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Father Name', 'Grade Level'],
    ['First', 'Student', 'Grade 5'],
    [null, null, null],
    [null, null, null],
    ['Second', 'Student', 'Grade 5'],
  ]);

  const sheet = await parseXlsx(buffer);
  assert.equal(sheet.rows.length, 2);
  assert.deepEqual(
    sheet.rowNumbers,
    [2, 5],
    'row numbers must point at the lines the administrator sees in Excel',
  );
});

test('a phone number mangled into a number by Excel is recovered, with a warning', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Father Name', 'Grade Level', 'Guardian Name', 'Guardian Phone'],
    // Excel drops the leading zero from 0911777001 when the cell is numeric.
    ['Phoned', 'Student', 'Grade 5', 'Alemu Bekele', 911777001],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(report.rows[0]!.status, 'ready');
  assert.match(report.rows[0]!.preview.guardian, /\+251911777001/);
  assert.ok(
    report.rows[0]!.warnings.some((w) => /leading zero/i.test(w)),
    'the administrator must be told Excel altered the value',
  );
});

test('a genuinely invalid phone is still rejected from a workbook', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Father Name', 'Grade Level', 'Guardian Name', 'Guardian Phone'],
    ['Bad', 'Phone', 'Grade 5', 'Someone', 12345],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });
  assert.ok(report.rows[0]!.errors.guardianPhone);
});

test('a numeric student ID keeps its digits intact', async () => {
  const buffer = buildXlsx([
    ['Student ID', 'Given Name', 'Father Name', 'Grade Level'],
    [20180042, 'Numeric', 'Code', 'Grade 5'],
  ]);

  const sheet = await parseXlsx(buffer);
  assert.equal(sheet.rows[0]!.studentid, '20180042', 'must not become 2.0180042e7');
});

// ---------------------------------------------------------------------------
// Multiple sheets
// ---------------------------------------------------------------------------

test('the first sheet is used by default and is named in the report', async () => {
  const buffer = buildXlsx(
    [
      ['Given Name', 'Father Name', 'Grade Level'],
      ['Sheeted', 'Student', 'Grade 5'],
    ],
    'Students 2018',
  );

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(report.format, 'xlsx');
  assert.equal(report.sheetUsed, 'Students 2018');
  assert.deepEqual(report.sheetNames, ['Students 2018']);
});

test('asking for a sheet that does not exist lists the ones that do', async () => {
  const buffer = buildXlsx([['Given Name'], ['A']], 'Only Sheet');
  await assert.rejects(
    () => parseXlsx(buffer, { sheet: 'Missing' }),
    (error: unknown) =>
      error instanceof SpreadsheetError && /Only Sheet/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Validation before writing — the core contract
// ---------------------------------------------------------------------------

test('validating a workbook writes nothing at all', async () => {
  const before = await studentCount();

  const buffer = buildXlsx([
    HEADERS,
    ['XV/1', 'Tesfaye', 'Alemu', 'ተስፋዬ', 'male', new Date(Date.UTC(2012, 4, 14)), 'Grade 5', 'A', 'Alemu Bekele', '0911777001'],
    ['XV/2', 'Hanna', 'Girma', 'ሃና', 'female', new Date(Date.UTC(2013, 2, 2)), 'Grade 5', 'A', null, null],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(report.mode, 'validate');
  assert.equal(report.format, 'xlsx');
  assert.equal(report.readyCount, 2);
  assert.equal(report.importedCount, 0);
  assert.equal(await studentCount(), before, 'a preview must never write');
});

test('bad rows in a workbook are reported individually with Excel row numbers', async () => {
  const buffer = buildXlsx([
    HEADERS,
    ['XE/1', 'Good', 'Student', '', 'male', new Date(Date.UTC(2013, 0, 1)), 'Grade 5', 'A', null, null],
    ['XE/2', 'BadGrade', 'Student', '', 'male', new Date(Date.UTC(2013, 0, 1)), 'Grade 99', 'A', null, null],
    ['XE/3', 'BadGender', 'Student', '', 'alien', new Date(Date.UTC(2013, 0, 1)), 'Grade 5', 'A', null, null],
    ['XE/4', null, 'NoName', '', 'male', new Date(Date.UTC(2013, 0, 1)), 'Grade 5', 'A', null, null],
    ['XE/5', 'BadSection', 'Student', '', 'male', new Date(Date.UTC(2013, 0, 1)), 'Grade 5', 'Z', null, null],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  const byRow = new Map(report.rows.map((r) => [r.rowNumber, r]));
  assert.equal(byRow.get(2)!.status, 'ready');
  assert.ok(byRow.get(3)!.errors.gradeLevel);
  assert.ok(byRow.get(4)!.errors.gender);
  assert.ok(byRow.get(5)!.errors.givenName);
  assert.ok(byRow.get(6)!.errors.section);
  assert.equal(report.errorCount, 4);
});

test('a duplicate student ID inside a workbook is caught before writing', async () => {
  const buffer = buildXlsx([
    ['Student ID', 'Given Name', 'Father Name', 'Grade Level'],
    ['XD/1', 'First', 'Student', 'Grade 5'],
    ['XD/1', 'Second', 'Student', 'Grade 5'],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(report.rows[0]!.status, 'ready');
  assert.ok(report.rows[1]!.errors.studentCode, 'the repeat must be flagged');
});

// ---------------------------------------------------------------------------
// Committing a workbook
// ---------------------------------------------------------------------------

test('committing a workbook imports good rows with Amharic and dates intact', async () => {
  const before = await studentCount();

  const buffer = buildXlsx([
    HEADERS,
    ['XC/1', 'Tesfaye', 'Alemu', 'ተስፋዬ', 'male', new Date(Date.UTC(2012, 4, 14)), 'Grade 5', 'A', 'Alemu Bekele', '0911777001'],
    ['XC/2', 'ሃና', 'Girma', 'ሃና ግርማ', 'female', new Date(Date.UTC(2013, 2, 2)), 'Grade 5', 'A', null, null],
    ['XC/3', 'Broken', 'Row', '', 'male', new Date(Date.UTC(2013, 0, 1)), 'Grade 99', 'A', null, null],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'commit',
  });

  assert.equal(report.format, 'xlsx');
  assert.equal(report.importedCount, 2);
  assert.equal(report.errorCount, 1);
  assert.equal(await studentCount(), before + 2);

  const [imported] = await db
    .select({
      id: students.id,
      givenNameAm: students.givenNameAm,
      dateOfBirth: students.dateOfBirth,
      gender: students.gender,
    })
    .from(students)
    .where(and(eq(students.schoolId, A.schoolId), eq(students.studentCode, 'XC/1')));

  assert.equal(imported!.givenNameAm, 'ተስፋዬ', 'Amharic must reach the database intact');
  assert.equal(imported!.dateOfBirth, '2012-05-14', 'the date must not drift by a day');
  assert.equal(imported!.gender, 'male');

  // An Amharic given name (not just the Amharic column) also survives.
  const [amharicNamed] = await db
    .select({ givenName: students.givenName })
    .from(students)
    .where(and(eq(students.schoolId, A.schoolId), eq(students.studentCode, 'XC/2')));
  assert.equal(amharicNamed!.givenName, 'ሃና');

  // Guardian created and linked, phone normalised.
  const links = await db
    .select({ guardianId: studentGuardians.guardianId })
    .from(studentGuardians)
    .where(eq(studentGuardians.studentId, imported!.id));
  assert.equal(links.length, 1);
  const [guardian] = await db
    .select({ phone: guardians.phone })
    .from(guardians)
    .where(eq(guardians.id, links[0]!.guardianId));
  assert.equal(guardian!.phone, '+251911777001');

  // The audit trail records that this was an Excel import.
  const audits = await db
    .select({ summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'student.import')));
  assert.ok(audits.some((a) => /Excel/.test(a.summary ?? '')), 'the format must be auditable');
});

test('a student ID already in the database is refused at commit', async () => {
  const before = await studentCount();
  const buffer = buildXlsx([
    ['Student ID', 'Given Name', 'Father Name', 'Grade Level'],
    ['XC/1', 'Clash', 'Student', 'Grade 5'],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'commit',
  });

  assert.equal(report.importedCount, 0);
  assert.ok(report.rows[0]!.errors.studentCode);
  assert.equal(await studentCount(), before, 'nothing was written');
});

test('rows unticked in the preview are skipped when committing a workbook', async () => {
  const before = await studentCount();
  const buffer = buildXlsx([
    ['Student ID', 'Given Name', 'Father Name', 'Grade Level'],
    ['XS/1', 'Wanted', 'Student', 'Grade 5'],
    ['XS/2', 'Unwanted', 'Student', 'Grade 5'],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'commit',
    skipRowNumbers: [3],
  });

  assert.equal(report.importedCount, 1);
  assert.equal(await studentCount(), before + 1);

  const found = await db
    .select({ code: students.studentCode })
    .from(students)
    .where(and(eq(students.schoolId, A.schoolId), eq(students.studentCode, 'XS/2')));
  assert.equal(found.length, 0);
});

// ---------------------------------------------------------------------------
// The two formats must agree
// ---------------------------------------------------------------------------

test('the same data as CSV and as .xlsx produces the same verdicts', async () => {
  const rows = [
    ['Student ID', 'Given Name', 'Father Name', 'Given Name (Amharic)', 'Grade Level', 'Section'],
    ['EQ/1', 'Tesfaye', 'Alemu', 'ተስፋዬ', 'Grade 5', 'A'],
    ['EQ/2', 'BadGrade', 'Student', '', 'Grade 99', 'A'],
    ['EQ/3', 'NoSection', 'Student', 'ሃና', 'Grade 5', ''],
  ];

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? '')}"`).join(','))
    .join('\r\n');
  const xlsx = buildXlsx(rows);

  const fromCsv = await importStudents(contextFor(A), {
    fileText: csv,
    academicYearId: A.yearId,
    mode: 'validate',
  });
  const fromXlsx = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(xlsx),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(fromCsv.format, 'csv');
  assert.equal(fromXlsx.format, 'xlsx');
  assert.equal(fromCsv.totalRows, fromXlsx.totalRows);
  assert.equal(fromCsv.readyCount, fromXlsx.readyCount);
  assert.equal(fromCsv.errorCount, fromXlsx.errorCount);

  for (let i = 0; i < fromCsv.rows.length; i++) {
    const c = fromCsv.rows[i]!;
    const x = fromXlsx.rows[i]!;
    assert.equal(x.rowNumber, c.rowNumber, `row ${i}: row numbers differ`);
    assert.equal(x.status, c.status, `row ${i}: status differs`);
    assert.deepEqual(x.errors, c.errors, `row ${i}: errors differ`);
    assert.equal(x.preview.name, c.preview.name, `row ${i}: parsed name differs`);
    assert.equal(x.preview.gradeLevel, c.preview.gradeLevel);
  }
});

test('a workbook with no recognisable columns reports what is missing', async () => {
  const buffer = buildXlsx([
    ['Nickname', 'Favourite Colour'],
    ['Abe', 'Blue'],
  ]);

  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buffer),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.ok(report.missingRequiredColumns.includes('Given Name'));
  assert.ok(report.missingRequiredColumns.includes('Grade Level'));
  assert.equal(report.rows.length, 0);
});

test('an empty workbook is handled without crashing', async () => {
  const report = await importStudents(contextFor(A), {
    fileBytes: new Uint8Array(buildXlsx([])),
    academicYearId: A.yearId,
    mode: 'validate',
  });
  assert.equal(report.totalRows, 0);
  assert.equal(report.rows.length, 0);
});

test('a column named __proto__ cannot pollute the prototype chain', async () => {
  const buffer = buildXlsx([
    ['Given Name', 'Father Name', 'Grade Level', '__proto__', 'constructor'],
    ['Safe', 'Student', 'Grade 5', 'polluted', 'polluted'],
  ]);

  const sheet = await parseXlsx(buffer);
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    'Object.prototype must be untouched',
  );
  // The value is stored as an ordinary key on a null-prototype record.
  assert.equal(Object.getPrototypeOf(sheet.rows[0]!), null);
});
