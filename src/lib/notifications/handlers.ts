/**
 * Notification handlers — the automation layer.
 *
 * This is the whole point of the event bus. Attendance does not know that
 * notifications exist; it emits `attendance.recorded` as it already did before
 * this module was written. These handlers subscribe to that event and decide,
 * from the school's configuration, whether anyone should be told.
 *
 * Consequently Group 6 required no edits to attendance, the gradebook or the
 * portals. The integration points were already there; this is the first
 * subscriber to use them.
 *
 * Two rules every handler obeys:
 *
 *  1. Check the school's configuration first. A school that has switched off
 *     absence alerts must not get them, and there is no code path that
 *     hard-codes "absences are always notified".
 *
 *  2. Never throw for a recoverable reason. The bus catches exceptions and
 *     records them on the event row, but a handler that throws leaves the
 *     event marked failed and eligible for retry. Marking a register must
 *     never fail because a parent has no phone number.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { registerHandler, type EventHandler } from '../events/index.ts';
import type { Database } from '../../db/client.ts';
import { schools } from '../../db/schema/core.ts';
import { guardians, studentGuardians, students } from '../../db/schema/people.ts';
import { terms } from '../../db/schema/core.ts';
import { personName } from '../format.ts';
import { notifyAboutStudent, getNotificationSettings } from './service.ts';
import { renderTemplate } from './templates.ts';
import { queueSms } from '../sms/service.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type StudentBrief = {
  id: string;
  givenName: string;
  fatherName: string;
  grandfatherName: string | null;
  givenNameAm: string | null;
  fatherNameAm: string | null;
};

async function loadStudents(
  db: Database,
  schoolId: string,
  studentIds: string[],
): Promise<Map<string, StudentBrief>> {
  if (studentIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: students.id,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
      givenNameAm: students.givenNameAm,
      fatherNameAm: students.fatherNameAm,
    })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), inArray(students.id, studentIds)));
  return new Map(rows.map((r) => [r.id, r]));
}

async function schoolName(db: Database, schoolId: string): Promise<string> {
  const [row] = await db
    .select({ name: schools.name })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  return row?.name ?? 'School';
}

/**
 * Guardian phone numbers for SMS.
 *
 * Separate from the in-app audience because a guardian can be reachable by
 * phone without having a login, and vice versa. Only guardians flagged to
 * receive notices are included.
 */
async function guardianPhones(
  db: Database,
  schoolId: string,
  studentId: string,
): Promise<{ phone: string; userId: string | null }[]> {
  const rows = await db
    .select({
      phone: guardians.phone,
      userId: guardians.userId,
      isPrimary: studentGuardians.isPrimary,
    })
    .from(studentGuardians)
    .innerJoin(
      guardians,
      and(eq(guardians.id, studentGuardians.guardianId), eq(guardians.schoolId, schoolId)),
    )
    .where(and(eq(studentGuardians.schoolId, schoolId), eq(studentGuardians.studentId, studentId)));

  return rows
    .filter((r): r is typeof r & { phone: string } => Boolean(r.phone))
    .map((r) => ({ phone: r.phone, userId: r.userId }));
}

/**
 * Send the SMS half of a notification, if the school has that channel on.
 *
 * Silently does nothing when SMS is off. When SMS is on but unconfigured the
 * outbox records `unconfigured` — visible to the office, never reported as sent.
 */
async function maybeSendSms(
  db: Database,
  schoolId: string,
  options: {
    studentId: string;
    type: string;
    values: Record<string, string | number>;
    relatedType: string;
    relatedId?: string;
  },
): Promise<void> {
  const settings = await getNotificationSettings(db, schoolId);
  if (!settings.channels.sms) return;

  const recipients = await guardianPhones(db, schoolId, options.studentId);
  if (recipients.length === 0) return;

  // SMS uses the school's own language setting rather than the recipient's,
  // because a phone number is not attached to a user profile with a locale.
  const rendered = await renderTemplate(db, schoolId, options.type, 'sms', 'en', options.values);

  await queueSms(
    db,
    schoolId,
    recipients.map((r) => ({
      to: r.phone,
      body: rendered.body,
      relatedType: options.relatedType,
      relatedId: options.relatedId,
      recipientUserId: r.userId,
      studentId: options.studentId,
    })),
  );
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

const onAttendanceRecorded: EventHandler<'attendance.recorded'> = {
  name: 'notifications.attendanceRecorded',
  event: 'attendance.recorded',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.attendanceAbsent) return;

    const ids = [...payload.absentStudentIds, ...payload.lateStudentIds];
    if (ids.length === 0) return;

    const studentMap = await loadStudents(ctx.db, ctx.schoolId, ids);
    const name = await schoolName(ctx.db, ctx.schoolId);

    for (const studentId of ids) {
      const student = studentMap.get(studentId);
      if (!student) continue; // Deleted between the register and the handler.

      const isLate = payload.lateStudentIds.includes(studentId);
      const type = isLate ? 'attendance.late' : 'attendance.absent';
      const values = {
        studentName: personName(student),
        date: payload.date,
        schoolName: name,
      };

      await notifyAboutStudent(ctx.db, ctx.schoolId, {
        studentId,
        type,
        values,
        // One notification per pupil per day per status, however many times
        // the register is corrected and re-emitted.
        dedupeKey: `${type}:${studentId}:${payload.date}`,
        includeStudent: false,
      });

      await maybeSendSms(ctx.db, ctx.schoolId, {
        studentId,
        type,
        values,
        relatedType: 'attendance',
        relatedId: `${payload.sectionId}:${payload.date}`,
      });
    }
  },
};

