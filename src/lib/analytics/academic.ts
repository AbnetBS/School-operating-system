/**
 * Academic performance intelligence.
 *
 * Reads the cached `subject_results` / `term_results` tables that the gradebook
 * already maintains rather than recomputing averages from raw marks. Those
 * tables are recomputed on every mark change, so they are current; recomputing
 * here would duplicate the grading configuration logic and risk the analytics
 * disagreeing with the report card, which is the one thing school analytics
 * must never do.
 *
 * ## Approved-only by default
 *
 * The specification is explicit: official analytics use approved results only.
 * Draft marks are a teacher's working notes — a half-entered test would drag a
 * class average down and trigger a false "declining" signal. So every figure
 * here is computed over assessments whose status is `approved` or `locked`,
 * unless the caller explicitly asks to include provisional work AND holds the
 * permission to see it.
 *
 * The distinction is surfaced in the return value (`basis`), never hidden, so
 * a screen can tell the user which numbers they are looking at.
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  assessments,
  marks,
  subjectResults,
  termResults,
} from '../../db/schema/academics.ts';
import {
  sections,
  sectionSubjects,
  subjects,
  gradeLevels,
  terms,
  users,
} from '../../db/schema/core.ts';
import { students, enrollments } from '../../db/schema/people.ts';

/** Which marks a figure was computed from. Always reported to the caller. */
export type ResultBasis = 'approved' | 'all';

/** Assessment statuses that count as official. */
const APPROVED_STATUSES = ['approved', 'locked'] as const;

/**
 * Restricts a query to the sections a caller may see.
 *
 * Returns `sql`false`` for an empty list. A teacher with no assigned sections
 * must see nothing; returning no condition at all would show them the whole
 * school, which is the classic analytics side-channel.
 */
function sectionScope(column: SQL | typeof sections.id, allowed: string[] | undefined): SQL[] {
  if (!allowed) return [];
  if (allowed.length === 0) return [sql`false`];
  return [inArray(column as never, allowed)];
}

// ---------------------------------------------------------------------------
// Subject performance
// ---------------------------------------------------------------------------

export type SubjectPerformance = {
  sectionSubjectId: string;
  subjectId: string;
  subjectName: string;
  sectionId: string;
  sectionName: string;
  gradeName: string;
  level: number;
  teacherName: string | null;
  studentCount: number;
  /** Mean of the pupils who have a computed result. Null when nobody does. */
  averagePercent: number | null;
  passCount: number;
  failCount: number;
  passRate: number | null;
  /** Pupils on roll with no computed result yet. */
  missingResults: number;
};

/**
 * Average, pass rate and completeness for every class-subject in a term.
 *
 * One query for the whole school. The obvious implementation — loop the
 * sections, then loop their subjects — is the N+1 the specification forbids.
 */
