/**
 * Validation for the operations modules (Group 8).
 *
 * The same rules as finance apply here wherever money is involved: integer
 * cents only, and `z.coerce.number()` is avoided because it turns `''` and
 * `null` into `0` — which for a purchase cost means "this was free" rather
 * than "the field was left blank".
 *
 * Every schema is used on BOTH sides. The form validates with it for a fast,
 * translated error; the route validates with it again because the form is not
 * the only thing that can post to the endpoint.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const isoDate = z
  .string({ error: 'Enter a date.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.');

const optionalIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.')
  .optional()
  .nullable();

/** HH:MM, 24-hour, school-local. */
const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 07:30.')
  .optional()
  .nullable();

const id = z.string({ error: 'A selection is required.' }).min(1, 'A selection is required.');
const optionalId = z.string().min(1).optional().nullable();

const shortText = (max = 200) => z.string().trim().max(max).optional().nullable();

const nonNegativeCents = z
  .number()
  .int('Amounts are in whole cents.')
  .min(0, 'The amount cannot be negative.')
  .max(1_000_000_000_00, 'That amount is implausibly large.')
  .optional()
  .nullable();

/** A school-defined machine key. */
const slug = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use a lowercase key such as "annual_leave".');

/**
 * Treat an empty string as "not supplied".
 *
 * HTML forms submit `''` for an untouched optional field. Without this, an
 * optional date would fail its regex and an optional number would become 0.
 */
export const emptyToNull = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), inner);

// ---------------------------------------------------------------------------
// Staff attendance
// ---------------------------------------------------------------------------

export const STAFF_ATTENDANCE_STATUSES = [
  'present',
  'absent',
  'late',
  'on_leave',
  'half_day',
] as const;

export const staffAttendanceEntrySchema = z.object({
  staffId: id,
  status: z.enum(STAFF_ATTENDANCE_STATUSES, { error: 'Choose a status.' }),
  checkIn: clockTime,
  checkOut: clockTime,
  minutesLate: emptyToNull(z.number().int().min(0).max(1440).optional().nullable()),
  reason: shortText(300),
});

export const recordStaffAttendanceSchema = z.object({
  date: isoDate,
  entries: z
    .array(staffAttendanceEntrySchema)
    .min(1, 'Mark at least one person.')
    .max(500, 'Too many entries in one submission.'),
});

