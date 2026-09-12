/**
 * Student module tests.
 *
 * Exercises the service layer directly against a real database: creation,
 * validation, per-school uniqueness, relationship-based access and the
 * side effects (enrolment, audit, status history, domain event) that other
 * modules depend on.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, desc, isNull } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import {
  schools,
  users,
  roles,
  rolePermissions,
  userRoles,
  academicYears,
  gradeLevels,
  sections,
  sectionSubjects,
  subjects,
  auditLog,
  domainEvents,
} from '../src/db/schema/core.ts';
import { students, enrollments, guardians, studentGuardians } from '../src/db/schema/people.ts';
import {
  createStudent,
  updateStudent,
  listStudents,
  getStudentProfile,
  generateStudentCode,
} from '../src/lib/students/service.ts';
import { createStudentSchema, normalisePhone } from '../src/lib/students/schema.ts';
import { loadRelationships } from '../src/lib/auth/context.ts';
import { isUniqueViolation } from '../src/db/errors.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionA: string;
  sectionB: string;
  adminUserId: string;
  teacherUserId: string;
};

const A: Fixture = {} as Fixture;
const B: Fixture = {} as Fixture;

/** Minimal context object accepted by the service layer. */
function contextFor(fixture: Fixture, userId: string, permissions: string[]) {
  return {
    db,
    schoolId: fixture.schoolId,
    user: { id: userId, givenName: 'Test', fatherName: 'User' },
    ipAddress: '127.0.0.1',
    has: (p: string) => permissions.includes(p),
    hasAny: (...list: string[]) => list.some((p) => permissions.includes(p)),
    displayName: () => 'Test User',
  } as never;
}

