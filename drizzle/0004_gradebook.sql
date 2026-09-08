CREATE TABLE "assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"academic_year_id" text NOT NULL,
	"term_id" text NOT NULL,
	"section_subject_id" text NOT NULL,
	"component_key" varchar(32) NOT NULL,
	"instance" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"title_am" text,
	"max_mark" real DEFAULT 100 NOT NULL,
	"assessed_on" date,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"review_note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grading_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"name" text NOT NULL,
	"name_am" text,
	"description" text,
	"components" jsonb NOT NULL,
	"pass_mark_percent" real,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mark_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"mark_id" text NOT NULL,
	"student_id" text NOT NULL,
	"previous_mark" real,
	"new_mark" real,
	"previous_excused" boolean,
	"new_excused" boolean,
	"reason" text,
	"was_locked" boolean DEFAULT false NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marks" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"assessment_id" text NOT NULL,
	"student_id" text NOT NULL,
	"mark" real,
	"is_excused" boolean DEFAULT false NOT NULL,
	"note" text,
	"entered_by" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"term_id" text NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"class_teacher_comment" text,
	"principal_comment" text,
	"conduct" varchar(32),
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"published_at" timestamp with time zone,
	"published_by" text,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_results" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"term_id" text NOT NULL,
	"section_subject_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"percentage" real,
	"provisional_percentage" real,
	"letter" varchar(4),
	"points" real,
	"is_pass" boolean,
	"is_complete" boolean DEFAULT false NOT NULL,
	"rank" integer,
	"breakdown" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_results" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"term_id" text NOT NULL,
	"section_id" text,
	"average" real,
	"gpa" real,
	"total_subjects" integer DEFAULT 0 NOT NULL,
	"passed_subjects" integer DEFAULT 0 NOT NULL,
	"failed_subjects" integer DEFAULT 0 NOT NULL,
	"is_pass" boolean,
	"rank_in_section" integer,
	"rank_in_grade" integer,
	"class_size" integer,
	"attendance_percent" real,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_section_subject_id_section_subjects_id_fk" FOREIGN KEY ("section_subject_id") REFERENCES "public"."section_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_configs" ADD CONSTRAINT "grading_configs_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_changes" ADD CONSTRAINT "mark_changes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_changes" ADD CONSTRAINT "mark_changes_mark_id_marks_id_fk" FOREIGN KEY ("mark_id") REFERENCES "public"."marks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_changes" ADD CONSTRAINT "mark_changes_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_changes" ADD CONSTRAINT "mark_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_section_subject_id_section_subjects_id_fk" FOREIGN KEY ("section_subject_id") REFERENCES "public"."section_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assessments_component_instance_uq" ON "assessments" USING btree ("section_subject_id","term_id","component_key","instance");--> statement-breakpoint
CREATE INDEX "assessments_school_term_idx" ON "assessments" USING btree ("school_id","term_id");--> statement-breakpoint
CREATE INDEX "assessments_section_subject_idx" ON "assessments" USING btree ("section_subject_id","term_id");--> statement-breakpoint
CREATE INDEX "assessments_status_idx" ON "assessments" USING btree ("school_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_configs_school_name_uq" ON "grading_configs" USING btree ("school_id","name");--> statement-breakpoint
CREATE INDEX "grading_configs_school_idx" ON "grading_configs" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "mark_changes_student_idx" ON "mark_changes" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "mark_changes_mark_idx" ON "mark_changes" USING btree ("mark_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marks_assessment_student_uq" ON "marks" USING btree ("assessment_id","student_id");--> statement-breakpoint
CREATE INDEX "marks_student_idx" ON "marks" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "marks_assessment_idx" ON "marks" USING btree ("assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_cards_student_term_uq" ON "report_cards" USING btree ("student_id","term_id");--> statement-breakpoint
CREATE INDEX "report_cards_term_status_idx" ON "report_cards" USING btree ("school_id","term_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_results_uq" ON "subject_results" USING btree ("student_id","term_id","section_subject_id");--> statement-breakpoint
CREATE INDEX "subject_results_term_idx" ON "subject_results" USING btree ("school_id","term_id");--> statement-breakpoint
CREATE INDEX "subject_results_section_subject_idx" ON "subject_results" USING btree ("section_subject_id","term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "term_results_uq" ON "term_results" USING btree ("student_id","term_id");--> statement-breakpoint
CREATE INDEX "term_results_term_idx" ON "term_results" USING btree ("school_id","term_id");--> statement-breakpoint
CREATE INDEX "term_results_section_idx" ON "term_results" USING btree ("section_id","term_id");