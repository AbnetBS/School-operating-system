/**
 * Gradebook and report-card schema.
 *
 * DESIGN NOTES
 * ------------
 * CONFIGURATION IS DATA. A mark never says "this is a midterm worth 30%". It
 * points at an `assessment`, which names a component key that must exist in the
 * school's configured grading structure. Change the configuration and the
 * arithmetic changes; no code branches on a school's assessment names. A school
 * that wants Practical subjects weighted differently attaches a
 * `grading_configs` row to that section-subject instead of forking the code.
 *
 * WORKFLOW LIVES ON THE ASSESSMENT, NOT THE MARK. Teachers submit a whole quiz
 * for review, not one pupil at a time, so `status` is a column on `assessments`
 * (draft → submitted → approved → locked). Per-mark status would be both
 * wrong-grained and enormously more expensive to query.
 *
 * NULL MARK IS NOT ZERO. `marks.mark` is nullable and means "not entered yet".
 * A zero is a real score. `is_excused` is a third state: the student legitimately
 * did not sit the assessment and it should be dropped from their average rather
 * than counted as nought. Conflating these three silently destroys averages.
 *
 * CACHED RESULTS ARE CACHES. `subject_results` and `term_results` are derived
 * from marks and recomputed when marks change. They exist because a report-card
 * run for 400 students would otherwise recompute thousands of times, but they
 * are never the sole source of truth — the marks are.
 *
 * A PUBLISHED REPORT CARD IS A SNAPSHOT. Once published, the card stores the
 * figures as they stood. If a mark is corrected afterwards the parent's copy
 * does not silently mutate; a new version is issued. Schools sign and archive
 * these documents, so retroactive edits are a correctness problem, not a
 * convenience.
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
  real,
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
  subjects,
  sectionSubjects,
} from './core.ts';
import { students } from './people.ts';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * A named assessment structure a school can reuse.
 *
 * The school's `grading.components` setting is the default; this table exists
 * so one subject (or one grade level) can differ without changing the default
 * for everyone. `components` holds the same shape the settings schema
 * validates, so both paths feed the identical calculation engine.
 */
export const gradingConfigs = pgTable(
  'grading_configs',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameAm: text('name_am'),
    description: text('description'),
    /** AssessmentComponent[] — validated by gradingSettingsSchema's component schema. */
    components: jsonb('components').notNull(),
    /** Optional override of the school pass mark for subjects using this config. */
    passMarkPercent: real('pass_mark_percent'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('grading_configs_school_name_uq').on(t.schoolId, t.name),
    index('grading_configs_school_idx').on(t.schoolId),
  ],
);

/**
 * A concrete piece of assessed work.
 *
 * `componentKey` ties it to the configured structure; `maxMark` may differ from
 * the component default when an individual test is out of 25 rather than 100.
 * `instance` distinguishes "Quiz 1" from "Quiz 2" for components configured to
 * repeat.
 */
export const assessments = pgTable(
  'assessments',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    academicYearId: text('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    termId: text('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    sectionSubjectId: text('section_subject_id')
      .notNull()
      .references(() => sectionSubjects.id, { onDelete: 'cascade' }),

    /** Must match a component key in the resolved grading configuration. */
    componentKey: varchar('component_key', { length: 32 }).notNull(),
    /** 1-based instance for repeated components ("best 3 of 4 quizzes"). */
    instance: integer('instance').notNull().default(1),

    title: text('title').notNull(),
    titleAm: text('title_am'),
    maxMark: real('max_mark').notNull().default(100),
    /** When the work was set/sat; used for ordering and for late entry rules. */
    assessedOn: date('assessed_on'),

    /** draft | submitted | approved | locked */
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedBy: text('submitted_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by').references(() => users.id, { onDelete: 'set null' }),
    /** Why marks were sent back, so the teacher knows what to fix. */
    reviewNote: text('review_note'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One "Quiz 2" per class subject per term. Prevents a double-entered test
    // quietly halving everyone's quiz average.
    uniqueIndex('assessments_component_instance_uq').on(
      t.sectionSubjectId,
      t.termId,
      t.componentKey,
      t.instance,
    ),
    index('assessments_school_term_idx').on(t.schoolId, t.termId),
    index('assessments_section_subject_idx').on(t.sectionSubjectId, t.termId),
    index('assessments_status_idx').on(t.schoolId, t.status),
  ],
);

/**
 * One student's mark for one assessment.
 *
 * Three distinct states, which must not be conflated:
 *   mark = null, isExcused = false → not entered yet
 *   mark = 0,    isExcused = false → sat it, scored nothing
 *   mark = null, isExcused = true  → excused; excluded from the average
 */
export const marks = pgTable(
  'marks',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    assessmentId: text('assessment_id')
      .notNull()
      .references(() => assessments.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),

    mark: real('mark'),
    isExcused: boolean('is_excused').notNull().default(false),
    /** Teacher's note on this particular mark, e.g. "sat late, supervised". */
    note: text('note'),

    enteredBy: text('entered_by').references(() => users.id, { onDelete: 'set null' }),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('marks_assessment_student_uq').on(t.assessmentId, t.studentId),
    index('marks_student_idx').on(t.schoolId, t.studentId),
    index('marks_assessment_idx').on(t.assessmentId),
  ],
);

