/**
 * Finance service — fee configuration, charges and balances.
 *
 * Payments live in ./payments.ts because they need transactional care that
 * would otherwise drown this file.
 *
 * THE BALANCE RULE, stated once and relied on everywhere: a charge's
 * outstanding amount is its net amount minus the sum of allocations from
 * payments whose status is 'completed'. There is no stored balance. Every
 * function here derives it the same way, so no two screens can disagree.
 */

import { and, eq, inArray, sql, desc, asc, isNull, or, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import { markDomainError } from '../api/domain-error.ts';
import {
  feeCategories,
  feeStructures,
  studentCharges,
  payments,
  paymentAllocations,
  SUGGESTED_FEE_CATEGORIES,
} from '../../db/schema/finance.ts';
import { students, enrollments } from '../../db/schema/people.ts';
import { academicYears, terms, gradeLevels, sections, users } from '../../db/schema/core.ts';
import { getSetting } from '../settings/service.ts';
import { recordAudit } from '../audit/index.ts';
import { cents, type Cents } from '../money.ts';
import type {
  FeeCategoryInput,
  FeeStructureInput,
  ApplyFeeInput,
  AdHocChargeInput,
} from './schema.ts';

export class FinanceError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(message: string, status = 400, fields?: Record<string, string>) {
    super(message);
    this.name = 'FinanceError';
    this.status = status;
    if (fields) this.fields = fields;
    markDomainError(this);
  }
}

// ---------------------------------------------------------------------------
// The one true "amount paid" expression
// ---------------------------------------------------------------------------

/**
 * Sum of live allocations against a charge.
 *
 * Correlated subquery. Note `${studentCharges}.${sql.identifier('id')}` rather
 * than a bare column reference: Drizzle only table-qualifies an interpolated
 * column when the outer query has a JOIN, and this expression is used in both
 * shapes.
 */
const paidExpr = sql<number>`coalesce((
  select sum(${paymentAllocations.amountCents})
  from ${paymentAllocations}
  join ${payments} on ${payments.id} = ${paymentAllocations.paymentId}
  where ${paymentAllocations.chargeId} = ${studentCharges}.${sql.identifier('id')}
    and ${payments.status} = 'completed'
), 0)::int`;

/** Outstanding for a charge: net minus paid, never below zero. */
const outstandingExpr = sql<number>`greatest(
  ${studentCharges.netAmountCents} - ${paidExpr}, 0
)::int`;

// ---------------------------------------------------------------------------
// Fee categories
// ---------------------------------------------------------------------------

export async function listFeeCategories(ctx: AuthContext, includeInactive = false) {
  const conditions = [eq(feeCategories.schoolId, ctx.schoolId)];
  if (!includeInactive) conditions.push(eq(feeCategories.isActive, true));

  return ctx.db
    .select({
      id: feeCategories.id,
      key: feeCategories.key,
      name: feeCategories.name,
      nameAm: feeCategories.nameAm,
      description: feeCategories.description,
      sortOrder: feeCategories.sortOrder,
      isActive: feeCategories.isActive,
    })
    .from(feeCategories)
    .where(and(...conditions))
    .orderBy(asc(feeCategories.sortOrder), asc(feeCategories.name));
}

export async function createFeeCategory(ctx: AuthContext, input: FeeCategoryInput) {
  ctx.require('fee.manage');

  const existing = await ctx.db
    .select({ id: feeCategories.id })
    .from(feeCategories)
    .where(and(eq(feeCategories.schoolId, ctx.schoolId), eq(feeCategories.key, input.key)))
    .limit(1);

  if (existing.length > 0) {
    throw new FinanceError('A category with that key already exists.', 409, {
      key: 'This key is already in use.',
    });
  }

  const [row] = await ctx.db
    .insert(feeCategories)
    .values({
      schoolId: ctx.schoolId,
      key: input.key,
      name: input.name,
      nameAm: input.nameAm ?? null,
      description: input.description ?? null,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    })
    .returning({ id: feeCategories.id });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'fee.create',
    entityType: 'feeCategory',
    entityId: row!.id,
    summary: `Created fee category "${input.name}"`,
  });

  return row!;
}

/**
 * Give a new school a starting set of categories.
 *
 * Suggestions, not a fixed list: every row is editable and removable, and a
 * school may add its own. Nothing in the code branches on a category key.
 */
