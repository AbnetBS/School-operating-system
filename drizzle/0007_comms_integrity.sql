-- Cross-tenant referential integrity for communication.
--
-- Same reasoning as 0001, 0003 and 0005: a plain foreign key proves the
-- referenced row EXISTS, not that it belongs to the SAME SCHOOL. For messaging
-- the consequence is a privacy breach rather than a bad number — a thread
-- stitched to another school's user would let that user read the conversation.
--
-- Composite foreign keys on the (id, school_id) pair make a cross-school
-- communication row impossible at the database level.

-- 1. Parents need the (id, school_id) pair to be referenceable.
--
-- `users` was not given this pair in 0001 because nothing referenced a user
-- together with its school until now. Communication does: a thread
-- participant, an announcement read and a notification all name a user, and
-- each must be provably in the same school as the row pointing at them.
ALTER TABLE "users"
  ADD CONSTRAINT "users_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "message_threads"
  ADD CONSTRAINT "message_threads_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint

-- 2. An announcement read must belong to the announcement's own school.
ALTER TABLE "announcement_reads"
  DROP CONSTRAINT IF EXISTS "announcement_reads_announcement_id_announcements_id_fk";--> statement-breakpoint
ALTER TABLE "announcement_reads"
  ADD CONSTRAINT "announcement_reads_announcement_school_fk"
  FOREIGN KEY ("announcement_id", "school_id") REFERENCES "announcements"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 3. Thread membership, and every message, must stay inside one school.
ALTER TABLE "message_participants"
  DROP CONSTRAINT IF EXISTS "message_participants_thread_id_message_threads_id_fk";--> statement-breakpoint
ALTER TABLE "message_participants"
  ADD CONSTRAINT "message_participants_thread_school_fk"
  FOREIGN KEY ("thread_id", "school_id") REFERENCES "message_threads"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "messages"
  DROP CONSTRAINT IF EXISTS "messages_thread_id_message_threads_id_fk";--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_thread_school_fk"
  FOREIGN KEY ("thread_id", "school_id") REFERENCES "message_threads"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 4. A thread's student, and a notification's student, must be in the same
--    school as the thread/notification itself.
ALTER TABLE "message_threads"
  DROP CONSTRAINT IF EXISTS "message_threads_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "message_threads"
  ADD CONSTRAINT "message_threads_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "notifications"
  DROP CONSTRAINT IF EXISTS "notifications_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "sms_messages"
  DROP CONSTRAINT IF EXISTS "sms_messages_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "sms_messages"
  ADD CONSTRAINT "sms_messages_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

-- 5. Every user referenced by communication must belong to the same school.
--    This is the constraint that stops a foreign account being added to a
--    thread or receiving another school's notifications.
ALTER TABLE "announcement_reads"
  DROP CONSTRAINT IF EXISTS "announcement_reads_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "announcement_reads"
  ADD CONSTRAINT "announcement_reads_user_school_fk"
  FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "message_participants"
  DROP CONSTRAINT IF EXISTS "message_participants_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "message_participants"
  ADD CONSTRAINT "message_participants_user_school_fk"
  FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "notifications"
  DROP CONSTRAINT IF EXISTS "notifications_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_school_fk"
  FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- 6. Value constraints. The application validates these too; the database is
--    the backstop that holds even if a future code path forgets.
ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_audience_ck"
  CHECK ("audience" IN ('everyone','staff','parents','students','section','grade'));--> statement-breakpoint

ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_title_ck"
  CHECK (length(btrim("title")) > 0);--> statement-breakpoint

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_body_ck"
  CHECK (length(btrim("body")) > 0);--> statement-breakpoint

ALTER TABLE "message_threads"
  ADD CONSTRAINT "message_threads_kind_ck"
  CHECK ("kind" IN ('direct','group'));--> statement-breakpoint

ALTER TABLE "sms_messages"
  ADD CONSTRAINT "sms_messages_status_ck"
  CHECK ("status" IN ('queued','sent','failed','unconfigured','cancelled'));--> statement-breakpoint

-- A message that claims to be sent must say which provider sent it. This is
-- the database-level guarantee behind "never claim an SMS was sent when no
-- provider actually sent it".
ALTER TABLE "sms_messages"
  ADD CONSTRAINT "sms_messages_sent_needs_provider_ck"
  CHECK ("status" <> 'sent' OR ("provider" IS NOT NULL AND "sent_at" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_type_ck"
  CHECK ("type" IN (
    'attendance.absent','attendance.late','attendance.risk',
    'grade.published','reportCard.published','homework.assigned',
    'fee.due','payment.recorded','announcement','message'
  ));--> statement-breakpoint

ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_channel_ck"
  CHECK ("channel" IN ('inApp','sms'));
