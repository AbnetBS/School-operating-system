/**
 * Finance reporting.
 *
 * The dashboard is meant to be actionable, so every figure here answers a
 * question a bursar actually asks: how much came in today, who owes money,
 * which fees are not being paid. Decorative totals were left out.
 *
 * Every query is filtered by school through an explicit `schoolId` condition —
 * an aggregate that forgot its tenant filter would silently report another
 * school's income as this one's.
 */

import { and, eq, inArray, sql, desc, asc, isNull, type SQL } from 'drizzle-orm';

import type { AuthContext } from '../auth/context.ts';
import {
  payments,
  paymentAllocations,
  studentCharges,
  feeCategories,
} from '../../db/schema/finance.ts';
import { students, enrollments } from '../../db/schema/people.ts';
import { academicYears, terms, gradeLevels, sections } from '../../db/schema/core.ts';
import { paidExpr, outstandingExpr } from './service.ts';

export type FinanceFilters = {
  academicYearId?: string;
  termId?: string;
  gradeLevelId?: string;
  sectionId?: string;
  categoryId?: string;
  method?: string;
  from?: string;
  to?: string;
};

/** Conditions applied to charge-side queries. */
function chargeConditions(schoolId: string, f: FinanceFilters): SQL[] {
  const c: SQL[] = [eq(studentCharges.schoolId, schoolId), eq(studentCharges.status, 'active')];
  if (f.academicYearId) c.push(eq(studentCharges.academicYearId, f.academicYearId));
  if (f.termId) c.push(eq(studentCharges.termId, f.termId));
  if (f.gradeLevelId) c.push(eq(studentCharges.gradeLevelId, f.gradeLevelId));
  if (f.categoryId) c.push(eq(studentCharges.categoryId, f.categoryId));
  return c;
}

/** Conditions applied to payment-side queries. */
function paymentConditions(schoolId: string, f: FinanceFilters): SQL[] {
  const c: SQL[] = [eq(payments.schoolId, schoolId), eq(payments.status, 'completed')];
  if (f.method) c.push(eq(payments.method, f.method));
  if (f.from) c.push(sql`${payments.paidOn} >= ${f.from}`);
  if (f.to) c.push(sql`${payments.paidOn} <= ${f.to}`);
  return c;
}

/**
 * Headline figures.
 *
 * `collected` is measured on the charge side (allocations against charges
 * matching the filters) so that it is comparable with `charged`. Measuring it
 * on the payment side would include unallocated credit and make the collection
 * rate exceed 100%.
 */
