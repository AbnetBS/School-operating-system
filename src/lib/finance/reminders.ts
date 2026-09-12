/**
 * Fee reminders.
 *
 * Finance does not send anything. It emits `fee.due` domain events and stops.
 * The notification engine built in Group 6 already has a registered handler
 * (`onFeeDue`) which decides — from the school's own notification settings —
 * whether to create an in-app notification, queue an SMS, or do nothing at all.
 *
 * This preserves the rule that no module imports another: finance knows about
 * charges and dates, the notification module knows about people and channels,
 * and the event bus is the only thing between them.
 *
 * Duplicate suppression is not implemented here either. The notification
 * layer's `dedupe_key` already guarantees that running this sweep twice in a
 * day produces one reminder, not two.
 */

import type { AuthContext } from '../auth/context.ts';
import { emitEvent } from '../events/index.ts';
import { getSetting } from '../settings/service.ts';
import { getDueCharges } from './reports.ts';

export type ReminderRun = {
  scanned: number;
  emitted: number;
  windowDays: number;
};

/**
 * Emit `fee.due` for every charge falling due inside the school's configured
 * reminder window, and for everything already overdue.
 *
 * Safe to run repeatedly — it is intended to be called from a scheduler, and
 * the dedupe key means a second run the same day is a no-op.
 */
export async function sweepDueReminders(
  ctx: AuthContext,
  options: { overdueOnly?: boolean } = {},
): Promise<ReminderRun> {
  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');
  const windowDays = finance.reminderDaysBefore;

  const due = await getDueCharges(ctx, {
    withinDays: windowDays,
    overdueOnly: options.overdueOnly,
    limit: 500,
  });

  let emitted = 0;
  for (const charge of due) {
    if (!charge.dueDate) continue;

    // One event per charge. A handler that throws is caught by the bus and
    // recorded on the event row; it must never stop the rest of the sweep.
    await emitEvent(ctx.db, ctx.schoolId, 'fee.due', {
      studentId: charge.studentId,
      amountCents: charge.outstandingCents,
      dueDate: charge.dueDate,
    });
    emitted += 1;
  }

  return { scanned: due.length, emitted, windowDays };
}
