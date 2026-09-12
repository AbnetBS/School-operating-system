/**
 * Operations schema — Group 8.
 *
 * Staff attendance, leave, library, inventory, assets, transport, the school
 * calendar and document metadata.
 *
 * DESIGN NOTES
 * ------------
 * STAFF ATTENDANCE IS NOT STUDENT ATTENDANCE. Student attendance is a register
 * taken per section per day by whoever teaches it; staff attendance is one
 * daily status per person, normally entered by an administrator. Sharing the
 * tables would put a nullable `section_id` on every row and force every query
 * to ask "is this a pupil or a member of staff?". They share a shape, not a
 * table: a school-local `date`, a configurable status vocabulary, and an
 * idempotency key so a resubmitted day is a no-op.
 *
 * A PHYSICAL THING AND A RECORD OF IT ARE DIFFERENT ROWS. A library *title* is
 * not a *copy*: a school owns six copies of one book and can lend five while
 * one is lost. Modelling only the title forces a `quantity` integer that drifts
 * the moment two librarians work at once. So `library_items` is the title,
 * `library_copies` is the physical book, and a loan points at a **copy**.
 * Availability is then derived — never stored — exactly as a fee balance is
 * derived in Group 7.
 *
 * INVENTORY IS THE DELIBERATE EXCEPTION. A box of chalk has no identity worth
 * tracking, so `inventory_items` does carry a quantity. But it is never updated
 * by reading and writing: every change appends a `stock_movements` row and the
 * column is recomputed in the same transaction under `SELECT … FOR UPDATE`.
 * The movement history is the truth; the column is a rebuildable cache.
 *
 * DATES ARE SCHOOL-LOCAL. Same rule as attendance: a plain calendar `date`,
 * never a timestamp, so a record made at 08:00 in Addis does not drift to the
 * previous day because the server runs in UTC.
 */

import {
  pgTable,
  text,
  varchar,
  boolean,
  integer,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { schools, users, academicYears, terms, sections } from './core.ts';
import { students, staff } from './people.ts';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Staff attendance
// ---------------------------------------------------------------------------

/**
 * One member of staff's attendance for one day.
 *
 * `status` is a varchar rather than an enum for the same reason student
 * attendance uses one: the vocabulary is configurable per school, and adding
 * 'field_work' must not require a migration.
 */
export const staffAttendance = pgTable(
  'staff_attendance',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),

    /** School-local calendar date. */
    date: date('date').notNull(),

    /** present | absent | late | on_leave | half_day — configurable. */
    status: varchar('status', { length: 24 }).notNull(),

    /** Optional clock times, for schools that record them. */
    checkIn: varchar('check_in', { length: 8 }),
    checkOut: varchar('check_out', { length: 8 }),
    minutesLate: integer('minutes_late'),

    /** Set when the day was covered by an approved leave request. */
    leaveRequestId: text('leave_request_id'),

    reason: text('reason'),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One record per person per day. This is the constraint that makes a
    // resubmitted day an update rather than a duplicate.
    uniqueIndex('staff_attendance_staff_date_uq').on(t.staffId, t.date),
    index('staff_attendance_school_date_idx').on(t.schoolId, t.date),
    index('staff_attendance_status_idx').on(t.schoolId, t.status, t.date),
  ],
);

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

/**
 * A school-defined kind of leave (annual, sick, maternity, unpaid…).
 *
 * Nothing about leave entitlement is hard-coded: a school that gives 20 days
 * of annual leave and one that gives 12 both configure it here.
 */
export const leaveTypes = pgTable(
  'leave_types',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** Stable machine key, e.g. 'annual'. */
    key: varchar('key', { length: 48 }).notNull(),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    /** Days granted per academic year. Null = unlimited / not tracked. */
    daysPerYear: integer('days_per_year'),
    /** Whether the days are deducted from pay. Informational until payroll. */
    paid: boolean('paid').notNull().default(true),
    requiresApproval: boolean('requires_approval').notNull().default(true),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('leave_types_school_key_uq').on(t.schoolId, t.key),
    index('leave_types_school_idx').on(t.schoolId, t.active),
  ],
);

