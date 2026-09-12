-- Operations integrity.
--
-- Same two jobs as 0001, 0003, 0005, 0007 and 0009, applied to the Group 8
-- tables:
--
--   1. VALUE RULES. A loan with no borrower, a stock movement of zero, leave
--      that ends before it starts, an approver who approved their own request
--      — these must be impossible, not merely unlikely. Application validation
--      is the first line; a CHECK is the one that still holds when a future
--      endpoint, an import script or a console session forgets.
--
--   2. TENANT INTEGRITY. A plain foreign key proves the referenced row EXISTS,
--      not that it belongs to the SAME SCHOOL. Here the consequence is a book
--      issued to another school's pupil, a bus route carrying a child who does
--      not attend, or a document filed against a stranger's record. Composite
--      foreign keys on the (id, school_id) pair make that impossible.

-- ---------------------------------------------------------------------------
-- 1. Referenceable (id, school_id) pairs
-- ---------------------------------------------------------------------------

-- `staff` never needed a composite pair before: nothing in Groups 1-7
-- referenced a member of staff from a school-scoped table. Group 8 references
-- them from seven (attendance, leave, loans, assets, maintenance, and two
-- columns on vehicles), so the pair has to exist first.
ALTER TABLE "staff"
  ADD CONSTRAINT "staff_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint

ALTER TABLE "leave_types"
  ADD CONSTRAINT "leave_types_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "library_items"
  ADD CONSTRAINT "library_items_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "library_copies"
  ADD CONSTRAINT "library_copies_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "transport_routes"
  ADD CONSTRAINT "transport_routes_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint
ALTER TABLE "route_stops"
  ADD CONSTRAINT "route_stops_id_school_uq" UNIQUE ("id", "school_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Value rules — staff attendance and leave
-- ---------------------------------------------------------------------------

ALTER TABLE "staff_attendance"
  ADD CONSTRAINT "staff_attendance_status_known"
  CHECK ("status" IN ('present','absent','late','on_leave','half_day'));--> statement-breakpoint
ALTER TABLE "staff_attendance"
  ADD CONSTRAINT "staff_attendance_minutes_sane"
  CHECK ("minutes_late" IS NULL OR ("minutes_late" >= 0 AND "minutes_late" <= 1440));--> statement-breakpoint

ALTER TABLE "leave_types"
  ADD CONSTRAINT "leave_types_days_positive"
  CHECK ("days_per_year" IS NULL OR "days_per_year" > 0);--> statement-breakpoint

-- Leave that ends before it starts is a data-entry error that would silently
-- produce negative day counts in every report that touches it.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_dates_ordered"
  CHECK ("end_date" >= "start_date");--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_days_positive" CHECK ("days" > 0);--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_status_known"
  CHECK ("status" IN ('pending','approved','rejected','cancelled'));--> statement-breakpoint
-- A decision must be attributable and dated. Same rule as a voided payment:
-- an approval with no approver is not an approval.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_decision_recorded"
  CHECK ("status" IN ('pending','cancelled')
         OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL));--> statement-breakpoint
-- A rejection without a reason tells the person nothing.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_rejection_explained"
  CHECK ("status" <> 'rejected' OR "decision_note" IS NOT NULL);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Value rules — library
-- ---------------------------------------------------------------------------

ALTER TABLE "library_items"
  ADD CONSTRAINT "library_items_type_known"
  CHECK ("item_type" IN ('book','reference','periodical','media','equipment'));--> statement-breakpoint
ALTER TABLE "library_items"
  ADD CONSTRAINT "library_items_year_sane"
  CHECK ("published_year" IS NULL OR ("published_year" >= 1000 AND "published_year" <= 2200));--> statement-breakpoint

ALTER TABLE "library_copies"
  ADD CONSTRAINT "library_copies_status_known"
  CHECK ("status" IN ('available','damaged','lost','withdrawn'));--> statement-breakpoint
ALTER TABLE "library_copies"
  ADD CONSTRAINT "library_copies_condition_known"
  CHECK ("condition" IN ('new','good','fair','poor'));--> statement-breakpoint