/**
 * Every change to a mark after it was first entered.
 *
 * Separate from the general audit log because grade changes are the single
 * most disputed record a school holds; they need to be queryable per student
 * without scanning the whole audit table, and they must survive even if the
 * audit log is later pruned.
 */
export const markChanges = pgTable(
  'mark_changes',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    markId: text('mark_id')
      .notNull()
      .references(() => marks.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    previousMark: real('previous_mark'),
    newMark: real('new_mark'),
    previousExcused: boolean('previous_excused'),
    newExcused: boolean('new_excused'),
    /** Required when changing a mark after it has been locked. */
    reason: text('reason'),
    /** True when the change bypassed a lock via grade.overrideLocked. */
    wasLocked: boolean('was_locked').notNull().default(false),
    changedBy: text('changed_by').references(() => users.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mark_changes_student_idx').on(t.schoolId, t.studentId),
    index('mark_changes_mark_idx').on(t.markId),
  ],
);

/**
 * Cached subject outcome for a student in a term.
 * Recomputed whenever a mark in that subject changes.
 */
export const subjectResults = pgTable(
  'subject_results',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    termId: text('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    sectionSubjectId: text('section_subject_id')
      .notNull()
      .references(() => sectionSubjects.id, { onDelete: 'cascade' }),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),

    /** Over components actually marked. */
    percentage: real('percentage'),
    /** Treating unmarked components as zero. */
    provisionalPercentage: real('provisional_percentage'),
    letter: varchar('letter', { length: 4 }),
    points: real('points'),
    isPass: boolean('is_pass'),
    isComplete: boolean('is_complete').notNull().default(false),
    /** Rank within the section for this subject, when the school ranks. */
    rank: integer('rank'),
    /** Per-component breakdown, so a report card need not re-derive it. */
    breakdown: jsonb('breakdown'),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subject_results_uq').on(t.studentId, t.termId, t.sectionSubjectId),
    index('subject_results_term_idx').on(t.schoolId, t.termId),
    index('subject_results_section_subject_idx').on(t.sectionSubjectId, t.termId),
  ],
);

/** Cached term aggregate across all a student's subjects. */
export const termResults = pgTable(
  'term_results',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    termId: text('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    sectionId: text('section_id').references(() => sections.id, { onDelete: 'set null' }),

    average: real('average'),
    gpa: real('gpa'),
    totalSubjects: integer('total_subjects').notNull().default(0),
    passedSubjects: integer('passed_subjects').notNull().default(0),
    failedSubjects: integer('failed_subjects').notNull().default(0),
    isPass: boolean('is_pass'),
    /** Rank within the section, when the school ranks. Null when it does not. */
    rankInSection: integer('rank_in_section'),
    rankInGrade: integer('rank_in_grade'),
    classSize: integer('class_size'),
    /** Attendance percentage for the term, copied in at computation time. */
    attendancePercent: real('attendance_percent'),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('term_results_uq').on(t.studentId, t.termId),
    index('term_results_term_idx').on(t.schoolId, t.termId),
    index('term_results_section_idx').on(t.sectionId, t.termId),
  ],
);

/**
 * A report card for one student for one term.
 *
 * `snapshot` freezes the figures at publication so the document a parent read
 * cannot change under them. A later correction produces a new version rather
 * than mutating this row's snapshot.
 */
export const reportCards = pgTable(
  'report_cards',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    termId: text('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),

    /** draft | pending_approval | approved | published */
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    version: integer('version').notNull().default(1),

    classTeacherComment: text('class_teacher_comment'),
    principalComment: text('principal_comment'),
    conduct: varchar('conduct', { length: 32 }),

    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    generatedBy: text('generated_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: text('published_by').references(() => users.id, { onDelete: 'set null' }),

    /** Frozen copy of the results as published. */
    snapshot: jsonb('snapshot'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('report_cards_student_term_uq').on(t.studentId, t.termId),
    index('report_cards_term_status_idx').on(t.schoolId, t.termId, t.status),
  ],
);
