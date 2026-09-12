/**
 * Tests for the first-run bootstrap — `npm run db:bootstrap`.
 *
 * ## Why this exists
 *
 * A migrated production database is empty and nothing in the application can
 * fill it: there is no sign-up route, no school-creation endpoint, no screen
 * for an academic year and no password-change form. Before the bootstrap
 * script, the only way into a fresh deployment was `npm run db:seed`, whose
 * administrator password (`Demo@2018`) is published in this repository and
 * cannot be changed from the UI afterwards.
 *
 * So the thing under test is not a convenience wrapper. If it produces a
 * school an administrator cannot sign in to, or one with no academic year,
 * terms, sections or subjects, the deployment is unusable and there is no
 * screen anywhere to fix it.
 *
 * Two levels are covered: configuration parsing and refusal (pure, no
 * database), and the created structure itself, ending in a real `login()`
 * against the rows the bootstrap wrote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';

import {
  ADMIN_PASSWORD_POLICY,
  BootstrapConfigError,
  PRIMARY_SUBJECTS,
  PUBLISHED_DEMO_PASSWORD,
  SECONDARY_SUBJECTS,
  assertDatabaseUninitialised,
  bootstrapSchool,
  defaultAcademicYear,
  formatSummary,
  parseBootstrapConfig,
  parseSubjectList,
} from '../scripts/bootstrap.ts';
import { closeDb, getDb, type Database } from '../src/db/client.ts';
import { SETTINGS_KEYS } from '../src/lib/settings/schemas.ts';
import { login } from '../src/lib/auth/login.ts';
import { DEFAULT_PASSWORD_POLICY, checkPasswordStrength, verifyPassword } from '../src/lib/auth/password.ts';
import {
  academicYears,
  gradeLevels,
  periods,
  rolePermissions,
  roles,
  schoolSettings,
  schools,
  sectionSubjects,
  sections,
  subjects,
  terms,
  userRoles,
  users,
} from '../src/db/schema/core.ts';

/** The minimum a real operator has to supply. */
const BASE_ENV = {
  BOOTSTRAP_SCHOOL_CODE: 'GMS',
  BOOTSTRAP_SCHOOL_NAME: 'Ghion Middle School',
  BOOTSTRAP_ADMIN_USERNAME: 'Admin',
  BOOTSTRAP_ADMIN_GIVEN_NAME: 'Almaz',
};

/** `count(*)::int` comes back as a single row; this reads it safely. */
function countOf(rows: { n: number }[]): number {
  return rows[0]?.n ?? 0;
}

async function countRowsFor(
  db: Database,
  table: typeof schoolSettings | typeof periods | typeof sectionSubjects,
  schoolId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.schoolId, schoolId));
  return countOf(rows);
}

// ---------------------------------------------------------------------------
// Required configuration
// ---------------------------------------------------------------------------

test('the four required variables are enough', () => {
  const config = parseBootstrapConfig(BASE_ENV);
  assert.equal(config.school.name, 'Ghion Middle School');
  assert.equal(config.admin.givenName, 'Almaz');
  assert.equal(config.admin.generated, true, 'no password supplied means one is generated');
  // Optional fields are null, never undefined: the columns are nullable and a
  // `null` that arrives as `undefined` silently escapes a `=== null` check.
  assert.deepEqual(config.school, { code: 'gms', name: 'Ghion Middle School', nameAm: null });
  assert.equal(config.admin.fatherName, null);
  assert.equal(config.admin.email, null);
});

test('each missing required variable is named in the error', () => {
  for (const key of Object.keys(BASE_ENV)) {
    const env = { ...BASE_ENV } as Record<string, string>;
    delete env[key];
    assert.throws(
      () => parseBootstrapConfig(env),
      (error: unknown) => {
        assert.ok(error instanceof BootstrapConfigError);
        assert.match(error.message, new RegExp(key), `the error must name ${key}`);
        return true;
      },
      `omitting ${key} must be reported`,
    );
  }
});

test('the school code and username are stored lowercased', () => {
  // Sign-in lowercases both before comparing, so a code saved with capitals
  // could never be matched and the school would be permanently unreachable.
  const config = parseBootstrapConfig(BASE_ENV);
  assert.equal(config.school.code, 'gms');
  assert.equal(config.admin.username, 'admin');
});

