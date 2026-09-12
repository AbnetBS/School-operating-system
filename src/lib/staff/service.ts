/**
 * Staff service.
 *
 * Creating a staff member provisions, in one transaction-like sequence:
 *   1. a `users` row (the login) with a temporary password,
 *   2. a `staff` row (the employment record),
 *   3. role assignments.
 *
 * The temporary password is returned ONCE to the caller and never stored in
 * readable form — the registrar reads it out to the teacher, who is forced to
 * change it at first login via `mustChangePassword`.
 */

import { and, asc, desc, eq, ilike, or, sql, count, inArray, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import { staff } from '../../db/schema/people.ts';
import {
  users,
  roles,
  userRoles,
  rolePermissions,
  sections,
  sectionSubjects,
  subjects,
  gradeLevels,
} from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { resolveCustomFieldValues } from '../customFields/service.ts';
import { hashPassword, generateTemporaryPassword } from '../auth/password.ts';
import { getSetting } from '../settings/service.ts';
import { normalisePhone } from '../students/schema.ts';
import type { CreateStaffInput, UpdateStaffInput, StaffListQuery } from './schema.ts';

export type StaffListRow = {
  id: string;
  userId: string;
  staffCode: string;
  givenName: string;
  fatherName: string | null;
  givenNameAm: string | null;
  staffType: string;
  jobTitle: string | null;
  phone: string | null;
  status: string;
  isActive: boolean;
  username: string;
  roleNames: string | null;
  sectionCount: number;
};

/** Generate the next free staff code from the school's configured pattern. */
export async function generateStaffCode(db: Database, schoolId: string): Promise<string> {
  const academic = await getSetting(db, schoolId, 'academic');
  const pattern = academic.staffCodeFormat || 'STF/{seq}';
  const padding = academic.staffCodeSeqPadding ?? 3;

  const [row] = await db.select({ total: count() }).from(staff).where(eq(staff.schoolId, schoolId));

  let seq = (row?.total ?? 0) + 1;
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = pattern
      .replace('{year}', String(new Date().getFullYear()))
      .replace('{seq}', String(seq).padStart(padding, '0'));
    const [existing] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.schoolId, schoolId), eq(staff.staffCode, candidate)))
      .limit(1);
    if (!existing) return candidate;
    seq++;
  }
  return `STF/${Date.now()}`;
}

export async function listStaff(
  db: Database,
  schoolId: string,
  query: StaffListQuery,
): Promise<{ rows: StaffListRow[]; total: number }> {
  const conditions: SQL[] = [eq(staff.schoolId, schoolId)];

  if (query.staffType) conditions.push(eq(staff.staffType, query.staffType));
  if (query.status) conditions.push(eq(staff.status, query.status));

  if (query.search) {
    const term = `%${query.search}%`;
    const match = or(
      ilike(users.givenName, term),
      ilike(users.fatherName, term),
      ilike(users.givenNameAm, term),
      ilike(staff.staffCode, term),
      ilike(staff.jobTitle, term),
      ilike(users.username, term),
    );
    if (match) conditions.push(match);
  }

  if (query.roleId) {
    conditions.push(
      sql`exists (select 1 from ${userRoles} ur where ur.user_id = ${staff.userId} and ur.role_id = ${query.roleId})`,
    );
  }

  const where = and(...conditions);

  const orderBy =
    query.sort === 'code'
      ? [asc(staff.staffCode)]
      : query.sort === 'type'
        ? [asc(staff.staffType), asc(users.givenName)]
        : query.sort === 'created'
          ? [desc(staff.createdAt)]
          : [asc(users.givenName), asc(users.fatherName)];

  const offset = (query.page - 1) * query.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: staff.id,
        userId: staff.userId,
        staffCode: staff.staffCode,
        givenName: users.givenName,
        fatherName: users.fatherName,
        givenNameAm: users.givenNameAm,
        staffType: staff.staffType,
        jobTitle: staff.jobTitle,
        phone: staff.phone,
        status: staff.status,
        isActive: users.isActive,
        username: users.username,
        roleNames: sql<string | null>`(
          select string_agg(r.name, ', ' order by r.name)
          from ${userRoles} ur join ${roles} r on r.id = ur.role_id
          where ur.user_id = ${staff.userId}
        )`,
        // How many distinct classes this person teaches — the quickest signal
        // of whether a teacher is actually timetabled.
        sectionCount: sql<number>`(
          select count(distinct ss.section_id)::int from ${sectionSubjects} ss
          where ss.teacher_id = ${staff.userId}
        )`,
      })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId))
      .where(where)
      .orderBy(...orderBy)
      .limit(query.pageSize)
      .offset(offset),

    db.select({ total: count() }).from(staff).innerJoin(users, eq(users.id, staff.userId)).where(where),
  ]);

  return { rows, total: totals[0]?.total ?? 0 };
}

