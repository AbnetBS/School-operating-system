CREATE TABLE "attendance_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"record_id" text NOT NULL,
	"student_id" text NOT NULL,
	"from_status" varchar(16),
	"to_status" varchar(16) NOT NULL,
	"reason" text,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_holidays" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"academic_year_id" text NOT NULL,
	"date" date NOT NULL,
	"end_date" date,
	"name" text NOT NULL,
	"name_am" text,
	"kind" varchar(24) DEFAULT 'holiday' NOT NULL,
	"applies_to_grade_level_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"session_id" text NOT NULL,
	"student_id" text NOT NULL,
	"date" date NOT NULL,
	"section_id" text NOT NULL,
	"academic_year_id" text NOT NULL,
	"term_id" text,
	"status" varchar(16) NOT NULL,
	"minutes_late" integer,
	"reason" text,
	"excused_by" text,
	"excused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"academic_year_id" text NOT NULL,
	"term_id" text,
	"section_id" text NOT NULL,
	"section_subject_id" text,
	"period_id" text,
	"date" date NOT NULL,
	"mode" varchar(16) DEFAULT 'daily' NOT NULL,
	"taken_by" text,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"present_count" integer DEFAULT 0 NOT NULL,
	"absent_count" integer DEFAULT 0 NOT NULL,
	"late_count" integer DEFAULT 0 NOT NULL,
	"excused_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"synced_offline" boolean DEFAULT false NOT NULL,
	"idempotency_key" varchar(128),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_record_id_attendance_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."attendance_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_holidays" ADD CONSTRAINT "attendance_holidays_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_holidays" ADD CONSTRAINT "attendance_holidays_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_excused_by_users_id_fk" FOREIGN KEY ("excused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_section_subject_id_section_subjects_id_fk" FOREIGN KEY ("section_subject_id") REFERENCES "public"."section_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_period_id_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."periods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_changes_record_idx" ON "attendance_changes" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "attendance_changes_student_idx" ON "attendance_changes" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_holidays_uq" ON "attendance_holidays" USING btree ("school_id","academic_year_id","date","name");--> statement-breakpoint
CREATE INDEX "attendance_holidays_year_idx" ON "attendance_holidays" USING btree ("school_id","academic_year_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_session_student_uq" ON "attendance_records" USING btree ("session_id","student_id");--> statement-breakpoint
CREATE INDEX "attendance_records_student_date_idx" ON "attendance_records" USING btree ("student_id","date");--> statement-breakpoint
CREATE INDEX "attendance_records_school_date_idx" ON "attendance_records" USING btree ("school_id","date");--> statement-breakpoint
CREATE INDEX "attendance_records_status_idx" ON "attendance_records" USING btree ("school_id","status","date");--> statement-breakpoint
CREATE INDEX "attendance_records_year_idx" ON "attendance_records" USING btree ("school_id","academic_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_daily_uq" ON "attendance_sessions" USING btree ("section_id","date") WHERE section_subject_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_subject_uq" ON "attendance_sessions" USING btree ("section_subject_id","date") WHERE section_subject_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_idem_uq" ON "attendance_sessions" USING btree ("school_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "attendance_sessions_school_date_idx" ON "attendance_sessions" USING btree ("school_id","date");--> statement-breakpoint
CREATE INDEX "attendance_sessions_section_date_idx" ON "attendance_sessions" USING btree ("section_id","date");--> statement-breakpoint
CREATE INDEX "attendance_sessions_year_idx" ON "attendance_sessions" USING btree ("school_id","academic_year_id");