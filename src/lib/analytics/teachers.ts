/**
 * Teacher workload and completion.
 *
 * ## What this is, and what it is not
 *
 * This answers an operational question — "which registers have not been taken,
 * and which marks are still outstanding?" — so that a head of school can help
 * before results are late, and so nobody's class is quietly missed for a week.
 *
 * It is deliberately NOT a performance score. There is no ranking, no rating,
 * no composite "completion index", and no comparison of one teacher against
 * another. The specification says operational visibility, not punitive
 * scoring, and the difference is a design constraint rather than a nicety:
 * the moment this becomes a league table, teachers start optimising the
 * number instead of teaching, and the data stops being trustworthy.
 *
 * Every figure is therefore a raw count with the denominator beside it, so a
 * teacher with nine classes is never made to look worse than one with two.
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { assessments, marks } from '../../db/schema/academics.ts';
import { attendanceSessions } from '../../db/schema/attendance.ts';
import { sections, sectionSubjects, users } from '../../db/schema/core.ts';
import { enrollments } from '../../db/schema/people.ts';

export type TeacherCompletion = {
  teacherId: string;
  teacherName: string;
  /** Distinct sections this teacher is responsible for. */
  sectionCount: number;
  /** Class-subject assignments. */
  subjectCount: number;
  studentCount: number;
  /** School days in the window × sections where they are the class teacher. */
  registersExpected: number;
  registersTaken: number;
  registersMissing: number;
  assessmentCount: number;
  /** Submitted, waiting for someone else to approve. */
  pendingApproval: number;
  /** Empty mark cells across their assessments. */
  missingMarks: number;
};

/**
 * Per-teacher workload and outstanding work.
 *
 * Four bulk queries joined in memory by teacher id, rather than a query per
 * teacher. A school with 60 staff would otherwise issue 240 round trips to
 * render one screen.
 */
