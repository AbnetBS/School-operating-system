-- Make "apply this fee" genuinely idempotent.
--
-- The unique index added in 0008 covers
--   (school_id, student_id, fee_structure_id, term_id, installment_number)
-- and is what `onConflictDoNothing` relies on to skip a pupil who has already
-- been charged.
--
-- But `term_id` is NULL for any fee that is not per-term — a one-off
-- registration fee, a monthly fee, a custom one. Under the SQL default of
-- NULLS DISTINCT, two rows whose term_id is NULL are never considered equal,
-- so the index does not match them, `onConflictDoNothing` finds no conflict,
-- and a second application silently bills every one of those pupils again.
--
-- PostgreSQL 15 added NULLS NOT DISTINCT for exactly this case: treat two
-- NULLs as the same value for uniqueness. Rebuilding the index with it makes a
-- repeated apply skip non-term charges the same way it already skips termly
-- ones.
--
-- Existing duplicates are cleared first, keeping the earliest row of each
-- group. Only charges with no money against them are removed: anything a
-- family has paid towards is left alone and must be resolved by a person, not
-- by a migration.

DELETE FROM "student_charges" sc
WHERE sc."fee_structure_id" IS NOT NULL
  AND sc."status" = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM "payment_allocations" pa WHERE pa."charge_id" = sc."id"
  )
  AND EXISTS (
    SELECT 1 FROM "student_charges" keep
    WHERE keep."school_id" = sc."school_id"
      AND keep."student_id" = sc."student_id"
      AND keep."fee_structure_id" = sc."fee_structure_id"
      AND keep."installment_number" = sc."installment_number"
      AND keep."status" = 'active'
      AND keep."term_id" IS NOT DISTINCT FROM sc."term_id"
      AND (keep."created_at", keep."id") < (sc."created_at", sc."id")
  );
--> statement-breakpoint

DROP INDEX IF EXISTS "student_charges_unique_generated";--> statement-breakpoint

CREATE UNIQUE INDEX "student_charges_unique_generated"
  ON "student_charges" ("school_id", "student_id", "fee_structure_id", "term_id", "installment_number")
  NULLS NOT DISTINCT
  WHERE "fee_structure_id" is not null and "status" = 'active';
