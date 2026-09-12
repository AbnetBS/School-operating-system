-- Finance integrity.
--
-- Two separate jobs, both done by the database rather than by application code:
--
--   1. VALUE RULES. A negative payment, a discount larger than the fee, an
--      allocation of zero — these must be impossible, not merely unlikely.
--      Application validation is the first line; a CHECK is the one that still
--      holds when a future endpoint, an import script or a console session
--      forgets. Money is the wrong place to rely on discipline.
--
--   2. TENANT INTEGRITY. Same reasoning as 0001, 0003, 0005 and 0007: a plain
--      foreign key proves the referenced row EXISTS, not that it belongs to the
--      SAME SCHOOL. For finance the consequence is a payment recorded against
--      another school's pupil, or one school's charge settled from another's
--      ledger. Composite foreign keys on the (id, school_id) pair make that
--      impossible.

-- ---------------------------------------------------------------------------
-- 1. Referenceable (id, school_id) pairs
-- ---------------------------------------------------------------------------

ALTER TABLE "fee_categories"
  ADD CONSTRAINT "fee_categories_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Value rules
-- ---------------------------------------------------------------------------

-- A fee structure may be free (a placeholder, or a fully waived charge) but
-- never negative.
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_amount_non_negative" CHECK ("amount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_installments_positive" CHECK ("installment_count" >= 1);--> statement-breakpoint
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_billing_period_known"
  CHECK ("billing_period" IN ('once','term','month','custom'));--> statement-breakpoint
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_applies_to_known"
  CHECK ("applies_to" IN ('all','grade','section','individual'));--> statement-breakpoint

-- A charge must be for a positive amount, and the concession can neither be
-- negative nor exceed the charge. Together these guarantee net >= 0, so a
-- "debt" can never secretly be a credit.
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_amount_positive" CHECK ("amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_discount_non_negative" CHECK ("discount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_discount_within_amount"
  CHECK ("discount_cents" <= "amount_cents");--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_status_known"
  CHECK ("status" IN ('active','cancelled'));--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_discount_type_known"
  CHECK ("discount_type" IN ('none','discount','scholarship','waiver','sibling'));--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_installment_sane"
  CHECK ("installment_number" >= 1 AND "installment_number" <= "installment_total");--> statement-breakpoint
-- A cancelled charge must say who cancelled it and when. Silent cancellation
-- would erase a debt with no trace.
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_cancel_recorded"
  CHECK ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL);--> statement-breakpoint

-- Money received is always positive. A refund is a separate, deliberate act,
-- never a negative payment slipped into the ledger.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_unallocated_sane"
  CHECK ("unallocated_cents" >= 0 AND "unallocated_cents" <= "amount_cents");--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_status_known" CHECK ("status" IN ('completed','voided'));--> statement-breakpoint
-- Voiding must be attributable. Without this a payment could be neutralised
-- with no record of who did it.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_void_recorded"
  CHECK ("status" <> 'voided' OR ("voided_at" IS NOT NULL AND "void_reason" IS NOT NULL));--> statement-breakpoint

-- An allocation of zero or less is meaningless and would let a payment appear
-- to settle a charge without moving any money.
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_amount_positive" CHECK ("amount_cents" > 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Cross-tenant referential integrity
-- ---------------------------------------------------------------------------

-- A fee structure's category and academic year must be its own school's.
ALTER TABLE "fee_structures"
  DROP CONSTRAINT IF EXISTS "fee_structures_category_id_fee_categories_id_fk";--> statement-breakpoint
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_category_school_fk"
  FOREIGN KEY ("category_id", "school_id") REFERENCES "fee_categories"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "fee_structures"
  DROP CONSTRAINT IF EXISTS "fee_structures_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- A charge must name a student, a fee structure, a year, a term and a grade
-- level that all belong to the charge's own school. This is the constraint
-- that makes a cross-school charge impossible rather than merely unlikely.
ALTER TABLE "student_charges"
  DROP CONSTRAINT IF EXISTS "student_charges_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "student_charges"
  DROP CONSTRAINT IF EXISTS "student_charges_fee_structure_id_fee_structures_id_fk";--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_structure_school_fk"
  FOREIGN KEY ("fee_structure_id", "school_id") REFERENCES "fee_structures"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "student_charges"
  DROP CONSTRAINT IF EXISTS "student_charges_category_id_fee_categories_id_fk";--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_category_school_fk"
  FOREIGN KEY ("category_id", "school_id") REFERENCES "fee_categories"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "student_charges"
  DROP CONSTRAINT IF EXISTS "student_charges_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "student_charges"
  DROP CONSTRAINT IF EXISTS "student_charges_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_term_school_fk"
  FOREIGN KEY ("term_id", "school_id") REFERENCES "terms"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "student_charges"
  DROP CONSTRAINT IF EXISTS "student_charges_grade_level_id_grade_levels_id_fk";--> statement-breakpoint
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_grade_school_fk"
  FOREIGN KEY ("grade_level_id", "school_id") REFERENCES "grade_levels"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

-- A payment must be for a pupil of the same school.
ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS "payments_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- An allocation must join a payment and a charge from the SAME school as
-- itself. Without the pair, school A could allocate its payment against
-- school B's charge and silently clear their debt.
ALTER TABLE "payment_allocations"
  DROP CONSTRAINT IF EXISTS "payment_allocations_payment_id_payments_id_fk";--> statement-breakpoint
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_payment_school_fk"
  FOREIGN KEY ("payment_id", "school_id") REFERENCES "payments"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "payment_allocations"
  DROP CONSTRAINT IF EXISTS "payment_allocations_charge_id_student_charges_id_fk";--> statement-breakpoint
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_charge_school_fk"
  FOREIGN KEY ("charge_id", "school_id") REFERENCES "student_charges"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Reporting indexes
-- ---------------------------------------------------------------------------

-- The dashboard's hot path: sum completed payments for a school over a date
-- range. Partial, because voided payments are never summed.
CREATE INDEX "payments_school_completed_paid_idx"
  ON "payments" ("school_id", "paid_on")
  WHERE "status" = 'completed';--> statement-breakpoint

-- Outstanding-balance queries only ever look at active charges.
CREATE INDEX "student_charges_active_due_idx"
  ON "student_charges" ("school_id", "due_date")
  WHERE "status" = 'active';
