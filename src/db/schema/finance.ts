/**
 * Finance schema: fee structures, student charges, payments, allocations.
 *
 * DESIGN NOTES
 * ------------
 * A FEE STRUCTURE IS A TEMPLATE; A STUDENT CHARGE IS A FACT. The structure
 * says "Grade 5 tuition is 3,000 Br this year". The charge says "this pupil
 * owes 3,000 Br for term 1 of 2018 EC". The charge copies the amount rather
 * than pointing at the template, so editing next year's tuition — or moving a
 * pupil to another class — cannot rewrite what they owed last year.
 *
 * BALANCE IS DERIVED, NEVER STORED. Outstanding = charge net amount minus the
 * sum of its live allocations. A cached balance column is one missed update
 * away from a family being wrongly chased for money, so there isn't one.
 *
 * PAYMENTS ARE APPEND-ONLY. A mistake is corrected by voiding, which keeps the
 * row, records who voided it and why, and releases its allocations. Nothing
 * deletes a receipt.
 *
 * DISCOUNTS SIT BESIDE THE AMOUNT, NOT INSIDE IT. A receipt and an audit must
 * both be able to show the full price and the concession separately, so
 * `net_amount_cents` is a GENERATED column: the database computes
 * amount - discount and no code path can make the parts disagree with the total.
 *
 * MONEY IS INTEGER CENTS. Never a float. See src/lib/money.ts.
 */

import {
  pgTable,
  text,
  varchar,
  boolean,
  integer,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { schools, users, academicYears, terms, gradeLevels, sections } from './core.ts';
import { students } from './people.ts';

/** Shared column builders, matching the conventions in core.ts. */
const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Fee categories
// ---------------------------------------------------------------------------

/**
 * Suggested categories, NOT an allowed list.
 *
 * The specification is explicit that categories are school-defined. These are
 * offered in the UI as a starting point; `fee_categories.key` is a free slug
 * and a school may add "Boarding", "Laboratory" or anything else. Nothing in
 * the code branches on a category key.
 */
export const SUGGESTED_FEE_CATEGORIES = [
  { key: 'registration', en: 'Registration', am: 'ምዝገባ' },
  { key: 'tuition', en: 'Tuition', am: 'የትምህርት ክፍያ' },
  { key: 'transport', en: 'Transport', am: 'መጓጓዣ' },
  { key: 'meal', en: 'Meals', am: 'ምግብ' },
  { key: 'examination', en: 'Examination', am: 'ፈተና' },
  { key: 'uniform', en: 'Uniform', am: 'የደንብ ልብስ' },
  { key: 'books', en: 'Books and materials', am: 'መጽሐፍትና ቁሳቁስ' },
  { key: 'activities', en: 'Activities', am: 'ተግባራት' },
  { key: 'other', en: 'Other', am: 'ሌላ' },
] as const;

export const feeCategories = pgTable(
  'fee_categories',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** School-defined slug. Free text — the school owns its own vocabulary. */
    key: varchar('key', { length: 48 }).notNull(),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    description: text('description'),
    /** Display order in pickers and reports. */
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('fee_categories_school_key_uq').on(table.schoolId, table.key),
    index('fee_categories_school_idx').on(table.schoolId),
  ],
);

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

/**
 * How often a fee is billed.
 *
 * `once` — a single charge for the year (registration, uniform)
 * `term`  — one charge per term/semester, whatever the school uses
 * `month` — one charge per month
 * `custom` — the school raises charges by hand
 *
 * The school's term count is NOT assumed: `term` means "per billing period as
 * this school defines them", which for `bfa` is 3 and for `aps` is 2.
 */