/**
 * A request for leave, and its approval trail.
 *
 * Same rule as grade approval in Group 4: a transition records who and why.
 * An approver may not approve their own request — enforced in the service and
 * by a CHECK in the migration.
 */
export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    leaveTypeId: text('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    academicYearId: text('academic_year_id').references(() => academicYears.id, {
      onDelete: 'set null',
    }),

    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /**
     * Working days requested. Computed by the service from the school's
     * calendar rather than by subtracting dates, so weekends and holidays are
     * excluded according to the school's own configuration.
     */
    days: integer('days').notNull(),

    reason: text('reason'),

    /** pending | approved | rejected | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('pending'),

    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Required when rejecting — a rejection without a reason is not useful. */
    decisionNote: text('decision_note'),

    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('leave_requests_school_status_idx').on(t.schoolId, t.status),
    index('leave_requests_staff_idx').on(t.staffId, t.startDate),
    index('leave_requests_range_idx').on(t.schoolId, t.startDate, t.endDate),
  ],
);

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** A title the library holds — the bibliographic record, not a physical book. */
export const libraryItems = pgTable(
  'library_items',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    author: text('author'),
    /** ISBN is optional: many Amharic-language titles have none. */
    isbn: varchar('isbn', { length: 32 }),
    publisher: text('publisher'),
    publishedYear: integer('published_year'),
    /** book | reference | periodical | media | equipment */
    itemType: varchar('item_type', { length: 24 }).notNull().default('book'),
    category: text('category'),
    /** Shelf/classification mark, school's own scheme. */
    callNumber: varchar('call_number', { length: 64 }),
    language: varchar('language', { length: 32 }),
    description: text('description'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('library_items_school_title_idx').on(t.schoolId, t.title),
    index('library_items_school_type_idx').on(t.schoolId, t.itemType),
    // ISBN is not unique per school: a school may catalogue the same ISBN
    // twice under different call numbers. Copies carry the uniqueness.
    index('library_items_isbn_idx').on(t.schoolId, t.isbn),
  ],
);

/**
 * One physical copy of a title.
 *
 * `status` is the copy's own condition, independent of whether it is on loan:
 * a copy can be 'available' and lent, or 'lost' and never returned. Whether it
 * can be issued is derived from status AND the absence of an open loan.
 */
export const libraryCopies = pgTable(
  'library_copies',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),
    /** Accession number — the school's physical label on the book. */
    accessionNumber: varchar('accession_number', { length: 64 }).notNull(),
    /** available | damaged | lost | withdrawn */
    status: varchar('status', { length: 24 }).notNull().default('available'),
    /** new | good | fair | poor */
    condition: varchar('condition', { length: 24 }).notNull().default('good'),
    acquiredOn: date('acquired_on'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('library_copies_school_accession_uq').on(t.schoolId, t.accessionNumber),
    index('library_copies_item_idx').on(t.itemId, t.status),
    index('library_copies_school_status_idx').on(t.schoolId, t.status),
  ],
);

/**
 * A loan of one copy to one borrower.
 *
 * The borrower is a student OR a member of staff, never both and never
 * neither — enforced by a CHECK in the migration rather than by two nullable
 * columns and hope.
 *
 * The partial unique index on (copy_id) where returned_at is null is what makes
 * double-issuing a copy impossible even if two requests race past the lock.
 */
