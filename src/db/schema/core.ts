/**
 * Core schema: tenancy, configuration, users, roles, audit, events.
 *
 * TENANCY RULE
 * ------------
 * Every table that holds school-owned data carries a non-null `schoolId`.
 * There is no exception. Queries must go through the scoped data-access layer
 * (src/db/scope.ts), which injects the school filter; route handlers never
 * build a raw query against these tables.
 *
 * DATE RULE
 * ---------
 * Calendar dates (school days, term boundaries, birthdays) are stored as
 * `date` — a calendar date has no timezone. Instants (created_at, logged_at)
 * are stored as `timestamptz`.
 *
 * MONEY RULE
 * ----------
 * Money is stored as `bigint` cents. Never numeric/float. See src/lib/money.ts.
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

/** Shared column builders. */
const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Schools (tenants)
// ---------------------------------------------------------------------------

export const schools = pgTable(
  'schools',
  {
    id: id(),
    /** Short unique slug used in URLs and student-code prefixes. */
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    /** Amharic name, shown when the user's locale is Amharic. */
    nameAm: text('name_am'),
    logoUrl: text('logo_url'),
    address: text('address'),
    phone: varchar('phone', { length: 32 }),
    email: varchar('email', { length: 255 }),
    /** IANA timezone; drives "today" for attendance. */
    timezone: varchar('timezone', { length: 64 }).notNull().default('Africa/Addis_Ababa'),
    /** Subscription plan — pricing itself lives in config, never in code. */
    plan: varchar('plan', { length: 32 }).notNull().default('starter'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('schools_code_uq').on(t.code)],
);

/**
 * Per-school settings as typed key/value documents.
 *
 * Configuration is DATA, not code. Grading scales, attendance thresholds,
 * report-card layout, fee policy, enabled modules and approval workflows all
 * live here, validated by Zod schemas in src/lib/settings.
 */
export const schoolSettings = pgTable(
  'school_settings',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** e.g. 'locale', 'attendance', 'grading', 'modules', 'reportCard' */
    key: varchar('key', { length: 64 }).notNull(),
    value: jsonb('value').notNull(),
    updatedAt: updatedAt(),
    updatedBy: text('updated_by'),
  },
  (t) => [uniqueIndex('school_settings_school_key_uq').on(t.schoolId, t.key)],
);

// ---------------------------------------------------------------------------
// Users, roles, permissions
// ---------------------------------------------------------------------------

/**
 * A user account.
 *
 * `schoolId` is nullable ONLY for platform super-admins, who are not owned by
 * any school. Every other user belongs to exactly one school.
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    schoolId: text('school_id').references(() => schools.id, { onDelete: 'cascade' }),
    username: varchar('username', { length: 64 }).notNull(),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 32 }),
    /** scrypt hash, format: scrypt$N$r$p$salt$hash */
    passwordHash: text('password_hash').notNull(),
    givenName: text('given_name').notNull(),
    fatherName: text('father_name'),
    grandfatherName: text('grandfather_name'),
    givenNameAm: text('given_name_am'),
    fatherNameAm: text('father_name_am'),
    grandfatherNameAm: text('grandfather_name_am'),
    /** Per-user language override; falls back to the school default. */
    locale: varchar('locale', { length: 8 }),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Usernames are unique per school, so two schools may both have "registrar".
    uniqueIndex('users_school_username_uq').on(t.schoolId, t.username),
    index('users_school_idx').on(t.schoolId),
  ],
);

/**
 * Roles are per-school and fully configurable — a school may rename them,
 * create new ones, or change what each may do, with no code change.
 * `isSystem` marks built-in roles that cannot be deleted (only edited).
 */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** Stable machine key, e.g. 'teacher', 'registrar'. */
    key: varchar('key', { length: 64 }).notNull(),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_school_key_uq').on(t.schoolId, t.key)],
);

