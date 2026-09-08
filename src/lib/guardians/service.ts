/**
 * Guardian service.
 *
 * Guardians are the school's contact point for a student: SMS alerts, fee
 * notices, pickup authorisation and the parent portal all resolve through the
 * `student_guardians` link. That link is also the parent-portal authorization
 * boundary, so every write here is careful to keep both sides in one school.
 *
 * A guardian record is shared across siblings deliberately: one father with
 * three children at the school is ONE guardian row linked three times, so
 * updating his phone number fixes it everywhere at once. This is the
 * "enter once, reuse everywhere" principle applied to contacts.
 */

import { and, asc, desc, eq, ilike, or, sql, count, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import { guardians, studentGuardians, students } from '../../db/schema/people.ts';
import { users } from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { normalisePhone } from '../students/schema.ts';
import type {
  CreateGuardianInput,
  UpdateGuardianInput,
  LinkGuardianInput,
  GuardianListQuery,
} from './schema.ts';

export type GuardianListRow = {
  id: string;
  givenName: string;
  fatherName: string | null;
  givenNameAm: string | null;
  fatherNameAm: string | null;
  phone: string | null;
  email: string | null;
  preferredChannel: string;
  hasPortalAccess: boolean;
  childCount: number;
  childNames: string | null;
};

/**
 * List guardians with the number of children each has at the school.
 *
 * The child count and names come from correlated subqueries rather than a
 * GROUP BY, so pagination stays correct and the query returns exactly
 * `pageSize` rows.
 */
export async function listGuardians(
  db: Database,
  schoolId: string,
  query: GuardianListQuery,
): Promise<{ rows: GuardianListRow[]; total: number }> {
  const conditions: SQL[] = [eq(guardians.schoolId, schoolId)];

  if (query.search) {
    const term = `%${query.search}%`;

    // Phones are stored normalised (+2519...), but staff type what is written
    // on the admission form (09...). Search both forms, or a number typed as
    // 09xxxxxxxx would never find the parent it belongs to.
    const asPhone = normalisePhone(query.search);
    const phoneMatches = [ilike(guardians.phone, term), ilike(guardians.altPhone, term)];
    if (asPhone) {
      phoneMatches.push(ilike(guardians.phone, `%${asPhone}%`));
      phoneMatches.push(ilike(guardians.altPhone, `%${asPhone}%`));
    }

    const match = or(
      ilike(guardians.givenName, term),
      ilike(guardians.fatherName, term),
      ilike(guardians.givenNameAm, term),
      ilike(guardians.fatherNameAm, term),
      ilike(guardians.email, term),
      ...phoneMatches,
    );
    if (match) conditions.push(match);
  }

  if (query.hasPortal === 'yes') {
    conditions.push(sql`${guardians.userId} is not null`);
  } else if (query.hasPortal === 'no') {
    conditions.push(sql`${guardians.userId} is null`);
  }

  const where = and(...conditions);

  const childCount = sql<number>`(
    select count(*)::int from ${studentGuardians} sg
    where sg.guardian_id = ${guardians.id}
  )`;

  const orderBy =
    query.sort === 'children'
      ? [desc(childCount), asc(guardians.givenName)]
      : query.sort === 'created'
        ? [desc(guardians.createdAt)]
        : [asc(guardians.givenName), asc(guardians.fatherName)];

  const offset = (query.page - 1) * query.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: guardians.id,
        givenName: guardians.givenName,
        fatherName: guardians.fatherName,
        givenNameAm: guardians.givenNameAm,
        fatherNameAm: guardians.fatherNameAm,
        phone: guardians.phone,
        email: guardians.email,
        preferredChannel: guardians.preferredChannel,
        hasPortalAccess: sql<boolean>`(${guardians.userId} is not null)`,
        childCount,
        childNames: sql<string | null>`(
          select string_agg(s.given_name, ', ' order by s.given_name)
          from ${studentGuardians} sg
          join ${students} s on s.id = sg.student_id
          where sg.guardian_id = ${guardians.id}
        )`,
      })
      .from(guardians)
      .where(where)
      .orderBy(...orderBy)
      .limit(query.pageSize)
      .offset(offset),

    db.select({ total: count() }).from(guardians).where(where),
  ]);

  return { rows, total: totals[0]?.total ?? 0 };
}

