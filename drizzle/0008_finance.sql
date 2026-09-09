CREATE TABLE "fee_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"key" varchar(48) NOT NULL,
	"name" text NOT NULL,
	"name_am" text,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_structures" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"academic_year_id" text NOT NULL,
	"category_id" text,
	"name" text NOT NULL,
	"name_am" text,
	"description" text,
	"amount_cents" integer NOT NULL,
	"billing_period" varchar(16) DEFAULT 'term' NOT NULL,
	"applies_to" varchar(16) DEFAULT 'all' NOT NULL,
	"grade_level_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"section_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"installment_count" integer DEFAULT 1 NOT NULL,
	"due_date" date,
	"due_day_of_period" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_counters" (
	"school_id" text PRIMARY KEY NOT NULL,
	"receipt_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"receipt_number" varchar(40) NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" varchar(32) NOT NULL,
	"reference_number" varchar(80),
	"paid_on" date NOT NULL,
	"unallocated_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"status" varchar(16) DEFAULT 'completed' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"client_key" varchar(80),
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"fee_structure_id" text,
	"category_id" text,
	"academic_year_id" text NOT NULL,
	"term_id" text,
	"grade_level_id" text,
	"description" text NOT NULL,
	"description_am" text,
	"amount_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"discount_type" varchar(16) DEFAULT 'none' NOT NULL,
	"discount_reason" text,
	"net_amount_cents" integer GENERATED ALWAYS AS ("amount_cents" - "discount_cents") STORED,
	"installment_number" integer DEFAULT 1 NOT NULL,
	"installment_total" integer DEFAULT 1 NOT NULL,
	"due_date" date,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_categories" ADD CONSTRAINT "fee_categories_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_category_id_fee_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fee_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_counters" ADD CONSTRAINT "finance_counters_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_charge_id_student_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."student_charges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_fee_structure_id_fee_structures_id_fk" FOREIGN KEY ("fee_structure_id") REFERENCES "public"."fee_structures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_category_id_fee_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fee_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_grade_level_id_grade_levels_id_fk" FOREIGN KEY ("grade_level_id") REFERENCES "public"."grade_levels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_categories_school_key_uq" ON "fee_categories" USING btree ("school_id","key");--> statement-breakpoint
CREATE INDEX "fee_categories_school_idx" ON "fee_categories" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "fee_structures_school_year_idx" ON "fee_structures" USING btree ("school_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "fee_structures_school_active_idx" ON "fee_structures" USING btree ("school_id","is_active");--> statement-breakpoint
CREATE INDEX "payment_allocations_school_payment_idx" ON "payment_allocations" USING btree ("school_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_school_charge_idx" ON "payment_allocations" USING btree ("school_id","charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_charge_uq" ON "payment_allocations" USING btree ("payment_id","charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_school_receipt_uq" ON "payments" USING btree ("school_id","receipt_number");--> statement-breakpoint
CREATE INDEX "payments_school_student_idx" ON "payments" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "payments_school_paid_idx" ON "payments" USING btree ("school_id","paid_on");--> statement-breakpoint
CREATE INDEX "payments_school_status_idx" ON "payments" USING btree ("school_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_school_client_key_uq" ON "payments" USING btree ("school_id","client_key") WHERE "client_key" is not null;--> statement-breakpoint
CREATE INDEX "student_charges_school_student_idx" ON "student_charges" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "student_charges_school_year_idx" ON "student_charges" USING btree ("school_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "student_charges_school_due_idx" ON "student_charges" USING btree ("school_id","due_date");--> statement-breakpoint
CREATE INDEX "student_charges_school_status_idx" ON "student_charges" USING btree ("school_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "student_charges_unique_generated" ON "student_charges" USING btree ("school_id","student_id","fee_structure_id","term_id","installment_number") WHERE "fee_structure_id" is not null and "status" = 'active';