/** Full staff record: employment details, login, roles and teaching load. */
export async function getStaffProfile(db: Database, schoolId: string, staffId: string) {
  const [row] = await db
    .select({
      staff: staff,
      user: {
        id: users.id,
        username: users.username,
        email: users.email,
        phone: users.phone,
        givenName: users.givenName,
        fatherName: users.fatherName,
        grandfatherName: users.grandfatherName,
        givenNameAm: users.givenNameAm,
        fatherNameAm: users.fatherNameAm,
        grandfatherNameAm: users.grandfatherNameAm,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        mustChangePassword: users.mustChangePassword,
      },
    })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .where(and(eq(staff.schoolId, schoolId), eq(staff.id, staffId)))
    .limit(1);

  if (!row) return null;

  const [assignedRoles, teaching, homerooms] = await Promise.all([
    db
      .select({ id: roles.id, key: roles.key, name: roles.name, nameAm: roles.nameAm })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, row.user.id))
      .orderBy(asc(roles.name)),

    db
      .select({
        id: sectionSubjects.id,
        sectionId: sections.id,
        sectionName: sections.name,
        gradeName: gradeLevels.name,
        gradeLevel: gradeLevels.level,
        subjectName: subjects.name,
        subjectId: subjects.id,
      })
      .from(sectionSubjects)
      .innerJoin(sections, eq(sections.id, sectionSubjects.sectionId))
      .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
      .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
      .where(
        and(
          eq(sectionSubjects.schoolId, schoolId),
          eq(sectionSubjects.teacherId, row.user.id),
        ),
      )
      .orderBy(asc(gradeLevels.level), asc(sections.name)),

    db
      .select({
        id: sections.id,
        name: sections.name,
        gradeName: gradeLevels.name,
      })
      .from(sections)
      .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
      .where(and(eq(sections.schoolId, schoolId), eq(sections.classTeacherId, row.user.id)))
      .orderBy(asc(gradeLevels.level), asc(sections.name)),
  ]);

  return { staff: row.staff, user: row.user, roles: assignedRoles, teaching, homerooms };
}

/**
 * Create a staff member together with their login.
 *
 * Returns the temporary password so it can be shown to the registrar exactly
 * once. It is stored only as a scrypt hash.
 */
