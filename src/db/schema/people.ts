/**
 * People schema: students, guardians, staff and the relationships between them.
 *
 * NAMING
 * ------
 * Ethiopian names are given name + father's name + grandfather's name. There
 * is no family surname. Storing these as three first-class columns (rather
 * than first_name/last_name) means the system never has to guess how to split
 * a name, and sorting/searching by father's name — which registrars do
 * constantly — works correctly.
 *
 * ENROLMENT HISTORY
 * -----------------
 * A student's section membership is a time-scoped `enrollments` row, not a
 * column on the student. Moving a student from 8A to 8B must not retroactively
 * rewrite last term's attendance registers or report cards.
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
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { schools, users, academicYears, gradeLevels, sections } from './core.ts';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export const students = pgTable(
  'students',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),

    /** Human-facing student number, unique within the school. */
    studentCode: varchar('student_code', { length: 32 }).notNull(),

    // Ethiopian naming, in Latin script and optionally Ethiopic script.
    givenName: text('given_name').notNull(),
    fatherName: text('father_name').notNull(),
    grandfatherName: text('grandfather_name'),
    givenNameAm: text('given_name_am'),
    fatherNameAm: text('father_name_am'),
    grandfatherNameAm: text('grandfather_name_am'),

    /** 'male' | 'female' */
    gender: varchar('gender', { length: 16 }),
    dateOfBirth: date('date_of_birth'),
    photoUrl: text('photo_url'),

    phone: varchar('phone', { length: 32 }),
    email: varchar('email', { length: 255 }),
    address: text('address'),
    /** Sub-city / woreda / kebele, commonly recorded by Ethiopian schools. */
    subCity: text('sub_city'),
    woreda: text('woreda'),
    kebele: text('kebele'),

    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: varchar('emergency_contact_phone', { length: 32 }),
    emergencyContactRelation: varchar('emergency_contact_relation', { length: 64 }),

    /** Free-text medical notes; access is permission-gated. */
    medicalNotes: text('medical_notes'),
    bloodGroup: varchar('blood_group', { length: 8 }),

    previousSchool: text('previous_school'),
    admissionDate: date('admission_date'),
    /** Year the student first joined this school. */
    admissionYearId: text('admission_year_id').references(() => academicYears.id, {
      onDelete: 'set null',
    }),

    /** active | transferred | withdrawn | graduated | suspended | inactive */
    status: varchar('status', { length: 24 }).notNull().default('active'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusReason: text('status_reason'),

    notes: text('notes'),

    /**
     * Values for school-defined custom fields, keyed by custom field key.
     * Lets a school add "House" or "Previous Student Number" without a
     * migration or a code change.
     */
    customFields: jsonb('custom_fields').notNull().default(sql`'{}'::jsonb`),

    /** Optional portal login for the student. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Soft delete — student records are never hard-deleted. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Prevents duplicate student IDs at the database level, not just in the UI.
    uniqueIndex('students_school_code_uq').on(t.schoolId, t.studentCode),
    index('students_school_status_idx').on(t.schoolId, t.status),
    index('students_school_name_idx').on(t.schoolId, t.givenName, t.fatherName),
    index('students_user_idx').on(t.userId),
  ],
);

/**
 * A student's placement in a section for one academic year.
 * Keeping this separate preserves history across section changes, repeats and
 * re-enrolment, and is what promotion at year end writes to.
 */
export const enrollments = pgTable(
  'enrollments',
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
    gradeLevelId: text('grade_level_id')
      .notNull()
      .references(() => gradeLevels.id, { onDelete: 'restrict' }),
    sectionId: text('section_id').references(() => sections.id, { onDelete: 'set null' }),

    /** Roll number within the section, where the school uses one. */
    rollNumber: integer('roll_number'),

    enrolledOn: date('enrolled_on').notNull(),
    /** Set when the student leaves this section (transfer, withdrawal, year end). */
    endedOn: date('ended_on'),

    /** enrolled | transferred_out | withdrawn | completed | repeating */
    status: varchar('status', { length: 24 }).notNull().default('enrolled'),

    /** Registration workflow state: pending | approved | rejected | correction_requested */
    registrationStatus: varchar('registration_status', { length: 24 }).notNull().default('approved'),
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A student has at most one active enrolment per academic year.
    uniqueIndex('enrollments_student_year_active_uq')
      .on(t.studentId, t.academicYearId)
      .where(sql`ended_on is null`),
    index('enrollments_section_idx').on(t.sectionId),
    index('enrollments_school_year_idx').on(t.schoolId, t.academicYearId),
    index('enrollments_student_idx').on(t.studentId),
  ],
);