/** Full guardian record with linked children. */
export async function getGuardianProfile(db: Database, schoolId: string, guardianId: string) {
  const [guardian] = await db
    .select()
    .from(guardians)
    .where(and(eq(guardians.schoolId, schoolId), eq(guardians.id, guardianId)))
    .limit(1);

  if (!guardian) return null;

  const children = await db
    .select({
      studentId: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      status: students.status,
      relationship: studentGuardians.relationship,
      isPrimary: studentGuardians.isPrimary,
      canPickUp: studentGuardians.canPickUp,
      receivesFeeNotices: studentGuardians.receivesFeeNotices,
    })
    .from(studentGuardians)
    .innerJoin(students, eq(students.id, studentGuardians.studentId))
    .where(
      and(
        eq(studentGuardians.schoolId, schoolId),
        eq(studentGuardians.guardianId, guardianId),
      ),
    )
    .orderBy(asc(students.givenName));

  let portalUser: { id: string; username: string; isActive: boolean } | null = null;
  if (guardian.userId) {
    const [user] = await db
      .select({ id: users.id, username: users.username, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, guardian.userId))
      .limit(1);
    portalUser = user ?? null;
  }

  return { guardian, children, portalUser };
}

/**
 * Find an existing guardian by phone number.
 *
 * Registrars routinely re-enter the same father for a second child. Matching on
 * the normalised phone lets the UI offer "this looks like an existing parent"
 * instead of silently creating a duplicate contact.
 */
export async function findGuardianByPhone(
  db: Database,
  schoolId: string,
  phone: string,
): Promise<{ id: string; givenName: string; fatherName: string | null } | null> {
  const normalised = normalisePhone(phone);
  if (!normalised) return null;

  const [row] = await db
    .select({ id: guardians.id, givenName: guardians.givenName, fatherName: guardians.fatherName })
    .from(guardians)
    .where(and(eq(guardians.schoolId, schoolId), eq(guardians.phone, normalised)))
    .limit(1);

  return row ?? null;
}

export async function createGuardian(
  ctx: AuthContext,
  input: CreateGuardianInput,
): Promise<{ id: string }> {
  const { db, schoolId } = ctx;

  // If a student was named, confirm it belongs to this school before linking.
  if (input.studentId) {
    const [student] = await db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, schoolId), eq(students.id, input.studentId)))
      .limit(1);
    if (!student) throw new Error('The selected student does not exist at this school.');
  }

  const [guardian] = await db
    .insert(guardians)
    .values({
      schoolId,
      givenName: input.givenName,
      fatherName: input.fatherName || null,
      grandfatherName: input.grandfatherName || null,
      givenNameAm: input.givenNameAm || null,
      fatherNameAm: input.fatherNameAm || null,
      grandfatherNameAm: input.grandfatherNameAm || null,
      phone: normalisePhone(input.phone),
      altPhone: normalisePhone(input.altPhone),
      email: input.email || null,
      address: input.address || null,
      occupation: input.occupation || null,
      nationalId: input.nationalId || null,
      preferredChannel: input.preferredChannel,
    })
    .returning({ id: guardians.id });

  const guardianId = guardian!.id;

  if (input.studentId) {
    await linkGuardianToStudent(ctx, {
      guardianId,
      studentId: input.studentId,
      relationship: input.relationship,
      isPrimary: input.isPrimary,
      canPickUp: input.canPickUp,
      receivesFeeNotices: input.receivesFeeNotices,
    });
  }

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'guardian.create',
    entityType: 'guardian',
    entityId: guardianId,
    summary: `Added guardian ${input.givenName} ${input.fatherName ?? ''}`.trim(),
    newValue: { givenName: input.givenName, phone: normalisePhone(input.phone) },
    ipAddress: ctx.ipAddress,
  });

  return { id: guardianId };
}

export async function updateGuardian(
  ctx: AuthContext,
  guardianId: string,
  patch: UpdateGuardianInput,
): Promise<void> {
  const { db, schoolId } = ctx;

  const [before] = await db
    .select()
    .from(guardians)
    .where(and(eq(guardians.schoolId, schoolId), eq(guardians.id, guardianId)))
    .limit(1);
  if (!before) throw new Error('Guardian not found');

  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'phone' || key === 'altPhone') {
      values[key] = normalisePhone(value as string);
    } else {
      values[key] = value === '' ? null : value;
    }
  }
  if (Object.keys(values).length === 0) return;

  values.updatedAt = new Date();

  await db
    .update(guardians)
    .set(values)
    .where(and(eq(guardians.schoolId, schoolId), eq(guardians.id, guardianId)));

  const diff = diffValues(
    before as unknown as Record<string, unknown>,
    { ...(before as unknown as Record<string, unknown>), ...values },
  );

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'guardian.update',
    entityType: 'guardian',
    entityId: guardianId,
    summary: `Updated guardian ${before.givenName}`,
    previousValue: diff?.previous ?? null,
    newValue: diff?.next ?? null,
    ipAddress: ctx.ipAddress,
  });
}