test('a school code that cannot be typed at sign-in is rejected', () => {
  for (const code of ['ghion school', 'gms!', '']) {
    assert.throws(
      () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_SCHOOL_CODE: code }),
      BootstrapConfigError,
      `"${code}" must be rejected`,
    );
  }
});

test('an unknown preset is rejected and the real presets are offered', () => {
  assert.throws(
    () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_PRESET: 'montessori' }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapConfigError);
      assert.match(error.message, /threeTermPrimary/);
      assert.match(error.message, /twoSemesterSecondary/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The shape of the school
// ---------------------------------------------------------------------------

test('the grade range defaults follow the preset', () => {
  assert.deepEqual(parseBootstrapConfig(BASE_ENV).grades, { from: 1, to: 8 });
  assert.deepEqual(
    parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_PRESET: 'twoSemesterSecondary' }).grades,
    { from: 9, to: 12 },
  );
  assert.deepEqual(
    parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_PRESET: 'kindergarten' }).grades,
    { from: 1, to: 3 },
  );
});

test('an explicit grade range is honoured, and a nonsense one is rejected', () => {
  assert.deepEqual(parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_GRADES: '9-12' }).grades, {
    from: 9,
    to: 12,
  });
  assert.deepEqual(parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_GRADES: '7' }).grades, {
    from: 7,
    to: 7,
  });
  for (const raw of ['9-3', '0-5', '1-13', 'one-eight']) {
    assert.throws(
      () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_GRADES: raw }),
      BootstrapConfigError,
      `"${raw}" must be rejected`,
    );
  }
});

test('the built-in subject lists are the primary and secondary ones', () => {
  assert.equal(
    parseBootstrapConfig(BASE_ENV).subjectList,
    null,
    'null means "use the built-in list for this grade range"',
  );
  assert.ok(PRIMARY_SUBJECTS.some((subject) => subject.code === 'AMH'));
  assert.ok(SECONDARY_SUBJECTS.some((subject) => subject.code === 'PHY'));
  assert.ok(
    !PRIMARY_SUBJECTS.some((subject) => subject.code === 'CHEM'),
    'chemistry is not a primary subject',
  );
});

test('a supplied subject list is parsed, normalised and deduplicated', () => {
  const list = parseSubjectList('math:Mathematics:ሒሳብ, AFA:Afaan Oromo');
  assert.deepEqual(list, [
    { code: 'MATH', name: 'Mathematics', nameAm: 'ሒሳብ' },
    { code: 'AFA', name: 'Afaan Oromo', nameAm: null },
  ]);

  assert.throws(() => parseSubjectList('MATH'), BootstrapConfigError, 'a code alone is not a subject');
  assert.throws(() => parseSubjectList('MATH:Mathematics,MATH:Maths'), /twice/);
  assert.throws(() => parseSubjectList('MA TH:Mathematics'), BootstrapConfigError, 'codes hold no spaces');
  assert.throws(() => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_SUBJECTS: 'MATH' }), BootstrapConfigError);
});

