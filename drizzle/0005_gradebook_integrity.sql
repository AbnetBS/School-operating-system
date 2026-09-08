-- Cross-tenant referential integrity for the gradebook.
--
-- Same reasoning as 0001_tenant_integrity.sql and 0003_attendance_integrity.sql:
-- a plain foreign key proves the referenced row EXISTS, not that it belongs to
-- the SAME SCHOOL. For marks this is the most consequential place in the whole
-- system to get wrong — a mis-stitched row would attach one school's mark to
-- another school's student, corrupting a report card that gets signed, printed
-- and handed to a parent.
--
-- Composite foreign keys make a cross-school grade row impossible at the
-- database level, not merely unlikely.

-- 1. Parents need the (id, school_id) pair to be referenceable.
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "marks"
  ADD CONSTRAINT "marks_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "grading_configs"
  ADD CONSTRAINT "grading_configs_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint

-- 2. An assessment's year, term and class-subject must be in its own school.
ALTER TABLE "assessments"
  DROP CONSTRAINT IF EXISTS "assessments_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "assessments"
  DROP CONSTRAINT IF EXISTS "assessments_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_term_school_fk"
  FOREIGN KEY ("term_id", "school_id") REFERENCES "terms"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "assessments"
  DROP CONSTRAINT IF EXISTS "assessments_section_subject_id_section_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_section_subject_school_fk"
  FOREIGN KEY ("section_subject_id", "school_id") REFERENCES "section_subjects"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 3. A mark's assessment and student must both be in the mark's school.
--    This is the constraint that actually prevents School A's pupil from
--    receiving School B's grade.
ALTER TABLE "marks"
  DROP CONSTRAINT IF EXISTS "marks_assessment_id_assessments_id_fk";--> statement-breakpoint
ALTER TABLE "marks"
  ADD CONSTRAINT "marks_assessment_school_fk"
  FOREIGN KEY ("assessment_id", "school_id") REFERENCES "assessments"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "marks"
  DROP CONSTRAINT IF EXISTS "marks_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "marks"
  ADD CONSTRAINT "marks_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 4. Mark-change history is bound to the same school as its mark and student.
ALTER TABLE "mark_changes"
  DROP CONSTRAINT IF EXISTS "mark_changes_mark_id_marks_id_fk";--> statement-breakpoint
ALTER TABLE "mark_changes"
  ADD CONSTRAINT "mark_changes_mark_school_fk"
  FOREIGN KEY ("mark_id", "school_id") REFERENCES "marks"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "mark_changes"
  DROP CONSTRAINT IF EXISTS "mark_changes_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "mark_changes"
  ADD CONSTRAINT "mark_changes_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 5. Cached results must not mix schools either. A wrong average is as
--    damaging as a wrong mark once it reaches a report card.
ALTER TABLE "subject_results"
  DROP CONSTRAINT IF EXISTS "subject_results_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "subject_results"
  ADD CONSTRAINT "subject_results_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "subject_results"
  DROP CONSTRAINT IF EXISTS "subject_results_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "subject_results"
  ADD CONSTRAINT "subject_results_term_school_fk"
  FOREIGN KEY ("term_id", "school_id") REFERENCES "terms"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "subject_results"
  DROP CONSTRAINT IF EXISTS "subject_results_section_subject_id_section_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "subject_results"
  ADD CONSTRAINT "subject_results_section_subject_school_fk"
  FOREIGN KEY ("section_subject_id", "school_id") REFERENCES "section_subjects"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "term_results"
  DROP CONSTRAINT IF EXISTS "term_results_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "term_results"
  ADD CONSTRAINT "term_results_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "term_results"
  DROP CONSTRAINT IF EXISTS "term_results_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "term_results"
  ADD CONSTRAINT "term_results_term_school_fk"
  FOREIGN KEY ("term_id", "school_id") REFERENCES "terms"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "term_results"
  DROP CONSTRAINT IF EXISTS "term_results_section_id_sections_id_fk";--> statement-breakpoint
ALTER TABLE "term_results"
  ADD CONSTRAINT "term_results_section_school_fk"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

-- 6. Report cards likewise.
ALTER TABLE "report_cards"
  DROP CONSTRAINT IF EXISTS "report_cards_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "report_cards"
  ADD CONSTRAINT "report_cards_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "report_cards"
  DROP CONSTRAINT IF EXISTS "report_cards_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "report_cards"
  ADD CONSTRAINT "report_cards_term_school_fk"
  FOREIGN KEY ("term_id", "school_id") REFERENCES "terms"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 7. A per-subject grading override must belong to the same school as the
--    class-subject it overrides.
ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_grading_config_school_fk"
  FOREIGN KEY ("grading_config_id", "school_id") REFERENCES "grading_configs"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

-- 8. Guard rails on the workflow and mark values themselves. These are cheap
--    and they catch application bugs that would otherwise be discovered by a
--    parent reading an impossible grade.
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_status_ck"
  CHECK ("status" IN ('draft', 'submitted', 'approved', 'locked'));--> statement-breakpoint
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_max_mark_ck" CHECK ("max_mark" > 0);--> statement-breakpoint
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_instance_ck" CHECK ("instance" >= 1);--> statement-breakpoint

-- A mark may be null (not entered) but never negative. The upper bound is
-- checked in the service against the assessment's max_mark, which SQL cannot
-- reference from here without a trigger.
ALTER TABLE "marks"
  ADD CONSTRAINT "marks_non_negative_ck" CHECK ("mark" IS NULL OR "mark" >= 0);--> statement-breakpoint
-- An excused mark must not also carry a score: the two states are exclusive
-- and conflating them is what silently corrupts an average.
ALTER TABLE "marks"
  ADD CONSTRAINT "marks_excused_has_no_score_ck"
  CHECK (NOT ("is_excused" AND "mark" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "report_cards"
  ADD CONSTRAINT "report_cards_status_ck"
  CHECK ("status" IN ('draft', 'pending_approval', 'approved', 'published'));