export const BILLING_PERIODS = ['once', 'term', 'month', 'custom'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/** Who a fee applies to. Resolved when charges are raised, like announcements. */
export const FEE_APPLIES_TO = ['all', 'grade', 'section', 'individual'] as const;
export type FeeAppliesTo = (typeof FEE_APPLIES_TO)[number];

export const feeStructures = pgTable(
  'fee_structures',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').references(() => feeCategories.id, { onDelete: 'set null' }),

    name: text('name').notNull(),
    nameAm: text('name_am'),
    description: text('description'),

    /** Full price in integer cents, before any discount. Must be >= 0. */
    amountCents: integer('amount_cents').notNull(),

    /** One of BILLING_PERIODS. */
    billingPeriod: varchar('billing_period', { length: 16 }).notNull().default('term'),

    /** One of FEE_APPLIES_TO. */
    appliesTo: varchar('applies_to', { length: 16 }).notNull().default('all'),
    /** Grade levels this applies to, when appliesTo = 'grade'. */
    gradeLevelIds: jsonb('grade_level_ids').notNull().default(sql`'[]'::jsonb`),
    /** Sections this applies to, when appliesTo = 'section'. */
    sectionIds: jsonb('section_ids').notNull().default(sql`'[]'::jsonb`),

    /**
     * Optional fees are not charged automatically — a pupil opts in (transport,
     * meals). Mandatory fees are raised for everyone who matches.
     */
    isOptional: boolean('is_optional').notNull().default(false),

    /** Number of installments the charge may be split into. 1 = pay in full. */
    installmentCount: integer('installment_count').notNull().default(1),

    /** Due date for a `once` fee, or the first period's due date. */
    dueDate: date('due_date'),
    /** Days after the period starts before payment is due, for recurring fees. */
    dueDayOfPeriod: integer('due_day_of_period'),

    isActive: boolean('is_active').notNull().default(true),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('fee_structures_school_year_idx').on(table.schoolId, table.academicYearId),
    index('fee_structures_school_active_idx').on(table.schoolId, table.isActive),
  ],
);

// ---------------------------------------------------------------------------
// Student charges — the ledger's debit side
// ---------------------------------------------------------------------------

export const DISCOUNT_TYPES = ['none', 'discount', 'scholarship', 'waiver', 'sibling'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const CHARGE_STATUSES = ['active', 'cancelled'] as const;

/**
 * What one student owes for one billing period.
 *
 * The amount, academic year and grade level are COPIES taken when the charge
 * was raised. That is deliberate: it is what makes historical records immune to
 * later edits of the fee structure or a change of class.
 */
export const studentCharges = pgTable(
  'student_charges',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),

    /** Null for an ad-hoc charge that came from no template. */
    feeStructureId: text('fee_structure_id').references(() => feeStructures.id, {
      onDelete: 'set null',
    }),
    categoryId: text('category_id').references(() => feeCategories.id, { onDelete: 'set null' }),

    /** Frozen at creation — the year this debt belongs to, forever. */
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** The billing period, when the school bills per term/semester. */
    termId: text('term_id').references(() => terms.id, { onDelete: 'set null' }),
    /** The pupil's grade level when charged. A later promotion must not alter it. */
    gradeLevelId: text('grade_level_id').references(() => gradeLevels.id, { onDelete: 'set null' }),

    /** Human-readable at the time of charging, so a receipt reads correctly
     *  even if the fee structure is later renamed or deleted. */
    description: text('description').notNull(),
    descriptionAm: text('description_am'),

    /** Full price, integer cents, > 0. */
    amountCents: integer('amount_cents').notNull(),
    /** Concession, integer cents, >= 0 and <= amount. */
    discountCents: integer('discount_cents').notNull().default(0),
    /** One of DISCOUNT_TYPES — why the concession was given. */
    discountType: varchar('discount_type', { length: 16 }).notNull().default('none'),
    discountReason: text('discount_reason'),

    /**
     * What is actually owed. GENERATED by the database so the parts can never
     * disagree with the total.
     */
    netAmountCents: integer('net_amount_cents').generatedAlwaysAs(
      sql`"amount_cents" - "discount_cents"`,
    ),

    /** Which installment of the fee this is, when split. */
    installmentNumber: integer('installment_number').notNull().default(1),
    installmentTotal: integer('installment_total').notNull().default(1),

    dueDate: date('due_date'),

    /** 'active' | 'cancelled'. Cancelling keeps the row for the audit trail. */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('student_charges_school_student_idx').on(table.schoolId, table.studentId),
    index('student_charges_school_year_idx').on(table.schoolId, table.academicYearId),
    index('student_charges_school_due_idx').on(table.schoolId, table.dueDate),
    index('student_charges_school_status_idx').on(table.schoolId, table.status),
    /**
     * One charge per student per fee per period. Stops a nightly "raise
     * charges" job from billing the same pupil twice for the same term.
     * Partial, because ad-hoc charges have no structure and may legitimately
     * repeat.
     */
    /**
     * What makes "apply this fee" safe to repeat.
     *
     * NULLS NOT DISTINCT is essential, not decorative: `termId` is NULL for
     * any fee that is not per-term, and under the SQL default two NULLs never
     * match, so the index would not catch a repeated application of a one-off
     * fee and every pupil would be billed twice.
     *
     * Drizzle's index builder cannot express NULLS NOT DISTINCT, so the live
     * index is created by hand in migration 0010. This declaration exists so
     * the column list stays visible here; the migration is the source of
     * truth for the null behaviour, and `tests/finance.test.ts` asserts the
     * real index actually enforces it.
     */
    uniqueIndex('student_charges_unique_generated')
      .on(
        table.schoolId,
        table.studentId,
        table.feeStructureId,
        table.termId,
        table.installmentNumber,
      )
      .where(sql`"fee_structure_id" is not null and "status" = 'active'`),
  ],
);

