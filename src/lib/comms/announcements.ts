/**
 * Announcements.
 *
 * The audience is stored as a rule and resolved when read, so the notice a
 * parent sees today reflects who they are today. The alternative — expanding
 * the audience into recipient rows at publish time — would both freeze the
 * audience and turn one whole-school notice into hundreds of rows.
 *
 * Visibility is computed from what the reader actually is: which classes they
 * teach, whose parent they are, which section they are enrolled in. A role
 * name alone never decides.
 */

import { and, desc, eq, inArray, isNull, or, sql, gt } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import type { Database } from '../../db/client.ts';
import { announcements, announcementReads } from '../../db/schema/comms.ts';
import { enrollments, students } from '../../db/schema/people.ts';
import { sections, users } from '../../db/schema/core.ts';
import { personName } from '../format.ts';
import { markDomainError } from '../api/domain-error.ts';
import { recordAudit } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import type { CreateAnnouncementInput, UpdateAnnouncementInput } from './schema.ts';

export class CommsError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CommsError';
    this.status = status;
    // Tagged so the API layer may surface this message and status to the
    // caller. Untagged errors are reported as a generic 500.
    markDomainError(this);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type AnnouncementRow = {
  id: string;
  title: string;
  titleAm: string | null;
  body: string;
  bodyAm: string | null;
  audience: string;
  isPinned: boolean;
  isPublished: boolean;
  publishedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  authorName: string | null;
  isRead: boolean;
};

/**
 * Which audience buckets apply to this user?
 *
 * A person can be in several at once — a teacher whose own child attends the
 * school is both staff and a parent, and should see both sets of notices.
 */
async function audienceFilterFor(ctx: AuthContext): Promise<{
  buckets: string[];
  sectionIds: string[];
  gradeLevelIds: string[];
}> {
  const buckets = new Set<string>(['everyone']);
  const sectionIds = new Set<string>(ctx.relationships.sectionIds);
  const gradeLevelIds = new Set<string>();

  // Staff: anyone with a staff-side permission rather than a role name.
  if (ctx.hasAny('school.view', 'student.view', 'attendance.take', 'grade.enter')) {
    buckets.add('staff');
  }
  if (ctx.relationships.guardianId) buckets.add('parents');
  if (ctx.relationships.ownStudentId) buckets.add('students');

  // A parent or student inherits the sections and grades of their children /
  // themselves, so a "Grade 5 parents" notice reaches them.
  const relevantStudentIds = [
    ...ctx.relationships.childStudentIds,
    ...(ctx.relationships.ownStudentId ? [ctx.relationships.ownStudentId] : []),
  ];

  if (relevantStudentIds.length > 0) {
    const rows = await ctx.db
      .select({ sectionId: enrollments.sectionId, gradeLevelId: sections.gradeLevelId })
      .from(enrollments)
      .innerJoin(
        sections,
        and(eq(sections.id, enrollments.sectionId), eq(sections.schoolId, ctx.schoolId)),
      )
      .where(
        and(
          eq(enrollments.schoolId, ctx.schoolId),
          inArray(enrollments.studentId, relevantStudentIds),
          eq(enrollments.status, 'enrolled'),
        ),
      );
    for (const row of rows) {
      if (row.sectionId) sectionIds.add(row.sectionId);
      if (row.gradeLevelId) gradeLevelIds.add(row.gradeLevelId);
    }
  }

  // A teacher's own sections imply their grades too.
  if (ctx.relationships.sectionIds.length > 0) {
    const rows = await ctx.db
      .select({ gradeLevelId: sections.gradeLevelId })
      .from(sections)
      .where(
        and(
          eq(sections.schoolId, ctx.schoolId),
          inArray(sections.id, ctx.relationships.sectionIds),
        ),
      );
    for (const row of rows) if (row.gradeLevelId) gradeLevelIds.add(row.gradeLevelId);
  }

  return {
    buckets: [...buckets],
    sectionIds: [...sectionIds],
    gradeLevelIds: [...gradeLevelIds],
  };
}

/**
 * Announcements this user may see.
 *
 * Only published, unexpired notices, matching one of the user's audience
 * buckets. Drafts are excluded for everyone here; authors read their drafts
 * through `listManageable`.
 */