/** Audit trail of student status transitions (active → transferred → ...). */
export const studentStatusHistory = pgTable(
  'student_status_history',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    fromStatus: varchar('from_status', { length: 24 }),
    toStatus: varchar('to_status', { length: 24 }).notNull(),
    reason: text('reason'),
    effectiveDate: date('effective_date').notNull(),
    changedBy: text('changed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('student_status_history_student_idx').on(t.studentId)],
);

// ---------------------------------------------------------------------------
// Guardians
// ---------------------------------------------------------------------------

/**
 * A parent or guardian. Modelled separately from students because one guardian
 * commonly has several children in the school — entering them once and linking
 * is the point of the product.
 */
export const guardians = pgTable(
  'guardians',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    givenName: text('given_name').notNull(),
    fatherName: text('father_name'),
    grandfatherName: text('grandfather_name'),
    givenNameAm: text('given_name_am'),
    fatherNameAm: text('father_name_am'),
    grandfatherNameAm: text('grandfather_name_am'),
    phone: varchar('phone', { length: 32 }),
    altPhone: varchar('alt_phone', { length: 32 }),
    email: varchar('email', { length: 255 }),
    address: text('address'),
    occupation: text('occupation'),
    nationalId: varchar('national_id', { length: 64 }),
    /** Preferred channel for notifications: sms | inapp | email */
    preferredChannel: varchar('preferred_channel', { length: 16 }).notNull().default('sms'),
    /** Portal login, created on demand. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('guardians_school_idx').on(t.schoolId),
    index('guardians_phone_idx').on(t.schoolId, t.phone),
    index('guardians_user_idx').on(t.userId),
  ],
);

/**
 * Links guardians to students. This relationship IS the parent-portal
 * authorization boundary: a parent may see exactly the students joined to them
 * here, and nothing else.
 */
export const studentGuardians = pgTable(
  'student_guardians',
  {
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    guardianId: text('guardian_id')
      .notNull()
      .references(() => guardians.id, { onDelete: 'cascade' }),
    /** father | mother | uncle | aunt | grandparent | sponsor | other */
    relationship: varchar('relationship', { length: 32 }).notNull().default('parent'),
    /** The contact called first, and the default SMS recipient. */
    isPrimary: boolean('is_primary').notNull().default(false),
    /** Whether this guardian may collect the student from school. */
    canPickUp: boolean('can_pick_up').notNull().default(true),
    /** Whether fee notices go to this guardian. */
    receivesFeeNotices: boolean('receives_fee_notices').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.studentId, t.guardianId] }),
    index('student_guardians_guardian_idx').on(t.guardianId),
    index('student_guardians_school_idx').on(t.schoolId),
  ],
);

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/**
 * Employment record for a staff member, linked to their user account.
 * Teachers are staff; the teaching relationship lives in section_subjects and
 * sections.class_teacher_id so it is defined once and reused everywhere.
 */
export const staff = pgTable(
  'staff',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    staffCode: varchar('staff_code', { length: 32 }).notNull(),
    /** teacher | admin | finance | librarian | driver | support | other */
    staffType: varchar('staff_type', { length: 32 }).notNull().default('teacher'),
    jobTitle: text('job_title'),
    department: text('department'),
    gender: varchar('gender', { length: 16 }),
    dateOfBirth: date('date_of_birth'),
    phone: varchar('phone', { length: 32 }),
    address: text('address'),
    qualification: text('qualification'),
    /** ISO date the person joined the school. */
    hireDate: date('hire_date'),
    /** permanent | contract | part_time */
    employmentType: varchar('employment_type', { length: 32 }),
    /** active | on_leave | resigned | terminated */
    status: varchar('status', { length: 24 }).notNull().default('active'),
    customFields: jsonb('custom_fields').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('staff_school_code_uq').on(t.schoolId, t.staffCode),
    uniqueIndex('staff_user_uq').on(t.userId),
    index('staff_school_type_idx').on(t.schoolId, t.staffType),
  ],
);

// ---------------------------------------------------------------------------
// Custom field definitions
// ---------------------------------------------------------------------------

/**
 * School-defined extra fields for students or staff.
 * The values live in the owning record's `customFields` JSONB column; these
 * rows describe the field so the UI can render and validate it.
 */
export const customFieldDefs = pgTable(
  'custom_field_defs',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** 'student' | 'staff' | 'guardian' */
    entityType: varchar('entity_type', { length: 32 }).notNull(),
    /** Machine key used inside customFields JSON. */
    key: varchar('key', { length: 64 }).notNull(),
    label: text('label').notNull(),
    labelAm: text('label_am'),
    /** text | number | date | select | boolean */
    fieldType: varchar('field_type', { length: 24 }).notNull().default('text'),
    /** Options for select fields. */
    options: jsonb('options'),
    isRequired: boolean('is_required').notNull().default(false),
    /** Controls form ordering. */
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('custom_field_defs_uq').on(t.schoolId, t.entityType, t.key)],
);