export async function seedSuggestedCategories(db: Database, schoolId: string) {
  const rows = SUGGESTED_FEE_CATEGORIES.map((c, i) => ({
    schoolId,
    key: c.key,
    name: c.en,
    nameAm: c.am,
    sortOrder: i * 10,
  }));
  await db.insert(feeCategories).values(rows).onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

export async function listFeeStructures(
  ctx: AuthContext,
  options: { academicYearId?: string; includeInactive?: boolean } = {},
) {
  const conditions = [eq(feeStructures.schoolId, ctx.schoolId)];
  if (options.academicYearId) {
    conditions.push(eq(feeStructures.academicYearId, options.academicYearId));
  }
  if (!options.includeInactive) conditions.push(eq(feeStructures.isActive, true));

  return ctx.db
    .select({
      id: feeStructures.id,
      name: feeStructures.name,
      nameAm: feeStructures.nameAm,
      description: feeStructures.description,
      amountCents: feeStructures.amountCents,
      billingPeriod: feeStructures.billingPeriod,
      appliesTo: feeStructures.appliesTo,
      gradeLevelIds: feeStructures.gradeLevelIds,
      sectionIds: feeStructures.sectionIds,
      isOptional: feeStructures.isOptional,
      installmentCount: feeStructures.installmentCount,
      dueDate: feeStructures.dueDate,
      isActive: feeStructures.isActive,
      academicYearId: feeStructures.academicYearId,
      categoryId: feeStructures.categoryId,
      categoryName: feeCategories.name,
      /** How many charges this structure has already produced. */
      chargeCount: sql<number>`(
        select count(*) from ${studentCharges}
        where ${studentCharges.feeStructureId} = ${feeStructures}.${sql.identifier('id')}
          and ${studentCharges.status} = 'active'
      )::int`,
    })
    .from(feeStructures)
    .leftJoin(feeCategories, eq(feeCategories.id, feeStructures.categoryId))
    .where(and(...conditions))
    .orderBy(asc(feeStructures.name));
}

export async function createFeeStructure(ctx: AuthContext, input: FeeStructureInput) {
  ctx.require('fee.manage');

  // The year must be this school's. A forged id from another school would
  // otherwise create a structure that the DB accepts only because the FK pair
  // is checked at insert — better to fail with a clear message.
  const year = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.id, input.academicYearId)))
    .limit(1);
  if (year.length === 0) {
    throw new FinanceError('Academic year not found', 404);
  }

  await assertOwnedIds(ctx, gradeLevels, input.gradeLevelIds, 'gradeLevelIds', 'grade level');
  await assertOwnedIds(ctx, sections, input.sectionIds, 'sectionIds', 'class');

  if (input.categoryId) {
    await assertOwnedIds(ctx, feeCategories, [input.categoryId], 'categoryId', 'category');
  }

  const [row] = await ctx.db
    .insert(feeStructures)
    .values({
      schoolId: ctx.schoolId,
      academicYearId: input.academicYearId,
      categoryId: input.categoryId ?? null,
      name: input.name,
      nameAm: input.nameAm ?? null,
      description: input.description ?? null,
      amountCents: input.amountCents,
      billingPeriod: input.billingPeriod,
      appliesTo: input.appliesTo,
      gradeLevelIds: input.gradeLevelIds,
      sectionIds: input.sectionIds,
      isOptional: input.isOptional,
      installmentCount: input.installmentCount,
      dueDate: input.dueDate ?? null,
      dueDayOfPeriod: input.dueDayOfPeriod ?? null,
      isActive: input.isActive,
      createdBy: ctx.user.userId,
    })
    .returning({ id: feeStructures.id });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'fee.create',
    entityType: 'feeStructure',
    entityId: row!.id,
    summary: `Created fee "${input.name}"`,
    newValue: { amountCents: input.amountCents, appliesTo: input.appliesTo },
  });

  return row!;
}

export async function updateFeeStructure(
  ctx: AuthContext,
  feeStructureId: string,
  input: Record<string, unknown>,
) {
  ctx.require('fee.manage');

  const [existing] = await ctx.db
    .select()
    .from(feeStructures)
    .where(and(eq(feeStructures.schoolId, ctx.schoolId), eq(feeStructures.id, feeStructureId)))
    .limit(1);

  if (!existing) throw new FinanceError('Fee not found', 404);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of [
    'name',
    'nameAm',
    'description',
    'amountCents',
    'categoryId',
    'billingPeriod',
    'appliesTo',
    'gradeLevelIds',
    'sectionIds',
    'isOptional',
    'installmentCount',
    'dueDate',
    'dueDayOfPeriod',
    'isActive',
  ]) {
    if (key in input) patch[key] = input[key];
  }

  await ctx.db
    .update(feeStructures)
    .set(patch)
    .where(and(eq(feeStructures.schoolId, ctx.schoolId), eq(feeStructures.id, feeStructureId)));

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'fee.update',
    entityType: 'feeStructure',
    entityId: feeStructureId,
    summary: `Updated fee "${existing.name}"`,
    previousValue: { amountCents: existing.amountCents, isActive: existing.isActive },
    newValue: patch,
  });

  // Editing a structure never touches charges already raised — that is the
  // whole point of copying the amount onto the charge.
  return { id: feeStructureId };
}

