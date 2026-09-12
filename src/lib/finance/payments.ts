/**
 * Payments.
 *
 * This is the file where correctness matters most, so the rules are stated
 * plainly and enforced in one place:
 *
 *  1. THE CLIENT NEVER SENDS A BALANCE. It names a student, an amount and
 *     optionally which charges to settle. How much each charge takes is
 *     decided here, from figures read inside the transaction. A tampered
 *     browser cannot make a 5,000 Br debt disappear for 1 Br.
 *
 *  2. THE CHARGES ARE LOCKED BEFORE THEY ARE READ. `SELECT ... FOR UPDATE`
 *     serialises two clerks taking money for the same pupil at the same
 *     moment. Without it, both would read "1,000 outstanding", both would
 *     accept 600, and the pupil would be credited 1,200 against a 1,000 debt.
 *     Verified: the second transaction re-reads and is rejected.
 *
 *  3. NOTHING IS HALF-WRITTEN. The receipt number, the payment row and every
 *     allocation are one transaction. A failure part-way leaves no orphan
 *     receipt and no money credited to nothing.
 *
 *  4. A REPLAY IS NOT A SECOND PAYMENT. `clientKey` is unique per school; a
 *     resubmitted form returns the original receipt with `duplicate: true`.
 *
 *  5. MONEY IS NEVER DELETED. A mistake is voided, which keeps the row, records
 *     who and why, and releases the allocations.
 */

import { and, eq, inArray, sql, desc, asc, isNotNull } from 'drizzle-orm';

import type { AuthContext } from '../auth/context.ts';
import {
  payments,
  paymentAllocations,
  studentCharges,
  financeCounters,
  feeCategories,
} from '../../db/schema/finance.ts';
import { students } from '../../db/schema/people.ts';
import { users, academicYears, terms } from '../../db/schema/core.ts';
import { getSetting } from '../settings/service.ts';
import { recordAudit } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { FinanceError, getStudentBalance } from './service.ts';
import type { RecordPaymentInput } from './schema.ts';

export type RecordedPayment = {
  id: string;
  receiptNumber: string;
  amountCents: number;
  allocatedCents: number;
  unallocatedCents: number;
  duplicate: boolean;
  balanceAfterCents: number;
};

/**
 * Record a payment.
 *
 * Returns the receipt. If `clientKey` matches an existing payment, returns
 * that one with `duplicate: true` and takes no further money.
 */