export async function getFinanceSummary(ctx: AuthContext, filters: FinanceFilters = {}) {
  const [totals] = await ctx.db
    .select({
      chargedCents: sql<number>`coalesce(sum(${studentCharges.amountCents}), 0)::int`,
      discountCents: sql<number>`coalesce(sum(${studentCharges.discountCents}), 0)::int`,
      netCents: sql<number>`coalesce(sum(${studentCharges.netAmountCents}), 0)::int`,
      collectedCents: sql<number>`coalesce(sum(${paidExpr}), 0)::int`,
      outstandingCents: sql<number>`coalesce(sum(${outstandingExpr}), 0)::int`,
      chargeCount: sql<number>`count(*)::int`,
    })
    .from(studentCharges)
    .where(and(...chargeConditions(ctx.schoolId, filters)));

  // Cash actually received in the window — a different question from
  // "how much of what we billed has been collected".
  const [received] = await ctx.db
    .select({
      receivedCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
      paymentCount: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(and(...paymentConditions(ctx.schoolId, filters)));

  const today = new Date().toISOString().slice(0, 10);
  const [todayRow] = await ctx.db
    .select({
      todayCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
      todayCount: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.schoolId, ctx.schoolId),
        eq(payments.status, 'completed'),
        eq(payments.paidOn, today),
      ),
    );

  // Overdue: past its due date, still owing. Grace days come from settings so
  // a school that allows a week's slack is not chasing families on day one.
  const { getSetting } = await import('../settings/service.ts');
  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - finance.graceDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const [overdue] = await ctx.db
    .select({
      overdueCents: sql<number>`coalesce(sum(${outstandingExpr}), 0)::int`,
      overdueCount: sql<number>`count(*)::int`,
    })
    .from(studentCharges)
    .where(
      and(
        ...chargeConditions(ctx.schoolId, filters),
        sql`${studentCharges.dueDate} is not null`,
        sql`${studentCharges.dueDate} < ${cutoffIso}`,
        sql`${outstandingExpr} > 0`,
      ),
    );

  const net = totals?.netCents ?? 0;
  const collected = totals?.collectedCents ?? 0;

  return {
    chargedCents: totals?.chargedCents ?? 0,
    discountCents: totals?.discountCents ?? 0,
    netCents: net,
    collectedCents: collected,
    outstandingCents: totals?.outstandingCents ?? 0,
    chargeCount: totals?.chargeCount ?? 0,
    receivedCents: received?.receivedCents ?? 0,
    paymentCount: received?.paymentCount ?? 0,
    todayCents: todayRow?.todayCents ?? 0,
    todayCount: todayRow?.todayCount ?? 0,
    overdueCents: overdue?.overdueCents ?? 0,
    overdueCount: overdue?.overdueCount ?? 0,
    /** Percentage of what was billed that has been collected. */
    collectionRate: net > 0 ? Math.round((collected / net) * 1000) / 10 : 0,
  };
}

/** Collections grouped by month, for a simple trend. */
export async function getMonthlyCollections(ctx: AuthContext, filters: FinanceFilters = {}) {
  return ctx.db
    .select({
      month: sql<string>`to_char(${payments.paidOn}, 'YYYY-MM')`,
      amountCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(and(...paymentConditions(ctx.schoolId, filters)))
    .groupBy(sql`to_char(${payments.paidOn}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${payments.paidOn}, 'YYYY-MM')`);
}

/** Which methods the money arrived by. */
export async function getMethodBreakdown(ctx: AuthContext, filters: FinanceFilters = {}) {
  return ctx.db
    .select({
      method: payments.method,
      amountCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(and(...paymentConditions(ctx.schoolId, filters)))
    .groupBy(payments.method)
    .orderBy(desc(sql`sum(${payments.amountCents})`));
}

/** Billed vs collected per fee category — shows which fees go unpaid. */
export async function getCategoryBreakdown(ctx: AuthContext, filters: FinanceFilters = {}) {
  return ctx.db
    .select({
      categoryId: studentCharges.categoryId,
      categoryName: sql<string>`coalesce(${feeCategories.name}, 'Uncategorised')`,
      netCents: sql<number>`coalesce(sum(${studentCharges.netAmountCents}), 0)::int`,
      collectedCents: sql<number>`coalesce(sum(${paidExpr}), 0)::int`,
      outstandingCents: sql<number>`coalesce(sum(${outstandingExpr}), 0)::int`,
    })
    .from(studentCharges)
    .leftJoin(feeCategories, eq(feeCategories.id, studentCharges.categoryId))
    .where(and(...chargeConditions(ctx.schoolId, filters)))
    .groupBy(studentCharges.categoryId, feeCategories.name)
    .orderBy(desc(sql`sum(${outstandingExpr})`));
}

/**
 * Students who owe money, worst first.
 *
 * This is the actionable list — the reason the dashboard exists. Section and
 * grade filters join through the current enrolment so a class teacher's list
 * matches their register.
 */
export async function getOutstandingStudents(
  ctx: AuthContext,
  filters: FinanceFilters = {},
  options: { limit?: number; offset?: number } = {},
) {
  const conditions = chargeConditions(ctx.schoolId, filters);

  // Section filtering needs the enrolment, which charges do not carry.
  const needsEnrolment = Boolean(filters.sectionId);

  const base = ctx.db
    .select({
      studentId: studentCharges.studentId,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
      studentCode: students.studentCode,
      netCents: sql<number>`coalesce(sum(${studentCharges.netAmountCents}), 0)::int`,
      paidCents: sql<number>`coalesce(sum(${paidExpr}), 0)::int`,
      outstandingCents: sql<number>`coalesce(sum(${outstandingExpr}), 0)::int`,
      oldestDue: sql<string | null>`min(${studentCharges.dueDate}) filter (where ${outstandingExpr} > 0)`,
    })
    .from(studentCharges)
    .innerJoin(students, eq(students.id, studentCharges.studentId));

  const query = needsEnrolment
    ? base.innerJoin(
        enrollments,
        and(
          eq(enrollments.studentId, studentCharges.studentId),
          eq(enrollments.schoolId, ctx.schoolId),
          eq(enrollments.status, 'enrolled'),
          filters.sectionId ? eq(enrollments.sectionId, filters.sectionId) : undefined,
        ),
      )
    : base;

  const rows = await query
    .where(and(...conditions))
    .groupBy(
      studentCharges.studentId,
      students.givenName,
      students.fatherName,
      students.grandfatherName,
      students.studentCode,
    )
    .having(sql`sum(${outstandingExpr}) > 0`)
    .orderBy(desc(sql`sum(${outstandingExpr})`))
    .limit(options.limit ?? 25)
    .offset(options.offset ?? 0);

  return rows;
}

/** Charges approaching or past their due date — the reminder queue. */
export async function getDueCharges(
  ctx: AuthContext,
  options: { withinDays?: number; overdueOnly?: boolean; limit?: number } = {},
) {
  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + (options.withinDays ?? 7));

  const todayIso = today.toISOString().slice(0, 10);
  const horizonIso = horizon.toISOString().slice(0, 10);

  const conditions = [
    eq(studentCharges.schoolId, ctx.schoolId),
    eq(studentCharges.status, 'active'),
    sql`${studentCharges.dueDate} is not null`,
    sql`${outstandingExpr} > 0`,
  ];

  if (options.overdueOnly) {
    conditions.push(sql`${studentCharges.dueDate} < ${todayIso}`);
  } else {
    conditions.push(sql`${studentCharges.dueDate} <= ${horizonIso}`);
  }

  return ctx.db
    .select({
      chargeId: studentCharges.id,
      studentId: studentCharges.studentId,
      description: studentCharges.description,
      dueDate: studentCharges.dueDate,
      outstandingCents: outstandingExpr,
      givenName: students.givenName,
      fatherName: students.fatherName,
    })
    .from(studentCharges)
    .innerJoin(students, eq(students.id, studentCharges.studentId))
    .where(and(...conditions))
    .orderBy(asc(studentCharges.dueDate))
    .limit(options.limit ?? 200);
}