/** Every id must belong to this school. Used before writing a jsonb id list. */
async function assertOwnedIds(
  ctx: AuthContext,
  table: typeof gradeLevels | typeof sections | typeof feeCategories,
  ids: string[],
  field: string,
  label: string,
) {
  if (ids.length === 0) return;
  const rows = await ctx.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.schoolId, ctx.schoolId), inArray(table.id, ids)));
  if (rows.length !== new Set(ids).size) {
    throw new FinanceError(`Unknown ${label}.`, 404, { [field]: `Unknown ${label}.` });
  }
}

// ---------------------------------------------------------------------------
// Raising charges
// ---------------------------------------------------------------------------

/**
 * Which students a fee structure applies to, right now.
 *
 * Resolved from current enrolment rather than stored, for the same reason an
 * announcement audience is a rule: a pupil who enrols next week should be
 * charged when the fee is next applied, without anyone editing the fee.
 */
export async function resolveFeeRecipients(
  ctx: AuthContext,
  structure: {
    appliesTo: string;
    gradeLevelIds: unknown;
    sectionIds: unknown;
    academicYearId: string;
  },
  restrictToStudentIds?: string[],
): Promise<{ studentId: string; gradeLevelId: string | null }[]> {
  const conditions: SQL[] = [
    eq(enrollments.schoolId, ctx.schoolId),
    eq(enrollments.academicYearId, structure.academicYearId),
    eq(enrollments.status, 'enrolled'),
    isNull(enrollments.endedOn),
  ];

  if (structure.appliesTo === 'grade') {
    const ids = (structure.gradeLevelIds as string[]) ?? [];
    if (ids.length === 0) return [];
    conditions.push(inArray(enrollments.gradeLevelId, ids));
  } else if (structure.appliesTo === 'section') {
    const ids = (structure.sectionIds as string[]) ?? [];
    if (ids.length === 0) return [];
    conditions.push(inArray(enrollments.sectionId, ids));
  }

  if (restrictToStudentIds && restrictToStudentIds.length > 0) {
    conditions.push(inArray(enrollments.studentId, restrictToStudentIds));
  } else if (structure.appliesTo === 'individual') {
    // An individual fee charges nobody until specific students are named.
    return [];
  }

  const rows = await ctx.db
    .selectDistinct({
      studentId: enrollments.studentId,
      gradeLevelId: enrollments.gradeLevelId,
    })
    .from(enrollments)
    .where(and(...conditions));

  return rows;
}

/**
 * Raise charges for everyone a fee structure matches.
 *
 * Idempotent by construction: the partial unique index on
 * (school, student, structure, term, installment) means running this twice
 * produces no duplicates, and `onConflictDoNothing` turns the second run into
 * a no-op rather than an error.
 */
