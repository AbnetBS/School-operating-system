/**
 * Direct messaging.
 *
 * Two separate authorization questions, deliberately kept apart:
 *
 *   1. May I READ this thread?   → am I a participant? (message_participants)
 *   2. May I START a thread with this person? → do we have a real relationship?
 *
 * Conflating them is the classic mistake. If reading were role-based, any
 * teacher could open any parent–teacher conversation in the school. If
 * starting were membership-based it would be circular. So reading checks the
 * participant row, and starting checks the teaching/guardianship graph that
 * Groups 2–5 already maintain.
 *
 * A parent may never message another parent. Nothing may cross a school
 * boundary — enforced here, and again by composite foreign keys in the
 * database.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import {
  messageThreads,
  messageParticipants,
  messages,
  notifications,
} from '../../db/schema/comms.ts';
import {
  users,
  sections,
  sectionSubjects,
  userRoles,
  roles,
  rolePermissions,
} from '../../db/schema/core.ts';
import { guardians, studentGuardians, students, staff } from '../../db/schema/people.ts';
import { personName } from '../format.ts';
import { recordAudit } from '../audit/index.ts';
import { renderTemplate } from '../notifications/templates.ts';
import { createNotifications } from '../notifications/service.ts';
import { CommsError } from './announcements.ts';
import type { CreateThreadInput, SendMessageInput } from './schema.ts';
import type { Locale } from '../i18n/types.ts';

// ---------------------------------------------------------------------------
// Who may talk to whom
// ---------------------------------------------------------------------------

export type ContactRow = {
  userId: string;
  name: string;
  role: 'staff' | 'parent' | 'student';
  detail: string | null;
};

/**
 * The people this user is allowed to start a conversation with.
 *
 * This is the single source of truth for "who may message whom" — the picker
 * shows it and `createThread` re-checks against it. A crafted user id that is
 * not in this list is rejected, so the UI is convenience, not security.
 */