export async function listVisibleAnnouncements(
  ctx: AuthContext,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<AnnouncementRow[]> {
  const filter = await audienceFilterFor(ctx);
  const now = new Date();

  // jsonb containment: does the stored array hold any of the user's ids?
  const sectionMatch =
    filter.sectionIds.length > 0
      ? sql`(${announcements.audience} = 'section' and ${announcements.sectionIds} ?| ${sql.raw(
          `array[${filter.sectionIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]`,
        )})`
      : sql`false`;

  const gradeMatch =
    filter.gradeLevelIds.length > 0
      ? sql`(${announcements.audience} = 'grade' and ${announcements.gradeLevelIds} ?| ${sql.raw(
          `array[${filter.gradeLevelIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}]`,
        )})`
      : sql`false`;

  const rows = await ctx.db
    .select({
      id: announcements.id,
      title: announcements.title,
      titleAm: announcements.titleAm,
      body: announcements.body,
      bodyAm: announcements.bodyAm,
      audience: announcements.audience,
      isPinned: announcements.isPinned,
      isPublished: announcements.isPublished,
      publishedAt: announcements.publishedAt,
      expiresAt: announcements.expiresAt,
      createdAt: announcements.createdAt,
      authorGivenName: users.givenName,
      authorFatherName: users.fatherName,
      readAt: announcementReads.readAt,
    })
    .from(announcements)
    .leftJoin(users, eq(users.id, announcements.createdBy))
    .leftJoin(
      announcementReads,
      and(
        eq(announcementReads.announcementId, announcements.id),
        eq(announcementReads.userId, ctx.user.userId),
      ),
    )
    .where(
      and(
        eq(announcements.schoolId, ctx.schoolId),
        eq(announcements.isPublished, true),
        or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)),
        or(inArray(announcements.audience, filter.buckets), sectionMatch, gradeMatch),
      ),
    )
    .orderBy(desc(announcements.isPinned), desc(announcements.publishedAt))
    .limit(Math.min(options.limit ?? 30, 100));

  const mapped = rows.map((r) => ({
    id: r.id,
    title: r.title,
    titleAm: r.titleAm,
    body: r.body,
    bodyAm: r.bodyAm,
    audience: r.audience,
    isPinned: r.isPinned,
    isPublished: r.isPublished,
    publishedAt: r.publishedAt,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    authorName: r.authorGivenName
      ? personName({ givenName: r.authorGivenName, fatherName: r.authorFatherName })
      : null,
    isRead: r.readAt !== null,
  }));

  return options.unreadOnly ? mapped.filter((a) => !a.isRead) : mapped;
}

/** Announcements the user may edit — their own drafts plus everything published. */
export async function listManageableAnnouncements(
  ctx: AuthContext,
  options: { limit?: number } = {},
): Promise<AnnouncementRow[]> {
  ctx.require('announcement.create');

  const rows = await ctx.db
    .select({
      id: announcements.id,
      title: announcements.title,
      titleAm: announcements.titleAm,
      body: announcements.body,
      bodyAm: announcements.bodyAm,
      audience: announcements.audience,
      isPinned: announcements.isPinned,
      isPublished: announcements.isPublished,
      publishedAt: announcements.publishedAt,
      expiresAt: announcements.expiresAt,
      createdAt: announcements.createdAt,
      authorGivenName: users.givenName,
      authorFatherName: users.fatherName,
    })
    .from(announcements)
    .leftJoin(users, eq(users.id, announcements.createdBy))
    .where(
      and(
        eq(announcements.schoolId, ctx.schoolId),
        // A teacher sees their own drafts; a manager sees every draft.
        ctx.has('school.manage')
          ? sql`true`
          : or(eq(announcements.isPublished, true), eq(announcements.createdBy, ctx.user.userId))!,
      ),
    )
    .orderBy(desc(announcements.createdAt))
    .limit(Math.min(options.limit ?? 50, 100));

  return rows.map(({ authorGivenName, authorFatherName, ...r }) => ({
    ...r,
    authorName: authorGivenName
      ? personName({ givenName: authorGivenName, fatherName: authorFatherName })
      : null,
    isRead: true,
  }));
}