export const staffAttendanceQuerySchema = z.object({
  date: optionalIsoDate,
  from: optionalIsoDate,
  to: optionalIsoDate,
  staffId: optionalId,
  status: z.enum(STAFF_ATTENDANCE_STATUSES).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export const leaveTypeSchema = z.object({
  key: slug,
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  nameAm: shortText(120),
  daysPerYear: emptyToNull(z.number().int().positive('Enter a positive number of days.').max(365).optional().nullable()),
  paid: z.boolean().default(true),
  requiresApproval: z.boolean().default(true),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
});

export const createLeaveRequestSchema = z
  .object({
    staffId: id,
    leaveTypeId: id,
    startDate: isoDate,
    endDate: isoDate,
    reason: shortText(1000),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The end date cannot be before the start date.',
    path: ['endDate'],
  });

export const decideLeaveSchema = z
  .object({
    decision: z.enum(['approved', 'rejected'], { error: 'Choose approve or reject.' }),
    note: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((v) => v.decision !== 'rejected' || (v.note && v.note.length > 0), {
    // A rejection with no reason leaves the person with nothing to act on.
    message: 'Give a reason for rejecting the request.',
    path: ['note'],
  });

export const leaveQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional().nullable(),
  staffId: optionalId,
  from: optionalIsoDate,
  to: optionalIsoDate,
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const LIBRARY_ITEM_TYPES = ['book', 'reference', 'periodical', 'media', 'equipment'] as const;
export const COPY_STATUSES = ['available', 'damaged', 'lost', 'withdrawn'] as const;
export const CONDITIONS = ['new', 'good', 'fair', 'poor'] as const;

export const libraryItemSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title.').max(300),
  author: shortText(200),
  isbn: emptyToNull(z.string().trim().max(32).optional().nullable()),
  publisher: shortText(200),
  publishedYear: emptyToNull(
    z.number().int().min(1000, 'Check the year.').max(2200, 'Check the year.').optional().nullable(),
  ),
  itemType: z.enum(LIBRARY_ITEM_TYPES).default('book'),
  category: shortText(120),
  callNumber: shortText(64),
  language: shortText(32),
  description: shortText(2000),
  active: z.boolean().default(true),
});

export const libraryCopySchema = z.object({
  accessionNumber: z.string().trim().min(1, 'Enter an accession number.').max(64),
  status: z.enum(COPY_STATUSES).default('available'),
  condition: z.enum(CONDITIONS).default('good'),
  acquiredOn: optionalIsoDate,
  note: shortText(500),
});

/** Add several copies of one title at once — the normal way stock arrives. */
export const addCopiesSchema = z.object({
  count: z
    .number({ error: 'How many copies?' })
    .int()
    .min(1, 'Add at least one copy.')
    .max(200, 'Add at most 200 copies at a time.'),
  prefix: z.string().trim().max(32).optional().nullable(),
  condition: z.enum(CONDITIONS).default('good'),
  acquiredOn: optionalIsoDate,
});

export const issueLoanSchema = z
  .object({
    copyId: id,
    /** Exactly one borrower. */
    studentId: optionalId,
    staffId: optionalId,
    dueOn: optionalIsoDate,
    note: shortText(500),
  })
  .refine((v) => Boolean(v.studentId) !== Boolean(v.staffId), {
    message: 'Choose exactly one borrower.',
    path: ['studentId'],
  });

export const returnLoanSchema = z.object({
  condition: z.enum(CONDITIONS).optional().nullable(),
  fineCents: nonNegativeCents,
  waiveFine: z.boolean().default(false),
  note: shortText(500),
});

export const libraryQuerySchema = z.object({
  q: z.string().trim().max(120).optional().nullable(),
  itemType: z.enum(LIBRARY_ITEM_TYPES).optional().nullable(),
  category: shortText(120),
  availableOnly: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export const MOVEMENT_TYPES = ['receipt', 'issue', 'adjustment', 'loss'] as const;

export const inventoryItemSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(200),
  sku: emptyToNull(z.string().trim().max(64).optional().nullable()),
  category: shortText(120),
  unit: z.string().trim().min(1).max(32).default('piece'),
  reorderLevel: z.number().int().min(0, 'Cannot be negative.').max(1_000_000).default(0),
  location: shortText(200),
  unitCostCents: emptyToNull(nonNegativeCents),
  active: z.boolean().default(true),
});

export const stockMovementSchema = z
  .object({
    movementType: z.enum(MOVEMENT_TYPES, { error: 'Choose a movement type.' }),
    /**
     * Always a positive magnitude. The sign is decided by the service from the
     * movement type, so a client cannot turn an issue into a receipt by sending
     * a negative number.
     */
    quantity: z
      .number({ error: 'Enter a quantity.' })
      .int('Whole units only.')
      .positive('The quantity must be greater than zero.')
      .max(1_000_000, 'That quantity is implausibly large.'),
    movedOn: isoDate,
    reference: shortText(200),
    note: shortText(500),
  })
  /**
   * A correction must say why.
   *
   * Receipts and issues explain themselves — a delivery arrived, a classroom
   * took chalk. An adjustment or a loss is someone asserting that the book
   * count was wrong, and a stock ledger that records "the number changed" with
   * no reason cannot be audited later. Either field satisfies it: `reference`
   * for "stock take 2018", `note` for a sentence.
   */
  .refine(
    (v) =>
      (v.movementType !== 'adjustment' && v.movementType !== 'loss') ||
      Boolean(v.reference?.trim() || v.note?.trim()),
    {
      message: 'Give a reason for the correction.',
      path: ['reference'],
    },
  );

// ---------------------------------------------------------------------------
// Assets and maintenance
// ---------------------------------------------------------------------------

export const ASSET_STATUSES = ['in_use', 'in_storage', 'under_repair', 'disposed', 'lost'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const MAINTENANCE_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'closed',
  'cancelled',
] as const;

export const assetSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(200),
  assetTag: emptyToNull(z.string().trim().max(64).optional().nullable()),
  category: shortText(120),
  serialNumber: shortText(96),
  sectionId: optionalId,
  location: shortText(200),
  assignedStaffId: optionalId,
  status: z.enum(ASSET_STATUSES).default('in_use'),
  condition: z.enum(CONDITIONS).default('good'),
  purchasedOn: optionalIsoDate,
  purchaseCostCents: emptyToNull(nonNegativeCents),
  warrantyUntil: optionalIsoDate,
  note: shortText(1000),
});