export async function getSubjectPerformance(
  db: Database,
  schoolId: string,
  termId: string,
  options: { restrictToSectionIds?: string[]; sectionId?: string; basis?: ResultBasis } = {},
): Promise<{ rows: SubjectPerformance[]; basis: ResultBasis }> {
  const basis: ResultBasis = options.basis ?? 'approved';

  const conditions: SQL[] = [
    eq(sectionSubjects.schoolId, schoolId),
    ...sectionScope(sectionSubjects.sectionId as never, options.restrictToSectionIds),
  ];
  if (options.sectionId) conditions.push(eq(sectionSubjects.sectionId, options.sectionId));

  // Roll size is counted from enrolments, not from result rows: a subject
  // where nobody has been marked must still report its pupils as missing
  // rather than vanishing from the report.
  const rollExpr = sql<number>`(
    select count(*)::int from ${enrollments} e
    where e.section_id = ${sectionSubjects}.${sql.identifier('section_id')}
      and e.ended_on is null
      and e.status = 'enrolled'
  )`;

  // Only results whose underlying assessments are approved count towards the
  // official average. `subject_results` has no status of its own, so the
  // filter is applied through the assessments that produced it.
  const approvedOnly =
    basis === 'approved'
      ? sql`and exists (
          select 1 from ${assessments} a
          where a.section_subject_id = sr.section_subject_id
            and a.term_id = sr.term_id
            and a.status in ('approved','locked')
        )`
      : sql``;

  const rows = await db
    .select({
      sectionSubjectId: sectionSubjects.id,
      subjectId: subjects.id,
      subjectName: subjects.name,
      sectionId: sections.id,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
      level: gradeLevels.level,
      teacherGiven: users.givenName,
      teacherFather: users.fatherName,
      studentCount: rollExpr,
      averagePercent: sql<number | null>`(
        select round(avg(sr.percentage)::numeric, 1)::float8 from ${subjectResults} sr
        where sr.section_subject_id = ${sectionSubjects}.${sql.identifier('id')}
          and sr.term_id = ${termId}
          and sr.percentage is not null
          ${approvedOnly}
      )`,
      passCount: sql<number>`(
        select count(*)::int from ${subjectResults} sr
        where sr.section_subject_id = ${sectionSubjects}.${sql.identifier('id')}
          and sr.term_id = ${termId}
          and sr.is_pass = true
          ${approvedOnly}
      )`,
      failCount: sql<number>`(
        select count(*)::int from ${subjectResults} sr
        where sr.section_subject_id = ${sectionSubjects}.${sql.identifier('id')}
          and sr.term_id = ${termId}
          and sr.is_pass = false
          ${approvedOnly}
      )`,
      resultCount: sql<number>`(
        select count(*)::int from ${subjectResults} sr
        where sr.section_subject_id = ${sectionSubjects}.${sql.identifier('id')}
          and sr.term_id = ${termId}
          and sr.percentage is not null
          ${approvedOnly}
      )`,
    })
    .from(sectionSubjects)
    .innerJoin(sections, eq(sections.id, sectionSubjects.sectionId))
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
    .leftJoin(users, eq(users.id, sectionSubjects.teacherId))
    .where(and(...conditions))
    .orderBy(gradeLevels.level, sections.name, subjects.name);

  return {
    basis,
    rows: rows.map((r) => {
      const graded = r.passCount + r.failCount;
      return {
        sectionSubjectId: r.sectionSubjectId,
        subjectId: r.subjectId,
        subjectName: r.subjectName,
        sectionId: r.sectionId,
        sectionName: r.sectionName,
        gradeName: r.gradeName,
        level: r.level,
        teacherName: r.teacherGiven
          ? [r.teacherGiven, r.teacherFather].filter(Boolean).join(' ')
          : null,
        studentCount: r.studentCount,
        averagePercent: r.averagePercent === null ? null : Number(r.averagePercent),
        passCount: r.passCount,
        failCount: r.failCount,
        passRate: graded > 0 ? Math.round((r.passCount / graded) * 1000) / 10 : null,
        missingResults: Math.max(0, r.studentCount - r.resultCount),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Marks pipeline: what is missing, what is waiting for a human
// ---------------------------------------------------------------------------

export type MarksPipeline = {
  /** Assessments created but with at least one pupil unmarked. */
  incompleteAssessments: number;
  /** Individual empty cells across those assessments. */
  missingMarks: number;
  /** Submitted by a teacher, waiting for approval. */
  pendingApproval: number;
  draft: number;
  approved: number;
  locked: number;
};

/**
 * Counts for the marks workflow. Answers "what is holding up results?".
 *
 * A missing mark is an enrolled pupil with no `marks` row for an assessment,
 * or a row whose mark is null and which is not excused — the gradebook's three
 * documented states, respected here.
 */
export async function getMarksPipeline(
  db: Database,
  schoolId: string,
  termId: string,
  options: { restrictToSectionIds?: string[]; teacherId?: string } = {},
): Promise<MarksPipeline> {
  const conditions: SQL[] = [
    eq(assessments.schoolId, schoolId),
    eq(assessments.termId, termId),
    ...sectionScope(sectionSubjects.sectionId as never, options.restrictToSectionIds),
  ];
  if (options.teacherId) conditions.push(eq(sectionSubjects.teacherId, options.teacherId));

  const [statusRow] = await db
    .select({
      draft: sql<number>`count(*) filter (where ${assessments.status} = 'draft')::int`,
      pendingApproval: sql<number>`count(*) filter (where ${assessments.status} = 'submitted')::int`,
      approved: sql<number>`count(*) filter (where ${assessments.status} = 'approved')::int`,
      locked: sql<number>`count(*) filter (where ${assessments.status} = 'locked')::int`,
    })
    .from(assessments)
    .innerJoin(sectionSubjects, eq(sectionSubjects.id, assessments.sectionSubjectId))
    .where(and(...conditions));

  // Expected cells minus filled cells, per assessment, summed. Done in SQL so
  // a school with 400 assessments does not ship 400 roster queries.
  const [gapRow] = await db
    .select({
      missingMarks: sql<number>`coalesce(sum(gaps.missing), 0)::int`,
      incompleteAssessments: sql<number>`count(*) filter (where gaps.missing > 0)::int`,
    })
    .from(
      db
        .select({
          missing: sql<number>`(
            (select count(*)::int from ${enrollments} e
              where e.section_id = ${sectionSubjects}.${sql.identifier('section_id')}
                and e.ended_on is null
                and e.status = 'enrolled')
            -
            (select count(*)::int from ${marks} m
              where m.assessment_id = ${assessments}.${sql.identifier('id')}
                and (m.mark is not null or m.is_excused = true))
          )`.as('missing'),
        })
        .from(assessments)
        .innerJoin(sectionSubjects, eq(sectionSubjects.id, assessments.sectionSubjectId))
        .where(and(...conditions))
        .as('gaps'),
    );

  return {
    draft: statusRow?.draft ?? 0,
    pendingApproval: statusRow?.pendingApproval ?? 0,
    approved: statusRow?.approved ?? 0,
    locked: statusRow?.locked ?? 0,
    missingMarks: Math.max(0, gapRow?.missingMarks ?? 0),
    incompleteAssessments: gapRow?.incompleteAssessments ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Student trends
// ---------------------------------------------------------------------------

export type StudentTrend = {
  studentId: string;
  studentCode: string;
  givenName: string;
  fatherName: string;
  sectionId: string | null;
  sectionName: string | null;
  gradeName: string | null;
  currentAverage: number | null;
  previousAverage: number | null;
  /** current − previous, in percentage points. Null without both terms. */
  changePoints: number | null;
  failedSubjects: number;
  totalSubjects: number;
};

/**
 * Per-pupil term averages with the change from the preceding term.
 *
 * `previousTermId` is passed in rather than derived, because "the previous
 * term" is a school-configurable notion — a two-semester school and a
 * three-term school disagree, and some schools start mid-year with no prior
 * term at all. When it is null every `changePoints` is null and the caller
 * shows "no comparison available" rather than inventing a baseline.
 */
export async function getStudentTrends(
  db: Database,
  schoolId: string,
  termId: string,
  previousTermId: string | null,
  options: {
    restrictToSectionIds?: string[];
    sectionId?: string;
    /** Only pupils whose average fell by at least this many points. */
    minDeclinePoints?: number;
    limit?: number;
  } = {},
): Promise<StudentTrend[]> {
  const conditions: SQL[] = [
    eq(termResults.schoolId, schoolId),
    eq(termResults.termId, termId),
    ...sectionScope(termResults.sectionId as never, options.restrictToSectionIds),
  ];
  if (options.sectionId) conditions.push(eq(termResults.sectionId, options.sectionId));

  const previousExpr = previousTermId
    ? sql<number | null>`(
        select tr2.average from ${termResults} tr2
        where tr2.student_id = ${termResults}.${sql.identifier('student_id')}
          and tr2.term_id = ${previousTermId}
      )`
    : sql<number | null>`null::float8`;

  const rows = await db
    .select({
      studentId: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      sectionId: termResults.sectionId,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
      currentAverage: termResults.average,
      previousAverage: previousExpr,
      failedSubjects: termResults.failedSubjects,
      totalSubjects: termResults.totalSubjects,
    })
    .from(termResults)
    .innerJoin(students, eq(students.id, termResults.studentId))
    .leftJoin(sections, eq(sections.id, termResults.sectionId))
    .leftJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(and(...conditions))
    .limit(options.limit ?? 500);

  const mapped = rows.map((r) => {
    const current = r.currentAverage === null ? null : Number(r.currentAverage);
    const previous = r.previousAverage === null ? null : Number(r.previousAverage);
    return {
      ...r,
      currentAverage: current,
      previousAverage: previous,
      changePoints:
        current !== null && previous !== null
          ? Math.round((current - previous) * 10) / 10
          : null,
    };
  });

  const minDecline = options.minDeclinePoints;
  const filtered =
    minDecline !== undefined
      ? mapped.filter((r) => r.changePoints !== null && r.changePoints <= -Math.abs(minDecline))
      : mapped;

  // Steepest fall first; pupils without a comparison sort last.
  filtered.sort((a, b) => {
    if (a.changePoints === null) return 1;
    if (b.changePoints === null) return -1;
    return a.changePoints - b.changePoints;
  });

  return filtered;
}

// ---------------------------------------------------------------------------
// Term context
// ---------------------------------------------------------------------------

export type TermContext = {
  currentTermId: string | null;
  currentTermName: string | null;
  previousTermId: string | null;
  previousTermName: string | null;
};

/**
 * The current term and the one before it, in the school's own sequence.
 *
 * Falls back to the latest started term when nothing is flagged current, so a
 * school that forgot to tick the box still gets analytics instead of a blank
 * page.
 */
export async function getTermContext(
  db: Database,
  schoolId: string,
  academicYearId: string,
  today: string,
): Promise<TermContext> {
  const all = await db
    .select({
      id: terms.id,
      name: terms.name,
      sequence: terms.sequence,
      startDate: terms.startDate,
      isCurrent: terms.isCurrent,
    })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.academicYearId, academicYearId)))
    .orderBy(terms.sequence);

  const first = all[0];
  if (!first) {
    return {
      currentTermId: null,
      currentTermName: null,
      previousTermId: null,
      previousTermName: null,
    };
  }

  const flagged = all.find((t) => t.isCurrent);
  const started = [...all].reverse().find((t) => t.startDate <= today);
  const current = flagged ?? started ?? first;
  const index = all.findIndex((t) => t.id === current.id);
  const previous = index > 0 ? all[index - 1] : null;

  return {
    currentTermId: current.id,
    currentTermName: current.name,
    previousTermId: previous?.id ?? null,
    previousTermName: previous?.name ?? null,
  };
}

/** Subjects across the school ranked by average — strongest and weakest. */
export async function getSubjectRanking(
  db: Database,
  schoolId: string,
  termId: string,
  options: { restrictToSectionIds?: string[] } = {},
): Promise<{ subjectId: string; subjectName: string; averagePercent: number; resultCount: number }[]> {
  const conditions: SQL[] = [
    eq(subjectResults.schoolId, schoolId),
    eq(subjectResults.termId, termId),
    sql`${subjectResults.percentage} is not null`,
  ];

  if (options.restrictToSectionIds) {
    if (options.restrictToSectionIds.length === 0) return [];
    conditions.push(
      sql`exists (select 1 from ${sectionSubjects} ss
        where ss.id = ${subjectResults.sectionSubjectId}
          and ss.section_id in ${options.restrictToSectionIds})`,
    );
  }

  const rows = await db
    .select({
      subjectId: subjects.id,
      subjectName: subjects.name,
      averagePercent: sql<number>`round(avg(${subjectResults.percentage})::numeric, 1)::float8`,
      resultCount: sql<number>`count(*)::int`,
    })
    .from(subjectResults)
    .innerJoin(subjects, eq(subjects.id, subjectResults.subjectId))
    .where(and(...conditions))
    .groupBy(subjects.id, subjects.name)
    .orderBy(sql`avg(${subjectResults.percentage}) desc`);

  return rows.map((r) => ({ ...r, averagePercent: Number(r.averagePercent) }));
}