export async function applyFeeStructure(ctx: AuthContext, input: ApplyFeeInput) {
  ctx.require('fee.manage');

  const [structure] = await ctx.db
    .select()
    .from(feeStructures)
    .where(
      and(eq(feeStructures.schoolId, ctx.schoolId), eq(feeStructures.id, input.feeStructureId)),
    )
    .limit(1);

  if (!structure) throw new FinanceError('Fee not found', 404);
  if (!structure.isActive) {
    throw new FinanceError('This fee is inactive. Reactivate it before applying it.', 400);
  }

  // A per-term fee must say which term, or charges could not be told apart.
  let termId: string | null = input.termId ?? null;
  if (structure.billingPeriod === 'term') {
    if (!termId) {
      const [current] = await ctx.db
        .select({ id: terms.id })
        .from(terms)
        .where(
          and(
            eq(terms.schoolId, ctx.schoolId),
            eq(terms.academicYearId, structure.academicYearId),
            eq(terms.isCurrent, true),
          ),
        )
        .limit(1);
      if (!current) {
        throw new FinanceError('Choose a term for this fee.', 400, {
          termId: 'Choose a term.',
        });
      }
      termId = current.id;
    } else {
      const [t] = await ctx.db
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.schoolId, ctx.schoolId), eq(terms.id, termId)))
        .limit(1);
      if (!t) throw new FinanceError('Term not found', 404);
    }
  }

  if (input.studentIds && input.studentIds.length > 0) {
    // Named students must be this school's.
    const owned = await ctx.db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, ctx.schoolId), inArray(students.id, input.studentIds)));
    if (owned.length !== new Set(input.studentIds).size) {
      throw new FinanceError('Unknown student.', 404);
    }
  }

  const recipients = await resolveFeeRecipients(ctx, structure, input.studentIds);
  if (recipients.length === 0) {
    return { created: 0, skipped: 0, recipients: 0 };
  }

  const dueDate = input.dueDate ?? structure.dueDate ?? null;

  // Split into installments if configured. splitEvenly never loses a cent.
  const { splitEvenly } = await import('../money.ts');
  const parts =
    structure.installmentCount > 1
      ? splitEvenly(cents(structure.amountCents), structure.installmentCount)
      : [cents(structure.amountCents)];

  const rows = recipients.flatMap((r) =>
    parts.map((amount, index) => ({
      schoolId: ctx.schoolId,
      studentId: r.studentId,
      feeStructureId: structure.id,
      categoryId: structure.categoryId,
      academicYearId: structure.academicYearId,
      termId,
      gradeLevelId: r.gradeLevelId,
      description:
        parts.length > 1 ? `${structure.name} (${index + 1}/${parts.length})` : structure.name,
      descriptionAm: structure.nameAm,
      amountCents: amount as number,
      installmentNumber: index + 1,
      installmentTotal: parts.length,
      dueDate,
      createdBy: ctx.user.userId,
    })),
  );

  // A zero-amount fee cannot become a charge — the CHECK forbids it, and a
  // charge of nothing is meaningless anyway.
  const payable = rows.filter((r) => r.amountCents > 0);
  if (payable.length === 0) {
    return { created: 0, skipped: 0, recipients: recipients.length };
  }

  const inserted = await ctx.db
    .insert(studentCharges)
    .values(payable)
    .onConflictDoNothing()
    .returning({ id: studentCharges.id, studentId: studentCharges.studentId });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'fee.assign',
    entityType: 'feeStructure',
    entityId: structure.id,
    summary: `Applied "${structure.name}" to ${inserted.length} charge(s)`,
    newValue: { termId, created: inserted.length, recipients: recipients.length },
  });

  return {
    created: inserted.length,
    skipped: payable.length - inserted.length,
    recipients: recipients.length,
    chargeIds: inserted.map((r) => r.id),
    studentIds: [...new Set(inserted.map((r) => r.studentId))],
  };
}

/** A one-off charge for a single pupil. */
export async function createAdHocCharge(ctx: AuthContext, input: AdHocChargeInput) {
  ctx.require('fee.manage');

  // Permission plus relationship. A finance officer may charge any pupil in
  // their school; nobody may charge a pupil who is not theirs.
  await ctx.requireStudentAccess(input.studentId);

  if (input.discountCents > input.amountCents) {
    throw new FinanceError('The discount cannot exceed the amount.', 400, {
      discountCents: 'The discount cannot exceed the amount.',
    });
  }

  const academicYearId = input.academicYearId ?? (await currentYearId(ctx));
  if (!academicYearId) throw new FinanceError('No academic year is set up yet.', 400);

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.id, academicYearId)))
    .limit(1);
  if (!year) throw new FinanceError('Academic year not found', 404);

  if (input.categoryId) {
    await assertOwnedIds(ctx, feeCategories, [input.categoryId], 'categoryId', 'category');
  }

  // Freeze the pupil's current grade level onto the charge.
  const [enrolment] = await ctx.db
    .select({ gradeLevelId: enrollments.gradeLevelId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, ctx.schoolId),
        eq(enrollments.studentId, input.studentId),
        eq(enrollments.academicYearId, academicYearId),
      ),
    )
    .limit(1);

  const [row] = await ctx.db
    .insert(studentCharges)
    .values({
      schoolId: ctx.schoolId,
      studentId: input.studentId,
      feeStructureId: null,
      categoryId: input.categoryId ?? null,
      academicYearId,
      termId: input.termId ?? null,
      gradeLevelId: enrolment?.gradeLevelId ?? null,
      description: input.description,
      descriptionAm: input.descriptionAm ?? null,
      amountCents: input.amountCents,
      discountCents: input.discountCents,
      discountType: input.discountType,
      discountReason: input.discountReason ?? null,
      dueDate: input.dueDate ?? null,
      createdBy: ctx.user.userId,
    })
    .returning({ id: studentCharges.id });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'fee.assign',
    entityType: 'studentCharge',
    entityId: row!.id,
    summary: `Charged "${input.description}" to one student`,
    newValue: { amountCents: input.amountCents, discountCents: input.discountCents },
  });

  return row!;
}