export async function getAnnouncement(
  ctx: AuthContext,
  announcementId: string,
): Promise<AnnouncementRow> {
  const visible = await listVisibleAnnouncements(ctx, { limit: 100 });
  const found = visible.find((a) => a.id === announcementId);
  if (found) return found;

  // Not in the visible set — it may still be the user's own draft.
  if (ctx.has('announcement.create')) {
    const manageable = await listManageableAnnouncements(ctx, { limit: 100 });
    const draft = manageable.find((a) => a.id === announcementId);
    if (draft) return draft;
  }

  // Deny with 404: a 403 would confirm the announcement exists.
  throw new CommsError('Announcement not found', 404);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Create an announcement.
 *
 * A teacher may only address classes they actually teach. Without this a
 * teacher holding `announcement.create` could broadcast to the whole school —
 * the permission says they may write notices, not that they may write to
 * everyone.
 */
export async function createAnnouncement(
  ctx: AuthContext,
  input: CreateAnnouncementInput,
): Promise<{ id: string }> {
  ctx.require('announcement.create');
  await ctx.requireModule('announcements');

  const schoolWide = ctx.hasAny('school.manage', 'announcement.publishSchoolWide');

  if (!schoolWide) {
    if (input.audience === 'everyone' || input.audience === 'staff' || input.audience === 'grade') {
      throw new CommsError(
        'You may only send announcements to classes you teach.',
        403,
      );
    }
    if (input.audience === 'section') {
      const allowed = new Set(ctx.relationships.sectionIds);
      const foreign = input.sectionIds.filter((id) => !allowed.has(id));
      if (foreign.length > 0) {
        throw new CommsError('You may only send announcements to classes you teach.', 403);
      }
    }
    if (input.audience === 'parents' || input.audience === 'students') {
      // Narrow an unscoped parents/students broadcast to the teacher's classes.
      if (ctx.relationships.sectionIds.length === 0) {
        throw new CommsError('You are not assigned to any class.', 403);
      }
      input = {
        ...input,
        audience: 'section',
        sectionIds: ctx.relationships.sectionIds,
      };
    }
  }

  // Verify every named section belongs to this school. The composite foreign
  // keys would catch it, but a clear error beats a constraint violation.
  if (input.sectionIds.length > 0) {
    const found = await ctx.db
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.schoolId, ctx.schoolId), inArray(sections.id, input.sectionIds)));
    if (found.length !== input.sectionIds.length) {
      throw new CommsError('One or more classes do not exist', 404);
    }
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new CommsError('Invalid expiry date');
  }

  const [row] = await ctx.db
    .insert(announcements)
    .values({
      schoolId: ctx.schoolId,
      title: input.title,
      titleAm: input.titleAm || null,
      body: input.body,
      bodyAm: input.bodyAm || null,
      audience: input.audience,
      sectionIds: input.sectionIds,
      gradeLevelIds: input.gradeLevelIds,
      isPinned: input.isPinned,
      isPublished: input.publish,
      publishedAt: input.publish ? new Date() : null,
      expiresAt,
      sendSms: input.sendSms,
      createdBy: ctx.user.userId,
    })
    .returning({ id: announcements.id });

  const created = row!;

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'announcement.create',
    entityType: 'announcement',
    entityId: created.id,
    summary: `Created announcement "${input.title}"`,
    ipAddress: ctx.ipAddress,
  });

  if (input.publish) {
    await publishAnnouncementEffects(ctx, created.id, input.audience);
  }

  return created;
}

/** Emit the event that drives notifications and optional SMS. */
async function publishAnnouncementEffects(
  ctx: AuthContext,
  announcementId: string,
  audience: string,
): Promise<void> {
  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'announcement.publish',
    entityType: 'announcement',
    entityId: announcementId,
    summary: `Published announcement to ${audience}`,
    ipAddress: ctx.ipAddress,
  });

  await emitEvent(ctx.db, ctx.schoolId, 'announcement.published', {
    announcementId,
    audience,
  });
}

export async function updateAnnouncement(
  ctx: AuthContext,
  announcementId: string,
  input: UpdateAnnouncementInput,
): Promise<void> {
  ctx.require('announcement.create');

  const [existing] = await ctx.db
    .select({
      id: announcements.id,
      createdBy: announcements.createdBy,
      isPublished: announcements.isPublished,
      audience: announcements.audience,
      title: announcements.title,
    })
    .from(announcements)
    .where(and(eq(announcements.schoolId, ctx.schoolId), eq(announcements.id, announcementId)))
    .limit(1);

  if (!existing) throw new CommsError('Announcement not found', 404);

  // Authors edit their own; managers edit anyone's.
  if (existing.createdBy !== ctx.user.userId && !ctx.has('school.manage')) {
    throw new CommsError('Announcement not found', 404);
  }

  const wasPublished = existing.isPublished;
  const willPublish = input.publish === true && !wasPublished;

  await ctx.db
    .update(announcements)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.titleAm !== undefined ? { titleAm: input.titleAm || null } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.bodyAm !== undefined ? { bodyAm: input.bodyAm || null } : {}),
      ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
      ...(input.publish !== undefined ? { isPublished: input.publish } : {}),
      ...(willPublish ? { publishedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(announcements.schoolId, ctx.schoolId), eq(announcements.id, announcementId)));

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'announcement.update',
    entityType: 'announcement',
    entityId: announcementId,
    summary: `Updated announcement "${input.title ?? existing.title}"`,
    ipAddress: ctx.ipAddress,
  });

  if (willPublish) {
    await publishAnnouncementEffects(ctx, announcementId, existing.audience);
  }
}