export async function createStaff(
  ctx: AuthContext,
  input: CreateStaffInput,
): Promise<{ id: string; userId: string; username: string; temporaryPassword: string | null }> {
  const { db, schoolId } = ctx;

  // Validated against this school's own definitions before anything is stored.
  const customFieldValues = await resolveCustomFieldValues(
    db,
    schoolId,
    'staff',
    input.customFields ?? {},
  );

  const staffCode = input.staffCode || (await generateStaffCode(db, schoolId));

  // A username is required to create a login. Derive one if the caller did not
  // supply it, so a registrar entering a driver does not have to invent one.
  const username =
    input.username ||
    `${input.givenName}.${input.fatherName}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 60);

  // Verify the requested roles exist in THIS school before assigning them.
  // Without this check a caller could attach a role id belonging to another
  // school and inherit its permissions.
  let validRoleIds: string[] = [];
  if (input.roleIds.length > 0) {
    const found = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.schoolId, schoolId), inArray(roles.id, input.roleIds)));
    validRoleIds = found.map((r) => r.id);
    if (validRoleIds.length !== input.roleIds.length) {
      throw new Error('One or more selected roles do not belong to this school.');
    }
  }

  const temporaryPassword = generateTemporaryPassword(10);
  const passwordHash = await hashPassword(temporaryPassword);

  const [user] = await db
    .insert(users)
    .values({
      schoolId,
      username,
      email: input.email || null,
      phone: normalisePhone(input.phone),
      passwordHash,
      givenName: input.givenName,
      fatherName: input.fatherName,
      grandfatherName: input.grandfatherName || null,
      givenNameAm: input.givenNameAm || null,
      fatherNameAm: input.fatherNameAm || null,
      grandfatherNameAm: input.grandfatherNameAm || null,
      isActive: true,
      // Forces a password change at first sign-in.
      mustChangePassword: true,
    })
    .returning({ id: users.id, username: users.username });

  const userId = user!.id;

  const [record] = await db
    .insert(staff)
    .values({
      schoolId,
      userId,
      staffCode,
      staffType: input.staffType,
      jobTitle: input.jobTitle || null,
      department: input.department || null,
      gender: input.gender ?? null,
      dateOfBirth: input.dateOfBirth || null,
      phone: normalisePhone(input.phone),
      address: input.address || null,
      qualification: input.qualification || null,
      hireDate: input.hireDate || null,
      employmentType: input.employmentType ?? null,
      status: input.status,
      customFields: customFieldValues,
    })
    .returning({ id: staff.id });

  if (validRoleIds.length > 0) {
    await db.insert(userRoles).values(validRoleIds.map((roleId) => ({ userId, roleId })));
  }

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'staff.create',
    entityType: 'staff',
    entityId: record!.id,
    summary: `Added ${input.staffType} ${input.givenName} ${input.fatherName} (${staffCode})`,
    // Never log the password, not even the temporary one.
    newValue: { staffCode, username, staffType: input.staffType, roleIds: validRoleIds },
    ipAddress: ctx.ipAddress,
  });

  return { id: record!.id, userId, username: user!.username, temporaryPassword };
}

export async function updateStaff(
  ctx: AuthContext,
  staffId: string,
  patch: UpdateStaffInput,
): Promise<void> {
  const { db, schoolId } = ctx;

  const [before] = await db
    .select({ staff: staff, userId: staff.userId })
    .from(staff)
    .where(and(eq(staff.schoolId, schoolId), eq(staff.id, staffId)))
    .limit(1);
  if (!before) throw new Error('Staff member not found');

  const staffValues: Record<string, unknown> = {};
  const userValues: Record<string, unknown> = {};

  const userFields = new Set([
    'givenName',
    'fatherName',
    'grandfatherName',
    'givenNameAm',
    'fatherNameAm',
    'grandfatherNameAm',
  ]);

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'roleIds' || key === 'isActive') continue;
    if (key === 'customFields') {
      staffValues.customFields = await resolveCustomFieldValues(db, schoolId, 'staff', value);
      continue;
    }
    if (key === 'phone') {
      staffValues.phone = normalisePhone(value as string);
      userValues.phone = normalisePhone(value as string);
      continue;
    }
    if (userFields.has(key)) {
      userValues[key] = value === '' ? null : value;
      // Names live on the user row, but keep both in step for display.
      continue;
    }
    staffValues[key] = value === '' ? null : value;
  }

  if (patch.isActive !== undefined) userValues.isActive = patch.isActive;

  if (Object.keys(staffValues).length > 0) {
    staffValues.updatedAt = new Date();
    await db
      .update(staff)
      .set(staffValues)
      .where(and(eq(staff.schoolId, schoolId), eq(staff.id, staffId)));
  }

  if (Object.keys(userValues).length > 0) {
    userValues.updatedAt = new Date();
    await db
      .update(users)
      .set(userValues)
      .where(and(eq(users.schoolId, schoolId), eq(users.id, before.userId)));
  }

  // Roles are replaced wholesale when supplied, so removing a role works.
  if (patch.roleIds) {
    const found = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.schoolId, schoolId), inArray(roles.id, patch.roleIds.length ? patch.roleIds : ['-'])));
    if (found.length !== patch.roleIds.length) {
      throw new Error('One or more selected roles do not belong to this school.');
    }
    await db.delete(userRoles).where(eq(userRoles.userId, before.userId));
    if (patch.roleIds.length > 0) {
      await db
        .insert(userRoles)
        .values(patch.roleIds.map((roleId) => ({ userId: before.userId, roleId })));
    }
  }

  const diff = diffValues(
    before.staff as unknown as Record<string, unknown>,
    { ...(before.staff as unknown as Record<string, unknown>), ...staffValues },
  );

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'staff.update',
    entityType: 'staff',
    entityId: staffId,
    summary: `Updated staff ${before.staff.staffCode}`,
    previousValue: diff?.previous ?? null,
    newValue: { ...(diff?.next ?? {}), ...(patch.roleIds ? { roleIds: patch.roleIds } : {}) },
    ipAddress: ctx.ipAddress,
  });
}

/**
 * Reset a staff member's password to a new temporary one.
 * Returned once; the user must change it at next sign-in.
 */
export async function resetStaffPassword(
  ctx: AuthContext,
  staffId: string,
): Promise<{ temporaryPassword: string; username: string }> {
  const { db, schoolId } = ctx;

  const [row] = await db
    .select({ userId: staff.userId, username: users.username, code: staff.staffCode })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .where(and(eq(staff.schoolId, schoolId), eq(staff.id, staffId)))
    .limit(1);
  if (!row) throw new Error('Staff member not found');

  const temporaryPassword = generateTemporaryPassword(10);
  const passwordHash = await hashPassword(temporaryPassword);

  await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, row.userId));

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'staff.update',
    entityType: 'staff',
    entityId: staffId,
    summary: `Reset the password for ${row.username}`,
    ipAddress: ctx.ipAddress,
  });

  return { temporaryPassword, username: row.username };
}

/** Roles available for assignment, with how many people already hold each. */
export async function listRoles(db: Database, schoolId: string) {
  return db
    .select({
      id: roles.id,
      key: roles.key,
      name: roles.name,
      nameAm: roles.nameAm,
      description: roles.description,
      isSystem: roles.isSystem,
      permissionCount: sql<number>`(
        select count(*)::int from ${rolePermissions} rp where rp.role_id = ${roles.id}
      )`,
      userCount: sql<number>`(
        select count(*)::int from ${userRoles} ur where ur.role_id = ${roles.id}
      )`,
    })
    .from(roles)
    .where(eq(roles.schoolId, schoolId))
    .orderBy(asc(roles.name));
}

/**
 * Assign a teacher to a subject class, or make them the class teacher.
 * Passing an empty teacher id clears the assignment.
 */
export async function assignTeacher(
  ctx: AuthContext,
  input: { teacherUserId: string; sectionSubjectId?: string; sectionId?: string; kind: 'subject' | 'classTeacher' },
): Promise<void> {
  const { db, schoolId } = ctx;

  // The teacher must be a user in this school.
  if (input.teacherUserId) {
    const [teacher] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.schoolId, schoolId), eq(users.id, input.teacherUserId)))
      .limit(1);
    if (!teacher) throw new Error('The selected teacher does not exist at this school.');
  }

  if (input.kind === 'classTeacher') {
    if (!input.sectionId) throw new Error('A section must be specified.');
    const updated = await db
      .update(sections)
      .set({ classTeacherId: input.teacherUserId || null, updatedAt: new Date() })
      .where(and(eq(sections.schoolId, schoolId), eq(sections.id, input.sectionId)))
      .returning({ id: sections.id });
    if (updated.length === 0) throw new Error('Section not found.');
  } else {
    if (!input.sectionSubjectId) throw new Error('A class subject must be specified.');
    const updated = await db
      .update(sectionSubjects)
      .set({ teacherId: input.teacherUserId || null, updatedAt: new Date() })
      .where(
        and(eq(sectionSubjects.schoolId, schoolId), eq(sectionSubjects.id, input.sectionSubjectId)),
      )
      .returning({ id: sectionSubjects.id });
    if (updated.length === 0) throw new Error('Class subject not found.');
  }

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'staff.update',
    entityType: input.kind === 'classTeacher' ? 'section' : 'section_subject',
    entityId: input.sectionId ?? input.sectionSubjectId ?? null,
    summary:
      input.kind === 'classTeacher'
        ? 'Changed the class teacher'
        : 'Changed the subject teacher',
    newValue: { teacherUserId: input.teacherUserId || null },
    ipAddress: ctx.ipAddress,
  });
}