/**
 * Link a guardian to a student.
 *
 * Both rows are re-checked against the caller's school first. The composite
 * foreign keys added in migration 0001 would reject a cross-school link anyway,
 * but failing here gives a readable message rather than a constraint error.
 */
export async function linkGuardianToStudent(
  ctx: AuthContext,
  input: LinkGuardianInput,
): Promise<void> {
  const { db, schoolId } = ctx;

  const [student] = await db
    .select({ id: students.id, givenName: students.givenName })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), eq(students.id, input.studentId)))
    .limit(1);
  if (!student) throw new Error('The selected student does not exist at this school.');

  const [guardian] = await db
    .select({ id: guardians.id, givenName: guardians.givenName })
    .from(guardians)
    .where(and(eq(guardians.schoolId, schoolId), eq(guardians.id, input.guardianId)))
    .limit(1);
  if (!guardian) throw new Error('The selected guardian does not exist at this school.');

  // Only one primary contact per student: demote the others first.
  if (input.isPrimary) {
    await db
      .update(studentGuardians)
      .set({ isPrimary: false })
      .where(
        and(
          eq(studentGuardians.schoolId, schoolId),
          eq(studentGuardians.studentId, input.studentId),
        ),
      );
  }

  await db.insert(studentGuardians).values({
    schoolId,
    studentId: input.studentId,
    guardianId: input.guardianId,
    relationship: input.relationship,
    isPrimary: input.isPrimary,
    canPickUp: input.canPickUp,
    receivesFeeNotices: input.receivesFeeNotices,
  });

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'guardian.link',
    entityType: 'student_guardian',
    entityId: input.studentId,
    summary: `Linked ${guardian.givenName} to ${student.givenName} as ${input.relationship}`,
    newValue: { guardianId: input.guardianId, relationship: input.relationship },
    ipAddress: ctx.ipAddress,
  });
}

export async function unlinkGuardian(
  ctx: AuthContext,
  /** Named rather than positional: two bare strings in a row invite a
   *  transposed call that silently targets the wrong pair. */
  target: { studentId: string; guardianId: string },
): Promise<void> {
  const { db, schoolId } = ctx;
  const { studentId, guardianId } = target;

  const deleted = await db
    .delete(studentGuardians)
    .where(
      and(
        eq(studentGuardians.schoolId, schoolId),
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.guardianId, guardianId),
      ),
    )
    .returning({ studentId: studentGuardians.studentId });

  if (deleted.length === 0) throw new Error('That guardian is not linked to this student.');

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'guardian.link',
    entityType: 'student_guardian',
    entityId: studentId,
    summary: 'Removed a guardian link',
    previousValue: { guardianId },
    ipAddress: ctx.ipAddress,
  });
}

/** Update the properties of an existing link (primary, pickup, notices). */
export async function updateGuardianLink(
  ctx: AuthContext,
  target: { studentId: string; guardianId: string },
  patch: { relationship?: string; isPrimary?: boolean; canPickUp?: boolean; receivesFeeNotices?: boolean },
): Promise<void> {
  const { db, schoolId } = ctx;
  const { studentId, guardianId } = target;

  if (patch.isPrimary) {
    await db
      .update(studentGuardians)
      .set({ isPrimary: false })
      .where(
        and(eq(studentGuardians.schoolId, schoolId), eq(studentGuardians.studentId, studentId)),
      );
  }

  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }
  if (Object.keys(values).length === 0) return;

  const updated = await db
    .update(studentGuardians)
    .set(values)
    .where(
      and(
        eq(studentGuardians.schoolId, schoolId),
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.guardianId, guardianId),
      ),
    )
    .returning({ studentId: studentGuardians.studentId });

  if (updated.length === 0) throw new Error('That guardian is not linked to this student.');

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'guardian.link',
    entityType: 'student_guardian',
    entityId: studentId,
    summary: 'Updated a guardian link',
    newValue: values,
    ipAddress: ctx.ipAddress,
  });
}