// ---------------------------------------------------------------------------
// Payments — the ledger's credit side
// ---------------------------------------------------------------------------

/**
 * Suggested payment methods, NOT an allowed list.
 *
 * Stored as a free slug so a school can add its own bank without a code
 * change. Recording "telebirr" means money was RECEIVED that way — it does not
 * imply any online integration, and nothing in this module contacts a payment
 * provider.
 */
export const SUGGESTED_PAYMENT_METHODS = [
  { key: 'cash', en: 'Cash', am: 'ጥሬ ገንዘብ' },
  { key: 'bank', en: 'Bank deposit', am: 'የባንክ ገቢ' },
  { key: 'telebirr', en: 'Telebirr', am: 'ቴሌብር' },
  { key: 'cbebirr', en: 'CBE Birr', am: 'ሲቢኢ ብር' },
  { key: 'cheque', en: 'Cheque', am: 'ቼክ' },
  { key: 'other', en: 'Other', am: 'ሌላ' },
] as const;

export const PAYMENT_STATUSES = ['completed', 'voided'] as const;

export const payments = pgTable(
  'payments',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),

    /** Sequential per school, generated inside the payment transaction. */
    receiptNumber: varchar('receipt_number', { length: 40 }).notNull(),

    /** Total received, integer cents, > 0 (enforced by CHECK). */
    amountCents: integer('amount_cents').notNull(),

    /** Free slug — see SUGGESTED_PAYMENT_METHODS. */
    method: varchar('method', { length: 32 }).notNull(),
    /** Bank slip number, Telebirr transaction id, cheque number. */
    referenceNumber: varchar('reference_number', { length: 80 }),

    /** School-local date the money was received; may predate the entry. */
    paidOn: date('paid_on').notNull(),

    /**
     * Any amount not allocated to a charge — only possible when the school
     * permits overpayment. Held as credit against future charges.
     */
    unallocatedCents: integer('unallocated_cents').notNull().default(0),

    notes: text('notes'),

    /** 'completed' | 'voided'. */
    status: varchar('status', { length: 16 }).notNull().default('completed'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by').references(() => users.id, { onDelete: 'set null' }),
    voidReason: text('void_reason'),

    /**
     * Idempotency key from the client. A double-tapped submit button reuses it,
     * so the second request returns the first receipt instead of taking the
     * money twice.
     */
    clientKey: varchar('client_key', { length: 80 }),

    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payments_school_receipt_uq').on(table.schoolId, table.receiptNumber),
    index('payments_school_student_idx').on(table.schoolId, table.studentId),
    index('payments_school_paid_idx').on(table.schoolId, table.paidOn),
    index('payments_school_status_idx').on(table.schoolId, table.status),
    /** Duplicate protection, scoped per school. */
    uniqueIndex('payments_school_client_key_uq')
      .on(table.schoolId, table.clientKey)
      .where(sql`"client_key" is not null`),
  ],
);

/**
 * Which payment settled which charge, and by how much.
 *
 * A payment may cover several charges; a charge may take several payments.
 * Voiding a payment leaves these rows in place but they stop counting, because
 * every balance query joins through `payments.status = 'completed'`.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    chargeId: text('charge_id')
      .notNull()
      .references(() => studentCharges.id, { onDelete: 'cascade' }),
    /** Integer cents, > 0 (enforced by CHECK). */
    amountCents: integer('amount_cents').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('payment_allocations_school_payment_idx').on(table.schoolId, table.paymentId),
    index('payment_allocations_school_charge_idx').on(table.schoolId, table.chargeId),
    /** A payment settles a given charge once; amounts are summed, not repeated. */
    uniqueIndex('payment_allocations_payment_charge_uq').on(table.paymentId, table.chargeId),
  ],
);

// ---------------------------------------------------------------------------
// Receipt numbering
// ---------------------------------------------------------------------------

/**
 * Per-school sequence for receipt numbers.
 *
 * A separate table rather than `max(receipt_number) + 1`: the row is locked
 * FOR UPDATE inside the payment transaction, so two simultaneous payments
 * cannot be issued the same receipt number. Scanning the payments table would
 * race.
 */
export const financeCounters = pgTable(
  'finance_counters',
  {
    schoolId: text('school_id')
      .primaryKey()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** Last issued receipt sequence number. */
    receiptSeq: integer('receipt_seq').notNull().default(0),
    updatedAt: updatedAt(),
  },
);
