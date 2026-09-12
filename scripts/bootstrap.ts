/**
 * First-run bootstrap: create a school and its first administrator.
 *
 * ## Why this exists
 *
 * A freshly migrated production database is empty, and nothing in the
 * application can fill it. There is no sign-up route, no school-creation
 * endpoint, no screen for an academic year and no password-change form: the
 * academic structure is written only by `scripts/seed.ts`. So a real deployment
 * had exactly one way in — the demo seed, whose administrator password
 * (`Demo@2018`) is published in this repository and cannot be changed through
 * the UI afterwards. For a system holding students' medical and disciplinary
 * records that is not an acceptable first login.
 *
 * ## What it creates
 *
 * The structure a school needs before anyone can do anything:
 *
 *   - the school, and its settings from a preset (terms, grading, modules),
 *   - every role template, with its permissions,
 *   - one academic year with its terms,
 *   - grade levels, one section per grade, and subjects linked to those
 *     sections (the combination attendance and the gradebook are keyed on),
 *   - the standard school day, so period-based attendance works,
 *   - one administrator holding the `owner` role, with a staff record.
 *
 * Students, guardians and teachers are deliberately NOT created: those come
 * from the UI (`/students/new`, `/staff/new`, `/students/import`).
 *
 * ## Safety
 *
 * It refuses to run against a database that already has users, so it cannot
 * quietly add a second administrator to a live system, and it refuses the
 * published demo password. Everything is created under one school row and
 * every child table cascades from it, so a failure part-way through is cleaned
 * up rather than left half-built.
 *
 * ## Usage
 *
 * In the deployed container (Coolify: the application's Terminal tab):
 *
 *     BOOTSTRAP_SCHOOL_CODE=gms \
 *     BOOTSTRAP_SCHOOL_NAME='Ghion Middle School' \
 *     BOOTSTRAP_ADMIN_USERNAME=admin \
 *     BOOTSTRAP_ADMIN_GIVEN_NAME=Almaz \
 *     BOOTSTRAP_ADMIN_FATHER_NAME=Tessema \
 *     npm run db:bootstrap
 *
 * Without `BOOTSTRAP_ADMIN_PASSWORD` a strong password is generated and printed
 * once. Store it immediately: there is no password-change screen yet, so
 * recovering it means editing the database.
 */

import { eq, sql } from 'drizzle-orm';

import { closeDb, getDb, type Database } from '../src/db/client.ts';
import {
  academicYears,
  gradeLevels,
  periods,
  rolePermissions,
  roles,
  schools,
  sectionSubjects,
  sections,
  subjects,
  terms,
  userRoles,
  users,
} from '../src/db/schema/core.ts';
import { staff } from '../src/db/schema/people.ts';
import { ROLE_TEMPLATES } from '../src/lib/auth/permissions.ts';
import {
  checkPasswordStrength,
  generateTemporaryPassword,
  hashPassword,
  type PasswordPolicy,
} from '../src/lib/auth/password.ts';
import { initialiseSchoolSettings } from '../src/lib/settings/service.ts';
import { SCHOOL_PRESETS } from '../src/lib/settings/presets.ts';
import { ethiopianToIso, gregorianToEthiopian } from '../src/lib/calendar/ethiopian.ts';

/**
 * Stricter than the policy applied at sign-in, on purpose.
 *
 * There is no password-change screen, so whatever is set here may be this
 * administrator's password for a long time. An account that can see every
 * student's record is worth twelve characters and both cases.
 */
export const ADMIN_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requireNumber: true,
  requireLetter: true,
  requireMixedCase: true,
  requireSymbol: false,
};

/**
 * The demo seed's password, published in this repository and in its README.
 * Refused outright rather than merely warned about: accepting it would put a
 * known credential on the most privileged account in a live system.
 */
export const PUBLISHED_DEMO_PASSWORD = 'Demo@2018';

export type SubjectDefinition = { code: string; name: string; nameAm: string | null };

