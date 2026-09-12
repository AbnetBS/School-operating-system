/**
 * Staff module tests.
 *
 * Creating a staff member creates a login, so this module is a privilege
 * boundary as much as a record-keeping one. The tests concentrate on the ways
 * that boundary could be crossed: attaching another school's role, reusing a
 * username, resetting someone else's password, and password storage.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';

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
} from '../src/db/schema/core.ts';
import { staff } from '../src/db/schema/people.ts';
import {
  createStaff,
  updateStaff,
  listStaff,
  getStaffProfile,
  resetStaffPassword,
  generateStaffCode,
  listRoles,
  assignTeacher,
} from '../src/lib/staff/service.ts';
import { createStaffSchema } from '../src/lib/staff/schema.ts';
import { verifyPassword } from '../src/lib/auth/password.ts';
import { loadRelationships } from '../src/lib/auth/context.ts';
import { isUniqueViolation } from '../src/db/errors.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionA: string;
  sectionB: string;
  subjectId: string;
  sectionSubjectA: string;
  adminUserId: string;
  teacherRoleId: string;
};

const A: Fixture = {} as Fixture;
const B: Fixture = {} as Fixture;

const ALL = ['staff.view', 'staff.manage', 'user.manage', 'role.manage', 'academic.assignTeacher'];

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

  const [subject] = await db
    .insert(subjects)
    .values({ schoolId: fixture.schoolId, code: 'MATH', name: 'Mathematics' })
    .returning({ id: subjects.id });
  fixture.subjectId = subject!.id;

  const [ss] = await db
    .insert(sectionSubjects)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sectionId: fixture.sectionA,
      subjectId: fixture.subjectId,
    })
    .returning({ id: sectionSubjects.id });
  fixture.sectionSubjectA = ss!.id;

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

  const [role] = await db
    .insert(roles)
    .values({
      schoolId: fixture.schoolId,
      key: 'teacher',
      name: 'Teacher',
      nameAm: 'መምህር',
      isSystem: true,
    })
    .returning({ id: roles.id });
  fixture.teacherRoleId = role!.id;

  await db.insert(rolePermissions).values([
    { roleId: fixture.teacherRoleId, permission: 'attendance.take' },
    { roleId: fixture.teacherRoleId, permission: 'student.view' },
  ]);
}

before(async () => {
  db = await getDb();
  await seedSchool(`tsta-${Date.now()}`, A);
  await seedSchool(`tstb-${Date.now()}`, B);
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  await closeDb();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a staff member requires a given name and a father name', () => {
  const result = createStaffSchema.safeParse({ givenName: '', fatherName: '' });
  assert.equal(result.success, false);
  const keys = result.success ? [] : Object.keys(result.error.flatten().fieldErrors);
  assert.ok(keys.includes('givenName'));
  assert.ok(keys.includes('fatherName'));
});

test('an invalid username is rejected', () => {
  const result = createStaffSchema.safeParse({
    givenName: 'A',
    fatherName: 'B',
    username: 'has spaces!',
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test('creating a staff member provisions an employment record and a login together', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const result = await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Dawit',
      fatherName: 'Bekele',
      staffType: 'teacher',
      jobTitle: 'Mathematics Teacher',
      phone: '0911234567',
      roleIds: [A.teacherRoleId],
    }),
  );

  assert.ok(result.id);
  assert.ok(result.userId);
  assert.equal(result.username, 'dawit.bekele');
  assert.ok(result.temporaryPassword, 'a temporary password is returned exactly once');
  assert.ok(result.temporaryPassword!.length >= 8);

  const profile = await getStaffProfile(db, A.schoolId, result.id);
  assert.ok(profile);
  assert.equal(profile.staff.jobTitle, 'Mathematics Teacher');
  assert.equal(profile.staff.phone, '+251911234567', 'phone is normalised');
  assert.equal(profile.roles.length, 1);
  assert.equal(profile.roles[0]!.name, 'Teacher');
  assert.equal(profile.user.mustChangePassword, true, 'must change password at first login');
});

test('the temporary password is stored only as a hash, never in readable form', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const result = await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Hana',
      fatherName: 'Girma',
      roleIds: [],
    }),
  );

  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, result.userId));

  assert.ok(row);
  assert.ok(
    !row!.passwordHash.includes(result.temporaryPassword!),
    'the plaintext password must not appear in the stored hash',
  );
  assert.ok(row!.passwordHash.startsWith('scrypt$'), 'expected a scrypt hash');
  assert.equal(
    await verifyPassword(result.temporaryPassword!, row!.passwordHash),
    true,
    'the issued password must actually work',
  );
});

test('a staff code is generated when none is supplied, and is unique per school', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const first = await createStaff(
    ctx,
    createStaffSchema.parse({ givenName: 'Coded', fatherName: 'One', roleIds: [] }),
  );
  const second = await createStaff(
    ctx,
    createStaffSchema.parse({ givenName: 'Coded', fatherName: 'Two', roleIds: [] }),
  );

  const p1 = await getStaffProfile(db, A.schoolId, first.id);
  const p2 = await getStaffProfile(db, A.schoolId, second.id);

  assert.ok(p1!.staff.staffCode.startsWith('STF/'));
  assert.notEqual(p1!.staff.staffCode, p2!.staff.staffCode, 'generated codes must not collide');
});

test('the same staff code may be reused in a different school', async () => {
  const ctxA = contextFor(A, A.adminUserId);
  const ctxB = contextFor(B, B.adminUserId);

  await createStaff(
    ctxA,
    createStaffSchema.parse({
      givenName: 'Shared',
      fatherName: 'Code',
      staffCode: 'STF/SHARED',
      roleIds: [],
    }),
  );

  const inB = await createStaff(
    ctxB,
    createStaffSchema.parse({
      givenName: 'Shared',
      fatherName: 'Code',
      staffCode: 'STF/SHARED',
      roleIds: [],
    }),
  );

  assert.ok(inB.id, 'staff codes are unique per school, not globally');
});

test('a duplicate staff code within the same school is refused', async () => {
  const ctx = contextFor(A, A.adminUserId);
  await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Dup',
      fatherName: 'First',
      staffCode: 'STF/DUP',
      roleIds: [],
    }),
  );

  await assert.rejects(
    () =>
      createStaff(
        ctx,
        createStaffSchema.parse({
          givenName: 'Dup',
          fatherName: 'Second',
          staffCode: 'STF/DUP',
          roleIds: [],
        }),
      ),
    (error: unknown) => isUniqueViolation(error) || error instanceof Error,
  );
});

test('a duplicate username within the same school is refused', async () => {
  const ctx = contextFor(A, A.adminUserId);
  await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'User',
      fatherName: 'One',
      username: 'sameuser',
      roleIds: [],
    }),
  );

  await assert.rejects(
    () =>
      createStaff(
        ctx,
        createStaffSchema.parse({
          givenName: 'User',
          fatherName: 'Two',
          username: 'sameuser',
          roleIds: [],
        }),
      ),
    (error: unknown) => isUniqueViolation(error) || error instanceof Error,
  );
});

// ---------------------------------------------------------------------------
// Privilege boundaries
// ---------------------------------------------------------------------------

test('a role belonging to another school cannot be attached', async () => {
  const ctx = contextFor(A, A.adminUserId);

  // The whole request is refused rather than the bad role being quietly
  // dropped: an admin who asked for a role and got silence would believe
  // permissions were granted when they were not.
  await assert.rejects(
    () =>
      createStaff(
        ctx,
        createStaffSchema.parse({
          givenName: 'Escalate',
          fatherName: 'Attempt',
          // B's role id, submitted by a school A admin.
          roleIds: [B.teacherRoleId],
        }),
      ),
    /do not belong to this school/,
  );

  // And no half-created user is left behind.
  const orphans = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.schoolId, A.schoolId), eq(users.givenName, 'Escalate')));
  assert.equal(orphans.length, 0, 'a rejected creation must not leave a login behind');
});

test('updating roles cannot smuggle in a foreign role either', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const result = await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Patch',
      fatherName: 'Roles',
      roleIds: [A.teacherRoleId],
    }),
  );

  await assert.rejects(
    () => updateStaff(ctx, result.id, { roleIds: [B.teacherRoleId, A.teacherRoleId] }),
    /do not belong to this school/,
  );

  // The existing roles must be left exactly as they were, not partially applied.
  const profile = await getStaffProfile(db, A.schoolId, result.id);
  assert.equal(profile!.roles.length, 1);
  assert.equal(profile!.roles[0]!.id, A.teacherRoleId);
});

test('clearing all roles leaves the user with no permissions', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const result = await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Cleared',
      fatherName: 'Roles',
      roleIds: [A.teacherRoleId],
    }),
  );

  await updateStaff(ctx, result.id, { roleIds: [] });

  const profile = await getStaffProfile(db, A.schoolId, result.id);
  assert.equal(profile!.roles.length, 0, 'an empty role list must actually clear the roles');
});

test('a staff member from another school is invisible and cannot be updated', async () => {
  const ctxB = contextFor(B, B.adminUserId);
  const foreign = await createStaff(
    ctxB,
    createStaffSchema.parse({ givenName: 'Foreign', fatherName: 'Staff', roleIds: [] }),
  );

  const seenFromA = await getStaffProfile(db, A.schoolId, foreign.id);
  assert.equal(seenFromA, null, 'school A must not read school B staff');

  const ctxA = contextFor(A, A.adminUserId);
  await assert.rejects(
    () => updateStaff(ctxA, foreign.id, { jobTitle: 'Hacked' }),
    /not found|does not exist/i,
  );

  const stillThere = await getStaffProfile(db, B.schoolId, foreign.id);
  assert.equal(stillThere!.staff.jobTitle, null, 'the record was not modified');
});

test('resetting a password cannot target another school\u2019s staff', async () => {
  const ctxB = contextFor(B, B.adminUserId);
  const foreign = await createStaff(
    ctxB,
    createStaffSchema.parse({ givenName: 'Target', fatherName: 'Staff', roleIds: [] }),
  );

  const ctxA = contextFor(A, A.adminUserId);
  await assert.rejects(
    () => resetStaffPassword(ctxA, foreign.id),
    /not found|does not exist/i,
    'a cross-school password reset must fail',
  );
});

test('resetting a password issues a new working password and forces a change', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const created = await createStaff(
    ctx,
    createStaffSchema.parse({ givenName: 'Reset', fatherName: 'Me', roleIds: [] }),
  );

  const reset = await resetStaffPassword(ctx, created.id);
  assert.ok(reset.temporaryPassword);
  assert.notEqual(reset.temporaryPassword, created.temporaryPassword, 'a fresh password is issued');

  const [row] = await db
    .select({ passwordHash: users.passwordHash, mustChange: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, created.userId));

  assert.equal(await verifyPassword(reset.temporaryPassword, row!.passwordHash), true);
  assert.equal(
    await verifyPassword(created.temporaryPassword!, row!.passwordHash),
    false,
    'the old password must stop working',
  );
  assert.equal(row!.mustChange, true);
});

// ---------------------------------------------------------------------------
// Teacher assignment — the switch that grants class visibility
// ---------------------------------------------------------------------------

test('assigning a subject class grants the teacher visibility of that section only', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const teacher = await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Assigned',
      fatherName: 'Teacher',
      roleIds: [A.teacherRoleId],
    }),
  );

  const before = await loadRelationships(db, A.schoolId, teacher.userId);
  assert.equal(before.sectionIds.length, 0, 'no assignment means no sections');

  await assignTeacher(ctx, {
    teacherUserId: teacher.userId,
    sectionSubjectId: A.sectionSubjectA,
    kind: 'subject',
  });

  const after = await loadRelationships(db, A.schoolId, teacher.userId);
  assert.deepEqual(after.sectionIds, [A.sectionA], 'only the assigned section is visible');
  assert.ok(!after.sectionIds.includes(A.sectionB), 'section B must not be visible');
});

test('making someone class teacher grants visibility of their homeroom', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const teacher = await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Homeroom',
      fatherName: 'Teacher',
      roleIds: [A.teacherRoleId],
    }),
  );

  await assignTeacher(ctx, {
    teacherUserId: teacher.userId,
    sectionId: A.sectionB,
    kind: 'classTeacher',
  });

  const rels = await loadRelationships(db, A.schoolId, teacher.userId);
  assert.ok(rels.sectionIds.includes(A.sectionB));
});

test('a teacher from another school cannot be assigned to our class', async () => {
  const ctxB = contextFor(B, B.adminUserId);
  const foreignTeacher = await createStaff(
    ctxB,
    createStaffSchema.parse({ givenName: 'Outsider', fatherName: 'Teacher', roleIds: [] }),
  );

  const ctxA = contextFor(A, A.adminUserId);
  await assert.rejects(
    () =>
      assignTeacher(ctxA, {
        teacherUserId: foreignTeacher.userId,
        sectionSubjectId: A.sectionSubjectA,
        kind: 'subject',
      }),
    /does not exist at this school/,
  );
});

test('assignment can be cleared with an empty teacher id', async () => {
  const ctx = contextFor(A, A.adminUserId);
  await assignTeacher(ctx, {
    teacherUserId: '',
    sectionSubjectId: A.sectionSubjectA,
    kind: 'subject',
  });

  const [row] = await db
    .select({ teacherId: sectionSubjects.teacherId })
    .from(sectionSubjects)
    .where(eq(sectionSubjects.id, A.sectionSubjectA));
  assert.equal(row!.teacherId, null);
});

// ---------------------------------------------------------------------------
// Listing, roles and audit
// ---------------------------------------------------------------------------

test('listStaff never returns another school\u2019s staff', async () => {
  const { rows } = await listStaff(db, A.schoolId, {
    page: 1,
    pageSize: 100,
    sort: 'name',
  });
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.givenName !== 'Foreign' && row.givenName !== 'Outsider'),
    'school B staff leaked into school A list',
  );
});

test('listStaff filters by type and status', async () => {
  const ctx = contextFor(A, A.adminUserId);
  await createStaff(
    ctx,
    createStaffSchema.parse({
      givenName: 'Driver',
      fatherName: 'Person',
      staffType: 'driver',
      roleIds: [],
    }),
  );

  const { rows } = await listStaff(db, A.schoolId, {
    staffType: 'driver',
    page: 1,
    pageSize: 25,
    sort: 'name',
  });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.staffType === 'driver'));
});

test('listRoles is scoped to the school and counts its members', async () => {
  const rolesA = await listRoles(db, A.schoolId);
  assert.equal(rolesA.length, 1);
  assert.equal(rolesA[0]!.name, 'Teacher');
  assert.equal(rolesA[0]!.permissionCount, 2);
  assert.ok(rolesA[0]!.userCount >= 1);

  const rolesB = await listRoles(db, B.schoolId);
  assert.notEqual(rolesA[0]!.id, rolesB[0]!.id, 'each school has its own role rows');
});

test('creating and updating staff writes audit entries', async () => {
  const ctx = contextFor(A, A.adminUserId);
  const created = await createStaff(
    ctx,
    createStaffSchema.parse({ givenName: 'Audited', fatherName: 'Staff', roleIds: [] }),
  );

  await updateStaff(ctx, created.id, { jobTitle: 'Registrar' });

  const entries = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.entityId, created.id)));

  assert.ok(entries.length >= 2, `expected create + update audit rows, saw ${entries.length}`);
});