export const libraryLoans = pgTable(
  'library_loans',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    copyId: text('copy_id')
      .notNull()
      .references(() => libraryCopies.id, { onDelete: 'restrict' }),
    /** Denormalised so "who has borrowed this title" needs no join. */
    itemId: text('item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),

    /** Exactly one of these is set. */
    studentId: text('student_id').references(() => students.id, { onDelete: 'cascade' }),
    staffId: text('staff_id').references(() => staff.id, { onDelete: 'cascade' }),

    issuedOn: date('issued_on').notNull(),
    dueOn: date('due_on').notNull(),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnedOn: date('returned_on'),

    /** Number of times the loan has been extended. */
    renewalCount: integer('renewal_count').notNull().default(0),

    /**
     * Fine accrued, in cents, using the same integer-cents rule as Group 7.
     * Recorded here for the librarian; turning it into a payable charge is a
     * finance action, not a library one.
     */
    fineCents: integer('fine_cents').notNull().default(0),
    fineWaived: boolean('fine_waived').notNull().default(false),

    issuedBy: text('issued_by').references(() => users.id, { onDelete: 'set null' }),
    receivedBy: text('received_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A copy can be out on at most one loan at a time.
    uniqueIndex('library_loans_open_copy_uq')
      .on(t.copyId)
      .where(sql`returned_at is null`),
    index('library_loans_school_due_idx').on(t.schoolId, t.dueOn),
    index('library_loans_student_idx').on(t.studentId, t.returnedAt),
    index('library_loans_staff_idx').on(t.staffId, t.returnedAt),
    index('library_loans_item_idx').on(t.itemId),
  ],
);

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * A consumable or bulk stock item.
 *
 * `quantity` is a cache of the movement history, recomputed inside the writing
 * transaction. See the module note above.
 */
export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sku: varchar('sku', { length: 64 }),
    category: text('category'),
    /** piece | box | packet | litre | kg — free text, school's own units. */
    unit: varchar('unit', { length: 32 }).notNull().default('piece'),
    /** Derived cache. Never written directly; see stock_movements. */
    quantity: integer('quantity').notNull().default(0),
    /** Below this, the item appears in the low-stock work queue. */
    reorderLevel: integer('reorder_level').notNull().default(0),
    location: text('location'),
    /** Unit cost in cents, for valuation. Optional. */
    unitCostCents: integer('unit_cost_cents'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('inventory_items_school_sku_uq')
      .on(t.schoolId, t.sku)
      .where(sql`sku is not null`),
    index('inventory_items_school_name_idx').on(t.schoolId, t.name),
    index('inventory_items_school_active_idx').on(t.schoolId, t.active),
  ],
);

/**
 * Append-only stock ledger. The truth behind `inventory_items.quantity`.
 *
 * `delta` is signed: positive for a receipt, negative for an issue. Storing the
 * signed change rather than a separate direction column means the balance is
 * always `sum(delta)` — one expression, impossible to get wrong.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => inventoryItems.id, { onDelete: 'cascade' }),
    /** receipt | issue | adjustment | loss */
    movementType: varchar('movement_type', { length: 24 }).notNull(),
    /** Signed. Positive adds stock, negative removes it. Never zero. */
    delta: integer('delta').notNull(),
    /** Balance after this movement, for an auditable running total. */
    balanceAfter: integer('balance_after').notNull(),
    /** Free text: who took it, which department, why. */
    reference: text('reference'),
    note: text('note'),
    movedOn: date('moved_on').notNull(),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('stock_movements_item_idx').on(t.itemId, t.movedOn),
    index('stock_movements_school_date_idx').on(t.schoolId, t.movedOn),
  ],
);

// ---------------------------------------------------------------------------
// Assets and maintenance
// ---------------------------------------------------------------------------