-- A loan belongs to exactly one borrower. Two nullable columns without this
-- check permit a loan to nobody (untraceable) or to both (ambiguous).
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_one_borrower"
  CHECK (("student_id" IS NOT NULL AND "staff_id" IS NULL)
      OR ("student_id" IS NULL AND "staff_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_dates_ordered" CHECK ("due_on" >= "issued_on");--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_renewals_non_negative" CHECK ("renewal_count" >= 0);--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_fine_non_negative" CHECK ("fine_cents" >= 0);--> statement-breakpoint
-- The two return columns must agree: either both set or both null. Otherwise
-- the open-loan index and the return report disagree about the same loan.
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_return_consistent"
  CHECK (("returned_at" IS NULL AND "returned_on" IS NULL)
      OR ("returned_at" IS NOT NULL AND "returned_on" IS NOT NULL));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Value rules — inventory
-- ---------------------------------------------------------------------------

-- Stock cannot go negative: issuing more than is held is a counting error, and
-- allowing it makes every downstream valuation wrong.
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_quantity_non_negative" CHECK ("quantity" >= 0);--> statement-breakpoint
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_reorder_non_negative" CHECK ("reorder_level" >= 0);--> statement-breakpoint
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_cost_non_negative"
  CHECK ("unit_cost_cents" IS NULL OR "unit_cost_cents" >= 0);--> statement-breakpoint

-- A movement of zero changes nothing but appears in the ledger as an event.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_delta_non_zero" CHECK ("delta" <> 0);--> statement-breakpoint
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_balance_non_negative" CHECK ("balance_after" >= 0);--> statement-breakpoint
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_type_known"
  CHECK ("movement_type" IN ('receipt','issue','adjustment','loss'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Value rules — assets, maintenance, transport, events, documents
-- ---------------------------------------------------------------------------

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_status_known"
  CHECK ("status" IN ('in_use','in_storage','under_repair','disposed','lost'));--> statement-breakpoint
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_condition_known"
  CHECK ("condition" IN ('new','good','fair','poor'));--> statement-breakpoint
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_cost_non_negative"
  CHECK ("purchase_cost_cents" IS NULL OR "purchase_cost_cents" >= 0);--> statement-breakpoint

ALTER TABLE "maintenance_issues"
  ADD CONSTRAINT "maintenance_priority_known"
  CHECK ("priority" IN ('low','normal','high','urgent'));--> statement-breakpoint
ALTER TABLE "maintenance_issues"
  ADD CONSTRAINT "maintenance_status_known"
  CHECK ("status" IN ('open','in_progress','resolved','closed','cancelled'));--> statement-breakpoint
ALTER TABLE "maintenance_issues"
  ADD CONSTRAINT "maintenance_cost_non_negative"
  CHECK ("cost_cents" IS NULL OR "cost_cents" >= 0);--> statement-breakpoint
-- A resolved issue must say when. Otherwise "how long do repairs take?" is
-- unanswerable, which is the main question the module exists to answer.
ALTER TABLE "maintenance_issues"
  ADD CONSTRAINT "maintenance_resolution_dated"
  CHECK ("status" NOT IN ('resolved','closed') OR "resolved_at" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_status_known"
  CHECK ("status" IN ('active','maintenance','retired'));--> statement-breakpoint
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_type_known"
  CHECK ("vehicle_type" IN ('bus','minibus','van','car','other'));--> statement-breakpoint
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_capacity_non_negative" CHECK ("capacity" >= 0);--> statement-breakpoint

ALTER TABLE "transport_routes"
  ADD CONSTRAINT "transport_routes_direction_known"
  CHECK ("direction" IN ('morning','afternoon','both'));--> statement-breakpoint
ALTER TABLE "transport_routes"
  ADD CONSTRAINT "transport_routes_fee_non_negative"
  CHECK ("monthly_fee_cents" IS NULL OR "monthly_fee_cents" >= 0);--> statement-breakpoint

ALTER TABLE "student_transport"
  ADD CONSTRAINT "student_transport_status_known"
  CHECK ("status" IN ('active','ended'));--> statement-breakpoint
ALTER TABLE "student_transport"
  ADD CONSTRAINT "student_transport_dates_ordered"
  CHECK ("end_date" IS NULL OR "end_date" >= "start_date");--> statement-breakpoint

ALTER TABLE "school_events"
  ADD CONSTRAINT "school_events_dates_ordered"
  CHECK ("end_date" IS NULL OR "end_date" >= "start_date");--> statement-breakpoint
ALTER TABLE "school_events"
  ADD CONSTRAINT "school_events_type_known"
  CHECK ("event_type" IN ('exam','holiday','meeting','activity','sport','ceremony','other'));--> statement-breakpoint

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_owner_type_known"
  CHECK ("owner_type" IN ('student','staff','school'));--> statement-breakpoint
-- A document about a person must name the person; a school-wide one must not.
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_owner_id_matches_type"
  CHECK (("owner_type" = 'school' AND "owner_id" IS NULL)
      OR ("owner_type" <> 'school' AND "owner_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_size_positive" CHECK ("size_bytes" > 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Cross-tenant referential integrity
-- ---------------------------------------------------------------------------

-- Staff attendance: the person must be this school's employee.
ALTER TABLE "staff_attendance"
  DROP CONSTRAINT IF EXISTS "staff_attendance_staff_id_staff_id_fk";--> statement-breakpoint
ALTER TABLE "staff_attendance"
  ADD CONSTRAINT "staff_attendance_staff_school_fk"
  FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- Leave: the requester and the kind of leave both belong to this school.
ALTER TABLE "leave_requests"
  DROP CONSTRAINT IF EXISTS "leave_requests_staff_id_staff_id_fk";--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_staff_school_fk"
  FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "leave_requests"
  DROP CONSTRAINT IF EXISTS "leave_requests_leave_type_id_leave_types_id_fk";--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_type_school_fk"
  FOREIGN KEY ("leave_type_id", "school_id") REFERENCES "leave_types"("id", "school_id")
  ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "leave_requests"
  DROP CONSTRAINT IF EXISTS "leave_requests_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

-- Library: a copy belongs to its own school's title.
ALTER TABLE "library_copies"
  DROP CONSTRAINT IF EXISTS "library_copies_item_id_library_items_id_fk";--> statement-breakpoint
ALTER TABLE "library_copies"
  ADD CONSTRAINT "library_copies_item_school_fk"
  FOREIGN KEY ("item_id", "school_id") REFERENCES "library_items"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- A loan joins a copy, a title and a borrower. All four must be one school's.
-- This is the constraint that stops one school's book being issued to another
-- school's pupil.
ALTER TABLE "library_loans"
  DROP CONSTRAINT IF EXISTS "library_loans_copy_id_library_copies_id_fk";--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_copy_school_fk"
  FOREIGN KEY ("copy_id", "school_id") REFERENCES "library_copies"("id", "school_id")
  ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "library_loans"
  DROP CONSTRAINT IF EXISTS "library_loans_item_id_library_items_id_fk";--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_item_school_fk"
  FOREIGN KEY ("item_id", "school_id") REFERENCES "library_items"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "library_loans"
  DROP CONSTRAINT IF EXISTS "library_loans_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "library_loans"
  DROP CONSTRAINT IF EXISTS "library_loans_staff_id_staff_id_fk";--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_staff_school_fk"
  FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- Inventory: a movement belongs to its own school's item.
ALTER TABLE "stock_movements"
  DROP CONSTRAINT IF EXISTS "stock_movements_item_id_inventory_items_id_fk";--> statement-breakpoint
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_item_school_fk"
  FOREIGN KEY ("item_id", "school_id") REFERENCES "inventory_items"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- Assets: the room and the responsible person are this school's.
ALTER TABLE "assets"
  DROP CONSTRAINT IF EXISTS "assets_section_id_sections_id_fk";--> statement-breakpoint
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_section_school_fk"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "assets"
  DROP CONSTRAINT IF EXISTS "assets_assigned_staff_id_staff_id_fk";--> statement-breakpoint
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_staff_school_fk"
  FOREIGN KEY ("assigned_staff_id", "school_id") REFERENCES "staff"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "maintenance_issues"
  DROP CONSTRAINT IF EXISTS "maintenance_issues_asset_id_assets_id_fk";--> statement-breakpoint
ALTER TABLE "maintenance_issues"
  ADD CONSTRAINT "maintenance_asset_school_fk"
  FOREIGN KEY ("asset_id", "school_id") REFERENCES "assets"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "maintenance_issues"
  DROP CONSTRAINT IF EXISTS "maintenance_issues_assigned_staff_id_staff_id_fk";--> statement-breakpoint
ALTER TABLE "maintenance_issues"
  ADD CONSTRAINT "maintenance_staff_school_fk"
  FOREIGN KEY ("assigned_staff_id", "school_id") REFERENCES "staff"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

-- Transport: driver, assistant, vehicle, stops and pupil are all one school's.
ALTER TABLE "vehicles"
  DROP CONSTRAINT IF EXISTS "vehicles_driver_staff_id_staff_id_fk";--> statement-breakpoint
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_driver_school_fk"
  FOREIGN KEY ("driver_staff_id", "school_id") REFERENCES "staff"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "vehicles"
  DROP CONSTRAINT IF EXISTS "vehicles_assistant_staff_id_staff_id_fk";--> statement-breakpoint
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_assistant_school_fk"
  FOREIGN KEY ("assistant_staff_id", "school_id") REFERENCES "staff"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "transport_routes"
  DROP CONSTRAINT IF EXISTS "transport_routes_vehicle_id_vehicles_id_fk";--> statement-breakpoint
ALTER TABLE "transport_routes"
  ADD CONSTRAINT "transport_routes_vehicle_school_fk"
  FOREIGN KEY ("vehicle_id", "school_id") REFERENCES "vehicles"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "route_stops"
  DROP CONSTRAINT IF EXISTS "route_stops_route_id_transport_routes_id_fk";--> statement-breakpoint
ALTER TABLE "route_stops"
  ADD CONSTRAINT "route_stops_route_school_fk"
  FOREIGN KEY ("route_id", "school_id") REFERENCES "transport_routes"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "student_transport"
  DROP CONSTRAINT IF EXISTS "student_transport_student_id_students_id_fk";--> statement-breakpoint
ALTER TABLE "student_transport"
  ADD CONSTRAINT "student_transport_student_school_fk"
  FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "student_transport"
  DROP CONSTRAINT IF EXISTS "student_transport_route_id_transport_routes_id_fk";--> statement-breakpoint
ALTER TABLE "student_transport"
  ADD CONSTRAINT "student_transport_route_school_fk"
  FOREIGN KEY ("route_id", "school_id") REFERENCES "transport_routes"("id", "school_id")
  ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "student_transport"
  DROP CONSTRAINT IF EXISTS "student_transport_pickup_stop_id_route_stops_id_fk";--> statement-breakpoint
ALTER TABLE "student_transport"
  ADD CONSTRAINT "student_transport_pickup_school_fk"
  FOREIGN KEY ("pickup_stop_id", "school_id") REFERENCES "route_stops"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "student_transport"
  DROP CONSTRAINT IF EXISTS "student_transport_dropoff_stop_id_route_stops_id_fk";--> statement-breakpoint
ALTER TABLE "student_transport"
  ADD CONSTRAINT "student_transport_dropoff_school_fk"
  FOREIGN KEY ("dropoff_stop_id", "school_id") REFERENCES "route_stops"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "student_transport"
  DROP CONSTRAINT IF EXISTS "student_transport_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "student_transport"
  ADD CONSTRAINT "student_transport_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- Events: the year and term are this school's.
ALTER TABLE "school_events"
  DROP CONSTRAINT IF EXISTS "school_events_academic_year_id_academic_years_id_fk";--> statement-breakpoint
ALTER TABLE "school_events"
  ADD CONSTRAINT "school_events_year_school_fk"
  FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "school_events"
  DROP CONSTRAINT IF EXISTS "school_events_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "school_events"
  ADD CONSTRAINT "school_events_term_school_fk"
  FOREIGN KEY ("term_id", "school_id") REFERENCES "terms"("id", "school_id")
  ON DELETE SET NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Performance indexes for the Group 9 read paths
-- ---------------------------------------------------------------------------

-- The overdue-loans work queue reads open loans past their due date.
CREATE INDEX "library_loans_overdue_idx"
  ON "library_loans" ("school_id", "due_on")
  WHERE "returned_at" IS NULL;--> statement-breakpoint

-- The low-stock work queue.
CREATE INDEX "inventory_items_low_stock_idx"
  ON "inventory_items" ("school_id")
  WHERE "active" = true;--> statement-breakpoint

-- The pending-leave work queue.
CREATE INDEX "leave_requests_pending_idx"
  ON "leave_requests" ("school_id", "created_at")
  WHERE "status" = 'pending';--> statement-breakpoint

-- The open-maintenance work queue.
CREATE INDEX "maintenance_open_idx"
  ON "maintenance_issues" ("school_id", "priority", "reported_on")
  WHERE "status" IN ('open','in_progress');--> statement-breakpoint

-- Portal document lookups filter on visibility before anything else.
CREATE INDEX "documents_portal_idx"
  ON "documents" ("school_id", "owner_type", "owner_id")
  WHERE "visible_to_portal" = true;