export const maintenanceIssueSchema = z.object({
  title: z.string().trim().min(1, 'Describe the problem briefly.').max(200),
  description: shortText(2000),
  assetId: optionalId,
  location: shortText(200),
  priority: z.enum(PRIORITIES).default('normal'),
  reportedOn: isoDate,
});

export const updateMaintenanceSchema = z
  .object({
    status: z.enum(MAINTENANCE_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignedStaffId: optionalId,
    resolutionNote: shortText(2000),
    costCents: emptyToNull(nonNegativeCents),
  })
  .refine(
    (v) => !['resolved', 'closed'].includes(v.status ?? '') || Boolean(v.resolutionNote),
    {
      message: 'Say what was done before closing the issue.',
      path: ['resolutionNote'],
    },
  );

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const VEHICLE_TYPES = ['bus', 'minibus', 'van', 'car', 'other'] as const;
export const VEHICLE_STATUSES = ['active', 'maintenance', 'retired'] as const;
export const ROUTE_DIRECTIONS = ['morning', 'afternoon', 'both'] as const;

export const vehicleSchema = z.object({
  plateNumber: z.string().trim().min(1, 'Enter the plate number.').max(32),
  label: shortText(120),
  vehicleType: z.enum(VEHICLE_TYPES).default('bus'),
  capacity: z.number().int().min(0, 'Cannot be negative.').max(200).default(0),
  driverStaffId: optionalId,
  assistantStaffId: optionalId,
  status: z.enum(VEHICLE_STATUSES).default('active'),
  insuranceUntil: optionalIsoDate,
  inspectionUntil: optionalIsoDate,
  note: shortText(500),
});

export const routeStopSchema = z.object({
  name: z.string().trim().min(1, 'Enter a stop name.').max(200),
  sortOrder: z.number().int().min(0).max(999).default(0),
  pickupTime: clockTime,
  dropoffTime: clockTime,
  landmark: shortText(200),
});

export const transportRouteSchema = z.object({
  name: z.string().trim().min(1, 'Enter a route name.').max(200),
  code: emptyToNull(z.string().trim().max(32).optional().nullable()),
  vehicleId: optionalId,
  direction: z.enum(ROUTE_DIRECTIONS).default('both'),
  monthlyFeeCents: emptyToNull(nonNegativeCents),
  active: z.boolean().default(true),
  note: shortText(500),
});

export const assignTransportSchema = z.object({
  studentId: id,
  routeId: id,
  pickupStopId: optionalId,
  dropoffStopId: optionalId,
  startDate: isoDate,
  note: shortText(500),
});

// ---------------------------------------------------------------------------
// School calendar
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'exam',
  'holiday',
  'meeting',
  'activity',
  'sport',
  'ceremony',
  'other',
] as const;

/** Mirrors the announcement audience shape so the two mean the same thing. */
export const eventAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('roles'), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('sections'), sectionIds: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('grades'), gradeIds: z.array(z.string().min(1)).min(1) }),
]);