/** Grades 1–8. Mirrors the demo seed's primary school. */
export const PRIMARY_SUBJECTS: SubjectDefinition[] = [
  { code: 'MATH', name: 'Mathematics', nameAm: 'ሒሳብ' },
  { code: 'ENG', name: 'English', nameAm: 'እንግሊዝኛ' },
  { code: 'AMH', name: 'Amharic', nameAm: 'አማርኛ' },
  { code: 'SCI', name: 'General Science', nameAm: 'አጠቃላይ ሳይንስ' },
  { code: 'SOC', name: 'Social Studies', nameAm: 'ማኅበራዊ ጥናት' },
  { code: 'CIV', name: 'Civics', nameAm: 'ሥነ ዜጋ' },
  { code: 'PE', name: 'Physical Education', nameAm: 'ስፖርት' },
  { code: 'ICT', name: 'ICT', nameAm: 'ኮምፒውተር' },
];

/** Grades 9–12. Mirrors the demo seed's preparatory school. */
export const SECONDARY_SUBJECTS: SubjectDefinition[] = [
  { code: 'MATH', name: 'Mathematics', nameAm: 'ሒሳብ' },
  { code: 'ENG', name: 'English', nameAm: 'እንግሊዝኛ' },
  { code: 'AMH', name: 'Amharic', nameAm: 'አማርኛ' },
  { code: 'PHY', name: 'Physics', nameAm: 'ፊዚክስ' },
  { code: 'CHEM', name: 'Chemistry', nameAm: 'ኬሚስትሪ' },
  { code: 'BIO', name: 'Biology', nameAm: 'ባዮሎጂ' },
  { code: 'GEO', name: 'Geography', nameAm: 'ጂኦግራፊ' },
  { code: 'HIST', name: 'History', nameAm: 'ታሪክ' },
  { code: 'ECON', name: 'Economics', nameAm: 'ኢኮኖሚክስ' },
  { code: 'ICT', name: 'ICT', nameAm: 'ኮምፒውተር' },
];

/**
 * What the youngest classes actually take. Below Grade 5 a primary school does
 * not run Civics or ICT, so attaching them would create empty gradebook columns
 * for every class. Same split the demo seed uses.
 */
const LOWER_PRIMARY_CODES = ['MATH', 'ENG', 'AMH', 'SCI', 'SOC', 'PE'];

/**
 * The standard school day: seven teaching periods plus break and lunch.
 *
 * Created so period-based attendance and a timetable have something to refer
 * to. A school on daily attendance never looks at these, and they cost nothing.
 */
const SCHOOL_DAY: { start: string; end: string; breakPeriod: boolean }[] = [
  { start: '08:00', end: '08:45', breakPeriod: false },
  { start: '08:45', end: '09:30', breakPeriod: false },
  { start: '09:30', end: '09:50', breakPeriod: true },
  { start: '09:50', end: '10:35', breakPeriod: false },
  { start: '10:35', end: '11:20', breakPeriod: false },
  { start: '11:20', end: '12:00', breakPeriod: false },
  { start: '12:00', end: '13:00', breakPeriod: true },
  { start: '13:00', end: '13:45', breakPeriod: false },
  { start: '13:45', end: '14:30', breakPeriod: false },
];

/**
 * Term boundaries inside the school year, as Ethiopian month/day spans.
 *
 * The school year runs Meskerem 1 to Sene 30 — ten months, with Hamle, Nehase
 * and Pagume as the long break — which is what the demo seed encodes for both
 * of its deliberately different schools.
 */
const TERM_SPANS: Record<number, { span: [number, number, number, number]; weight: number }[]> = {
  3: [
    { span: [1, 1, 4, 10], weight: 30 }, // Meskerem 1 – Tahsas 10
    { span: [4, 11, 7, 20], weight: 30 }, // Tahsas 11 – Megabit 20
    { span: [7, 21, 10, 30], weight: 40 }, // Megabit 21 – Sene 30
  ],
  2: [
    { span: [1, 1, 5, 30], weight: 50 }, // Meskerem 1 – Ter 30
    { span: [6, 1, 10, 30], weight: 50 }, // Yekatit 1 – Sene 30
  ],
};

export type BootstrapConfig = {
  school: { code: string; name: string; nameAm: string | null };
  presetKey: string;
  grades: { from: number; to: number };
  academicYear: number;
  sectionsPerGrade: number;
  /** Null means "use the built-in list for this grade range". */
  subjectList: SubjectDefinition[] | null;
  admin: {
    username: string;
    givenName: string;
    fatherName: string | null;
    email: string | null;
    password: string;
    /** True when the password was generated rather than supplied. */
    generated: boolean;
  };
};