/** Change the concession on a charge. Cannot drop net below what is paid. */
export async function setChargeDiscount(
  ctx: AuthContext,
  chargeId: string,
  input: { discountCents: number; discountType: string; discountReason?: string | null },
) {
  ctx.require('fee.manage');

  const charge = await getChargeOwned(ctx, chargeId);

  if (input.discountCents > charge.amountCents) {
    throw new FinanceError('The discount cannot exceed the charge.', 400, {
      discountCents: 'The discount cannot exceed the charge.',
    });
  }

  // A concession that takes the net below what has already been paid would
  // create a phantom credit. Refuse it and say so.
  const paid = await getChargePaid(ctx.db, ctx.schoolId, chargeId);
  const newNet = charge.amountCents - input.discountCents;
  if (newNet < paid) {
    throw new FinanceError(
      'That discount is larger than the unpaid part of this charge. Void a payment first.',
      400,
      { discountCents: 'More has already been paid than this would leave owing.' },
    );
  }

  await ctx.db
    .update(studentCharges)
    .set({
      discountCents: input.discountCents,
      discountType: input.discountType,
      discountReason: input.discountReason ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(studentCharges.schoolId, ctx.schoolId), eq(studentCharges.id, chargeId)));

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'fee.update',
    entityType: 'studentCharge',
    entityId: chargeId,
    summary: `Set ${input.discountType} on a charge`,
    previousValue: { discountCents: charge.discountCents, discountType: charge.discountType },
    newValue: { discountCents: input.discountCents, discountType: input.discountType },
    reason: input.discountReason ?? null,
  });

  return { id: chargeId, netAmountCents: newNet };
}

/** Cancel a charge. Kept, not deleted, and refused if money is against it. */
export async function cancelCharge(ctx: AuthContext, chargeId: string, reason: string) {
  ctx.require('fee.manage');

  const charge = await getChargeOwned(ctx, chargeId);
  if (charge.status === 'cancelled') {
    throw new FinanceError('This charge is already cancelled.', 409);
  }

  const paid = await getChargePaid(ctx.db, ctx.schoolId, chargeId);
  if (paid > 0) {
    throw new FinanceError(
      'Money has been paid against this charge. Void the payment before cancelling it.',
      409,
    );
  }

  await ctx.db
    .update(studentCharges)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: ctx.user.userId,
      cancelReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(studentCharges.schoolId, ctx.schoolId), eq(studentCharges.id, chargeId)));

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'fee.update',
    entityType: 'studentCharge',
    entityId: chargeId,
    summary: 'Cancelled a charge',
    reason,
  });

  return { id: chargeId };
}

// ---------------------------------------------------------------------------
// Reading balances
// ---------------------------------------------------------------------------

export type ChargeRow = {
  id: string;
  description: string;
  descriptionAm: string | null;
  amountCents: number;
  discountCents: number;
  netAmountCents: number;
  paidCents: number;
  outstandingCents: number;
  dueDate: string | null;
  status: string;
  categoryName: string | null;
  termName: string | null;
  academicYearId: string;
  academicYearName: string;
  installmentNumber: number;
  installmentTotal: number;
  discountType: string;
  discountReason: string | null;
};

/**
 * Every charge for one student, with what has been paid against each.
 *
 * Callers MUST have established the right to see this student first — either
 * `ctx.requireStudentAccess(studentId)` or the portal's `resolvePortalStudent`.
 * This function deliberately does not guess.
 */