async function seedSchool(code: string, fixture: Fixture) {
  const [school] = await db
    .insert(schools)
    .values({ code, name: `Test ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId: fixture.schoolId,
      name: '2018 E.C.',
      ethiopianYear: 2018,
      startDate: '2025-09-11',
      endDate: '2026-07-07',
      isCurrent: true,
    })
    .returning({ id: academicYears.id });
  fixture.yearId = year!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

  const inserted = await db
    .insert(sections)
    .values([
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        gradeLevelId: fixture.gradeId,
        name: 'A',
      },
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        gradeLevelId: fixture.gradeId,
        name: 'B',
      },
    ])
    .returning({ id: sections.id, name: sections.name });
  fixture.sectionA = inserted.find((s) => s.name === 'A')!.id;
  fixture.sectionB = inserted.find((s) => s.name === 'B')!.id;

  const [admin] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: 'admin',
      passwordHash: 'x',
      givenName: 'Admin',
    })
    .returning({ id: users.id });
  fixture.adminUserId = admin!.id;

  const [teacher] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: 'teacher',
      passwordHash: 'x',
      givenName: 'Teacher',
    })
    .returning({ id: users.id });
  fixture.teacherUserId = teacher!.id;

  // The teacher teaches section A only.
  const [subject] = await db
    .insert(subjects)
    .values({ schoolId: fixture.schoolId, code: 'MATH', name: 'Mathematics' })
    .returning({ id: subjects.id });
  await db.insert(sectionSubjects).values({
    schoolId: fixture.schoolId,
    academicYearId: fixture.yearId,
    sectionId: fixture.sectionA,
    subjectId: subject!.id,
    teacherId: fixture.teacherUserId,
  });
}

before(async () => {
  db = await getDb();
  await seedSchool(`tsa-${Date.now()}`, A);
  await seedSchool(`tsb-${Date.now()}`, B);
});

after(async () => {
  // Remove both test schools; cascades clear all child rows.
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  await closeDb();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a student requires a given name and a father name', () => {
  const result = createStudentSchema.safeParse({
    studentCode: 'X/1',
    givenName: '',
    fatherName: '',
    gradeLevelId: '',
  });
  assert.equal(result.success, false);
  const keys = result.success ? [] : Object.keys(result.error.flatten().fieldErrors);
  assert.ok(keys.includes('givenName'));
  assert.ok(keys.includes('fatherName'));
  assert.ok(keys.includes('gradeLevelId'));
});

test('Ethiopian phone numbers are normalised to +251 form', () => {
  assert.equal(normalisePhone('0912345678'), '+251912345678');
  assert.equal(normalisePhone('251912345678'), '+251912345678');
  assert.equal(normalisePhone('+251912345678'), '+251912345678');
  assert.equal(normalisePhone('0912 345 678'), '+251912345678');
  assert.equal(normalisePhone(''), null);
});

test('a grandfather name is optional — Ethiopian names are not forced into three parts', () => {
  const result = createStudentSchema.safeParse({
    studentCode: 'X/2',
    givenName: 'Sara',
    fatherName: 'Tesfaye',
    gradeLevelId: 'g1',
  });
  assert.equal(result.success, true);
});

// ---------------------------------------------------------------------------
// Creation and side effects
// ---------------------------------------------------------------------------

test('creating a student also writes enrolment, guardian, status history, audit and event', async () => {
  const ctx = contextFor(A, A.adminUserId, ['student.create', 'student.viewSensitive']);
  const input = createStudentSchema.parse({
    studentCode: 'A/0001',
    givenName: 'Hanna',
    fatherName: 'Bekele',
    grandfatherName: 'Tadesse',
    givenNameAm: 'ሐና',
    gender: 'female',
    phone: '0912345678',
    gradeLevelId: A.gradeId,
    sectionId: A.sectionA,
    guardian: { givenName: 'Bekele', phone: '0911223344', relationship: 'father' },
  });

  const result = await createStudent(ctx, input, A.yearId);
  assert.ok(result.id);

  const profile = await getStudentProfile(db, A.schoolId, result.id);
  assert.ok(profile);
  assert.equal(profile.student.givenName, 'Hanna');
  assert.equal(profile.student.givenNameAm, 'ሐና');
  assert.equal(profile.student.phone, '+251912345678', 'phone must be stored normalised');

  // Enrolment created and open.
  const rows = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.studentId, result.id), isNull(enrollments.endedOn)));
  assert.equal(rows.length, 1, 'exactly one open enrolment');
  assert.equal(rows[0]!.sectionId, A.sectionA);

  // Guardian linked, with a normalised phone.
  assert.equal(profile.guardians.length, 1);
  assert.equal(profile.guardians[0]!.phone, '+251911223344');
  assert.equal(profile.guardians[0]!.isPrimary, true);

  // Status history seeded.
  assert.equal(profile.statusHistory.length, 1);
  assert.equal(profile.statusHistory[0]!.toStatus, 'active');

  // Audit entry written.
  const audit = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, result.id), eq(auditLog.action, 'student.create')));
  assert.equal(audit.length, 1, 'creation must be audited');

  // Domain event emitted for other modules.
  const events = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.schoolId, A.schoolId), eq(domainEvents.type, 'student.enrolled')));
  assert.ok(events.length >= 1, 'student.enrolled event must be emitted');
});

test('a student can be registered without a section — mid-year admission', async () => {
  const ctx = contextFor(A, A.adminUserId, ['student.create']);
  const input = createStudentSchema.parse({
    studentCode: 'A/0002',
    givenName: 'Nardos',
    fatherName: 'Girma',
    gradeLevelId: A.gradeId,
  });
  const result = await createStudent(ctx, input, A.yearId);
  const profile = await getStudentProfile(db, A.schoolId, result.id);
  assert.equal(profile!.currentEnrolment?.sectionName, null);
});

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

test('CRITICAL: student codes are unique per school but reusable across schools', async () => {
  const ctxA = contextFor(A, A.adminUserId, ['student.create']);
  const ctxB = contextFor(B, B.adminUserId, ['student.create']);

  const duplicate = createStudentSchema.parse({
    studentCode: 'A/0001', // already used in school A
    givenName: 'Copy',
    fatherName: 'Cat',
    gradeLevelId: A.gradeId,
  });

  await assert.rejects(
    () => createStudent(ctxA, duplicate, A.yearId),
    (error: unknown) => {
      assert.ok(isUniqueViolation(error), 'must be a unique-constraint violation');
      return true;
    },
    'the same code twice in one school must be rejected',
  );

  // The identical code in a different school is fine.
  const other = createStudentSchema.parse({
    studentCode: 'A/0001',
    givenName: 'Meron',
    fatherName: 'Alemu',
    gradeLevelId: B.gradeId,
  });
  const created = await createStudent(ctxB, other, B.yearId);
  assert.ok(created.id, 'the same code must be allowed in another school');
});

test('generated student codes do not collide', async () => {
  const first = await generateStudentCode(db, A.schoolId, 2018);
  const ctx = contextFor(A, A.adminUserId, ['student.create']);
  await createStudent(
    ctx,
    createStudentSchema.parse({
      studentCode: first,
      givenName: 'Seq',
      fatherName: 'One',
      gradeLevelId: A.gradeId,
    }),
    A.yearId,
  );
  const second = await generateStudentCode(db, A.schoolId, 2018);
  assert.notEqual(first, second, 'the next generated code must skip the taken one');
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('CRITICAL: a teacher restricted to their sections sees only those students', async () => {
  const ctx = contextFor(A, A.adminUserId, ['student.create']);

  // One student in the teacher's section, one in a section they do not teach.
  await createStudent(
    ctx,
    createStudentSchema.parse({
      studentCode: 'A/1001',
      givenName: 'InSection',
      fatherName: 'A',
      gradeLevelId: A.gradeId,
      sectionId: A.sectionA,
    }),
    A.yearId,
  );
  await createStudent(
    ctx,
    createStudentSchema.parse({
      studentCode: 'A/1002',
      givenName: 'OutOfSection',
      fatherName: 'B',
      gradeLevelId: A.gradeId,
      sectionId: A.sectionB,
    }),
    A.yearId,
  );

  const relationships = await loadRelationships(db, A.schoolId, A.teacherUserId);
  assert.deepEqual(relationships.sectionIds, [A.sectionA], 'teacher teaches section A only');

  const scoped = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 50, sort: 'name' } as never,
    { restrictToSectionIds: relationships.sectionIds, academicYearId: A.yearId },
  );
  const names = scoped.rows.map((r) => r.givenName);
  assert.ok(names.includes('InSection'));
  assert.ok(!names.includes('OutOfSection'), 'must not see students from other sections');
});

test('CRITICAL: passing a foreign sectionId cannot widen a restricted teacher\u2019s scope', async () => {
  const relationships = await loadRelationships(db, A.schoolId, A.teacherUserId);

  // Simulate ?sectionId=<a section they do not teach>.
  const result = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 50, sort: 'name', sectionId: A.sectionB } as never,
    { restrictToSectionIds: relationships.sectionIds, academicYearId: A.yearId },
  );
  assert.equal(result.total, 0, 'the restriction must be applied on top of the filter');
});

test('CRITICAL: a teacher with no assigned sections sees nobody, not everybody', async () => {
  const result = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 50, sort: 'name' } as never,
    { restrictToSectionIds: [], academicYearId: A.yearId },
  );
  assert.equal(result.total, 0, 'an empty section list must mean zero students, never all');
});

test('CRITICAL: a student from another school is never returned', async () => {
  const listA = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 100, sort: 'name' } as never,
    { academicYearId: A.yearId },
  );
  const foreign = await db.select().from(students).where(eq(students.schoolId, B.schoolId));
  const foreignIds = new Set(foreign.map((s) => s.id));
  for (const row of listA.rows) {
    assert.ok(!foreignIds.has(row.id), 'school A list must not contain a school B student');
  }

  // And a direct fetch scoped to the wrong school finds nothing.
  const profile = await getStudentProfile(db, A.schoolId, foreign[0]!.id);
  assert.equal(profile, null, 'fetching another school\u2019s student must return null');
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

test('updating a student records a diff-based audit entry', async () => {
  const ctx = contextFor(A, A.adminUserId, ['student.create', 'student.edit']);
  const created = await createStudent(
    ctx,
    createStudentSchema.parse({
      studentCode: 'A/2001',
      givenName: 'Before',
      fatherName: 'Name',
      gradeLevelId: A.gradeId,
    }),
    A.yearId,
  );

  await updateStudent(ctx, created.id, { givenName: 'After' } as never);

  const profile = await getStudentProfile(db, A.schoolId, created.id);
  assert.equal(profile!.student.givenName, 'After');

  const [entry] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, created.id), eq(auditLog.action, 'student.update')))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  assert.ok(entry, 'an update must be audited');
  const previous = entry!.previousValue as Record<string, unknown>;
  const next = entry!.newValue as Record<string, unknown>;
  assert.equal(previous.givenName, 'Before');
  assert.equal(next.givenName, 'After');
  assert.ok(
    !('fatherName' in next),
    'the audit diff must record only changed fields, not the whole row',
  );
});

test('changing status writes a history row and emits an event', async () => {
  const ctx = contextFor(A, A.adminUserId, ['student.create', 'student.edit']);
  const created = await createStudent(
    ctx,
    createStudentSchema.parse({
      studentCode: 'A/2002',
      givenName: 'Leaving',
      fatherName: 'Student',
      gradeLevelId: A.gradeId,
    }),
    A.yearId,
  );

  await updateStudent(ctx, created.id, {
    status: 'transferred',
    statusReason: 'Family relocated to Bahir Dar',
  } as never);

  const profile = await getStudentProfile(db, A.schoolId, created.id);
  assert.equal(profile!.student.status, 'transferred');
  assert.equal(profile!.statusHistory.length, 2, 'initial status plus the change');

  const latest = profile!.statusHistory[0]!;
  assert.equal(latest.toStatus, 'transferred');
  assert.equal(latest.reason, 'Family relocated to Bahir Dar');

  const events = await db
    .select()
    .from(domainEvents)
    .where(
      and(eq(domainEvents.schoolId, A.schoolId), eq(domainEvents.type, 'student.statusChanged')),
    );
  assert.ok(events.length >= 1, 'a status change must emit student.statusChanged');
});

// ---------------------------------------------------------------------------
// Listing behaviour
// ---------------------------------------------------------------------------

test('search matches Ethiopian names and student codes, including Amharic', async () => {
  const byName = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 20, sort: 'name', search: 'Hanna' } as never,
    { academicYearId: A.yearId },
  );
  assert.ok(byName.total >= 1, 'search by given name must find the student');

  const byAmharic = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 20, sort: 'name', search: 'ሐና' } as never,
    { academicYearId: A.yearId },
  );
  assert.ok(byAmharic.total >= 1, 'search must work in Amharic');

  const byCode = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 20, sort: 'name', search: 'A/0001' } as never,
    { academicYearId: A.yearId },
  );
  assert.ok(byCode.total >= 1, 'search by student code must work');
});

test('pagination never returns more than the requested page size', async () => {
  const page = await listStudents(
    db,
    A.schoolId,
    { page: 1, pageSize: 2, sort: 'name' } as never,
    { academicYearId: A.yearId },
  );
  assert.ok(page.rows.length <= 2);
  assert.ok(page.total >= page.rows.length, 'total counts all matches, not just this page');
});