export type BootstrapResult = {
  schoolId: string;
  schoolCode: string;
  username: string;
  password: string;
  generated: boolean;
  counts: {
    roles: number;
    terms: number;
    gradeLevels: number;
    sections: number;
    subjects: number;
    sectionSubjects: number;
    periods: number;
  };
};

/** Raised for anything the operator has to correct before re-running. */
export class BootstrapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapConfigError';
  }
}

/**
 * The bootstrap's own inputs — the complete list, so a misspelled variable is
 * a compile error rather than a silently ignored one.
 *
 * These are inputs to a one-off setup command, not configuration the running
 * server reads, which is why they are named as a type of their own and why the
 * tests can pass a plain object instead of mutating the real environment.
 */
export type BootstrapEnv = {
  BOOTSTRAP_SCHOOL_CODE?: string;
  BOOTSTRAP_SCHOOL_NAME?: string;
  BOOTSTRAP_SCHOOL_NAME_AM?: string;
  BOOTSTRAP_PRESET?: string;
  BOOTSTRAP_GRADES?: string;
  BOOTSTRAP_ACADEMIC_YEAR?: string;
  BOOTSTRAP_SECTIONS_PER_GRADE?: string;
  BOOTSTRAP_SUBJECTS?: string;
  BOOTSTRAP_ADMIN_USERNAME?: string;
  BOOTSTRAP_ADMIN_GIVEN_NAME?: string;
  BOOTSTRAP_ADMIN_FATHER_NAME?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  BOOTSTRAP_ADMIN_PASSWORD?: string;
};

const REQUIRED_VARIABLES = [
  'BOOTSTRAP_SCHOOL_CODE',
  'BOOTSTRAP_SCHOOL_NAME',
  'BOOTSTRAP_ADMIN_USERNAME',
  'BOOTSTRAP_ADMIN_GIVEN_NAME',
] as const;

/** Trim, and treat an empty variable as one that was never set. */
function read(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function required(value: string | undefined, key: string): string {
  const trimmed = read(value);
  if (trimmed === undefined) {
    throw new BootstrapConfigError(
      `${key} is required and is not set.\n\n` +
        `The bootstrap needs, at minimum:\n` +
        REQUIRED_VARIABLES.map((name) => `  ${name}`).join('\n') +
        `\n\nSet them for this one command rather than as application\n` +
        `environment variables — they are inputs to a setup step, not\n` +
        `configuration the running server reads.`,
    );
  }
  return trimmed;
}

/**
 * The Ethiopian school year to create, when the operator did not choose one.
 *
 * During the long break (Hamle, Nehase, Pagume — months 11 to 13) a school
 * setting itself up is preparing for the year that starts in Meskerem, so the
 * next year is used. Otherwise the year in progress is.
 */
export function defaultAcademicYear(today: Date = new Date()): number {
  const ethiopian = gregorianToEthiopian({
    year: today.getFullYear(),
    month: today.getMonth() + 1,
    day: today.getDate(),
  });
  return ethiopian.month >= 11 ? ethiopian.year + 1 : ethiopian.year;
}

function parseGradeRange(raw: string | undefined, presetKey: string): { from: number; to: number } {
  if (raw === undefined) {
    // Match the preset the school chose rather than imposing one range.
    if (presetKey === 'twoSemesterSecondary') return { from: 9, to: 12 };
    if (presetKey === 'kindergarten') return { from: 1, to: 3 };
    return { from: 1, to: 8 };
  }
  const match = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(raw);
  if (!match) {
    throw new BootstrapConfigError(
      `BOOTSTRAP_GRADES must be a level ("8") or a range ("1-8"); got "${raw}".`,
    );
  }
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to > 12 || from > to) {
    throw new BootstrapConfigError(
      `BOOTSTRAP_GRADES must run from 1 to 12 with the first level not above the last; got "${raw}".`,
    );
  }
  return { from, to };
}

