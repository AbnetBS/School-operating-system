/**
 * SMS outbox.
 *
 * Messages are always recorded, whether or not they can be sent. That is the
 * point: a school with no provider still has a queue it can inspect, and can
 * see exactly what *would* have gone out. When a provider is connected later,
 * `flushQueued` drains the backlog.
 *
 * Nothing here ever marks a message `sent` unless a provider returned a
 * reference. The database enforces that too (0007_comms_integrity.sql).
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { smsMessages } from '../../db/schema/comms.ts';
import { getSetting } from '../settings/service.ts';
import { normalisePhone } from '../students/schema.ts';
import {
  resolveSmsAvailability,
  type SmsProviderConfig,
  type SmsAvailability,
} from './provider.ts';

export type QueueSmsInput = {
  to: string;
  body: string;
  relatedType?: string;
  relatedId?: string;
  recipientUserId?: string | null;
  studentId?: string | null;
};

/**
 * Read the school's SMS configuration.
 *
 * Lives under the `notifications` settings group rather than its own, because
 * SMS is a delivery channel for notifications and schools think of it that way.
 */
export async function getSmsConfig(
  db: Database,
  schoolId: string,
): Promise<SmsProviderConfig | null> {
  const notifications = await getSetting(db, schoolId, 'notifications');
  const sms = (notifications as unknown as { sms?: Partial<SmsProviderConfig> }).sms;
  if (!sms || !sms.provider) {
    return { provider: 'none', isEnabled: false };
  }
  return {
    provider: sms.provider,
    senderId: sms.senderId,
    apiKeyRef: sms.apiKeyRef,
    endpoint: sms.endpoint,
    isEnabled: Boolean(sms.isEnabled),
  };
}

export async function checkSmsAvailability(
  db: Database,
  schoolId: string,
): Promise<SmsAvailability> {
  return resolveSmsAvailability(await getSmsConfig(db, schoolId));
}

/**
 * Queue messages and attempt delivery if a provider is available.
 *
 * Returns a per-status breakdown so callers can report honestly. Invalid
 * numbers are counted separately rather than silently dropped — a parent with
 * a mistyped phone number is a data problem the office needs to see.
 */
export async function queueSms(
  db: Database,
  schoolId: string,
  requests: QueueSmsInput[],
): Promise<{
  queued: number;
  sent: number;
  failed: number;
  unconfigured: number;
  invalidNumbers: number;
  availability: SmsAvailability;
}> {
  const availability = await checkSmsAvailability(db, schoolId);

  let invalidNumbers = 0;
  const rows: {
    schoolId: string;
    toPhone: string;
    body: string;
    status: string;
    relatedType: string | null;
    relatedId: string | null;
    recipientUserId: string | null;
    studentId: string | null;
  }[] = [];

  for (const request of requests) {
    const phone = normalisePhone(request.to);
    if (!phone) {
      invalidNumbers++;
      continue;
    }
    rows.push({
      schoolId,
      toPhone: phone,
      body: request.body.slice(0, 1600),
      // Without a provider the message is parked as `unconfigured`, never
      // `queued` — "queued" implies something will pick it up.
      status: availability.available ? 'queued' : 'unconfigured',
      relatedType: request.relatedType ?? null,
      relatedId: request.relatedId ?? null,
      recipientUserId: request.recipientUserId ?? null,
      studentId: request.studentId ?? null,
    });
  }

  if (rows.length === 0) {
    return { queued: 0, sent: 0, failed: 0, unconfigured: 0, invalidNumbers, availability };
  }

  const inserted = await db
    .insert(smsMessages)
    .values(rows)
    .returning({ id: smsMessages.id, toPhone: smsMessages.toPhone, body: smsMessages.body });

  if (!availability.available) {
    return {
      queued: 0,
      sent: 0,
      failed: 0,
      unconfigured: inserted.length,
      invalidNumbers,
      availability,
    };
  }

  let sent = 0;
  let failed = 0;
  for (const row of inserted) {
    const result = await attemptSend(db, schoolId, row, availability);
    if (result) sent++;
    else failed++;
  }

  return { queued: 0, sent, failed, unconfigured: 0, invalidNumbers, availability };
}

