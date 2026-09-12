CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"name" text NOT NULL,
	"asset_tag" varchar(64),
	"category" text,
	"serial_number" varchar(96),
	"section_id" text,
	"location" text,
	"assigned_staff_id" text,
	"status" varchar(24) DEFAULT 'in_use' NOT NULL,
	"condition" varchar(24) DEFAULT 'good' NOT NULL,
	"purchased_on" date,
	"purchase_cost_cents" integer,
	"warranty_until" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"owner_type" varchar(24) NOT NULL,
	"owner_id" text,
	"title" text NOT NULL,
	"category" varchar(48) DEFAULT 'other' NOT NULL,
	"description" text,
	"file_name" text NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"checksum" varchar(64),
	"visible_to_portal" boolean DEFAULT false NOT NULL,
	"expires_on" date,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"name" text NOT NULL,
	"sku" varchar(64),
	"category" text,
	"unit" varchar(32) DEFAULT 'piece' NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"location" text,
	"unit_cost_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"staff_id" text NOT NULL,
	"leave_type_id" text NOT NULL,
	"academic_year_id" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"days" integer NOT NULL,
	"reason" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"key" varchar(48) NOT NULL,
	"name" text NOT NULL,
	"name_am" text,
	"days_per_year" integer,
	"paid" boolean DEFAULT true NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_copies" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"item_id" text NOT NULL,
	"accession_number" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'available' NOT NULL,
	"condition" varchar(24) DEFAULT 'good' NOT NULL,
	"acquired_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_items" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"isbn" varchar(32),
	"publisher" text,
	"published_year" integer,
	"item_type" varchar(24) DEFAULT 'book' NOT NULL,
	"category" text,
	"call_number" varchar(64),
	"language" varchar(32),
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_loans" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"copy_id" text NOT NULL,
	"item_id" text NOT NULL,
	"student_id" text,
	"staff_id" text,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"returned_at" timestamp with time zone,
	"returned_on" date,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	"fine_cents" integer DEFAULT 0 NOT NULL,
	"fine_waived" boolean DEFAULT false NOT NULL,
	"issued_by" text,
	"received_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"asset_id" text,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"priority" varchar(16) DEFAULT 'normal' NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"reported_by" text,
	"reported_on" date NOT NULL,
	"assigned_staff_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"cost_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_stops" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"route_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"pickup_time" varchar(8),
	"dropoff_time" varchar(8),
	"landmark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "school_events" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"academic_year_id" text,
	"term_id" text,
	"title" text NOT NULL,
	"description" text,
	"event_type" varchar(32) DEFAULT 'activity' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"start_time" varchar(8),
	"end_time" varchar(8),
	"all_day" boolean DEFAULT true NOT NULL,
	"location" text,
	"audience" jsonb DEFAULT '{"kind":"all"}'::jsonb NOT NULL,
	"visible_to_portal" boolean DEFAULT true NOT NULL,
	"colour" varchar(16),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"staff_id" text NOT NULL,
	"date" date NOT NULL,
	"status" varchar(24) NOT NULL,
	"check_in" varchar(8),
	"check_out" varchar(8),
	"minutes_late" integer,
	"leave_request_id" text,
	"reason" text,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"item_id" text NOT NULL,
	"movement_type" varchar(24) NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reference" text,
	"note" text,
	"moved_on" date NOT NULL,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_transport" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"academic_year_id" text NOT NULL,
	"route_id" text NOT NULL,
	"pickup_stop_id" text,
	"dropoff_stop_id" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"name" text NOT NULL,
	"code" varchar(32),
	"vehicle_id" text,
	"direction" varchar(16) DEFAULT 'both' NOT NULL,
	"monthly_fee_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"plate_number" varchar(32) NOT NULL,
	"label" text,
	"vehicle_type" varchar(24) DEFAULT 'bus' NOT NULL,
	"capacity" integer DEFAULT 0 NOT NULL,
	"driver_staff_id" text,
	"assistant_staff_id" text,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"insurance_until" date,
	"inspection_until" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_item_id_library_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_copy_id_library_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."library_copies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_item_id_library_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_transport_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transport_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_transport" ADD CONSTRAINT "student_transport_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_transport" ADD CONSTRAINT "student_transport_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_transport" ADD CONSTRAINT "student_transport_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_transport" ADD CONSTRAINT "student_transport_route_id_transport_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transport_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_transport" ADD CONSTRAINT "student_transport_pickup_stop_id_route_stops_id_fk" FOREIGN KEY ("pickup_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_transport" ADD CONSTRAINT "student_transport_dropoff_stop_id_route_stops_id_fk" FOREIGN KEY ("dropoff_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driver_staff_id_staff_id_fk" FOREIGN KEY ("driver_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_assistant_staff_id_staff_id_fk" FOREIGN KEY ("assistant_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_school_tag_uq" ON "assets" USING btree ("school_id","asset_tag") WHERE asset_tag is not null;--> statement-breakpoint
CREATE INDEX "assets_school_status_idx" ON "assets" USING btree ("school_id","status");--> statement-breakpoint
CREATE INDEX "assets_school_name_idx" ON "assets" USING btree ("school_id","name");--> statement-breakpoint
CREATE INDEX "assets_section_idx" ON "assets" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("school_id","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "documents_school_category_idx" ON "documents" USING btree ("school_id","category");--> statement-breakpoint
CREATE INDEX "documents_school_created_idx" ON "documents" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_school_sku_uq" ON "inventory_items" USING btree ("school_id","sku") WHERE sku is not null;--> statement-breakpoint
CREATE INDEX "inventory_items_school_name_idx" ON "inventory_items" USING btree ("school_id","name");--> statement-breakpoint
CREATE INDEX "inventory_items_school_active_idx" ON "inventory_items" USING btree ("school_id","active");--> statement-breakpoint
CREATE INDEX "leave_requests_school_status_idx" ON "leave_requests" USING btree ("school_id","status");--> statement-breakpoint
CREATE INDEX "leave_requests_staff_idx" ON "leave_requests" USING btree ("staff_id","start_date");--> statement-breakpoint
CREATE INDEX "leave_requests_range_idx" ON "leave_requests" USING btree ("school_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_types_school_key_uq" ON "leave_types" USING btree ("school_id","key");--> statement-breakpoint
CREATE INDEX "leave_types_school_idx" ON "leave_types" USING btree ("school_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "library_copies_school_accession_uq" ON "library_copies" USING btree ("school_id","accession_number");--> statement-breakpoint
CREATE INDEX "library_copies_item_idx" ON "library_copies" USING btree ("item_id","status");--> statement-breakpoint
CREATE INDEX "library_copies_school_status_idx" ON "library_copies" USING btree ("school_id","status");--> statement-breakpoint
CREATE INDEX "library_items_school_title_idx" ON "library_items" USING btree ("school_id","title");--> statement-breakpoint
CREATE INDEX "library_items_school_type_idx" ON "library_items" USING btree ("school_id","item_type");--> statement-breakpoint
CREATE INDEX "library_items_isbn_idx" ON "library_items" USING btree ("school_id","isbn");--> statement-breakpoint
CREATE UNIQUE INDEX "library_loans_open_copy_uq" ON "library_loans" USING btree ("copy_id") WHERE returned_at is null;--> statement-breakpoint
CREATE INDEX "library_loans_school_due_idx" ON "library_loans" USING btree ("school_id","due_on");--> statement-breakpoint
CREATE INDEX "library_loans_student_idx" ON "library_loans" USING btree ("student_id","returned_at");--> statement-breakpoint
CREATE INDEX "library_loans_staff_idx" ON "library_loans" USING btree ("staff_id","returned_at");--> statement-breakpoint
CREATE INDEX "library_loans_item_idx" ON "library_loans" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "maintenance_school_status_idx" ON "maintenance_issues" USING btree ("school_id","status","priority");--> statement-breakpoint
CREATE INDEX "maintenance_asset_idx" ON "maintenance_issues" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "maintenance_assigned_idx" ON "maintenance_issues" USING btree ("assigned_staff_id","status");--> statement-breakpoint
CREATE INDEX "route_stops_route_idx" ON "route_stops" USING btree ("route_id","sort_order");--> statement-breakpoint
CREATE INDEX "route_stops_school_idx" ON "route_stops" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "school_events_school_start_idx" ON "school_events" USING btree ("school_id","start_date");--> statement-breakpoint
CREATE INDEX "school_events_year_idx" ON "school_events" USING btree ("school_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "school_events_type_idx" ON "school_events" USING btree ("school_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_attendance_staff_date_uq" ON "staff_attendance" USING btree ("staff_id","date");--> statement-breakpoint
CREATE INDEX "staff_attendance_school_date_idx" ON "staff_attendance" USING btree ("school_id","date");--> statement-breakpoint
CREATE INDEX "staff_attendance_status_idx" ON "staff_attendance" USING btree ("school_id","status","date");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("item_id","moved_on");--> statement-breakpoint
CREATE INDEX "stock_movements_school_date_idx" ON "stock_movements" USING btree ("school_id","moved_on");--> statement-breakpoint
CREATE UNIQUE INDEX "student_transport_active_uq" ON "student_transport" USING btree ("student_id","academic_year_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "student_transport_route_idx" ON "student_transport" USING btree ("route_id","status");--> statement-breakpoint
CREATE INDEX "student_transport_school_idx" ON "student_transport" USING btree ("school_id","academic_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_routes_school_code_uq" ON "transport_routes" USING btree ("school_id","code") WHERE code is not null;--> statement-breakpoint
CREATE INDEX "transport_routes_school_active_idx" ON "transport_routes" USING btree ("school_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_school_plate_uq" ON "vehicles" USING btree ("school_id","plate_number");--> statement-breakpoint
CREATE INDEX "vehicles_school_status_idx" ON "vehicles" USING btree ("school_id","status");