export async function listContacts(ctx: AuthContext): Promise<ContactRow[]> {
  const contacts = new Map<string, ContactRow>();
  const isStaff = ctx.hasAny('school.view', 'student.view', 'attendance.take', 'grade.enter');
  const schoolWide = ctx.hasAny('school.manage', 'student.view');

  // --- Staff → the parents and pupils of the classes they teach ------------
  if (isStaff) {
    const sectionIds = schoolWide ? null : ctx.relationships.sectionIds;

    if (sectionIds === null || sectionIds.length > 0) {
      const { enrollments } = await import('../../db/schema/people.ts');
      const conditions = [
        eq(enrollments.schoolId, ctx.schoolId),
        eq(enrollments.status, 'enrolled'),
      ];
      if (sectionIds !== null) conditions.push(inArray(enrollments.sectionId, sectionIds));

      const pupils = await ctx.db
        .select({
          studentId: students.id,
          userId: students.userId,
          givenName: students.givenName,
          fatherName: students.fatherName,
          sectionName: sections.name,
        })
        .from(enrollments)
        .innerJoin(
          students,
          and(eq(students.id, enrollments.studentId), eq(students.schoolId, ctx.schoolId)),
        )
        .leftJoin(sections, eq(sections.id, enrollments.sectionId))
        .where(and(...conditions));

      const studentIds = pupils.map((p) => p.studentId);

      for (const pupil of pupils) {
        if (pupil.userId) {
          contacts.set(pupil.userId, {
            userId: pupil.userId,
            name: personName({ givenName: pupil.givenName, fatherName: pupil.fatherName }),
            role: 'student',
            detail: pupil.sectionName,
          });
        }
      }

      if (studentIds.length > 0) {
        const parents = await ctx.db
          .select({
            userId: guardians.userId,
            givenName: guardians.givenName,
            fatherName: guardians.fatherName,
            childGiven: students.givenName,
            childFather: students.fatherName,
          })
          .from(studentGuardians)
          .innerJoin(
            guardians,
            and(
              eq(guardians.id, studentGuardians.guardianId),
              eq(guardians.schoolId, ctx.schoolId),
            ),
          )
          .innerJoin(
            students,
            and(eq(students.id, studentGuardians.studentId), eq(students.schoolId, ctx.schoolId)),
          )
          .where(
            and(
              eq(studentGuardians.schoolId, ctx.schoolId),
              inArray(studentGuardians.studentId, studentIds),
            ),
          );

        for (const parent of parents) {
          if (!parent.userId) continue;
          contacts.set(parent.userId, {
            userId: parent.userId,
            name: personName({ givenName: parent.givenName, fatherName: parent.fatherName }),
            role: 'parent',
            detail: `Parent of ${personName({
              givenName: parent.childGiven,
              fatherName: parent.childFather,
            })}`,
          });
        }
      }
    }

    // Staff may always reach other staff.
    const colleagues = await ctx.db
      .select({
        userId: users.id,
        givenName: users.givenName,
        fatherName: users.fatherName,
        position: staff.jobTitle,
      })
      .from(staff)
      .innerJoin(users, and(eq(users.id, staff.userId), eq(users.schoolId, ctx.schoolId)))
      .where(and(eq(staff.schoolId, ctx.schoolId), eq(users.isActive, true)));

    for (const colleague of colleagues) {
      if (colleague.userId === ctx.user.userId) continue;
      contacts.set(colleague.userId, {
        userId: colleague.userId,
        name: personName({ givenName: colleague.givenName, fatherName: colleague.fatherName }),
        role: 'staff',
        detail: colleague.position,
      });
    }
  }

  // --- Parent / student → the staff who teach the child --------------------
  const ownStudentIds = [
    ...ctx.relationships.childStudentIds,
    ...(ctx.relationships.ownStudentId ? [ctx.relationships.ownStudentId] : []),
  ];

  if (!isStaff && ownStudentIds.length > 0) {
    const { enrollments } = await import('../../db/schema/people.ts');

    const enrolled = await ctx.db
      .select({ sectionId: enrollments.sectionId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.schoolId, ctx.schoolId),
          inArray(enrollments.studentId, ownStudentIds),
          eq(enrollments.status, 'enrolled'),
        ),
      );

    const sectionIds = [...new Set(enrolled.map((e) => e.sectionId).filter(Boolean) as string[])];

    if (sectionIds.length > 0) {
      // Subject teachers of those classes.
      const subjectTeachers = await ctx.db
        .select({
          userId: users.id,
          givenName: users.givenName,
          fatherName: users.fatherName,
          position: staff.jobTitle,
        })
        .from(sectionSubjects)
        .innerJoin(
          users,
          and(eq(users.id, sectionSubjects.teacherId), eq(users.schoolId, ctx.schoolId)),
        )
        .leftJoin(staff, eq(staff.userId, users.id))
        .where(
          and(
            eq(sectionSubjects.schoolId, ctx.schoolId),
            inArray(sectionSubjects.sectionId, sectionIds),
            eq(users.isActive, true),
          ),
        );

      // Plus the class teacher.
      const classTeachers = await ctx.db
        .select({
          userId: users.id,
          givenName: users.givenName,
          fatherName: users.fatherName,
          position: staff.jobTitle,
        })
        .from(sections)
        .innerJoin(
          users,
          and(eq(users.id, sections.classTeacherId), eq(users.schoolId, ctx.schoolId)),
        )
        .leftJoin(staff, eq(staff.userId, users.id))
        .where(and(eq(sections.schoolId, ctx.schoolId), inArray(sections.id, sectionIds)));

      for (const teacher of [...subjectTeachers, ...classTeachers]) {
        if (teacher.userId === ctx.user.userId) continue;
        contacts.set(teacher.userId, {
          userId: teacher.userId,
          name: personName({ givenName: teacher.givenName, fatherName: teacher.fatherName }),
          role: 'staff',
          detail: teacher.position ?? 'Teacher',
        });
      }
    }

    // Office staff are reachable by any parent — a fee or records question
    // should not have to go through a subject teacher.
    //
    // "Office staff" is derived from permissions, not from a job-title string:
    // a school may call the role Registrar, Secretary or something in Amharic,
    // and matching on the label would break the moment they rename it.
    //
    // The distinguishing signal is school-wide reach: front office can see
    // student records *without* `restrict.ownSectionsOnly`, whereas a subject
    // teacher holds `student.view` limited to their own classes. Matching on
    // `student.view` alone would make every teacher in the school reachable by
    // every parent, which is exactly what this restriction exists to prevent.
    const officeRoleIds = ctx.db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .where(eq(rolePermissions.permission, 'student.view'))
      .except(
        ctx.db
          .select({ roleId: rolePermissions.roleId })
          .from(rolePermissions)
          .where(eq(rolePermissions.permission, 'restrict.ownSectionsOnly')),
      );

    const office = await ctx.db
      .selectDistinct({
        userId: users.id,
        givenName: users.givenName,
        fatherName: users.fatherName,
        position: staff.jobTitle,
      })
      .from(staff)
      .innerJoin(users, and(eq(users.id, staff.userId), eq(users.schoolId, ctx.schoolId)))
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(
        roles,
        and(
          eq(roles.id, userRoles.roleId),
          eq(roles.schoolId, ctx.schoolId),
          inArray(roles.id, officeRoleIds),
        ),
      )
      .where(and(eq(staff.schoolId, ctx.schoolId), eq(users.isActive, true)));

    for (const person of office) {
      if (person.userId === ctx.user.userId) continue;
      contacts.set(person.userId, {
        userId: person.userId,
        name: personName({ givenName: person.givenName, fatherName: person.fatherName }),
        role: 'staff',
        detail: person.position,
      });
    }
  }

  contacts.delete(ctx.user.userId);
  return [...contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Re-check a chosen recipient against the allowed set. */
async function assertCanInitiate(ctx: AuthContext, recipientUserIds: string[]): Promise<void> {
  const allowed = new Set((await listContacts(ctx)).map((c) => c.userId));
  const forbidden = recipientUserIds.filter((id) => !allowed.has(id));
  if (forbidden.length > 0) {
    // 404 rather than 403: a 403 would confirm the account exists.
    throw new CommsError('One or more recipients were not found', 404);
  }
}

// ---------------------------------------------------------------------------
// Thread access
// ---------------------------------------------------------------------------

/**
 * Membership check.
 *
 * The only gate on reading a conversation. Scoped by school as well as thread
 * so a valid id from another tenant cannot match.
 */
async function assertThreadAccess(ctx: AuthContext, threadId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ userId: messageParticipants.userId })
    .from(messageParticipants)
    .innerJoin(
      messageThreads,
      and(
        eq(messageThreads.id, messageParticipants.threadId),
        eq(messageThreads.schoolId, ctx.schoolId),
      ),
    )
    .where(
      and(
        eq(messageParticipants.schoolId, ctx.schoolId),
        eq(messageParticipants.threadId, threadId),
        eq(messageParticipants.userId, ctx.user.userId),
        isNull(messageParticipants.leftAt),
      ),
    )
    .limit(1);

  if (!row) throw new CommsError('Conversation not found', 404);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ThreadSummary = {
  id: string;
  subject: string;
  kind: string;
  studentId: string | null;
  lastMessageAt: Date;
  unreadCount: number;
  participantNames: string[];
  lastMessagePreview: string | null;
};