/**
 * `CODE:Name:NameAm,CODE:Name` — Amharic optional, commas between subjects.
 *
 * Provided because the built-in lists are a starting point, not a national
 * curriculum: a school that teaches Afaan Oromo instead of Amharic, or splits
 * General Science, needs its own list and has no screen to enter it.
 */
export function parseSubjectList(raw: string): SubjectDefinition[] {
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [code, name, nameAm] = entry.split(':').map((part) => part?.trim() ?? '');
      if (!code || !name) {
        throw new BootstrapConfigError(
          `BOOTSTRAP_SUBJECTS entries are "CODE:Name" or "CODE:Name:NameAm"; "${entry}" is not.`,
        );
      }
      if (!/^[A-Za-z0-9]{1,32}$/.test(code)) {
        throw new BootstrapConfigError(
          `Subject code "${code}" must be 1–32 letters or digits, with no spaces.`,
        );
      }
      // An entry may simply omit the Amharic name; `nameAm` is then undefined
      // rather than empty, and the column is nullable — both mean null.
      return {
        code: code.toUpperCase(),
        name,
        nameAm: nameAm === undefined || nameAm === '' ? null : nameAm,
      };
    });

  if (list.length === 0) {
    throw new BootstrapConfigError('BOOTSTRAP_SUBJECTS is set but contains no subjects.');
  }
  const seen = new Set<string>();
  for (const subject of list) {
    if (seen.has(subject.code)) {
      throw new BootstrapConfigError(`Subject code "${subject.code}" appears twice.`);
    }
    seen.add(subject.code);
  }
  return list;
}

/**
 * Resolve and validate the administrator's password.
 *
 * Generates one when none was supplied, which is the recommended path: a
 * password typed into a shell is stored in that shell's history and in the
 * deployment log, and Coolify keeps both.
 */
function resolveAdminPassword(supplied: string | undefined): { password: string; generated: boolean } {
  if (supplied === undefined) {
    // Retry rather than patch: the generator's alphabet is unambiguous by
    // design, and a fresh draw is simpler to reason about than fixing up a
    // password that happened to come out single-case.
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = generateTemporaryPassword(16);
      if (checkPasswordStrength(candidate, ADMIN_PASSWORD_POLICY).ok) {
        return { password: candidate, generated: true };
      }
    }
    throw new BootstrapConfigError('Could not generate a password that satisfies the policy.');
  }

  if (supplied === PUBLISHED_DEMO_PASSWORD) {
    throw new BootstrapConfigError(
      `${PUBLISHED_DEMO_PASSWORD} is the demo seed's password and is published in this\n` +
        'repository. It cannot be used for a real administrator account.\n\n' +
        'Leave BOOTSTRAP_ADMIN_PASSWORD unset to have a strong one generated.',
    );
  }

  const check = checkPasswordStrength(supplied, ADMIN_PASSWORD_POLICY);
  if (!check.ok) {
    throw new BootstrapConfigError(
      'The administrator password is too weak for an account that can see every\n' +
        `student record:\n  ${check.problems.join('\n  ')}\n\n` +
        'Leave BOOTSTRAP_ADMIN_PASSWORD unset to have a strong one generated.',
    );
  }
  return { password: supplied, generated: false };
}

/**
 * The one place the process environment is read. Everything after this works
 * from the typed object it returns, so a misspelled variable is a compile error
 * rather than a silently ignored one, and the tests can supply their own inputs
 * without touching `process.env`.
 */
function bootstrapEnvironment(): BootstrapEnv {
  const env = process.env;
  return {
    BOOTSTRAP_SCHOOL_CODE: env.BOOTSTRAP_SCHOOL_CODE,
    BOOTSTRAP_SCHOOL_NAME: env.BOOTSTRAP_SCHOOL_NAME,
    BOOTSTRAP_SCHOOL_NAME_AM: env.BOOTSTRAP_SCHOOL_NAME_AM,
    BOOTSTRAP_PRESET: env.BOOTSTRAP_PRESET,
    BOOTSTRAP_GRADES: env.BOOTSTRAP_GRADES,
    BOOTSTRAP_ACADEMIC_YEAR: env.BOOTSTRAP_ACADEMIC_YEAR,
    BOOTSTRAP_SECTIONS_PER_GRADE: env.BOOTSTRAP_SECTIONS_PER_GRADE,
    BOOTSTRAP_SUBJECTS: env.BOOTSTRAP_SUBJECTS,
    BOOTSTRAP_ADMIN_USERNAME: env.BOOTSTRAP_ADMIN_USERNAME,
    BOOTSTRAP_ADMIN_GIVEN_NAME: env.BOOTSTRAP_ADMIN_GIVEN_NAME,
    BOOTSTRAP_ADMIN_FATHER_NAME: env.BOOTSTRAP_ADMIN_FATHER_NAME,
    BOOTSTRAP_ADMIN_EMAIL: env.BOOTSTRAP_ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: env.BOOTSTRAP_ADMIN_PASSWORD,
  };
}

