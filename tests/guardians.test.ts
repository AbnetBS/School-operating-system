/**
 * Guardian module tests.
 *
 * The guardian link is the parent-portal authorization boundary: a parent may
 * only see the students they are linked to. So these tests care less about
 * CRUD mechanics and more about the link — that it cannot cross schools, that
 * exactly one primary contact survives, and that unlinking removes access
 * without destroying the person's record.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';

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
import {
  createGuardian,
  updateGuardian,
  listGuardians,
  getGuardianProfile,
  findGuardianByPhone,
  linkGuardianToStudent,
  unlinkGuardian,
  updateGuardianLink,
} from '../src/lib/guardians/service.ts';
import { createGuardianSchema } from '../src/lib/guardians/schema.ts';
import { createStudent } from '../src/lib/students/service.ts';
import { createStudentSchema } from '../src/lib/students/schema.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionA: string;
  adminUserId: string;
};

const A: Fixture = {} as Fixture;
const B: Fixture = {} as Fixture;

const ALL = [
  'guardian.view',
  'guardian.manage',
  'student.view',
  'student.create',
  'student.edit',
];

function contextFor(fixture: Fixture, userId: string, permissions: string[] = ALL) {
  return {
    db,
    schoolId: fixture.schoolId,
    user: { userId, givenName: 'Test', fatherName: 'User' },
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

  const [section] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: 'A',
    })
    .returning({ id: sections.id });
  fixture.sectionA = section!.id;

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
}

async function makeStudent(fixture: Fixture, code: string, givenName = 'Abebe') {
  const ctx = contextFor(fixture, fixture.adminUserId);
  const input = createStudentSchema.parse({
    studentCode: code,
    givenName,
    fatherName: 'Kebede',
    gradeLevelId: fixture.gradeId,
    sectionId: fixture.sectionA,
  });
  return createStudent(ctx, input, fixture.yearId);
}

before(async () => {
  db = await getDb();
  await seedSchool(`tga-${Date.now()}`, A);
  await seedSchool(`tgb-${Date.now()}`, B);
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  await closeDb();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a guardian requires a given name', () => {
  const result = createGuardianSchema.safeParse({ givenName: '' });
  assert.equal(result.success, false);
  const keys = result.success ? [] : Object.keys(result.error.flatten().fieldErrors);
  assert.ok(keys.includes('givenName'));
});

test('a guardian does not require a father name, because many are recorded by one name', () => {
  const result = createGuardianSchema.safeParse({ givenName: 'Almaz' });
  assert.equal(result.success, true);
});

test('an invalid phone number is rejected', () => {
  const result = createGuardianSchema.safeParse({ givenName: 'Almaz', phone: '12345' });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Creation and linking
// ---------------------------------------------------------------------------

test('creating a guardian with a student links them in one step', async () => {
  const student = await makeStudent(A, 'G/001');
  const ctx = contextFor(A, A.adminUserId);

  const { id } = await createGuardian(
    ctx,
    createGuardianSchema.parse({
      givenName: 'Kebede',
      fatherName: 'Tesfaye',
      phone: '0911000001',
      studentId: student.id,
      relationship: 'father',
      isPrimary: true,
    }),
  );

  const profile = await getGuardianProfile(db, A.schoolId, id);
  assert.ok(profile);
  assert.equal(profile.guardian.phone, '+251911000001', 'phone should be normalised');
  assert.equal(profile.children.length, 1);
  assert.equal(profile.children[0]!.studentId, student.id);
});

test('one guardian record is shared across siblings rather than duplicated', async () => {
  const first = await makeStudent(A, 'G/010', 'Sara');
  const second = await makeStudent(A, 'G/011', 'Selam');
  const ctx = contextFor(A, A.adminUserId);

  const { id } = await createGuardian(
    ctx,
    createGuardianSchema.parse({
      givenName: 'Tigist',
      phone: '0911000010',
      studentId: first.id,
      relationship: 'mother',
    }),
  );

  await linkGuardianToStudent(
    ctx,
    { guardianId: id, studentId: second.id, relationship: 'mother', isPrimary: false, canPickUp: true, receivesFeeNotices: true },
  );

  const profile = await getGuardianProfile(db, A.schoolId, id);
  assert.equal(profile!.children.length, 2, 'both siblings share one guardian row');

  const all = await db
    .select({ id: guardians.id })
    .from(guardians)
    .where(and(eq(guardians.schoolId, A.schoolId), eq(guardians.phone, '+251911000010')));
  assert.equal(all.length, 1, 'no duplicate guardian was created');
});

test('findGuardianByPhone powers the "may already exist" prompt', async () => {
  const match = await findGuardianByPhone(db, A.schoolId, '0911000010');
  assert.ok(match, 'an existing guardian is found by an unnormalised phone number');
  assert.equal(match!.givenName, 'Tigist');

  const miss = await findGuardianByPhone(db, A.schoolId, '0911999999');
  assert.equal(miss, null);
});

test('a guardian in another school is not found by phone', async () => {
  // Same number, different school.
  const match = await findGuardianByPhone(db, B.schoolId, '0911000010');
  assert.equal(match, null, 'phone lookup must not cross the school boundary');
});

// ---------------------------------------------------------------------------
// Primary contact
// ---------------------------------------------------------------------------

test('marking a guardian primary demotes the previous primary for that student', async () => {
  const student = await makeStudent(A, 'G/020', 'Hanna');
  const ctx = contextFor(A, A.adminUserId);

  const father = await createGuardian(
    ctx,
    createGuardianSchema.parse({
      givenName: 'Getachew',
      phone: '0911000020',
      studentId: student.id,
      relationship: 'father',
      isPrimary: true,
    }),
  );

  const mother = await createGuardian(
    ctx,
    createGuardianSchema.parse({
      givenName: 'Meseret',
      phone: '0911000021',
      studentId: student.id,
      relationship: 'mother',
      isPrimary: true,
    }),
  );

  const links = await db
    .select({ guardianId: studentGuardians.guardianId, isPrimary: studentGuardians.isPrimary })
    .from(studentGuardians)
    .where(
      and(
        eq(studentGuardians.schoolId, A.schoolId),
        eq(studentGuardians.studentId, student.id),
      ),
    );

  const primaries = links.filter((l) => l.isPrimary);
  assert.equal(primaries.length, 1, 'exactly one primary contact per student');
  assert.equal(primaries[0]!.guardianId, mother.id, 'the newest primary wins');
  assert.ok(links.some((l) => l.guardianId === father.id && !l.isPrimary));
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation
// ---------------------------------------------------------------------------

test('a guardian cannot be linked to a student in another school', async () => {
  const foreignStudent = await makeStudent(B, 'G/030', 'Bereket');
  const ctx = contextFor(A, A.adminUserId);

  const { id } = await createGuardian(
    ctx,
    createGuardianSchema.parse({ givenName: 'Yohannes', phone: '0911000030' }),
  );

  await assert.rejects(
    () =>
      linkGuardianToStudent(ctx, {
        guardianId: id,
        studentId: foreignStudent.id,
        relationship: 'father',
        isPrimary: false,
        canPickUp: true,
        receivesFeeNotices: true,
      }),
    /does not exist at this school/,
    'linking across schools must be refused',
  );

  const links = await db
    .select({ studentId: studentGuardians.studentId })
    .from(studentGuardians)
    .where(eq(studentGuardians.guardianId, id));
  assert.equal(links.length, 0, 'no link row was written');
});

test('creating a guardian against another school\u2019s student is refused', async () => {
  const foreignStudent = await makeStudent(B, 'G/031', 'Meron');
  const ctx = contextFor(A, A.adminUserId);

  await assert.rejects(
    () =>
      createGuardian(
        ctx,
        createGuardianSchema.parse({
          givenName: 'Alemu',
          phone: '0911000031',
          studentId: foreignStudent.id,
        }),
      ),
    /does not exist at this school/,
  );
});

test('a guardian from another school is invisible to getGuardianProfile', async () => {
  const ctxB = contextFor(B, B.adminUserId);
  const { id } = await createGuardian(
    ctxB,
    createGuardianSchema.parse({ givenName: 'Foreign', phone: '0911000040' }),
  );

  const seenFromA = await getGuardianProfile(db, A.schoolId, id);
  assert.equal(seenFromA, null, 'school A must not read school B\u2019s guardian');

  const seenFromB = await getGuardianProfile(db, B.schoolId, id);
  assert.ok(seenFromB, 'the owning school still sees it');
});

test('listGuardians never returns another school\u2019s guardians', async () => {
  const { rows } = await listGuardians(db, A.schoolId, {
    page: 1,
    pageSize: 100,
    sort: 'name',
  });
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.givenName !== 'Foreign'),
    'school B guardian leaked into school A list',
  );
});

// ---------------------------------------------------------------------------
// Unlinking
// ---------------------------------------------------------------------------

test('unlinking removes the link but keeps the guardian record', async () => {
  const student = await makeStudent(A, 'G/040', 'Dawit');
  const ctx = contextFor(A, A.adminUserId);

  const { id } = await createGuardian(
    ctx,
    createGuardianSchema.parse({
      givenName: 'Solomon',
      phone: '0911000050',
      studentId: student.id,
      relationship: 'father',
    }),
  );

  await unlinkGuardian(ctx, { studentId: student.id, guardianId: id });

  const links = await db
    .select({ studentId: studentGuardians.studentId })
    .from(studentGuardians)
    .where(
      and(eq(studentGuardians.guardianId, id), eq(studentGuardians.studentId, student.id)),
    );
  assert.equal(links.length, 0, 'the link is gone');

  const profile = await getGuardianProfile(db, A.schoolId, id);
  assert.ok(profile, 'the guardian record itself survives');
  assert.equal(profile!.guardian.givenName, 'Solomon');
});

test('updating a link changes the relationship without touching the person', async () => {
  const student = await makeStudent(A, 'G/050', 'Lidya');
  const ctx = contextFor(A, A.adminUserId);

  const { id } = await createGuardian(
    ctx,
    createGuardianSchema.parse({
      givenName: 'Almaz',
      phone: '0911000060',
      studentId: student.id,
      relationship: 'mother',
      canPickUp: true,
    }),
  );

  await updateGuardianLink(ctx, { studentId: student.id, guardianId: id }, {
    relationship: 'aunt',
    canPickUp: false,
  });

  const [link] = await db
    .select({
      relationship: studentGuardians.relationship,
      canPickUp: studentGuardians.canPickUp,
    })
    .from(studentGuardians)
    .where(
      and(eq(studentGuardians.guardianId, id), eq(studentGuardians.studentId, student.id)),
    );

  assert.equal(link!.relationship, 'aunt');
  assert.equal(link!.canPickUp, false);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('creating and updating a guardian writes audit entries', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const { id } = await createGuardian(
    ctx,
    createGuardianSchema.parse({ givenName: 'Audited', phone: '0911000070' }),
  );

  await updateGuardian(ctx, id, { occupation: 'Trader' });

  const entries = await db
    .select({ action: auditLog.action, entityId: auditLog.entityId })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.entityId, id)));

  assert.ok(entries.length >= 2, `expected create and update audit rows, saw ${entries.length}`);
});

test('searching guardians matches Latin and Amharic names and phone numbers', async () => {
  const ctx = contextFor(A, A.adminUserId);
  await createGuardian(
    ctx,
    createGuardianSchema.parse({
      givenName: 'Tesfaye',
      givenNameAm: 'ተስፋዬ',
      phone: '0922334455',
    }),
  );

  const byLatin = await listGuardians(db, A.schoolId, {
    search: 'Tesfaye',
    page: 1,
    pageSize: 25,
    sort: 'name',
  });
  assert.ok(byLatin.rows.some((r) => r.givenName === 'Tesfaye'));

  const byAmharic = await listGuardians(db, A.schoolId, {
    search: 'ተስፋዬ',
    page: 1,
    pageSize: 25,
    sort: 'name',
  });
  assert.ok(byAmharic.rows.some((r) => r.givenName === 'Tesfaye'), 'Amharic search failed');

  const byPhone = await listGuardians(db, A.schoolId, {
    search: '0922334455',
    page: 1,
    pageSize: 25,
    sort: 'name',
  });
  assert.ok(byPhone.rows.some((r) => r.givenName === 'Tesfaye'), 'phone search failed');
});

test('guardian pagination is capped and consistent', async () => {
  const first = await listGuardians(db, A.schoolId, { page: 1, pageSize: 2, sort: 'name' });
  assert.equal(first.rows.length, 2);
  assert.ok(first.total > 2);

  const second = await listGuardians(db, A.schoolId, { page: 2, pageSize: 2, sort: 'name' });
  const overlap = first.rows.filter((r) => second.rows.some((s) => s.id === r.id));
  assert.equal(overlap.length, 0, 'pages must not repeat rows');
});
