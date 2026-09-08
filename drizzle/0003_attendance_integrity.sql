-- Cross-tenant referential integrity for attendance.
--
-- Same reasoning as 0001_tenant_integrity.sql: a plain foreign key proves the
-- referenced row EXISTS, not that it belongs to the SAME SCHOOL. Attendance is
-- especially sensitive because a mis-stitched row would silently corrupt a
-- student's attendance percentage — which in turn drives at-risk flags,
-- parent SMS alerts and, in some schools, promotion decisions.
--
-- Composite foreign keys make a cross-school attendance row impossible at the
-- database level, not merely unlikely.

-- 1. Attendance parents need the (id, school_id) pair to reference.
ALTER TABLE "attendance_sessions"
  ADD CONSTRAINT "attendance_sessions_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint

-- 2. A session's section and year must belong to the session's school.
ALTER TABLE "attendance_sessions"
  DROP CONSTRAINT IF EXISTS "attendance_sessions_section_id_sections_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_sessions"
  ADD CONSTRAINT "attendance_sessions_section_school_fk"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "attendance_sessions"
  DROP CONSTRAINT IF EXISTS "attendance_sessions_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_sessions"
  ADD CONSTRAINT "attendance_sessions_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "attendance_sessions"
  DROP CONSTRAINT IF EXISTS "attendance_sessions_section_subject_id_section_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_sessions"
  ADD CONSTRAINT "attendance_sessions_subject_school_fk"
  FOREIGN KEY ("section_subject_id", "school_id") REFERENCES "section_subjects"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 3. A record's session, student and section must all be in the same school.
--    This is the constraint that actually prevents School A's student from
--    appearing on School B's register.
ALTER TABLE "attendance_records"
  DROP CONSTRAINT IF EXISTS "attendance_records_session_id_attendance_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_session_school_fk"
  FOREIGN KEY ("session_id", "school_id") REFERENCES "attendance_sessions"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "attendance_records"
  DROP CONSTRAINT IF EXISTS "attendance_records_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "attendance_records"
  DROP CONSTRAINT IF EXISTS "attendance_records_section_id_sections_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_section_school_fk"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 4. Change history must stay within the school of the record it describes.
ALTER TABLE "attendance_changes"
  DROP CONSTRAINT IF EXISTS "attendance_changes_record_id_attendance_records_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_changes"
  ADD CONSTRAINT "attendance_changes_record_school_fk"
  FOREIGN KEY ("record_id", "school_id") REFERENCES "attendance_records"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "attendance_changes"
  DROP CONSTRAINT IF EXISTS "attendance_changes_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_changes"
  ADD CONSTRAINT "attendance_changes_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 5. Holidays belong to a year in the same school.
ALTER TABLE "attendance_holidays"
  DROP CONSTRAINT IF EXISTS "attendance_holidays_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "attendance_holidays"
  ADD CONSTRAINT "attendance_holidays_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 6. A student may only ever have ONE attendance record per session.
--    Already enforced by a unique index in 0002; restated here as a named
--    constraint so the error message is recognisable to friendlyDbError.
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_records_student_day_daily_uq"
  ON "attendance_records" ("student_id", "date", "section_id")
  WHERE "term_id" IS NOT NULL;