export const schoolEventSchema = z
  .object({
    title: z.string().trim().min(1, 'Enter a title.').max(200),
    description: shortText(2000),
    eventType: z.enum(EVENT_TYPES).default('activity'),
    startDate: isoDate,
    endDate: optionalIsoDate,
    startTime: clockTime,
    endTime: clockTime,
    allDay: z.boolean().default(true),
    location: shortText(200),
    audience: eventAudienceSchema.default({ kind: 'all' }),
    visibleToPortal: z.boolean().default(true),
    colour: emptyToNull(z.string().trim().max(16).optional().nullable()),
    termId: optionalId,
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'The end date cannot be before the start date.',
    path: ['endDate'],
  })
  .refine((v) => v.allDay || Boolean(v.startTime), {
    message: 'Give a start time, or mark the event as all day.',
    path: ['startTime'],
  });

export const eventQuerySchema = z.object({
  from: optionalIsoDate,
  to: optionalIsoDate,
  eventType: z.enum(EVENT_TYPES).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DOCUMENT_OWNER_TYPES = ['student', 'staff', 'school'] as const;
export const DOCUMENT_CATEGORIES = [
  'birth_certificate',
  'transcript',
  'report_card',
  'contract',
  'certificate',
  'identification',
  'medical',
  'policy',
  'photo',
  'other',
] as const;

export const documentMetaSchema = z
  .object({
    ownerType: z.enum(DOCUMENT_OWNER_TYPES, { error: 'Choose what this document belongs to.' }),
    ownerId: optionalId,
    title: z.string().trim().min(1, 'Enter a title.').max(200),
    category: z.enum(DOCUMENT_CATEGORIES).default('other'),
    description: shortText(1000),
    visibleToPortal: z.boolean().default(false),
    expiresOn: optionalIsoDate,
  })
  .refine((v) => (v.ownerType === 'school' ? !v.ownerId : Boolean(v.ownerId)), {
    message: 'Choose who this document belongs to.',
    path: ['ownerId'],
  });

export const documentQuerySchema = z.object({
  ownerType: z.enum(DOCUMENT_OWNER_TYPES).optional().nullable(),
  ownerId: optionalId,
  category: z.enum(DOCUMENT_CATEGORIES).optional().nullable(),
  q: z.string().trim().max(120).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RecordStaffAttendanceInput = z.infer<typeof recordStaffAttendanceSchema>;
export type LeaveTypeInput = z.infer<typeof leaveTypeSchema>;
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type DecideLeaveInput = z.infer<typeof decideLeaveSchema>;
export type LibraryItemInput = z.infer<typeof libraryItemSchema>;
export type LibraryCopyInput = z.infer<typeof libraryCopySchema>;
export type AddCopiesInput = z.infer<typeof addCopiesSchema>;
export type IssueLoanInput = z.infer<typeof issueLoanSchema>;
export type ReturnLoanInput = z.infer<typeof returnLoanSchema>;
export type InventoryItemInput = z.infer<typeof inventoryItemSchema>;
export type StockMovementInput = z.infer<typeof stockMovementSchema>;
export type AssetInput = z.infer<typeof assetSchema>;
export type MaintenanceIssueInput = z.infer<typeof maintenanceIssueSchema>;
export type UpdateMaintenanceInput = z.infer<typeof updateMaintenanceSchema>;
export type VehicleInput = z.infer<typeof vehicleSchema>;
export type TransportRouteInput = z.infer<typeof transportRouteSchema>;
export type RouteStopInput = z.infer<typeof routeStopSchema>;
export type AssignTransportInput = z.infer<typeof assignTransportSchema>;
export type SchoolEventInput = z.infer<typeof schoolEventSchema>;
export type EventAudience = z.infer<typeof eventAudienceSchema>;
export type DocumentMetaInput = z.infer<typeof documentMetaSchema>;
