/**
 * In-app notifications.
 *
 * A notification is a personal fact addressed to one user, so it is stored per
 * recipient with its own read state. Creation is idempotent on `dedupeKey`:
 * the event bus retries failed handlers, and a parent must not be told twice
 * that their child was absent once.
 *
 * Recipient resolution reuses the relationships Groups 2–5 already established.
 * There is no separate notion of "who is a parent" here.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { notifications } from '../../db/schema/comms.ts';
import { users } from '../../db/schema/core.ts';
import { guardians, studentGuardians, students } from '../../db/schema/people.ts';
import { getSetting } from '../settings/service.ts';
import type { Locale } from '../i18n/types.ts';
import { renderTemplate } from './templates.ts';
import type { NotificationSettings } from '../settings/schemas.ts';

export type NotifyInput = {
  userId: string;
  type: string;
  title: string;
  body: string;
  linkPath?: string | null;
  studentId?: string | null;
  dedupeKey?: string | null;
};

/**
 * Write notifications, skipping any that already exist.
 *
 * Uses ON CONFLICT DO NOTHING against the partial unique index on
 * (school, user, dedupeKey), so concurrent handlers cannot race a duplicate in.
 * Rows without a dedupe key are always inserted — that is the caller saying
 * "this is a genuinely new event every time".
 */
export async function createNotifications(
  db: Database,
  schoolId: string,
  inputs: NotifyInput[],
): Promise<{ created: number; skipped: number }> {
  if (inputs.length === 0) return { created: 0, skipped: 0 };

  const rows = inputs.map((n) => ({
    schoolId,
    userId: n.userId,
    type: n.type,
    title: n.title.slice(0, 200),
    body: n.body,
    linkPath: n.linkPath ?? null,
    studentId: n.studentId ?? null,
    dedupeKey: n.dedupeKey ?? null,
  }));

  const inserted = await db
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: notifications.id });

  return { created: inserted.length, skipped: rows.length - inserted.length };
}

/**
 * Is this school configured to send notifications for this kind of event?
 *
 * Schools differ: a small primary may want a message for every absence, a
 * large secondary only for sustained risk. The answer is configuration, never
 * a code branch on school name.
 */
export function isEventEnabled(
  settings: NotificationSettings,
  event: keyof NotificationSettings['events'],
): boolean {
  return settings.events[event] !== false;
}

/**
 * The user accounts that should hear about something concerning a student.
 *
 * Returns guardians who have a login, plus the pupil's own account when they
 * have one. A guardian without a user account is not returned — they cannot
 * receive an in-app notification — but they are still reachable over SMS,
 * which is why the SMS path resolves phone numbers separately.
 */
export async function resolveStudentAudience(
  db: Database,
  schoolId: string,
  studentId: string,
  options: { includeStudent?: boolean } = {},
): Promise<{ userId: string; locale: Locale; isStudent: boolean }[]> {
  const guardianRows = await db
    .select({ userId: guardians.userId, locale: users.locale })
    .from(studentGuardians)
    .innerJoin(
      guardians,
      and(eq(guardians.id, studentGuardians.guardianId), eq(guardians.schoolId, schoolId)),
    )
    .leftJoin(users, eq(users.id, guardians.userId))
    .where(
      and(eq(studentGuardians.schoolId, schoolId), eq(studentGuardians.studentId, studentId)),
    );

  const audience: { userId: string; locale: Locale; isStudent: boolean }[] = [];
  for (const row of guardianRows) {
    if (!row.userId) continue;
    audience.push({
      userId: row.userId,
      locale: (row.locale as Locale) ?? 'en',
      isStudent: false,
    });
  }

  if (options.includeStudent !== false) {
    const [student] = await db
      .select({ userId: students.userId, locale: users.locale })
      .from(students)
      .leftJoin(users, eq(users.id, students.userId))
      .where(and(eq(students.schoolId, schoolId), eq(students.id, studentId)))
      .limit(1);
    if (student?.userId) {
      audience.push({
        userId: student.userId,
        locale: (student.locale as Locale) ?? 'en',
        isStudent: true,
      });
    }
  }

  // A guardian linked twice (two children in one notification batch) would
  // otherwise be told twice in the same breath.
  const seen = new Set<string>();
  return audience.filter((a) => (seen.has(a.userId) ? false : (seen.add(a.userId), true)));
}

/**
 * Render and deliver a templated notification to everyone connected to a pupil.
 *
 * Each recipient gets the text in their own language, because a school can
 * have Amharic-reading parents and English-reading ones at the same time.
 */
export async function notifyAboutStudent(
  db: Database,
  schoolId: string,
  options: {
    studentId: string;
    type: string;
    values: Record<string, string | number>;
    linkPath?: string;
    dedupeKey?: string;
    includeStudent?: boolean;
  },
): Promise<{ created: number; skipped: number }> {
  const audience = await resolveStudentAudience(db, schoolId, options.studentId, {
    includeStudent: options.includeStudent,
  });
  if (audience.length === 0) return { created: 0, skipped: 0 };

  const inputs: NotifyInput[] = [];
  for (const person of audience) {
    const rendered = await renderTemplate(
      db,
      schoolId,
      options.type,
      'inApp',
      person.locale,
      options.values,
    );
    inputs.push({
      userId: person.userId,
      type: options.type,
      title: rendered.title,
      body: rendered.body,
      linkPath:
        options.linkPath ??
        (person.isStudent ? '/portal/student' : `/portal/parent?studentId=${options.studentId}`),
      studentId: options.studentId,
      dedupeKey: options.dedupeKey ? `${options.dedupeKey}:${person.userId}` : null,
    });
  }

  return createNotifications(db, schoolId, inputs);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  linkPath: string | null;
  studentId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

/**
 * A user's own notifications.
 *
 * Scoped by both school and user id — the caller cannot ask for someone
 * else's, because there is no parameter that would let them.
 */
export async function listNotifications(
  db: Database,
  schoolId: string,
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const conditions = [eq(notifications.schoolId, schoolId), eq(notifications.userId, userId)];
  if (options.unreadOnly) conditions.push(isNull(notifications.readAt));

  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkPath: notifications.linkPath,
      studentId: notifications.studentId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(options.limit ?? 30, 100));
}

export async function countUnread(
  db: Database,
  schoolId: string,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.schoolId, schoolId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Mark notifications read.
 *
 * The user id is part of the WHERE clause, so passing another person's
 * notification id marks nothing rather than touching their row.
 */
export async function markNotificationsRead(
  db: Database,
  schoolId: string,
  userId: string,
  notificationIds?: string[],
): Promise<number> {
  const conditions = [
    eq(notifications.schoolId, schoolId),
    eq(notifications.userId, userId),
    isNull(notifications.readAt),
  ];
  if (notificationIds && notificationIds.length > 0) {
    conditions.push(inArray(notifications.id, notificationIds));
  } else if (notificationIds) {
    // An explicit empty list means "nothing", not "everything".
    return 0;
  }

  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id });

  return updated.length;
}

/** The school's notification preferences, with defaults applied. */
export async function getNotificationSettings(
  db: Database,
  schoolId: string,
): Promise<NotificationSettings> {
  return getSetting(db, schoolId, 'notifications');
}