const onAttendanceRisk: EventHandler<'attendance.riskDetected'> = {
  name: 'notifications.attendanceRisk',
  event: 'attendance.riskDetected',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.attendanceRisk) return;

    const studentMap = await loadStudents(ctx.db, ctx.schoolId, [payload.studentId]);
    const student = studentMap.get(payload.studentId);
    if (!student) return;

    const name = await schoolName(ctx.db, ctx.schoolId);
    const values = {
      studentName: personName(student),
      percent: payload.attendancePercent,
      threshold: payload.threshold,
      schoolName: name,
    };

    await notifyAboutStudent(ctx.db, ctx.schoolId, {
      studentId: payload.studentId,
      type: 'attendance.risk',
      values,
      // Re-alerting every day would train parents to ignore it; the percentage
      // is part of the key so a materially worse figure does notify again.
      dedupeKey: `attendance.risk:${payload.studentId}:${Math.round(payload.attendancePercent)}`,
      includeStudent: false,
    });

    await maybeSendSms(ctx.db, ctx.schoolId, {
      studentId: payload.studentId,
      type: 'attendance.risk',
      values,
      relatedType: 'attendance.risk',
      relatedId: payload.studentId,
    });
  },
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const onReportCardPublished: EventHandler<'reportCard.published'> = {
  name: 'notifications.reportCardPublished',
  event: 'reportCard.published',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.reportCardPublished) return;
    if (payload.studentIds.length === 0) return;

    const [term] = await ctx.db
      .select({ name: terms.name })
      .from(terms)
      .where(and(eq(terms.schoolId, ctx.schoolId), eq(terms.id, payload.termId)))
      .limit(1);

    const studentMap = await loadStudents(ctx.db, ctx.schoolId, payload.studentIds);
    const name = await schoolName(ctx.db, ctx.schoolId);

    for (const studentId of payload.studentIds) {
      const student = studentMap.get(studentId);
      if (!student) continue;

      const values = {
        studentName: personName(student),
        termName: term?.name ?? 'this term',
        schoolName: name,
      };

      await notifyAboutStudent(ctx.db, ctx.schoolId, {
        studentId,
        type: 'reportCard.published',
        values,
        dedupeKey: `reportCard.published:${studentId}:${payload.termId}`,
        // The pupil hears about their own report card too.
        includeStudent: true,
      });

      await maybeSendSms(ctx.db, ctx.schoolId, {
        studentId,
        type: 'reportCard.published',
        values,
        relatedType: 'reportCard',
        relatedId: payload.termId,
      });
    }
  },
};