export async function listStudentCharges(
  ctx: AuthContext,
  studentId: string,
  options: { academicYearId?: string; includeCancelled?: boolean } = {},
): Promise<ChargeRow[]> {
  const conditions = [
    eq(studentCharges.schoolId, ctx.schoolId),
    eq(studentCharges.studentId, studentId),
  ];
  if (options.academicYearId) {
    conditions.push(eq(studentCharges.academicYearId, options.academicYearId));
  }
  if (!options.includeCancelled) conditions.push(eq(studentCharges.status, 'active'));

  const rows = await ctx.db
    .select({
      id: studentCharges.id,
      description: studentCharges.description,
      descriptionAm: studentCharges.descriptionAm,
      amountCents: studentCharges.amountCents,
      discountCents: studentCharges.discountCents,
      netAmountCents: studentCharges.netAmountCents,
      paidCents: paidExpr,
      outstandingCents: outstandingExpr,
      dueDate: studentCharges.dueDate,
      status: studentCharges.status,
      categoryName: feeCategories.name,
      termName: terms.name,
      academicYearId: studentCharges.academicYearId,
      academicYearName: academicYears.name,
      installmentNumber: studentCharges.installmentNumber,
      installmentTotal: studentCharges.installmentTotal,
      discountType: studentCharges.discountType,
      discountReason: studentCharges.discountReason,
    })
    .from(studentCharges)
    .leftJoin(feeCategories, eq(feeCategories.id, studentCharges.categoryId))
    .leftJoin(terms, eq(terms.id, studentCharges.termId))
    .innerJoin(academicYears, eq(academicYears.id, studentCharges.academicYearId))
    .where(and(...conditions))
    .orderBy(desc(academicYears.startDate), asc(studentCharges.dueDate));

  return rows.map((r) => ({
    ...r,
    netAmountCents: r.netAmountCents ?? r.amountCents - r.discountCents,
  })) as ChargeRow[];
}

/** Totals for one student. */
export async function getStudentBalance(
  ctx: AuthContext,
  studentId: string,
  options: { academicYearId?: string } = {},
) {
  const conditions = [
    eq(studentCharges.schoolId, ctx.schoolId),
    eq(studentCharges.studentId, studentId),
    eq(studentCharges.status, 'active'),
  ];
  if (options.academicYearId) {
    conditions.push(eq(studentCharges.academicYearId, options.academicYearId));
  }

  const [row] = await ctx.db
    .select({
      chargedCents: sql<number>`coalesce(sum(${studentCharges.amountCents}), 0)::int`,
      discountCents: sql<number>`coalesce(sum(${studentCharges.discountCents}), 0)::int`,
      netCents: sql<number>`coalesce(sum(${studentCharges.netAmountCents}), 0)::int`,
      paidCents: sql<number>`coalesce(sum(${paidExpr}), 0)::int`,
      outstandingCents: sql<number>`coalesce(sum(${outstandingExpr}), 0)::int`,
    })
    .from(studentCharges)
    .where(and(...conditions));

  // Unallocated credit is money the school is holding for this pupil.
  const [credit] = await ctx.db
    .select({
      creditCents: sql<number>`coalesce(sum(${payments.unallocatedCents}), 0)::int`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.schoolId, ctx.schoolId),
        eq(payments.studentId, studentId),
        eq(payments.status, 'completed'),
      ),
    );

  return {
    chargedCents: row?.chargedCents ?? 0,
    discountCents: row?.discountCents ?? 0,
    netCents: row?.netCents ?? 0,
    paidCents: row?.paidCents ?? 0,
    outstandingCents: row?.outstandingCents ?? 0,
    creditCents: credit?.creditCents ?? 0,
  };
}

/** Sum already paid against one charge, from completed payments only. */
export async function getChargePaid(
  db: Database,
  schoolId: string,
  chargeId: string,
): Promise<number> {
  const [row] = await db
    .select({
      paid: sql<number>`coalesce(sum(${paymentAllocations.amountCents}), 0)::int`,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(
      and(
        eq(paymentAllocations.schoolId, schoolId),
        eq(paymentAllocations.chargeId, chargeId),
        eq(payments.status, 'completed'),
      ),
    );
  return row?.paid ?? 0;
}

/** Load a charge, proving it belongs to this school. 404 otherwise. */
export async function getChargeOwned(ctx: AuthContext, chargeId: string) {
  const [row] = await ctx.db
    .select()
    .from(studentCharges)
    .where(and(eq(studentCharges.schoolId, ctx.schoolId), eq(studentCharges.id, chargeId)))
    .limit(1);
  // 404 rather than 403: confirming that an id exists but belongs to another
  // school is itself a leak.
  if (!row) throw new FinanceError('Charge not found', 404);
  return row;
}

async function currentYearId(ctx: AuthContext): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  return row?.id ?? null;
}

export { paidExpr, outstandingExpr, currentYearId };