/** The user's inbox. Only threads they belong to. */
export async function listThreads(
  ctx: AuthContext,
  options: { limit?: number } = {},
): Promise<ThreadSummary[]> {
  const rows = await ctx.db
    .select({
      id: messageThreads.id,
      subject: messageThreads.subject,
      kind: messageThreads.kind,
      studentId: messageThreads.studentId,
      lastMessageAt: messageThreads.lastMessageAt,
      lastReadAt: messageParticipants.lastReadAt,
    })
    .from(messageParticipants)
    .innerJoin(
      messageThreads,
      and(
        eq(messageThreads.id, messageParticipants.threadId),
        eq(messageThreads.schoolId, ctx.schoolId),
      ),
    )
    .where(
      and(
        eq(messageParticipants.schoolId, ctx.schoolId),
        eq(messageParticipants.userId, ctx.user.userId),
        isNull(messageParticipants.leftAt),
      ),
    )
    .orderBy(desc(messageThreads.lastMessageAt))
    .limit(Math.min(options.limit ?? 30, 100));

  if (rows.length === 0) return [];

  const threadIds = rows.map((r) => r.id);

  // Other participants, for the inbox line.
  const participantRows = await ctx.db
    .select({
      threadId: messageParticipants.threadId,
      userId: users.id,
      givenName: users.givenName,
      fatherName: users.fatherName,
    })
    .from(messageParticipants)
    .innerJoin(users, and(eq(users.id, messageParticipants.userId), eq(users.schoolId, ctx.schoolId)))
    .where(
      and(
        eq(messageParticipants.schoolId, ctx.schoolId),
        inArray(messageParticipants.threadId, threadIds),
        ne(messageParticipants.userId, ctx.user.userId),
      ),
    );

  const namesByThread = new Map<string, string[]>();
  for (const p of participantRows) {
    const list = namesByThread.get(p.threadId) ?? [];
    list.push(personName({ givenName: p.givenName, fatherName: p.fatherName }));
    namesByThread.set(p.threadId, list);
  }

  // Latest message per thread, for the preview.
  const latest = await ctx.db
    .select({
      threadId: messages.threadId,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.schoolId, ctx.schoolId),
        inArray(messages.threadId, threadIds),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.createdAt));

  const previewByThread = new Map<string, string>();
  for (const m of latest) {
    if (!previewByThread.has(m.threadId)) {
      previewByThread.set(m.threadId, m.body.slice(0, 120));
    }
  }

  // Unread counts: messages newer than the participant's own last read mark,
  // not counting their own messages.
  const unreadRows = await ctx.db
    .select({
      threadId: messages.threadId,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.threadId, messages.threadId),
        eq(messageParticipants.userId, ctx.user.userId),
        eq(messageParticipants.schoolId, ctx.schoolId),
      ),
    )
    .where(
      and(
        eq(messages.schoolId, ctx.schoolId),
        inArray(messages.threadId, threadIds),
        isNull(messages.deletedAt),
        ne(messages.senderId, ctx.user.userId),
        or(
          isNull(messageParticipants.lastReadAt),
          sql`${messages.createdAt} > ${messageParticipants.lastReadAt}`,
        ),
      ),
    )
    .groupBy(messages.threadId);

  const unreadByThread = new Map(unreadRows.map((r) => [r.threadId, r.count]));

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    kind: r.kind,
    studentId: r.studentId,
    lastMessageAt: r.lastMessageAt,
    unreadCount: unreadByThread.get(r.id) ?? 0,
    participantNames: namesByThread.get(r.id) ?? [],
    lastMessagePreview: previewByThread.get(r.id) ?? null,
  }));
}