export function parseBootstrapConfig(env: BootstrapEnv = bootstrapEnvironment()): BootstrapConfig {
  const presetKey = read(env.BOOTSTRAP_PRESET) ?? 'threeTermPrimary';
  if (!(presetKey in SCHOOL_PRESETS)) {
    throw new BootstrapConfigError(
      `BOOTSTRAP_PRESET "${presetKey}" is not a preset. Choose one of:\n` +
        Object.values(SCHOOL_PRESETS)
          .map((preset) => `  ${preset.key} — ${preset.description}`)
          .join('\n'),
    );
  }

  const grades = parseGradeRange(read(env.BOOTSTRAP_GRADES), presetKey);

  const sectionsRaw = read(env.BOOTSTRAP_SECTIONS_PER_GRADE);
  let sectionsPerGrade = 1;
  if (sectionsRaw !== undefined) {
    sectionsPerGrade = Number(sectionsRaw);
    if (!Number.isInteger(sectionsPerGrade) || sectionsPerGrade < 1 || sectionsPerGrade > 10) {
      throw new BootstrapConfigError(
        `BOOTSTRAP_SECTIONS_PER_GRADE must be a whole number from 1 to 10; got "${sectionsRaw}".`,
      );
    }
  }

  const yearRaw = read(env.BOOTSTRAP_ACADEMIC_YEAR);
  const expectedYear = defaultAcademicYear();
  let academicYear = expectedYear;
  if (yearRaw !== undefined) {
    academicYear = Number(yearRaw);
    // Checked against the present Ethiopian year rather than against an
    // absolute window: an Ethiopian year runs seven or eight behind a
    // Gregorian one, so a plausible-looking Gregorian year such as 2026 sits
    // inside any sane absolute range and would silently create a school year
    // whose dates start in 2033. Two years either side covers setting up next
    // year's records and finishing last year's, and rejects that typo.
    if (!Number.isInteger(academicYear) || Math.abs(academicYear - expectedYear) > 2) {
      throw new BootstrapConfigError(
        `BOOTSTRAP_ACADEMIC_YEAR must be an Ethiopian year within two years of the\n` +
          `present one, which is ${expectedYear}; got "${yearRaw}". Ethiopian years run seven\n` +
          `or eight behind Gregorian ones, so ${yearRaw} looks like a Gregorian year.`,
      );
    }
  }

  // Stored lowercased: sign-in lowercases the school code and the username
  // before comparing, so a code saved with capitals could never be matched.
  const code = required(env.BOOTSTRAP_SCHOOL_CODE, 'BOOTSTRAP_SCHOOL_CODE').toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(code)) {
    throw new BootstrapConfigError(
      `BOOTSTRAP_SCHOOL_CODE must be 1–32 letters, digits, hyphens or underscores; got "${code}".`,
    );
  }

  const email = read(env.BOOTSTRAP_ADMIN_EMAIL) ?? null;
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapConfigError(`BOOTSTRAP_ADMIN_EMAIL "${email}" does not look like an email address.`);
  }

  const rawSubjects = read(env.BOOTSTRAP_SUBJECTS);
  const { password, generated } = resolveAdminPassword(read(env.BOOTSTRAP_ADMIN_PASSWORD));

  return {
    school: {
      code,
      name: required(env.BOOTSTRAP_SCHOOL_NAME, 'BOOTSTRAP_SCHOOL_NAME'),
      nameAm: read(env.BOOTSTRAP_SCHOOL_NAME_AM) ?? null,
    },
    presetKey,
    grades,
    academicYear,
    sectionsPerGrade,
    subjectList: rawSubjects === undefined ? null : parseSubjectList(rawSubjects),
    admin: {
      username: required(env.BOOTSTRAP_ADMIN_USERNAME, 'BOOTSTRAP_ADMIN_USERNAME').toLowerCase(),
      givenName: required(env.BOOTSTRAP_ADMIN_GIVEN_NAME, 'BOOTSTRAP_ADMIN_GIVEN_NAME'),
      fatherName: read(env.BOOTSTRAP_ADMIN_FATHER_NAME) ?? null,
      email,
      password,
      generated,
    },
  };
}