/**
 * Record that this user has read an announcement.
 *
 * Only for announcements they are actually allowed to see, so this cannot be
 * used to probe which ids exist.
 */
export async function markAnnouncementRead(
  ctx: AuthContext,
  announcementId: string,
): Promise<void> {
  await getAnnouncement(ctx, announcementId);

  await ctx.db
    .insert(announcementReads)
    .values({
      schoolId: ctx.schoolId,
      announcementId,
      userId: ctx.user.userId,
    })
    .onConflictDoNothing();
}

/** How many published announcements this user has not opened. */
export async function countUnreadAnnouncements(ctx: AuthContext): Promise<number> {
  const visible = await listVisibleAnnouncements(ctx, { limit: 100, unreadOnly: true });
  return visible.length;
}

/**
 * Resolve who an announcement reaches, as user accounts.
 *
 * Used by the notification handler. Kept here beside the audience rules so the
 * two definitions of "who is in the audience" cannot drift apart.
 */
export async function resolveAnnouncementRecipients(
  db: Database,
  schoolId: string,
  announcementId: string,
): Promise<{ userId: string; locale: string }[]> {
  const [row] = await db
    .select({
      audience: announcements.audience,
      sectionIds: announcements.sectionIds,
      gradeLevelIds: announcements.gradeLevelIds,
    })
    .from(announcements)
    .where(and(eq(announcements.schoolId, schoolId), eq(announcements.id, announcementId)))
    .limit(1);

  if (!row) return [];

  // Staff and whole-school notices go to every active account; the audience
  // buckets above then decide what each person sees in their list.
  if (row.audience === 'everyone' || row.audience === 'staff') {
    const staffUsers = await db
      .select({ userId: users.id, locale: users.locale })
      .from(users)
      .where(and(eq(users.schoolId, schoolId), eq(users.isActive, true)));
    return staffUsers.map((u) => ({ userId: u.userId, locale: u.locale ?? 'en' }));
  }

  // Everything else is derived from the pupils in scope.
  const conditions = [eq(enrollments.schoolId, schoolId), eq(enrollments.status, 'enrolled')];
  if (row.audience === 'section' && row.sectionIds.length > 0) {
    conditions.push(inArray(enrollments.sectionId, row.sectionIds));
  } else if (row.audience === 'grade' && row.gradeLevelIds.length > 0) {
    const gradeSections = await db
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.schoolId, schoolId), inArray(sections.gradeLevelId, row.gradeLevelIds)));
    if (gradeSections.length === 0) return [];
    conditions.push(inArray(enrollments.sectionId, gradeSections.map((s) => s.id)));
  }

  const pupils = await db
    .select({ studentId: enrollments.studentId })
    .from(enrollments)
    .where(and(...conditions));

  const studentIds = [...new Set(pupils.map((p) => p.studentId))];
  if (studentIds.length === 0) return [];

  const recipients = new Map<string, string>();

  if (row.audience === 'students' || row.audience === 'section' || row.audience === 'grade') {
    const pupilUsers = await db
      .select({ userId: students.userId, locale: users.locale })
      .from(students)
      .leftJoin(users, eq(users.id, students.userId))
      .where(and(eq(students.schoolId, schoolId), inArray(students.id, studentIds)));
    for (const u of pupilUsers) if (u.userId) recipients.set(u.userId, u.locale ?? 'en');
  }

  if (row.audience === 'parents' || row.audience === 'section' || row.audience === 'grade') {
    const { guardians: g, studentGuardians: sg } = await import('../../db/schema/people.ts');
    const parentUsers = await db
      .select({ userId: g.userId, locale: users.locale })
      .from(sg)
      .innerJoin(g, and(eq(g.id, sg.guardianId), eq(g.schoolId, schoolId)))
      .leftJoin(users, eq(users.id, g.userId))
      .where(and(eq(sg.schoolId, schoolId), inArray(sg.studentId, studentIds)));
    for (const u of parentUsers) if (u.userId) recipients.set(u.userId, u.locale ?? 'en');
  }

  return [...recipients].map(([userId, locale]) => ({ userId, locale }));
}