export async function getTeacherCompletion(
  db: Database,
  schoolId: string,
  academicYearId: string,
  options: {
    termId?: string | null;
    /** Attendance window. Defaults to the whole year when omitted. */
    from?: string;
    to?: string;
    restrictToSectionIds?: string[];
    teacherId?: string;
  } = {},
): Promise<TeacherCompletion[]> {
  const restrict = options.restrictToSectionIds;
  if (restrict && restrict.length === 0) return [];

  // ---- assignments --------------------------------------------------------
  const assignmentConditions: SQL[] = [
    eq(sectionSubjects.schoolId, schoolId),
    eq(sectionSubjects.academicYearId, academicYearId),
    sql`${sectionSubjects.teacherId} is not null`,
  ];
  if (restrict) assignmentConditions.push(inArray(sectionSubjects.sectionId, restrict));
  if (options.teacherId) assignmentConditions.push(eq(sectionSubjects.teacherId, options.teacherId));

  const assignments = await db
    .select({
      teacherId: sectionSubjects.teacherId,
      teacherGiven: users.givenName,
      teacherFather: users.fatherName,
      sectionId: sectionSubjects.sectionId,
      sectionSubjectId: sectionSubjects.id,
      studentCount: sql<number>`(
        select count(*)::int from ${enrollments} e
        where e.section_id = ${sectionSubjects}.${sql.identifier('section_id')}
          and e.ended_on is null
          and e.status = 'enrolled'
      )`,
    })
    .from(sectionSubjects)
    .innerJoin(users, eq(users.id, sectionSubjects.teacherId))
    .where(and(...assignmentConditions));

  if (assignments.length === 0) return [];

  type Accumulator = TeacherCompletion & {
    sections: Set<string>;
    countedSections: Set<string>;
  };
  const byTeacher = new Map<string, Accumulator>();

  for (const row of assignments) {
    const id = row.teacherId!;
    let entry = byTeacher.get(id);
    if (!entry) {
      entry = {
        teacherId: id,
        teacherName: [row.teacherGiven, row.teacherFather].filter(Boolean).join(' '),
        sectionCount: 0,
        subjectCount: 0,
        studentCount: 0,
        registersExpected: 0,
        registersTaken: 0,
        registersMissing: 0,
        assessmentCount: 0,
        pendingApproval: 0,
        missingMarks: 0,
        sections: new Set<string>(),
        countedSections: new Set<string>(),
      };
      byTeacher.set(id, entry);
    }
    entry.subjectCount += 1;
    entry.sections.add(row.sectionId);
    // A teacher taking three subjects in one section teaches those pupils
    // once, not three times.
    if (!entry.countedSections.has(row.sectionId)) {
      entry.countedSections.add(row.sectionId);
      entry.studentCount += row.studentCount;
    }
  }

  // ---- attendance sessions taken -----------------------------------------
  const sessionConditions: SQL[] = [
    eq(attendanceSessions.schoolId, schoolId),
    eq(attendanceSessions.academicYearId, academicYearId),
  ];
  if (options.from) sessionConditions.push(sql`${attendanceSessions.date} >= ${options.from}`);
  if (options.to) sessionConditions.push(sql`${attendanceSessions.date} <= ${options.to}`);
  if (restrict) sessionConditions.push(inArray(attendanceSessions.sectionId, restrict));

  const taken = await db
    .select({
      takenBy: attendanceSessions.takenBy,
      total: sql<number>`count(*)::int`,
    })
    .from(attendanceSessions)
    .where(and(...sessionConditions))
    .groupBy(attendanceSessions.takenBy);

  for (const row of taken) {
    if (!row.takenBy) continue;
    const entry = byTeacher.get(row.takenBy);
    if (entry) entry.registersTaken = row.total;
  }

  // ---- expected registers, from homeroom responsibility -------------------
  // Only class teachers own a daily register; a subject teacher does not, so
  // counting one for every assignment would invent missing work.
  const homeroomConditions: SQL[] = [
    eq(sections.schoolId, schoolId),
    eq(sections.academicYearId, academicYearId),
    eq(sections.isActive, true),
    sql`${sections.classTeacherId} is not null`,
  ];
  if (restrict) homeroomConditions.push(inArray(sections.id, restrict));

  const homerooms = await db
    .select({
      classTeacherId: sections.classTeacherId,
      sectionId: sections.id,
      sessionsHeld: sql<number>`(
        select count(*)::int from ${attendanceSessions} s
        where s.section_id = ${sections}.${sql.identifier('id')}
          and s.academic_year_id = ${academicYearId}
          ${options.from ? sql`and s.date >= ${options.from}` : sql``}
          ${options.to ? sql`and s.date <= ${options.to}` : sql``}
      )`,
    })
    .from(sections)
    .where(and(...homeroomConditions));

  // The number of school days that *should* have a register is derived by the
  // attendance module (it knows the school's working days and holidays). Here
  // the expectation is simply the busiest section's count in the same window:
  // if one class managed 40 registers, a class with 31 is 9 behind. This
  // avoids re-deriving the calendar and, more importantly, avoids inventing a
  // number for a school that started mid-term.
  const expected = Math.max(0, ...homerooms.map((h) => h.sessionsHeld));

  for (const room of homerooms) {
    if (!room.classTeacherId) continue;
    const entry = byTeacher.get(room.classTeacherId);
    if (!entry) continue;
    entry.registersExpected += expected;
    entry.registersMissing += Math.max(0, expected - room.sessionsHeld);
  }

  // ---- assessments and missing marks --------------------------------------
  if (options.termId) {
    const assessmentConditions: SQL[] = [
      eq(assessments.schoolId, schoolId),
      eq(assessments.termId, options.termId),
      sql`${sectionSubjects.teacherId} is not null`,
    ];
    if (restrict) assessmentConditions.push(inArray(sectionSubjects.sectionId, restrict));
    if (options.teacherId) {
      assessmentConditions.push(eq(sectionSubjects.teacherId, options.teacherId));
    }

    const rows = await db
      .select({
        teacherId: sectionSubjects.teacherId,
        assessmentCount: sql<number>`count(*)::int`,
        pendingApproval: sql<number>`count(*) filter (where ${assessments.status} = 'submitted')::int`,
        missingMarks: sql<number>`coalesce(sum(greatest(0,
          (select count(*)::int from ${enrollments} e
            where e.section_id = ${sectionSubjects}.${sql.identifier('section_id')}
              and e.ended_on is null
              and e.status = 'enrolled')
          -
          (select count(*)::int from ${marks} m
            where m.assessment_id = ${assessments}.${sql.identifier('id')}
              and (m.mark is not null or m.is_excused = true))
        )), 0)::int`,
      })
      .from(assessments)
      .innerJoin(sectionSubjects, eq(sectionSubjects.id, assessments.sectionSubjectId))
      .where(and(...assessmentConditions))
      .groupBy(sectionSubjects.teacherId);

    for (const row of rows) {
      if (!row.teacherId) continue;
      const entry = byTeacher.get(row.teacherId);
      if (!entry) continue;
      entry.assessmentCount = row.assessmentCount;
      entry.pendingApproval = row.pendingApproval;
      entry.missingMarks = row.missingMarks;
    }
  }

  return [...byTeacher.values()]
    .map(({ sections: sectionSet, countedSections, ...rest }) => {
      void countedSections;
      return { ...rest, sectionCount: sectionSet.size };
    })
    // Alphabetical, deliberately. Sorting by "most missing" would turn an
    // operational list into the ranking this module refuses to be.
    .sort((a, b) => a.teacherName.localeCompare(b.teacherName));
}
