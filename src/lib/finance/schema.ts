/**
 * Validation for the finance module.
 *
 * Money never arrives as a float. The client sends integer cents, and these
 * schemas refuse anything else — `z.coerce.number()` is avoided throughout
 * because it turns `null` and `''` into `0`, which for money means "this
 * charge is free" rather than "the field was empty".
 */

import { z } from 'zod';
import { BILLING_PERIODS, FEE_APPLIES_TO, DISCOUNT_TYPES } from '../../db/schema/finance.ts';

/** Integer cents, strictly positive. */
const positiveCents = z
  .number({ error: 'Enter an amount.' })
  .int('Amounts are in whole cents.')
  .positive('The amount must be greater than zero.')
  .max(1_000_000_000_00, 'That amount is implausibly large.');

/** Integer cents, zero allowed (discounts, waivers). */
const nonNegativeCents = z
  .number()
  .int('Amounts are in whole cents.')
  .min(0, 'The amount cannot be negative.')
  .max(1_000_000_000_00, 'That amount is implausibly large.');

/** A school-defined slug: payment method, fee category key. */
const slug = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use a lowercase slug such as "awash-bank".');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.');

// ---------------------------------------------------------------------------
// Fee categories
// ---------------------------------------------------------------------------

export const feeCategorySchema = z.object({
  key: slug,
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  nameAm: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

export const feeStructureSchema = z
  .object({
    academicYearId: z.string().min(1, 'Choose an academic year.'),
    categoryId: z.string().min(1).optional().nullable(),

    name: z.string().trim().min(1, 'Enter a name for this fee.').max(160),
    nameAm: z.string().trim().max(160).optional().nullable(),
    description: z.string().trim().max(1000).optional().nullable(),

    amountCents: nonNegativeCents,

    billingPeriod: z.enum(BILLING_PERIODS).default('term'),
    appliesTo: z.enum(FEE_APPLIES_TO).default('all'),
    gradeLevelIds: z.array(z.string().min(1)).default([]),
    sectionIds: z.array(z.string().min(1)).default([]),

    isOptional: z.boolean().default(false),
    installmentCount: z.number().int().min(1).max(12).default(1),

    dueDate: isoDate.optional().nullable(),
    dueDayOfPeriod: z.number().int().min(1).max(28).optional().nullable(),

    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    // A fee aimed at grades must name at least one, otherwise it silently
    // applies to nobody and the school wonders why no one was charged.
    if (value.appliesTo === 'grade' && value.gradeLevelIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['gradeLevelIds'],
        message: 'Choose at least one grade level.',
      });
    }
    if (value.appliesTo === 'section' && value.sectionIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['sectionIds'],
        message: 'Choose at least one class.',
      });
    }
  });

export const updateFeeStructureSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  nameAm: z.string().trim().max(160).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  amountCents: nonNegativeCents.optional(),
  categoryId: z.string().min(1).optional().nullable(),
  billingPeriod: z.enum(BILLING_PERIODS).optional(),
  appliesTo: z.enum(FEE_APPLIES_TO).optional(),
  gradeLevelIds: z.array(z.string().min(1)).optional(),
  sectionIds: z.array(z.string().min(1)).optional(),
  isOptional: z.boolean().optional(),
  installmentCount: z.number().int().min(1).max(12).optional(),
  dueDate: isoDate.optional().nullable(),
  dueDayOfPeriod: z.number().int().min(1).max(28).optional().nullable(),
  isActive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Raising charges
// ---------------------------------------------------------------------------

/** Apply a fee structure to everyone it matches. */
export const applyFeeSchema = z.object({
  feeStructureId: z.string().min(1, 'Choose a fee.'),
  /** Which billing period to raise. Required when the fee is per-term. */
  termId: z.string().min(1).optional().nullable(),
  /** Restrict to specific students; otherwise everyone the fee matches. */
  studentIds: z.array(z.string().min(1)).optional(),
  dueDate: isoDate.optional().nullable(),
});

/** A one-off charge for a single pupil. */
export const adHocChargeSchema = z.object({
  studentId: z.string().min(1, 'Choose a student.'),
  categoryId: z.string().min(1).optional().nullable(),
  academicYearId: z.string().min(1).optional().nullable(),
  termId: z.string().min(1).optional().nullable(),
  description: z.string().trim().min(1, 'Describe the charge.').max(300),
  descriptionAm: z.string().trim().max(300).optional().nullable(),
  amountCents: positiveCents,
  discountCents: nonNegativeCents.default(0),
  discountType: z.enum(DISCOUNT_TYPES).default('none'),
  discountReason: z.string().trim().max(300).optional().nullable(),
  dueDate: isoDate.optional().nullable(),
});

/** Change the concession on an existing charge. */
export const discountSchema = z
  .object({
    discountCents: nonNegativeCents,
    discountType: z.enum(DISCOUNT_TYPES),
    discountReason: z.string().trim().max(300).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    // A concession without a stated reason cannot be audited later.
    if (value.discountCents > 0 && !value.discountReason?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['discountReason'],
        message: 'Give a reason for the discount or scholarship.',
      });
    }
    if (value.discountCents > 0 && value.discountType === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['discountType'],
        message: 'Choose the kind of concession.',
      });
    }
  });

export const cancelChargeSchema = z.object({
  // The `error` argument covers the missing/wrong-type case too. Without it a
  // request with no reason at all reports Zod's internal wording, which is not
  // something a registrar should ever be shown.
  reason: z
    .string({ error: 'Give a reason for cancelling this charge.' })
    .trim()
    .min(3, 'Give a reason for cancelling this charge.')
    .max(300),
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const recordPaymentSchema = z.object({
  studentId: z.string().min(1, 'Choose a student.'),
  amountCents: positiveCents,
  method: slug,
  referenceNumber: z.string().trim().max(80).optional().nullable(),
  paidOn: isoDate,
  notes: z.string().trim().max(500).optional().nullable(),

  /**
   * Settle these charges, in this order. Omitted means "oldest due first",
   * which is what a clerk taking a round sum at the desk expects.
   *
   * The client never sends amounts — the server decides how much each charge
   * takes, from the balance it computes itself.
   */
  chargeIds: z.array(z.string().min(1)).optional(),

  /** Idempotency key so a double-tapped button does not take the money twice. */
  clientKey: z.string().trim().max(80).optional().nullable(),
});

export const voidPaymentSchema = z.object({
  reason: z
    .string({ error: 'Give a reason for voiding this payment.' })
    .trim()
    .min(3, 'Give a reason for voiding this payment.')
    .max(300),
});

export type FeeCategoryInput = z.infer<typeof feeCategorySchema>;
export type FeeStructureInput = z.infer<typeof feeStructureSchema>;
export type ApplyFeeInput = z.infer<typeof applyFeeSchema>;
export type AdHocChargeInput = z.infer<typeof adHocChargeSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