test('sections per grade is bounded', () => {
  assert.equal(parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_SECTIONS_PER_GRADE: '3' }).sectionsPerGrade, 3);
  for (const raw of ['0', '11', 'two', '1.5']) {
    assert.throws(
      () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_SECTIONS_PER_GRADE: raw }),
      BootstrapConfigError,
      `"${raw}" must be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// The academic year: Ethiopian, not Gregorian
// ---------------------------------------------------------------------------

test('the default year is the one in progress, and the next one during the break', () => {
  // Megabit 2018 — March 2026, inside the school year.
  assert.equal(defaultAcademicYear(new Date(2026, 2, 20)), 2018);
  // Hamle 2018 — July 2026, the long break: a school setting up now is
  // preparing for the year that starts in Meskerem.
  assert.equal(defaultAcademicYear(new Date(2026, 6, 20)), 2019);
  // Meskerem 2019 — September 2026, the new year has begun.
  assert.equal(defaultAcademicYear(new Date(2026, 8, 12)), 2019);
});

test('a Gregorian year is rejected rather than creating a school year in 2033', () => {
  // The tempting mistake: the operator types the year they see on the wall.
  // An Ethiopian year runs seven or eight behind, so 2026 E.C. would start in
  // September 2033 — a school nobody would notice was empty for seven years.
  const gregorian = String(new Date().getFullYear());
  assert.throws(
    () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_ACADEMIC_YEAR: gregorian }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapConfigError);
      assert.match(error.message, /Gregorian/);
      assert.match(error.message, new RegExp(gregorian));
      return true;
    },
  );
});

test('a nearby Ethiopian year is accepted, so next year can be prepared', () => {
  const expected = defaultAcademicYear();
  assert.equal(
    parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_ACADEMIC_YEAR: String(expected + 1) }).academicYear,
    expected + 1,
  );
  assert.throws(
    () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_ACADEMIC_YEAR: String(expected + 9) }),
    BootstrapConfigError,
  );
});

// ---------------------------------------------------------------------------
// The administrator's password
// ---------------------------------------------------------------------------

test('the published demo password is refused outright', () => {
  // Not a warning: accepting it would put a credential from this repository's
  // README on the account that can read every student's record.
  assert.throws(
    () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_ADMIN_PASSWORD: PUBLISHED_DEMO_PASSWORD }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapConfigError);
      assert.match(error.message, /published in this/);
      return true;
    },
  );
});

test('a weak password is refused with the reasons', () => {
  assert.throws(
    () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_ADMIN_PASSWORD: 'school1' }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapConfigError);
      assert.match(error.message, /at least 12 characters/);
      assert.match(error.message, /uppercase and lowercase/);
      return true;
    },
  );
});

test('the bootstrap policy is stricter than the sign-in policy', () => {
  // Justified by there being no password-change screen: what is set here may be
  // this administrator's password for a long time.
  assert.ok(ADMIN_PASSWORD_POLICY.minLength > DEFAULT_PASSWORD_POLICY.minLength);
  assert.equal(ADMIN_PASSWORD_POLICY.requireMixedCase, true);
});

test('a supplied password that meets the policy is used unchanged', () => {
  const config = parseBootstrapConfig({
    ...BASE_ENV,
    BOOTSTRAP_ADMIN_PASSWORD: 'Str0ngPassw0rdXyz',
  });
  assert.equal(config.admin.password, 'Str0ngPassw0rdXyz');
  assert.equal(config.admin.generated, false);
});

test('an omitted password is generated strong enough to satisfy the policy', () => {
  const config = parseBootstrapConfig(BASE_ENV);
  assert.equal(config.admin.generated, true);
  assert.ok(config.admin.password.length >= 16);
  assert.deepEqual(checkPasswordStrength(config.admin.password, ADMIN_PASSWORD_POLICY), { ok: true });
  assert.notEqual(config.admin.password, PUBLISHED_DEMO_PASSWORD);
});

test('a malformed administrator email is rejected', () => {
  assert.throws(
    () => parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_ADMIN_EMAIL: 'admin@ghion' }),
    BootstrapConfigError,
  );
  assert.equal(
    parseBootstrapConfig({ ...BASE_ENV, BOOTSTRAP_ADMIN_EMAIL: 'admin@ghion.edu.et' }).admin.email,
    'admin@ghion.edu.et',
  );
});

// ---------------------------------------------------------------------------
// What the operator is told
// ---------------------------------------------------------------------------

test('the summary prints the credentials once and says where to go next', () => {
  const summary = formatSummary(
    {
      schoolId: 'x',
      schoolCode: 'gms',
      username: 'admin',
      password: 'Abcdefgh12345678',
      generated: true,
      counts: { roles: 17, terms: 3, gradeLevels: 8, sections: 8, subjects: 8, sectionSubjects: 56, periods: 9 },
    },
    'Ghion Middle School',
  );
  assert.match(summary, /gms/);
  assert.match(summary, /admin/);
  assert.match(summary, /Abcdefgh12345678/, 'the generated password is shown once, here');
  assert.match(summary, /shown once/i);
  assert.match(summary, /\/staff\/new/);
});

test('the summary warns when a password was supplied on the command line', () => {
  const summary = formatSummary(
    {
      schoolId: 'x',
      schoolCode: 'gms',
      username: 'admin',
      password: 'Str0ngPassw0rdXyz',
      generated: false,
      counts: { roles: 1, terms: 1, gradeLevels: 1, sections: 1, subjects: 1, sectionSubjects: 1, periods: 1 },
    },
    'Ghion Middle School',
  );
  // It is in the shell history and in the deployment log; say so.
  assert.match(summary, /shell history/i);
});

// ---------------------------------------------------------------------------
// The created school, ending in a real sign-in
// ---------------------------------------------------------------------------

test('a database that already has users is refused', async () => {
  const db = await getDb();
  try {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    const existing = row?.n ?? 0;
    if (existing === 0) {
      await assertDatabaseUninitialised(db);
      return;
    }
    await assert.rejects(
      () => assertDatabaseUninitialised(db),
      (error: unknown) => {
        assert.ok(error instanceof BootstrapConfigError);
        // The message must point somewhere useful, not just say no.
        assert.match(error.message, /\/staff\/new/);
        return true;
      },
    );
  } finally {
    await closeDb();
  }
});

test('the bootstrap creates a school an administrator can sign in to', async () => {
  const db = await getDb();
  const code = `bst${Date.now().toString().slice(-8)}`;
  const password = 'Str0ngPassw0rdXyz';
  const config = parseBootstrapConfig({
    BOOTSTRAP_SCHOOL_CODE: code,
    BOOTSTRAP_SCHOOL_NAME: 'Bootstrap Test School',
    BOOTSTRAP_ADMIN_USERNAME: 'admin',
    BOOTSTRAP_ADMIN_GIVEN_NAME: 'Almaz',
    BOOTSTRAP_ADMIN_FATHER_NAME: 'Tessema',
    BOOTSTRAP_ADMIN_PASSWORD: password,
    BOOTSTRAP_SECTIONS_PER_GRADE: '2',
  });

  let schoolId: string | undefined;
  try {
    const result = await bootstrapSchool(db, config);
    schoolId = result.schoolId;

    // The structure attendance, the gradebook and report cards are keyed on.
    assert.equal(result.counts.roles, 17, 'every role template');
    assert.equal(result.counts.terms, 3);
    assert.equal(result.counts.gradeLevels, 8);
    assert.equal(result.counts.sections, 16, 'two sections per grade');
    assert.equal(result.counts.subjects, PRIMARY_SUBJECTS.length);
    assert.equal(result.counts.periods, 9);
    assert.ok(result.counts.sectionSubjects > 0);

    assert.equal(
      await countRowsFor(db, schoolSettings, schoolId),
      SETTINGS_KEYS.length,
      'every setting key initialised',
    );

    // Exactly one current year and one current term, or the gradebook opens on
    // a year that has not started.
    const currentYears = await db
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(eq(academicYears.schoolId, schoolId));
    assert.equal(currentYears.length, 1);

    const [admin] = await db
      .select({ id: users.id, passwordHash: users.passwordHash, username: users.username })
      .from(users)
      .where(eq(users.schoolId, schoolId));
    assert.ok(admin);
    assert.equal(admin.username, 'admin');
    assert.equal(await verifyPassword(password, admin.passwordHash), true, 'the hash matches');

    // The account is useless without the owner role's permissions.
    const ownedRoles = await db
      .select({ key: roles.key })
      .from(roles)
      .innerJoin(userRoles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, admin.id));
    assert.deepEqual(
      ownedRoles.map((role) => role.key),
      ['owner'],
    );
    const [ownerRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'owner'));
    const permissions = await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, ownerRole!.id));
    assert.ok(permissions.length > 0, 'the owner role carries permissions');

    // The point of the whole exercise: this account can actually sign in.
    const good = await login(db, { schoolCode: code, username: 'admin', password });
    assert.equal(good.ok, true, `sign-in failed: ${good.ok ? '' : good.reason}`);

    const wrong = await login(db, { schoolCode: code, username: 'admin', password: 'wrong-password' });
    assert.equal(wrong.ok, false);

    // A second school cannot take the same code: sign-in selects by code.
    await assert.rejects(
      () => bootstrapSchool(db, { ...config, admin: { ...config.admin, password } }),
      /already exists/,
    );
  } finally {
    if (schoolId !== undefined) {
      // Every child table cascades from the school row.
      await db.delete(schools).where(eq(schools.id, schoolId));
    }
    await closeDb();
  }
});

test('a school created for a secondary preset gets semesters and secondary subjects', async () => {
  const db = await getDb();
  const code = `bst2${Date.now().toString().slice(-7)}`;
  const config = parseBootstrapConfig({
    BOOTSTRAP_SCHOOL_CODE: code,
    BOOTSTRAP_SCHOOL_NAME: 'Bootstrap Preparatory',
    BOOTSTRAP_PRESET: 'twoSemesterSecondary',
    BOOTSTRAP_ADMIN_USERNAME: 'principal',
    BOOTSTRAP_ADMIN_GIVEN_NAME: 'Hirut',
  });

  let schoolId: string | undefined;
  try {
    const result = await bootstrapSchool(db, config);
    schoolId = result.schoolId;

    assert.equal(result.counts.terms, 2);
    assert.equal(result.counts.gradeLevels, 4, 'grades 9 to 12');
    assert.equal(result.counts.subjects, SECONDARY_SUBJECTS.length);

    const kinds = await db
      .select({ kind: terms.kind })
      .from(terms)
      .where(eq(terms.schoolId, schoolId));
    assert.deepEqual(
      kinds.map((term) => term.kind),
      ['semester', 'semester'],
    );

    const levels = await db
      .select({ level: gradeLevels.level })
      .from(gradeLevels)
      .where(eq(gradeLevels.schoolId, schoolId));
    assert.deepEqual(
      levels.map((grade) => grade.level).sort((a, b) => a - b),
      [9, 10, 11, 12],
    );
  } finally {
    if (schoolId !== undefined) await db.delete(schools).where(eq(schools.id, schoolId));
    await closeDb();
  }
});

test('a custom subject list reaches every section, including the youngest', async () => {
  const db = await getDb();
  const code = `bst3${Date.now().toString().slice(-7)}`;
  const config = parseBootstrapConfig({
    BOOTSTRAP_SCHOOL_CODE: code,
    BOOTSTRAP_SCHOOL_NAME: 'Bootstrap Custom Subjects',
    BOOTSTRAP_ADMIN_USERNAME: 'admin',
    BOOTSTRAP_ADMIN_GIVEN_NAME: 'Almaz',
    BOOTSTRAP_SUBJECTS: 'MATH:Mathematics:ሒሳብ,AFA:Afaan Oromo',
    BOOTSTRAP_GRADES: '1-2',
  });

  let schoolId: string | undefined;
  try {
    const result = await bootstrapSchool(db, config);
    schoolId = result.schoolId;

    assert.equal(result.counts.subjects, 2);
    // A list the operator chose is applied as written: the built-in rule that
    // drops Civics and ICT below Grade 5 must not touch it.
    assert.equal(result.counts.sectionSubjects, result.counts.sections * 2);

    const created = await db
      .select({ code: subjects.code, name: subjects.name, nameAm: subjects.nameAm })
      .from(subjects)
      .where(eq(subjects.schoolId, schoolId));
    created.sort((a, b) => a.code.localeCompare(b.code));
    assert.deepEqual(created, [
      { code: 'AFA', name: 'Afaan Oromo', nameAm: null },
      { code: 'MATH', name: 'Mathematics', nameAm: 'ሒሳብ' },
    ]);

    // Physical education is excluded from averages in the built-in list; a
    // custom list has no such entry, so everything counts.
    const averages = await db
      .select({ counts: subjects.countsTowardAverage })
      .from(subjects)
      .where(eq(subjects.schoolId, schoolId));
    assert.deepEqual(averages.map((subject) => subject.counts), [true, true]);

    // Sections exist for both grades and periods are there for period-mode
    // attendance, even though this school is on daily attendance by default.
    const sectionRows = await db
      .select({ id: sections.id })
      .from(sections)
      .where(eq(sections.schoolId, schoolId));
    assert.equal(sectionRows.length, 2);
    assert.equal(await countRowsFor(db, periods, schoolId), 9);
    assert.ok((await countRowsFor(db, sectionSubjects, schoolId)) > 0);
  } finally {
    if (schoolId !== undefined) await db.delete(schools).where(eq(schools.id, schoolId));
    await closeDb();
  }
});
