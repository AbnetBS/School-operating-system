/**
 * Attendance schema.
 *
 * DESIGN NOTES
 * ------------
 * SESSIONS AND RECORDS. Attendance is stored as a `attendance_sessions` header
 * (who took the register, for which class, on which date) plus one
 * `attendance_records` row per student. The header is what lets the system
 * distinguish "nobody was absent today" from "the register was never taken" —
 * a distinction that matters enormously for chasing teachers and for computing
 * honest attendance percentages.
 *
 * DAILY VS PER-SUBJECT. Ethiopian schools differ: primary schools usually take
 * one register a day, secondary schools often take one per period. Rather than
 * branching in code, the session carries a nullable `section_subject_id`. When
 * it is null the session is the day's single register; when set it belongs to
 * one subject period. The unique indexes below enforce one register per
 * (section, date) for daily mode and one per (section_subject, date) for
 * per-subject mode, without the two modes colliding.
 *
 * OFFLINE SYNC. Teachers in Ethiopia frequently have no connectivity in the
 * classroom. The client composes a deterministic `idempotency_key` for each
 * register it submits; replaying the same submission is a no-op rather than a
 * duplicate. This is what makes "save when the network returns" safe.
 *
 * DATES ARE SCHOOL-LOCAL. `date` is a plain calendar date in the school's own
 * timezone, never a timestamp. A register taken at 08:00 in Addis must not
 * drift to the previous day because the server runs in UTC.
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
import {
  schools,
  users,
  academicYears,
  terms,
  sections,
  sectionSubjects,
  periods,
} from './core.ts';
import { students } from './people.ts';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * One taking of a register.
 *
 * The row exists as soon as a teacher submits, even if every student was
 * present, so "not yet taken" is always distinguishable from "all present".
 */
export const attendanceSessions = pgTable(
  'attendance_sessions',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    /** Denormalised so term-scoped reports do not need a date-range join. */
    termId: text('term_id').references(() => terms.id, { onDelete: 'set null' }),
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    /**
     * Null for a daily register; set for a per-subject register.
     * Its presence is what makes the two attendance modes one code path.
     */
    sectionSubjectId: text('section_subject_id').references(() => sectionSubjects.id, {
      onDelete: 'cascade',
    }),
    /** Optional period, for schools that timetable by period. */
    periodId: text('period_id').references(() => periods.id, { onDelete: 'set null' }),

    /** School-local calendar date. */
    date: date('date').notNull(),

    /** 'daily' | 'perSubject' — copied from settings at the time of taking. */
    mode: varchar('mode', { length: 16 }).notNull().default('daily'),

    takenBy: text('taken_by').references(() => users.id, { onDelete: 'set null' }),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),

    /** Cached counts, so class lists and dashboards avoid re-aggregating. */
    presentCount: integer('present_count').notNull().default(0),
    absentCount: integer('absent_count').notNull().default(0),
    lateCount: integer('late_count').notNull().default(0),
    excusedCount: integer('excused_count').notNull().default(0),
    totalCount: integer('total_count').notNull().default(0),

    /** Set when submitted from a device that had been offline. */
    syncedOffline: boolean('synced_offline').notNull().default(false),
    /** Client-generated key making a replayed submission a no-op. */
    idempotencyKey: varchar('idempotency_key', { length: 128 }),

    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One daily register per section per date.
    uniqueIndex('attendance_sessions_daily_uq')
      .on(t.sectionId, t.date)
      .where(sql`section_subject_id is null`),
    // One register per subject period per date.
    uniqueIndex('attendance_sessions_subject_uq')
      .on(t.sectionSubjectId, t.date)
      .where(sql`section_subject_id is not null`),
    // Replay protection for offline sync.
    uniqueIndex('attendance_sessions_idem_uq')
      .on(t.schoolId, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    index('attendance_sessions_school_date_idx').on(t.schoolId, t.date),
    index('attendance_sessions_section_date_idx').on(t.sectionId, t.date),
    index('attendance_sessions_year_idx').on(t.schoolId, t.academicYearId),
  ],
);

/**
 * One student's attendance within a session.
 *
 * `status` is deliberately a varchar rather than an enum: the set of statuses a
 * school uses is configurable (some track 'sick' separately, some do not), and
 * adding a status must not require a migration.
 */
export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => attendanceSessions.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),

    /** Denormalised for fast per-student reporting without joining sessions. */
    date: date('date').notNull(),
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    termId: text('term_id').references(() => terms.id, { onDelete: 'set null' }),

    /** present | absent | late | excused | sick — configurable per school. */
    status: varchar('status', { length: 16 }).notNull(),
    /** Minutes late, when the school records it. */
    minutesLate: integer('minutes_late'),
    /** Free-text or a configured reason code. */
    reason: text('reason'),

    /** True once a guardian's excuse note has been accepted. */
    excusedBy: text('excused_by').references(() => users.id, { onDelete: 'set null' }),
    excusedAt: timestamp('excused_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A student appears at most once per register.
    uniqueIndex('attendance_records_session_student_uq').on(t.sessionId, t.studentId),
    index('attendance_records_student_date_idx').on(t.studentId, t.date),
    index('attendance_records_school_date_idx').on(t.schoolId, t.date),
    index('attendance_records_status_idx').on(t.schoolId, t.status, t.date),
    index('attendance_records_year_idx').on(t.schoolId, t.academicYearId),
  ],
);

/**
 * Append-only history of attendance corrections.
 *
 * Changing a mark of absent to present has consequences — it affects at-risk
 * flags, parent notifications and, in some schools, fee rebates. Every change
 * after the initial entry is recorded here in addition to the audit log, so the
 * attendance module can show "corrected by X on Y" inline without querying the
 * global audit table.
 */
export const attendanceChanges = pgTable(
  'attendance_changes',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => attendanceRecords.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    fromStatus: varchar('from_status', { length: 16 }),
    toStatus: varchar('to_status', { length: 16 }).notNull(),
    reason: text('reason'),
    changedBy: text('changed_by').references(() => users.id, { onDelete: 'set null' }),
    changedAt: createdAt(),
  },
  (t) => [
    index('attendance_changes_record_idx').on(t.recordId),
    index('attendance_changes_student_idx').on(t.studentId),
  ],
);

/**
 * Days the school is closed: public holidays, Ethiopian feast days,
 * examination days, or an unplanned closure.
 *
 * Attendance percentages must not count these days against a student, and the
 * "registers not taken" report must not nag teachers about them. Which days are
 * holidays is entirely school-configurable — Ethiopian schools observe
 * different religious calendars and regional holidays.
 */
export const attendanceHolidays = pgTable(
  'attendance_holidays',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    endDate: date('end_date'),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    /** holiday | exam | closure | break */
    kind: varchar('kind', { length: 24 }).notNull().default('holiday'),
    /** Limit to certain grades, e.g. an exam day for Grade 12 only. */
    appliesToGradeLevelIds: jsonb('applies_to_grade_level_ids'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('attendance_holidays_uq').on(t.schoolId, t.academicYearId, t.date, t.name),
    index('attendance_holidays_year_idx').on(t.schoolId, t.academicYearId, t.date),
  ],
);