/** Try one message. Returns true only when a provider accepted it. */
async function attemptSend(
  db: Database,
  schoolId: string,
  row: { id: string; toPhone: string; body: string },
  availability: Extract<SmsAvailability, { available: true }>,
): Promise<boolean> {
  try {
    const result = await availability.provider.send(
      { to: row.toPhone, body: row.body },
      availability.config,
    );

    if (result.ok) {
      await db
        .update(smsMessages)
        .set({
          status: 'sent',
          provider: availability.provider.key,
          providerRef: result.providerRef,
          sentAt: new Date(),
          error: null,
          attempts: sql`(${smsMessages.attempts}::int + 1)::text`,
        })
        .where(and(eq(smsMessages.schoolId, schoolId), eq(smsMessages.id, row.id)));
      return true;
    }

    await db
      .update(smsMessages)
      .set({
        status: 'failed',
        provider: availability.provider.key,
        error: result.error.slice(0, 500),
        attempts: sql`(${smsMessages.attempts}::int + 1)::text`,
      })
      .where(and(eq(smsMessages.schoolId, schoolId), eq(smsMessages.id, row.id)));
    return false;
  } catch (error) {
    // A provider throwing must not take down the caller — sending an absence
    // alert is never worth failing the attendance submission for.
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(smsMessages)
      .set({
        status: 'failed',
        provider: availability.provider.key,
        error: message.slice(0, 500),
        attempts: sql`(${smsMessages.attempts}::int + 1)::text`,
      })
      .where(and(eq(smsMessages.schoolId, schoolId), eq(smsMessages.id, row.id)));
    return false;
  }
}

/**
 * Drain messages parked while no provider was available.
 *
 * Called after a school connects a provider, or from a scheduled job.
 */
export async function flushQueued(
  db: Database,
  schoolId: string,
  options: { limit?: number } = {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  const availability = await checkSmsAvailability(db, schoolId);
  if (!availability.available) {
    return { sent: 0, failed: 0, skipped: 0 };
  }

  const pending = await db
    .select({ id: smsMessages.id, toPhone: smsMessages.toPhone, body: smsMessages.body })
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.schoolId, schoolId),
        inArray(smsMessages.status, ['queued', 'unconfigured']),
      ),
    )
    .orderBy(asc(smsMessages.createdAt))
    .limit(options.limit ?? 100);

  let sent = 0;
  let failed = 0;
  for (const row of pending) {
    if (await attemptSend(db, schoolId, row, availability)) sent++;
    else failed++;
  }
  return { sent, failed, skipped: 0 };
}

/** Outbox summary for the settings screen. */
export async function getSmsSummary(
  db: Database,
  schoolId: string,
): Promise<{ status: string; count: number }[]> {
  return db
    .select({
      status: smsMessages.status,
      count: sql<number>`count(*)::int`,
    })
    .from(smsMessages)
    .where(eq(smsMessages.schoolId, schoolId))
    .groupBy(smsMessages.status);
}

/** Recent outbox rows, newest first. */
export async function listSmsMessages(
  db: Database,
  schoolId: string,
  options: { limit?: number; status?: string } = {},
) {
  const conditions = [eq(smsMessages.schoolId, schoolId)];
  if (options.status) conditions.push(eq(smsMessages.status, options.status));

  return db
    .select({
      id: smsMessages.id,
      toPhone: smsMessages.toPhone,
      body: smsMessages.body,
      status: smsMessages.status,
      provider: smsMessages.provider,
      error: smsMessages.error,
      relatedType: smsMessages.relatedType,
      createdAt: smsMessages.createdAt,
      sentAt: smsMessages.sentAt,
    })
    .from(smsMessages)
    .where(and(...conditions))
    .orderBy(sql`${smsMessages.createdAt} desc`)
    .limit(options.limit ?? 50);
}