export type ThreadDetail = {
  id: string;
  subject: string;
  kind: string;
  studentId: string | null;
  participants: { userId: string; name: string }[];
  messages: {
    id: string;
    body: string;
    senderId: string | null;
    senderName: string | null;
    isMine: boolean;
    createdAt: Date;
  }[];
};

/** One conversation, with its history. Marks it read for this user. */
export async function getThread(ctx: AuthContext, threadId: string): Promise<ThreadDetail> {
  await assertThreadAccess(ctx, threadId);

  const [thread] = await ctx.db
    .select({
      id: messageThreads.id,
      subject: messageThreads.subject,
      kind: messageThreads.kind,
      studentId: messageThreads.studentId,
    })
    .from(messageThreads)
    .where(and(eq(messageThreads.schoolId, ctx.schoolId), eq(messageThreads.id, threadId)))
    .limit(1);

  if (!thread) throw new CommsError('Conversation not found', 404);

  const participantRows = await ctx.db
    .select({
      userId: users.id,
      givenName: users.givenName,
      fatherName: users.fatherName,
    })
    .from(messageParticipants)
    .innerJoin(users, and(eq(users.id, messageParticipants.userId), eq(users.schoolId, ctx.schoolId)))
    .where(
      and(
        eq(messageParticipants.schoolId, ctx.schoolId),
        eq(messageParticipants.threadId, threadId),
      ),
    );

  const messageRows = await ctx.db
    .select({
      id: messages.id,
      body: messages.body,
      senderId: messages.senderId,
      createdAt: messages.createdAt,
      givenName: users.givenName,
      fatherName: users.fatherName,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(
      and(
        eq(messages.schoolId, ctx.schoolId),
        eq(messages.threadId, threadId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(messages.createdAt);

  // Opening a thread is what marks it read.
  await ctx.db
    .update(messageParticipants)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(messageParticipants.schoolId, ctx.schoolId),
        eq(messageParticipants.threadId, threadId),
        eq(messageParticipants.userId, ctx.user.userId),
      ),
    );

  return {
    id: thread.id,
    subject: thread.subject,
    kind: thread.kind,
    studentId: thread.studentId,
    participants: participantRows.map((p) => ({
      userId: p.userId,
      name: personName({ givenName: p.givenName, fatherName: p.fatherName }),
    })),
    messages: messageRows.map((m) => ({
      id: m.id,
      body: m.body,
      senderId: m.senderId,
      senderName: m.givenName
        ? personName({ givenName: m.givenName, fatherName: m.fatherName })
        : null,
      isMine: m.senderId === ctx.user.userId,
      createdAt: m.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Start a conversation. */
export async function createThread(
  ctx: AuthContext,
  input: CreateThreadInput,
): Promise<{ id: string }> {
  ctx.require('message.send');

  const recipientIds = [...new Set(input.recipientUserIds)].filter(
    (id) => id !== ctx.user.userId,
  );
  if (recipientIds.length === 0) {
    throw new CommsError('Choose at least one recipient');
  }

  await assertCanInitiate(ctx, recipientIds);

  // The pupil a thread is about must be one the sender may actually see.
  let studentId: string | null = null;
  if (input.studentId) {
    const allowed = await ctx.canViewStudent(input.studentId);
    if (!allowed) throw new CommsError('Student not found', 404);
    studentId = input.studentId;
  }

  const [thread] = await ctx.db
    .insert(messageThreads)
    .values({
      schoolId: ctx.schoolId,
      subject: input.subject,
      kind: recipientIds.length > 1 ? 'group' : 'direct',
      studentId,
      createdBy: ctx.user.userId,
      lastMessageAt: new Date(),
    })
    .returning({ id: messageThreads.id });

  const created = thread!;

  await ctx.db.insert(messageParticipants).values([
    {
      schoolId: ctx.schoolId,
      threadId: created.id,
      userId: ctx.user.userId,
      lastReadAt: new Date(),
    },
    ...recipientIds.map((userId) => ({
      schoolId: ctx.schoolId,
      threadId: created.id,
      userId,
    })),
  ]);

  await ctx.db.insert(messages).values({
    schoolId: ctx.schoolId,
    threadId: created.id,
    senderId: ctx.user.userId,
    body: input.body,
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'message.threadCreate',
    entityType: 'messageThread',
    entityId: created.id,
    summary: `Started conversation "${input.subject}" with ${recipientIds.length} recipient(s)`,
    ipAddress: ctx.ipAddress,
  });

  await notifyRecipients(ctx, created.id, recipientIds, input.body);

  return created;
}

/** Post to an existing thread. */
export async function sendMessage(
  ctx: AuthContext,
  input: SendMessageInput,
): Promise<{ id: string; duplicate: boolean }> {
  ctx.require('message.send');
  await assertThreadAccess(ctx, input.threadId);

  // Idempotency for a double-tapped send button: the same author posting the
  // identical body to the same thread within a minute is treated as a repeat.
  if (input.clientKey || true) {
    const [recent] = await ctx.db
      .select({ id: messages.id, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.schoolId, ctx.schoolId),
          eq(messages.threadId, input.threadId),
          eq(messages.senderId, ctx.user.userId),
          eq(messages.body, input.body),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);

    if (recent && Date.now() - recent.createdAt.getTime() < 60_000) {
      return { id: recent.id, duplicate: true };
    }
  }

  const [row] = await ctx.db
    .insert(messages)
    .values({
      schoolId: ctx.schoolId,
      threadId: input.threadId,
      senderId: ctx.user.userId,
      body: input.body,
    })
    .returning({ id: messages.id });

  const created = row!;

  await ctx.db
    .update(messageThreads)
    .set({ lastMessageAt: new Date() })
    .where(and(eq(messageThreads.schoolId, ctx.schoolId), eq(messageThreads.id, input.threadId)));

  await ctx.db
    .update(messageParticipants)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(messageParticipants.schoolId, ctx.schoolId),
        eq(messageParticipants.threadId, input.threadId),
        eq(messageParticipants.userId, ctx.user.userId),
      ),
    );

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'message.send',
    entityType: 'messageThread',
    entityId: input.threadId,
    summary: 'Sent a message',
    ipAddress: ctx.ipAddress,
  });

  const others = await ctx.db
    .select({ userId: messageParticipants.userId })
    .from(messageParticipants)
    .where(
      and(
        eq(messageParticipants.schoolId, ctx.schoolId),
        eq(messageParticipants.threadId, input.threadId),
        ne(messageParticipants.userId, ctx.user.userId),
        isNull(messageParticipants.leftAt),
      ),
    );

  await notifyRecipients(
    ctx,
    input.threadId,
    others.map((o) => o.userId),
    input.body,
  );

  return { id: created.id, duplicate: false };
}

/** Tell the other participants, in their own language. */
async function notifyRecipients(
  ctx: AuthContext,
  threadId: string,
  recipientIds: string[],
  body: string,
): Promise<void> {
  if (recipientIds.length === 0) return;

  const localeRows = await ctx.db
    .select({ id: users.id, locale: users.locale })
    .from(users)
    .where(and(eq(users.schoolId, ctx.schoolId), inArray(users.id, recipientIds)));

  const senderName = ctx.displayName();
  const preview = body.slice(0, 120);

  const inputs = [];
  for (const person of localeRows) {
    const rendered = await renderTemplate(
      ctx.db,
      ctx.schoolId,
      'message',
      'inApp',
      (person.locale as Locale) ?? 'en',
      { senderName, preview },
    );
    inputs.push({
      userId: person.id,
      type: 'message',
      title: rendered.title,
      body: rendered.body,
      linkPath: `/messages/${threadId}`,
      // No dedupe key: every message is genuinely a new notification.
      dedupeKey: null,
    });
  }

  await createNotifications(ctx.db, ctx.schoolId, inputs);
}

/** Total unread messages across the user's threads, for the nav badge. */
export async function countUnreadMessages(ctx: AuthContext): Promise<number> {
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.threadId, messages.threadId),
        eq(messageParticipants.userId, ctx.user.userId),
        eq(messageParticipants.schoolId, ctx.schoolId),
      ),
    )
    .where(
      and(
        eq(messages.schoolId, ctx.schoolId),
        isNull(messages.deletedAt),
        isNull(messageParticipants.leftAt),
        ne(messages.senderId, ctx.user.userId),
        or(
          isNull(messageParticipants.lastReadAt),
          sql`${messages.createdAt} > ${messageParticipants.lastReadAt}`,
        ),
      ),
    );

  return row?.count ?? 0;
}

/** Unread in-app notifications, for the nav badge. */
export async function countUnreadNotifications(ctx: AuthContext): Promise<number> {
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.schoolId, ctx.schoolId),
        eq(notifications.userId, ctx.user.userId),
        isNull(notifications.readAt),
      ),
    );
  return row?.count ?? 0;
}