/** A durable item the school owns and tracks individually. */
export const assets = pgTable(
  'assets',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The school's own asset tag, physically on the item. */
    assetTag: varchar('asset_tag', { length: 64 }),
    category: text('category'),
    serialNumber: varchar('serial_number', { length: 96 }),
    /** Where it lives. A section, a room name, or both. */
    sectionId: text('section_id').references(() => sections.id, { onDelete: 'set null' }),
    location: text('location'),
    /** Person responsible, when one is named. */
    assignedStaffId: text('assigned_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    /** in_use | in_storage | under_repair | disposed | lost */
    status: varchar('status', { length: 24 }).notNull().default('in_use'),
    condition: varchar('condition', { length: 24 }).notNull().default('good'),
    purchasedOn: date('purchased_on'),
    purchaseCostCents: integer('purchase_cost_cents'),
    warrantyUntil: date('warranty_until'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('assets_school_tag_uq')
      .on(t.schoolId, t.assetTag)
      .where(sql`asset_tag is not null`),
    index('assets_school_status_idx').on(t.schoolId, t.status),
    index('assets_school_name_idx').on(t.schoolId, t.name),
    index('assets_section_idx').on(t.sectionId),
  ],
);

/**
 * A reported fault or a scheduled piece of maintenance.
 *
 * Deliberately usable without an asset row: the commonest real report is "the
 * tap in the Grade 3 corridor is broken", which nobody has tagged. Requiring an
 * asset would mean the report never gets filed.
 */
export const maintenanceIssues = pgTable(
  'maintenance_issues',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    /** low | normal | high | urgent */
    priority: varchar('priority', { length: 16 }).notNull().default('normal'),
    /** open | in_progress | resolved | closed | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('open'),
    reportedBy: text('reported_by').references(() => users.id, { onDelete: 'set null' }),
    reportedOn: date('reported_on').notNull(),
    assignedStaffId: text('assigned_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    costCents: integer('cost_cents'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('maintenance_school_status_idx').on(t.schoolId, t.status, t.priority),
    index('maintenance_asset_idx').on(t.assetId),
    index('maintenance_assigned_idx').on(t.assignedStaffId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A school bus or other vehicle. */
export const vehicles = pgTable(
  'vehicles',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** Plate as written on the vehicle. */
    plateNumber: varchar('plate_number', { length: 32 }).notNull(),
    label: text('label'),
    /** bus | minibus | van | car | other */
    vehicleType: varchar('vehicle_type', { length: 24 }).notNull().default('bus'),
    capacity: integer('capacity').notNull().default(0),
    /** Driver and assistant are staff members, not free text. */
    driverStaffId: text('driver_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    assistantStaffId: text('assistant_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    /** active | maintenance | retired */
    status: varchar('status', { length: 24 }).notNull().default('active'),
    insuranceUntil: date('insurance_until'),
    inspectionUntil: date('inspection_until'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vehicles_school_plate_uq').on(t.schoolId, t.plateNumber),
    index('vehicles_school_status_idx').on(t.schoolId, t.status),
  ],
);

/** A named route, optionally worked by a vehicle. */
export const transportRoutes = pgTable(
  'transport_routes',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: varchar('code', { length: 32 }),
    vehicleId: text('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    /** morning | afternoon | both */
    direction: varchar('direction', { length: 16 }).notNull().default('both'),
    /** Monthly fee in cents, when transport is charged. Optional. */
    monthlyFeeCents: integer('monthly_fee_cents'),
    active: boolean('active').notNull().default(true),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('transport_routes_school_code_uq')
      .on(t.schoolId, t.code)
      .where(sql`code is not null`),
    index('transport_routes_school_active_idx').on(t.schoolId, t.active),
  ],
);

/** An ordered pick-up / drop-off point on a route. */
export const routeStops = pgTable(
  'route_stops',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    routeId: text('route_id')
      .notNull()
      .references(() => transportRoutes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Position along the route, 1-based. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** Scheduled times as HH:MM, school-local. */
    pickupTime: varchar('pickup_time', { length: 8 }),
    dropoffTime: varchar('dropoff_time', { length: 8 }),
    landmark: text('landmark'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('route_stops_route_idx').on(t.routeId, t.sortOrder),
    index('route_stops_school_idx').on(t.schoolId),
  ],
);

/**
 * A student's transport subscription.
 *
 * Scoped to an academic year because a family's arrangement changes year to
 * year, and last year's route must remain readable.
 */
export const studentTransport = pgTable(
  'student_transport',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    routeId: text('route_id')
      .notNull()
      .references(() => transportRoutes.id, { onDelete: 'restrict' }),
    /** Stops may differ morning and afternoon. */
    pickupStopId: text('pickup_stop_id').references(() => routeStops.id, { onDelete: 'set null' }),
    dropoffStopId: text('dropoff_stop_id').references(() => routeStops.id, {
      onDelete: 'set null',
    }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    /** active | ended */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One active subscription per student per year.
    uniqueIndex('student_transport_active_uq')
      .on(t.studentId, t.academicYearId)
      .where(sql`status = 'active'`),
    index('student_transport_route_idx').on(t.routeId, t.status),
    index('student_transport_school_idx').on(t.schoolId, t.academicYearId),
  ],
);

// ---------------------------------------------------------------------------
// School calendar
// ---------------------------------------------------------------------------

/**
 * A dated entry on the school calendar.
 *
 * Reuses the announcement audience model rather than inventing a second
 * visibility system: `audience` mirrors `announcements.audience`, so "visible
 * to Grade 5 parents" means the same thing in both places.
 *
 * Holidays that suppress attendance stay in `attendance_holidays` — that table
 * has behaviour attached to it. An event is a calendar entry; a holiday is a
 * rule. Linking them would make every calendar edit an attendance edit.
 */
export const schoolEvents = pgTable(
  'school_events',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id').references(() => academicYears.id, {
      onDelete: 'cascade',
    }),
    termId: text('term_id').references(() => terms.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    description: text('description'),
    /** exam | holiday | meeting | activity | sport | ceremony | other */
    eventType: varchar('event_type', { length: 32 }).notNull().default('activity'),

    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    /** HH:MM school-local; null for an all-day event. */
    startTime: varchar('start_time', { length: 8 }),
    endTime: varchar('end_time', { length: 8 }),
    allDay: boolean('all_day').notNull().default(true),

    location: text('location'),

    /**
     * Same shape as announcements: {"kind":"all"} |
     * {"kind":"roles","roles":[…]} | {"kind":"sections","sectionIds":[…]} |
     * {"kind":"grades","gradeIds":[…]}
     */
    audience: jsonb('audience').notNull().default(sql`'{"kind":"all"}'::jsonb`),

    /** Whether portal users (parents/students) can see it at all. */
    visibleToPortal: boolean('visible_to_portal').notNull().default(true),

    /** Colour hint for the calendar UI. Presentation only. */
    colour: varchar('colour', { length: 16 }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('school_events_school_start_idx').on(t.schoolId, t.startDate),
    index('school_events_year_idx').on(t.schoolId, t.academicYearId),
    index('school_events_type_idx').on(t.schoolId, t.eventType),
  ],
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Metadata for a stored file.
 *
 * The bytes live outside the database behind a storage key; the row records
 * what the file is, who it belongs to and who may read it. Every download
 * re-checks permission and tenancy — the client never receives a path it can
 * reuse or guess.
 *
 * `ownerType`/`ownerId` is a deliberate soft link rather than a set of nullable
 * foreign keys: a document attaches to a student, a staff member, or the school
 * itself, and adding a fourth owner later must not mean another column and
 * another migration on a table that will be large.
 */
export const documents = pgTable(
  'documents',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),

    /** student | staff | school */
    ownerType: varchar('owner_type', { length: 24 }).notNull(),
    /** Null when ownerType is 'school'. */
    ownerId: text('owner_id'),

    title: text('title').notNull(),
    /** birth_certificate | transcript | contract | policy | photo | other */
    category: varchar('category', { length: 48 }).notNull().default('other'),
    description: text('description'),

    /** Original name as uploaded, for the download filename. */
    fileName: text('file_name').notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Opaque storage key. Never exposed to the client. */
    storageKey: text('storage_key').notNull(),
    /** SHA-256 of the contents, for de-duplication and integrity. */
    checksum: varchar('checksum', { length: 64 }),

    /**
     * Whether the owning family may see it in the portal. Defaults to false:
     * an internal note about a pupil must not become visible by accident.
     */
    visibleToPortal: boolean('visible_to_portal').notNull().default(false),

    /** Optional expiry, for documents that must be renewed. */
    expiresOn: date('expires_on'),

    uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('documents_owner_idx').on(t.schoolId, t.ownerType, t.ownerId),
    index('documents_school_category_idx').on(t.schoolId, t.category),
    index('documents_school_created_idx').on(t.schoolId, t.createdAt),
  ],
);