/** Permissions granted to a role, as permission keys (see src/lib/auth/permissions.ts). */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: varchar('permission', { length: 96 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    assignedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

/**
 * Server-side sessions.
 *
 * Sessions are stored (not stateless JWTs) so that access can be revoked
 * immediately when a teacher leaves or a device is lost. The cookie carries an
 * opaque token; only its hash is stored.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sessions_token_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append-only audit trail.
 *
 * Written inside the same transaction as the change it records, so an audited
 * mutation cannot succeed without its audit entry. No update or delete path is
 * exposed anywhere in the application.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    schoolId: text('school_id').references(() => schools.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Denormalised so the entry stays readable if the user is later removed. */
    actorName: text('actor_name'),
    /** e.g. 'grade.update', 'student.create', 'payment.record' */
    action: varchar('action', { length: 64 }).notNull(),
    /** Entity type and id the action applied to. */
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: text('entity_id'),
    /** Human-readable summary, e.g. "Mathematics mark for Abebe Kebede". */
    summary: text('summary'),
    previousValue: jsonb('previous_value'),
    newValue: jsonb('new_value'),
    /** Required when overriding a lock or other guarded action. */
    reason: text('reason'),
    ipAddress: varchar('ip_address', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_school_created_idx').on(t.schoolId, t.createdAt),
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_actor_idx').on(t.actorUserId),
  ],
);

// ---------------------------------------------------------------------------
// Domain events (automation engine)
// ---------------------------------------------------------------------------

/**
 * Domain events emitted by modules (attendance.recorded, payment.recorded,
 * marks.submitted, ...). The automation runner consumes these and applies the
 * school's configured rules. Persisting events makes automation retryable and
 * debuggable, and decouples modules from each other.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    /** Set when the event has been processed by the automation runner. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('domain_events_pending_idx')
      .on(t.schoolId, t.createdAt)
      .where(sql`processed_at is null`),
    index('domain_events_type_idx').on(t.type),
  ],
);

// ---------------------------------------------------------------------------
// Academic structure
// ---------------------------------------------------------------------------

/**
 * An academic year, e.g. "2018 E.C." running Meskerem 2018 – Sene 2018.
 * Dates are stored in Gregorian ISO form and displayed in either calendar.
 */
export const academicYears = pgTable(
  'academic_years',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** Display label, e.g. '2018 E.C.' or '2025/26'. */
    name: text('name').notNull(),
    nameAm: text('name_am'),
    /** Ethiopian year number, for sorting and Ethiopian-calendar display. */
    ethiopianYear: integer('ethiopian_year'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /** Exactly one year per school may be current — enforced by partial index. */
    isCurrent: boolean('is_current').notNull().default(false),
    isClosed: boolean('is_closed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('academic_years_school_name_uq').on(t.schoolId, t.name),
    uniqueIndex('academic_years_one_current_uq')
      .on(t.schoolId)
      .where(sql`is_current`),
    index('academic_years_school_idx').on(t.schoolId),
  ],
);

/**
 * A grading period within a year.
 *
 * `kind` distinguishes a three-term school from a two-semester school; both
 * are supported by data alone, with no branching in application code.
 */
export const terms = pgTable(
  'terms',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    /** 'term' | 'semester' | 'quarter' */
    kind: varchar('kind', { length: 16 }).notNull().default('term'),
    /** 1-based ordinal within the year. */
    sequence: integer('sequence').notNull(),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /** Weight toward the final yearly result, as a percentage. */
    weightPercent: integer('weight_percent'),
    isCurrent: boolean('is_current').notNull().default(false),
    isLocked: boolean('is_locked').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('terms_year_sequence_uq').on(t.academicYearId, t.sequence),
    uniqueIndex('terms_one_current_uq')
      .on(t.schoolId)
      .where(sql`is_current`),
    index('terms_school_year_idx').on(t.schoolId, t.academicYearId),
  ],
);

/** A grade level, e.g. Grade 8, KG-2, Grade 11 Natural Science. */
export const gradeLevels = pgTable(
  'grade_levels',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    /** Numeric level used for ordering and promotion (KG may be 0 or negative). */
    level: integer('level').notNull(),
    /** Optional stream/programme, e.g. 'natural', 'social'. */
    stream: varchar('stream', { length: 32 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('grade_levels_school_name_uq').on(t.schoolId, t.name),
    index('grade_levels_school_level_idx').on(t.schoolId, t.level),
  ],
);

/**
 * A section (class group) within a grade level, for one academic year.
 * Sections are year-scoped so that "Grade 8A" in 2017 and 2018 are distinct
 * records and history stays intact.
 */
export const sections = pgTable(
  'sections',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    gradeLevelId: text('grade_level_id')
      .notNull()
      .references(() => gradeLevels.id, { onDelete: 'restrict' }),
    /** e.g. 'A', 'B', 'Blue' */
    name: varchar('name', { length: 32 }).notNull(),
    capacity: integer('capacity'),
    /** The class teacher / homeroom teacher. */
    classTeacherId: text('class_teacher_id').references(() => users.id, { onDelete: 'set null' }),
    roomId: text('room_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sections_year_grade_name_uq').on(t.academicYearId, t.gradeLevelId, t.name),
    index('sections_school_year_idx').on(t.schoolId, t.academicYearId),
  ],
);

/** A subject offered by the school, e.g. Mathematics, Amharic, Biology. */
export const subjects = pgTable(
  'subjects',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    /** Whether marks for this subject count toward averages and promotion. */
    countsTowardAverage: boolean('counts_toward_average').notNull().default(true),
    /** Credit/period weight where a school weights subjects differently. */
    creditWeight: integer('credit_weight').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('subjects_school_code_uq').on(t.schoolId, t.code),
    index('subjects_school_idx').on(t.schoolId),
  ],
);

/**
 * Which subjects are taught to which grade level in a given year, and by whom.
 * This is the join that makes "Grade 8 → Section A → Mathematics" resolvable
 * for attendance, gradebook and timetable without re-entering data.
 */
export const sectionSubjects = pgTable(
  'section_subjects',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    teacherId: text('teacher_id').references(() => users.id, { onDelete: 'set null' }),
    /** Optional per-assignment override of the grading configuration. */
    gradingConfigId: text('grading_config_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('section_subjects_uq').on(t.sectionId, t.subjectId),
    index('section_subjects_teacher_idx').on(t.schoolId, t.teacherId),
    index('section_subjects_school_year_idx').on(t.schoolId, t.academicYearId),
  ],
);

/** Physical rooms, used by timetable and exam scheduling. */
export const rooms = pgTable(
  'rooms',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    capacity: integer('capacity'),
    building: text('building'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rooms_school_name_uq').on(t.schoolId, t.name)],
);

/** Daily period structure, e.g. Period 1 08:00–08:45. */
export const periods = pgTable(
  'periods',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    name: text('name').notNull(),
    startTime: varchar('start_time', { length: 5 }).notNull(), // 'HH:MM'
    endTime: varchar('end_time', { length: 5 }).notNull(),
    /** Break periods are shown on the timetable but hold no lessons. */
    isBreak: boolean('is_break').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('periods_school_sequence_uq').on(t.schoolId, t.sequence)],
);