/**
 * Refuse to run against a database that is already in use.
 *
 * The check is on users rather than schools: a school with no users is a
 * half-finished bootstrap worth replacing, while any user at all means somebody
 * is already accountable for this system and adding another administrator
 * behind their back is not this script's decision to make.
 */
export async function assertDatabaseUninitialised(db: Database): Promise<void> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const existing = row?.count ?? 0;
  if (existing > 0) {
    throw new BootstrapConfigError(
      `This database already has ${existing} user${existing === 1 ? '' : 's'}, so it is not a\n` +
        'fresh installation and the bootstrap will not add another administrator to it.\n\n' +
        'Create further staff from the UI (/staff/new), which gives them the correct\n' +
        'role and a temporary password. If this really is a new school that needs its\n' +
        'own database, point DATABASE_URL at an empty one and migrate it first.',
    );
  }
}

/**
 * Create the school and everything it needs to be usable.
 *
 * Takes a database handle rather than opening one, so tests can run it against
 * their own connection and so the CLI wrapper owns the connect/close pair.
 */
export async function bootstrapSchool(db: Database, config: BootstrapConfig): Promise<BootstrapResult> {
  const existing = await db.select({ id: schools.id }).from(schools).where(eq(schools.code, config.school.code));
  if (existing.length > 0) {
    throw new BootstrapConfigError(
      `A school with the code "${config.school.code}" already exists. School codes are\n` +
        'unique and are what staff and students select at sign-in, so pick another.',
    );
  }

  const [school] = await db
    .insert(schools)
    .values({
      code: config.school.code,
      name: config.school.name,
      nameAm: config.school.nameAm,
      plan: 'professional',
    })
    .returning({ id: schools.id });
  const schoolId = school!.id;

  // Everything below hangs off this school row, and every one of those foreign
  // keys cascades. So if any step fails, deleting the school removes the whole
  // partial attempt instead of leaving a half-built school behind.
  try {
    const preset = SCHOOL_PRESETS[config.presetKey as keyof typeof SCHOOL_PRESETS]!;
    await initialiseSchoolSettings(db, schoolId, {
      academic: preset.academic,
      grading: preset.grading,
      locale: { defaultLocale: 'en', calendarDisplay: 'both' },
      modules: {
        attendance: true, gradebook: true, reportCards: true, studentPortal: true,
        parentPortal: true, fees: true, payments: true,
        hr: true, library: true, inventory: true, maintenance: true, transport: true,
        documents: true,
      },
      attendance: { mode: 'daily', riskThresholdPercent: 85, consecutiveAbsenceAlert: 3 },
      reportCard: { showRank: preset.grading.useRanking ?? false, showAttendance: true, printLocale: 'en' },
    });

    // Roles first: the administrator needs the owner role to exist.
    const roleIds: Record<string, string> = {};
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      const [role] = await db
        .insert(roles)
        .values({
          schoolId,
          key,
          name: template.name,
          nameAm: template.nameAm,
          description: template.description,
          isSystem: true,
        })
        .returning({ id: roles.id });
      roleIds[key] = role!.id;
      if (template.permissions.length > 0) {
        await db
          .insert(rolePermissions)
          .values(template.permissions.map((permission) => ({ roleId: role!.id, permission })));
      }
    }

    const year = config.academicYear;
    const [academicYear] = await db
      .insert(academicYears)
      .values({
        schoolId,
        name: `${year} E.C.`,
        nameAm: `${year} ዓ.ም.`,
        ethiopianYear: year,
        startDate: ethiopianToIso({ year, month: 1, day: 1 }),
        endDate: ethiopianToIso({ year, month: 10, day: 30 }),
        isCurrent: true,
      })
      .returning({ id: academicYears.id });
    const yearId = academicYear!.id;

    const termStructure = preset.academic.termStructure === 'semester' ? 'semester' : 'term';
    const spans = TERM_SPANS[preset.academic.termsPerYear ?? 3] ?? TERM_SPANS[3]!;
    let termCount = 0;
    for (let index = 0; index < spans.length; index++) {
      const { span, weight } = spans[index]!;
      const [startMonth, startDay, endMonth, endDay] = span;
      await db.insert(terms).values({
        schoolId,
        academicYearId: yearId,
        kind: termStructure,
        sequence: index + 1,
        name: termStructure === 'semester' ? `Semester ${index + 1}` : `Term ${index + 1}`,
        nameAm: termStructure === 'semester' ? `${index + 1}ኛ ሴሚስተር` : `${index + 1}ኛ ወቅት`,
        startDate: ethiopianToIso({ year, month: startMonth!, day: startDay! }),
        endDate: ethiopianToIso({ year, month: endMonth!, day: endDay! }),
        weightPercent: weight,
        // The term containing today is the current one; before Meskerem and
        // after Sene the year has not started, so the first term is marked.
        isCurrent: index === currentTermIndex(year, spans),
      });
      termCount++;
    }

    const gradeIds: { id: string; level: number }[] = [];
    for (let level = config.grades.from; level <= config.grades.to; level++) {
      const [grade] = await db
        .insert(gradeLevels)
        .values({ schoolId, name: `Grade ${level}`, nameAm: `${level}ኛ ክፍል`, level })
        .returning({ id: gradeLevels.id });
      gradeIds.push({ id: grade!.id, level });
    }

    const subjectList =
      config.subjectList ?? (config.grades.to <= 8 ? PRIMARY_SUBJECTS : SECONDARY_SUBJECTS);
    const subjectIds: Record<string, string> = {};
    for (const subject of subjectList) {
      const [created] = await db
        .insert(subjects)
        .values({
          schoolId,
          code: subject.code,
          name: subject.name,
          nameAm: subject.nameAm,
          // Physical education is recorded but does not move an average, which
          // is how the demo seed treats it and what schools expect.
          countsTowardAverage: subject.code !== 'PE',
        })
        .returning({ id: subjects.id });
      subjectIds[subject.code] = created!.id;
    }

    let sectionCount = 0;
    let sectionSubjectCount = 0;
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    for (const grade of gradeIds) {
      for (let index = 0; index < config.sectionsPerGrade; index++) {
        const [section] = await db
          .insert(sections)
          .values({
            schoolId,
            academicYearId: yearId,
            gradeLevelId: grade.id,
            name: letters[index] ?? `Section ${index + 1}`,
            capacity: 45,
            // No class teacher yet: teachers are hired from /staff/new.
            classTeacherId: null,
          })
          .returning({ id: sections.id });
        sectionCount++;

        // A custom subject list is applied to every section as given; the
        // built-in primary list drops the subjects the youngest classes do not
        // take, so no class starts with empty columns it will never fill.
        const codes =
          config.subjectList === null && grade.level < 5 ? LOWER_PRIMARY_CODES : subjectList.map((s) => s.code);
        for (const code of codes) {
          const subjectId = subjectIds[code];
          if (subjectId === undefined) continue;
          await db.insert(sectionSubjects).values({
            schoolId,
            academicYearId: yearId,
            sectionId: section!.id,
            subjectId,
            teacherId: null,
          });
          sectionSubjectCount++;
        }
      }
    }

    let periodCount = 0;
    let teachingPeriod = 0;
    for (const slot of SCHOOL_DAY) {
      teachingPeriod += slot.breakPeriod ? 0 : 1;
      await db.insert(periods).values({
        schoolId,
        sequence: periodCount + 1,
        name: slot.breakPeriod
          ? slot.start === '09:30'
            ? 'Break'
            : 'Lunch'
          : `Period ${teachingPeriod}`,
        startTime: slot.start,
        endTime: slot.end,
        isBreak: slot.breakPeriod,
      });
      periodCount++;
    }

    const passwordHash = await hashPassword(config.admin.password);
    const [admin] = await db
      .insert(users)
      .values({
        schoolId,
        username: config.admin.username,
        email: config.admin.email,
        passwordHash,
        givenName: config.admin.givenName,
        fatherName: config.admin.fatherName,
        isPlatformAdmin: false,
      })
      .returning({ id: users.id });

    const ownerRoleId = roleIds['owner'];
    if (ownerRoleId === undefined) {
      throw new BootstrapConfigError('The owner role template is missing; the administrator would have no permissions.');
    }
    await db.insert(userRoles).values({ userId: admin!.id, roleId: ownerRoleId });

    // A staff record too, so the administrator appears in HR and can be given a
    // contract, salary and leave like anyone else.
    await db.insert(staff).values({
      schoolId,
      userId: admin!.id,
      staffCode: 'STF-001',
      staffType: 'admin',
      jobTitle: 'Administrator',
      status: 'active',
    });

    return {
      schoolId,
      schoolCode: config.school.code,
      username: config.admin.username,
      password: config.admin.password,
      generated: config.admin.generated,
      counts: {
        roles: Object.keys(roleIds).length,
        terms: termCount,
        gradeLevels: gradeIds.length,
        sections: sectionCount,
        subjects: subjectList.length,
        sectionSubjects: sectionSubjectCount,
        periods: periodCount,
      },
    };
  } catch (error) {
    await db.delete(schools).where(eq(schools.id, schoolId)).catch(() => {
      /* the original error is the useful one; never mask it */
    });
    throw error;
  }
}