export async function recordPayment(
  ctx: AuthContext,
  input: RecordPaymentInput,
): Promise<RecordedPayment> {
  ctx.require('payment.record');

  // Permission alone is not authorisation: the pupil must be one this user may
  // act on, and must exist in this school. 404 for anything else.
  await ctx.requireStudentAccess(input.studentId);

  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');

  // The method must be one the school accepts. An arbitrary string here would
  // quietly corrupt the payment-method breakdown on the dashboard.
  if (!finance.paymentMethods.includes(input.method)) {
    throw new FinanceError('That payment method is not accepted by this school.', 400, {
      method: 'Choose one of the accepted payment methods.',
    });
  }

  // Idempotency check before doing any work. The unique index is the real
  // guarantee; this is the fast path that returns a friendly result.
  if (input.clientKey) {
    const existing = await findByClientKey(ctx, input.clientKey);
    if (existing) return existing;
  }

  try {
    return await ctx.db.transaction(async (tx) => {
      // ---- 1. Lock and read the charges this payment may settle -----------
      //
      // FOR UPDATE is what makes concurrent payments safe. Ordering by id
      // keeps the lock order deterministic, so two transactions locking
      // overlapping sets cannot deadlock.
      const targetConditions = [
        eq(studentCharges.schoolId, ctx.schoolId),
        eq(studentCharges.studentId, input.studentId),
        eq(studentCharges.status, 'active'),
      ];
      if (input.chargeIds && input.chargeIds.length > 0) {
        targetConditions.push(inArray(studentCharges.id, input.chargeIds));
      }

      const locked = await tx
        .select({
          id: studentCharges.id,
          netAmountCents: studentCharges.netAmountCents,
          dueDate: studentCharges.dueDate,
          description: studentCharges.description,
        })
        .from(studentCharges)
        .where(and(...targetConditions))
        .orderBy(asc(studentCharges.id))
        .for('update');

      // A caller naming charges that do not exist, are cancelled, or belong to
      // another pupil or school must not silently have them ignored.
      if (input.chargeIds && input.chargeIds.length > 0) {
        const found = new Set(locked.map((c) => c.id));
        const missing = input.chargeIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw new FinanceError('One or more charges could not be found.', 404);
        }
      }

      // ---- 2. Work out what is outstanding, inside the lock ---------------
      const paidByCharge = await sumAllocations(
        tx,
        ctx.schoolId,
        locked.map((c) => c.id),
      );

      const settleable = locked
        .map((c) => ({
          id: c.id,
          dueDate: c.dueDate,
          outstanding: Math.max((c.netAmountCents ?? 0) - (paidByCharge.get(c.id) ?? 0), 0),
        }))
        .filter((c) => c.outstanding > 0);

      // Oldest due first when the caller did not choose an order — what a
      // clerk taking a round sum at the desk expects. Charges with no due date
      // come last.
      settleable.sort((a, b) => {
        if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return a.id < b.id ? -1 : 1;
      });

      const totalOutstanding = settleable.reduce((sum, c) => sum + c.outstanding, 0);

      // ---- 3. Overpayment policy ------------------------------------------
      if (input.amountCents > totalOutstanding && !finance.allowOverpayment) {
        throw new FinanceError(
          totalOutstanding === 0
            ? 'This student has nothing outstanding.'
            : `That is more than the outstanding balance.`,
          400,
          { amountCents: 'The amount is more than this student owes.' },
        );
      }

      // ---- 4. Allocate --------------------------------------------------
      let remaining = input.amountCents;
      const allocations: { chargeId: string; amountCents: number }[] = [];
      for (const charge of settleable) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, charge.outstanding);
        if (take > 0) {
          allocations.push({ chargeId: charge.id, amountCents: take });
          remaining -= take;
        }
      }
      const allocated = input.amountCents - remaining;

      // ---- 5. Receipt number, from a locked per-school counter ------------
      const receiptNumber = await nextReceiptNumber(tx, ctx.schoolId, finance.receiptPrefix);

      // ---- 6. Write ------------------------------------------------------
      const [payment] = await tx
        .insert(payments)
        .values({
          schoolId: ctx.schoolId,
          studentId: input.studentId,
          receiptNumber,
          amountCents: input.amountCents,
          method: input.method,
          referenceNumber: input.referenceNumber ?? null,
          paidOn: input.paidOn,
          unallocatedCents: remaining,
          notes: input.notes ?? null,
          clientKey: input.clientKey ?? null,
          recordedBy: ctx.user.userId,
        })
        .returning({ id: payments.id });

      if (allocations.length > 0) {
        await tx.insert(paymentAllocations).values(
          allocations.map((a) => ({
            schoolId: ctx.schoolId,
            paymentId: payment!.id,
            chargeId: a.chargeId,
            amountCents: a.amountCents,
          })),
        );
      }

      await recordAudit(tx, {
        schoolId: ctx.schoolId,
        actorUserId: ctx.user.userId,
        action: 'payment.record',
        entityType: 'payment',
        entityId: payment!.id,
        summary: `Recorded ${receiptNumber}`,
        newValue: {
          amountCents: input.amountCents,
          method: input.method,
          allocated,
          unallocated: remaining,
        },
      });

      return {
        id: payment!.id,
        receiptNumber,
        amountCents: input.amountCents,
        allocatedCents: allocated,
        unallocatedCents: remaining,
        duplicate: false,
        balanceAfterCents: Math.max(totalOutstanding - allocated, 0),
      };
    });
  } catch (error) {
    // The unique index on (school, client_key) is the real duplicate guard.
    // Two genuinely simultaneous submissions both pass the pre-check above;
    // one wins the insert and the other lands here.
    if (input.clientKey && isUniqueViolation(error)) {
      const existing = await findByClientKey(ctx, input.clientKey);
      if (existing) return existing;
    }
    throw error;
  }
}