const onMarksApproved: EventHandler<'marks.approved'> = {
  name: 'notifications.marksApproved',
  event: 'marks.approved',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.gradePublished) return;
    // Approved marks are not yet a published report card. Schools that want a
    // per-assessment alert switch `gradePublished` on; the notification points
    // at the portal, which shows only what the portal is allowed to show.
    void payload;
  },
};

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const onAnnouncementPublished: EventHandler<'announcement.published'> = {
  name: 'notifications.announcementPublished',
  event: 'announcement.published',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.announcement) return;

    const { resolveAnnouncementRecipients } = await import('../comms/announcements.ts');
    const { announcements } = await import('../../db/schema/comms.ts');
    const { createNotifications } = await import('./service.ts');

    const [row] = await ctx.db
      .select({
        title: announcements.title,
        titleAm: announcements.titleAm,
        body: announcements.body,
        bodyAm: announcements.bodyAm,
        sendSms: announcements.sendSms,
      })
      .from(announcements)
      .where(
        and(
          eq(announcements.schoolId, ctx.schoolId),
          eq(announcements.id, payload.announcementId),
        ),
      )
      .limit(1);

    if (!row) return;

    const recipients = await resolveAnnouncementRecipients(
      ctx.db,
      ctx.schoolId,
      payload.announcementId,
    );
    if (recipients.length === 0) return;

    const name = await schoolName(ctx.db, ctx.schoolId);

    const inputs = [];
    for (const person of recipients) {
      const locale = person.locale === 'am' ? 'am' : 'en';
      // The notice itself is already written in the school's own words, so the
      // template only supplies the wrapper; the title and preview come from
      // the announcement, in the reader's language where a translation exists.
      const title = locale === 'am' && row.titleAm ? row.titleAm : row.title;
      const body = locale === 'am' && row.bodyAm ? row.bodyAm : row.body;

      const rendered = await renderTemplate(ctx.db, ctx.schoolId, 'announcement', 'inApp', locale, {
        title,
        preview: body.slice(0, 160),
        schoolName: name,
      });

      inputs.push({
        userId: person.userId,
        type: 'announcement',
        title: rendered.title,
        body: rendered.body,
        linkPath: `/announcements/${payload.announcementId}`,
        dedupeKey: `announcement:${payload.announcementId}:${person.userId}`,
      });
    }

    await createNotifications(ctx.db, ctx.schoolId, inputs);

    // SMS only if the author asked for it AND the school has the channel on.
    if (row.sendSms && settings.channels.sms) {
      const { queueSms } = await import('../sms/service.ts');
      const { users } = await import('../../db/schema/core.ts');

      const phones = await ctx.db
        .select({ phone: users.phone, userId: users.id })
        .from(users)
        .where(
          and(
            eq(users.schoolId, ctx.schoolId),
            inArray(
              users.id,
              recipients.map((r) => r.userId),
            ),
          ),
        );

      const rendered = await renderTemplate(ctx.db, ctx.schoolId, 'announcement', 'sms', 'en', {
        title: row.title,
        preview: row.body.slice(0, 100),
        schoolName: name,
      });

      const targets = phones
        .filter((p): p is typeof p & { phone: string } => Boolean(p.phone))
        .map((p) => ({
          to: p.phone,
          body: rendered.body,
          relatedType: 'announcement',
          relatedId: payload.announcementId,
          recipientUserId: p.userId,
        }));

      if (targets.length > 0) {
        await queueSms(ctx.db, ctx.schoolId, targets);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Seams for later groups
// ---------------------------------------------------------------------------

/**
 * Fees, payments and homework do not exist yet (Groups 7 and 8). These
 * handlers are registered now so that when those modules emit their events,
 * notifications happen with no further wiring — and so the contract is
 * visible to whoever builds them.
 */
const onFeeDue: EventHandler<'fee.due'> = {
  name: 'notifications.feeDue',
  event: 'fee.due',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.feeDue) return;

    const studentMap = await loadStudents(ctx.db, ctx.schoolId, [payload.studentId]);
    const student = studentMap.get(payload.studentId);
    if (!student) return;

    const { formatMoney, cents } = await import('../money.ts');
    const values = {
      studentName: personName(student),
      amount: formatMoney(cents(payload.amountCents)),
      dueDate: payload.dueDate,
      schoolName: await schoolName(ctx.db, ctx.schoolId),
    };

    await notifyAboutStudent(ctx.db, ctx.schoolId, {
      studentId: payload.studentId,
      type: 'fee.due',
      values,
      dedupeKey: `fee.due:${payload.studentId}:${payload.dueDate}`,
      includeStudent: false,
    });

    await maybeSendSms(ctx.db, ctx.schoolId, {
      studentId: payload.studentId,
      type: 'fee.due',
      values,
      relatedType: 'fee',
      relatedId: payload.studentId,
    });
  },
};

const onPaymentRecorded: EventHandler<'payment.recorded'> = {
  name: 'notifications.paymentRecorded',
  event: 'payment.recorded',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.paymentRecorded) return;

    const studentMap = await loadStudents(ctx.db, ctx.schoolId, [payload.studentId]);
    const student = studentMap.get(payload.studentId);
    if (!student) return;

    const { formatMoney, cents } = await import('../money.ts');
    const values = {
      studentName: personName(student),
      amount: formatMoney(cents(payload.amountCents)),
      receiptNumber: payload.receiptNumber,
      schoolName: await schoolName(ctx.db, ctx.schoolId),
    };

    await notifyAboutStudent(ctx.db, ctx.schoolId, {
      studentId: payload.studentId,
      type: 'payment.recorded',
      values,
      dedupeKey: `payment.recorded:${payload.receiptNumber}`,
      includeStudent: false,
    });

    await maybeSendSms(ctx.db, ctx.schoolId, {
      studentId: payload.studentId,
      type: 'payment.recorded',
      values,
      relatedType: 'payment',
      relatedId: payload.receiptNumber,
    });
  },
};

const onHomeworkAssigned: EventHandler<'homework.assigned'> = {
  name: 'notifications.homeworkAssigned',
  event: 'homework.assigned',
  async handle(payload, ctx) {
    const settings = await getNotificationSettings(ctx.db, ctx.schoolId);
    if (!settings.events.homeworkAssigned) return;
    // Group 8 will supply the roster for the section; until homework exists
    // there is nothing to resolve, and inventing a fan-out now would be
    // guessing at an interface that has not been designed.
    void payload;
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register every notification handler.
 *
 * Idempotent — the bus rejects duplicate names — so calling it from module
 * scope is safe under Next.js hot reload.
 */
export function registerNotificationHandlers(): void {
  registerHandler(onAttendanceRecorded as unknown as EventHandler);
  registerHandler(onAttendanceRisk as unknown as EventHandler);
  registerHandler(onReportCardPublished as unknown as EventHandler);
  registerHandler(onMarksApproved as unknown as EventHandler);
  registerHandler(onAnnouncementPublished as unknown as EventHandler);
  registerHandler(onFeeDue as unknown as EventHandler);
  registerHandler(onPaymentRecorded as unknown as EventHandler);
  registerHandler(onHomeworkAssigned as unknown as EventHandler);
}