/**
 * Which term contains today, or 0 when today is outside the school year.
 *
 * Marking the current term matters: the gradebook and attendance default to it,
 * and a year with no current term presents as one that has not started.
 */
function currentTermIndex(
  year: number,
  spans: { span: [number, number, number, number]; weight: number }[],
): number {
  const today = gregorianToEthiopian({
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    day: new Date().getDate(),
  });
  if (today.year !== year) return 0;
  for (let index = 0; index < spans.length; index++) {
    const [startMonth, startDay, endMonth, endDay] = spans[index]!.span;
    const start = ethiopianToIso({ year, month: startMonth!, day: startDay! });
    const end = ethiopianToIso({ year, month: endMonth!, day: endDay! });
    const iso = ethiopianToIso(today);
    if (iso >= start && iso <= end) return index;
  }
  return 0;
}

/** The operator-facing summary, kept separate so it can be tested. */
export function formatSummary(result: BootstrapResult, schoolName: string): string {
  const lines = [
    '',
    `School created: ${schoolName} (${result.schoolCode})`,
    `  roles ${result.counts.roles} · academic year terms ${result.counts.terms} · ` +
      `grades ${result.counts.gradeLevels} · sections ${result.counts.sections}`,
    `  subjects ${result.counts.subjects} · section-subjects ${result.counts.sectionSubjects} · ` +
      `periods ${result.counts.periods}`,
    '',
    'Sign in with:',
    `  School code  ${result.schoolCode}`,
    `  Username     ${result.username}`,
    `  Password     ${result.password}`,
    '',
  ];
  if (result.generated) {
    lines.push(
      'This password was generated and is shown once. Store it now: there is no',
      'password-change screen yet, so replacing it means editing the database.',
      '',
    );
  } else {
    lines.push(
      'A supplied password was used. It is now visible in this shell history and',
      'in the deployment log; consider rotating it in the database.',
      '',
    );
  }
  lines.push(
    'Next: add staff at /staff/new, then students at /students/new or by',
    'spreadsheet import at /students/import. Teachers can be assigned to',
    'sections and subjects from the staff and gradebook screens.',
    '',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const config = parseBootstrapConfig();
  const db = await getDb();
  try {
    await assertDatabaseUninitialised(db);
    const result = await bootstrapSchool(db, config);
    process.stdout.write(formatSummary(result, config.school.name));
  } finally {
    await closeDb();
  }
}

// Same guard migrate.ts uses, so importing this module in a test does not run it.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(
        `\nBootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