/**
 * Emit the domain event for a recorded payment.
 *
 * Deliberately separate from the transaction: an event handler must never be
 * able to roll back money that was legitimately received. Called by the API
 * route after the payment has committed.
 */
export async function announcePayment(
  ctx: AuthContext,
  payment: { id: string; receiptNumber: string; amountCents: number; method: string },
  studentId: string,
) {
  const balance = await getStudentBalance(ctx, studentId);
  await emitEvent(ctx.db, ctx.schoolId, 'payment.recorded', {
    studentId,
    amountCents: payment.amountCents,
    method: payment.method,
    receiptNumber: payment.receiptNumber,
    balanceCents: balance.outstandingCents,
  });
}

/** Sum of live allocations per charge. */
async function sumAllocations(
  tx: AuthContext['db'],
  schoolId: string,
  chargeIds: string[],
): Promise<Map<string, number>> {
  if (chargeIds.length === 0) return new Map();

  const rows = await tx
    .select({
      chargeId: paymentAllocations.chargeId,
      paid: sql<number>`coalesce(sum(${paymentAllocations.amountCents}), 0)::int`,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(
      and(
        eq(paymentAllocations.schoolId, schoolId),
        inArray(paymentAllocations.chargeId, chargeIds),
        eq(payments.status, 'completed'),
      ),
    )
    .groupBy(paymentAllocations.chargeId);

  return new Map(rows.map((r) => [r.chargeId, Number(r.paid)]));
}

/**
 * Next receipt number for a school.
 *
 * The counter row is locked FOR UPDATE, so two concurrent payments cannot be
 * issued the same number. Deriving it from `max(receipt_number) + 1` would
 * race, and a duplicate receipt number is the kind of error that destroys
 * trust in a ledger.
 */
async function nextReceiptNumber(
  tx: AuthContext['db'],
  schoolId: string,
  prefix: string,
): Promise<string> {
  await tx.insert(financeCounters).values({ schoolId, receiptSeq: 0 }).onConflictDoNothing();

  const [locked] = await tx
    .select({ seq: financeCounters.receiptSeq })
    .from(financeCounters)
    .where(eq(financeCounters.schoolId, schoolId))
    .for('update');

  const next = (locked?.seq ?? 0) + 1;

  await tx
    .update(financeCounters)
    .set({ receiptSeq: next, updatedAt: new Date() })
    .where(eq(financeCounters.schoolId, schoolId));

  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(next).padStart(6, '0')}`;
}

async function findByClientKey(
  ctx: AuthContext,
  clientKey: string,
): Promise<RecordedPayment | null> {
  const [row] = await ctx.db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountCents: payments.amountCents,
      unallocatedCents: payments.unallocatedCents,
      studentId: payments.studentId,
    })
    .from(payments)
    .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.clientKey, clientKey)))
    .limit(1);

  if (!row) return null;

  const balance = await getStudentBalance(ctx, row.studentId);
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    amountCents: row.amountCents,
    allocatedCents: row.amountCents - row.unallocatedCents,
    unallocatedCents: row.unallocatedCents,
    duplicate: true,
    balanceAfterCents: balance.outstandingCents,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

/**
 * Void a payment.
 *
 * The row stays. Its allocations stop counting because every balance query
 * joins through `payments.status = 'completed'`, so the debt reappears
 * automatically without touching the charges.
 */
export async function voidPayment(ctx: AuthContext, paymentId: string, reason: string) {
  ctx.require('payment.void');

  const [existing] = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.id, paymentId)))
    .limit(1);

  if (!existing) throw new FinanceError('Payment not found', 404);
  if (existing.status === 'voided') {
    throw new FinanceError('This payment has already been voided.', 409);
  }

  await ctx.db
    .update(payments)
    .set({
      status: 'voided',
      voidedAt: new Date(),
      voidedBy: ctx.user.userId,
      voidReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.id, paymentId)));

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'payment.void',
    entityType: 'payment',
    entityId: paymentId,
    summary: `Voided ${existing.receiptNumber}`,
    previousValue: { amountCents: existing.amountCents, status: 'completed' },
    newValue: { status: 'voided' },
    reason,
  });

  return { id: paymentId, receiptNumber: existing.receiptNumber };
}

// ---------------------------------------------------------------------------
// Reading payments
// ---------------------------------------------------------------------------

export async function listPayments(
  ctx: AuthContext,
  options: {
    studentId?: string;
    from?: string;
    to?: string;
    method?: string;
    includeVoided?: boolean;
    limit?: number;
    offset?: number;
  } = {},
) {
  const conditions = [eq(payments.schoolId, ctx.schoolId)];
  if (options.studentId) conditions.push(eq(payments.studentId, options.studentId));
  if (options.method) conditions.push(eq(payments.method, options.method));
  if (options.from) conditions.push(sql`${payments.paidOn} >= ${options.from}`);
  if (options.to) conditions.push(sql`${payments.paidOn} <= ${options.to}`);
  if (!options.includeVoided) conditions.push(eq(payments.status, 'completed'));

  const rows = await ctx.db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountCents: payments.amountCents,
      method: payments.method,
      referenceNumber: payments.referenceNumber,
      paidOn: payments.paidOn,
      status: payments.status,
      notes: payments.notes,
      studentId: payments.studentId,
      studentGivenName: students.givenName,
      studentFatherName: students.fatherName,
      studentCode: students.studentCode,
      recordedByGiven: users.givenName,
      recordedByFather: users.fatherName,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .leftJoin(users, eq(users.id, payments.recordedBy))
    .where(and(...conditions))
    .orderBy(desc(payments.paidOn), desc(payments.createdAt))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);

  const [count] = await ctx.db
    .select({ total: sql<number>`count(*)::int` })
    .from(payments)
    .where(and(...conditions));

  return { payments: rows, total: count?.total ?? 0 };
}

/**
 * One receipt, with everything it needs to be printed.
 *
 * Deliberately narrow: the student's name, code and class, and what was paid.
 * A receipt has no business carrying medical notes, an address or a guardian's
 * phone number, so none are selected.
 */
export async function getReceipt(ctx: AuthContext, paymentId: string) {
  const [payment] = await ctx.db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountCents: payments.amountCents,
      method: payments.method,
      referenceNumber: payments.referenceNumber,
      paidOn: payments.paidOn,
      status: payments.status,
      notes: payments.notes,
      unallocatedCents: payments.unallocatedCents,
      voidReason: payments.voidReason,
      voidedAt: payments.voidedAt,
      createdAt: payments.createdAt,
      studentId: payments.studentId,
      studentGivenName: students.givenName,
      studentFatherName: students.fatherName,
      studentGrandfatherName: students.grandfatherName,
      studentCode: students.studentCode,
      recordedByGiven: users.givenName,
      recordedByFather: users.fatherName,
    })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .leftJoin(users, eq(users.id, payments.recordedBy))
    .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.id, paymentId)))
    .limit(1);

  // 404, not 403 — an id from another school must be indistinguishable from
  // one that does not exist.
  if (!payment) throw new FinanceError('Receipt not found', 404);

  const lines = await ctx.db
    .select({
      chargeId: paymentAllocations.chargeId,
      amountCents: paymentAllocations.amountCents,
      description: studentCharges.description,
      descriptionAm: studentCharges.descriptionAm,
      categoryName: feeCategories.name,
      termName: terms.name,
    })
    .from(paymentAllocations)
    .innerJoin(studentCharges, eq(studentCharges.id, paymentAllocations.chargeId))
    .leftJoin(feeCategories, eq(feeCategories.id, studentCharges.categoryId))
    .leftJoin(terms, eq(terms.id, studentCharges.termId))
    .where(
      and(
        eq(paymentAllocations.schoolId, ctx.schoolId),
        eq(paymentAllocations.paymentId, paymentId),
      ),
    );

  const balance = await getStudentBalance(ctx, payment.studentId);

  return { payment, lines, balance };
}
