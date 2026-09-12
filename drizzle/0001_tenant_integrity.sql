-- Cross-tenant referential integrity.
--
-- A plain foreign key such as enrollments.student_id -> students.id proves the
-- student EXISTS, but not that the student belongs to the SAME SCHOOL as the
-- enrolment. A bug (or an attacker with a valid session at School B) could
-- therefore create a row that stitches School A's student to School B's
-- section, producing a record that belongs to neither school cleanly and can
-- leak data across the tenancy boundary.
--
-- The fix is composite foreign keys: give each parent table a unique key on
-- (id, school_id), then have children reference that PAIR. PostgreSQL will
-- then refuse any row whose school_id does not match its parent's.
--
-- This makes cross-tenant corruption structurally impossible rather than
-- merely discouraged by convention.

-- 1. Parent tables need a unique constraint on the (id, school_id) pair.
--    id is already the primary key, so this adds no meaningful storage cost
--    and never rejects a row that would otherwise be valid.
ALTER TABLE "students" ADD CONSTRAINT "students_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "grade_levels" ADD CONSTRAINT "grade_levels_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint

-- 2. student_guardians: both sides must be in the linking row's school.
--    This is the parent-portal authorization boundary, so it matters most.
ALTER TABLE "student_guardians"
  ADD CONSTRAINT "student_guardians_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "student_guardians"
  ADD CONSTRAINT "student_guardians_guardian_school_fk"
  FOREIGN KEY ("guardian_id", "school_id") REFERENCES "guardians"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 3. enrollments: student, section, grade level and year must all match.
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_section_school_fk"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_grade_school_fk"
  FOREIGN KEY ("grade_level_id", "school_id") REFERENCES "grade_levels"("id", "school_id");--> statement-breakpoint
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 4. sections must sit in a grade level and academic year of the same school.
ALTER TABLE "sections"
  ADD CONSTRAINT "sections_grade_school_fk"
  FOREIGN KEY ("grade_level_id", "school_id") REFERENCES "grade_levels"("id", "school_id");--> statement-breakpoint
ALTER TABLE "sections"
  ADD CONSTRAINT "sections_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 5. section_subjects ties a section to a subject; both must match the school.
ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_section_school_fk"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_subject_school_fk"
  FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id");--> statement-breakpoint
ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 6. terms belong to an academic year in the same school.
ALTER TABLE "terms"
  ADD CONSTRAINT "terms_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 7. student_status_history must reference a student in the same school.
ALTER TABLE "student_status_history"
  ADD CONSTRAINT "student_status_history_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;
