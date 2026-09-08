/**
 * Dashboard aggregate queries.
 *
 * Every figure here is computed in SQL. Loading rows into JavaScript and
 * counting them would work for a 200-student school and fall over at 5,000 —
 * and the specification explicitly requires the system to stay fast as schools
 * grow.
 *
 * All queries are school-scoped by construction.
 */

import { and, eq, isNull, sql, desc, count } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  academicYears,
  sections,
  sectionSubjects,
  subjects,
  gradeLevels,
  users,
} from '../../db/schema/core.ts';
import { students, enrollments, staff, guardians } from '../../db/schema/people.ts';

export type SchoolOverview = {
  activeStudents: number;
  totalStudents: number;
  maleStudents: number;
  femaleStudents: number;
  teachers: number;
  staffCount: number;
  guardianCount: number;
  sections: number;
  subjects: number;
  gradeLevels: number;
  currentYearName: string | null;
  currentYearId: string | null;
};

export async function getSchoolOverview(
  db: Database,
  schoolId: string,
): Promise<SchoolOverview> {
  const [year] = await db
    .select({ id: academicYears.id, name: academicYears.name })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  // One round trip per aggregate, but each is an indexed COUNT rather than a
  // full row fetch.
  const [studentStats] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${students.status} = 'active')::int`,
      male: sql<number>`count(*) filter (where ${students.gender} = 'male' and ${students.status} = 'active')::int`,
      female: sql<number>`count(*) filter (where ${students.gender} = 'female' and ${students.status} = 'active')::int`,
    })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), isNull(students.deletedAt)));

  const [staffStats] = await db
    .select({
      total: count(),
      teachers: sql<number>`count(*) filter (where ${staff.staffType} = 'teacher')::int`,
    })
    .from(staff)
    .where(and(eq(staff.schoolId, schoolId), eq(staff.status, 'active')));

  const [guardianStats] = await db
    .select({ total: count() })
    .from(guardians)
    .where(eq(guardians.schoolId, schoolId));

  const [sectionStats] = year
    ? await db
        .select({ total: count() })
        .from(sections)
        .where(and(eq(sections.schoolId, schoolId), eq(sections.academicYearId, year.id)))
    : [{ total: 0 }];

  const [subjectStats] = await db
    .select({ total: count() })
    .from(subjects)
    .where(and(eq(subjects.schoolId, schoolId), eq(subjects.isActive, true)));

  const [gradeStats] = await db
    .select({ total: count() })
    .from(gradeLevels)
    .where(and(eq(gradeLevels.schoolId, schoolId), eq(gradeLevels.isActive, true)));

  return {
    activeStudents: studentStats?.active ?? 0,
    totalStudents: studentStats?.total ?? 0,
    maleStudents: studentStats?.male ?? 0,
    femaleStudents: studentStats?.female ?? 0,
    teachers: staffStats?.teachers ?? 0,
    staffCount: staffStats?.total ?? 0,
    guardianCount: guardianStats?.total ?? 0,
    sections: sectionStats?.total ?? 0,
    subjects: subjectStats?.total ?? 0,
    gradeLevels: gradeStats?.total ?? 0,
    currentYearName: year?.name ?? null,
    currentYearId: year?.id ?? null,
  };
}

export type GradeEnrollment = {
  gradeLevelId: string;
  gradeName: string;
  level: number;
  studentCount: number;
  sectionCount: number;
  capacity: number | null;
};

/** Enrolment broken down by grade level, for the current year. */
export async function getEnrollmentByGrade(
  db: Database,
  schoolId: string,
  academicYearId: string,
): Promise<GradeEnrollment[]> {
  const rows = await db
    .select({
      gradeLevelId: gradeLevels.id,
      gradeName: gradeLevels.name,
      level: gradeLevels.level,
      studentCount: sql<number>`count(distinct ${enrollments.studentId})::int`,
      sectionCount: sql<number>`count(distinct ${enrollments.sectionId})::int`,
      capacity: sql<number | null>`sum(distinct ${sections.capacity})::int`,
    })
    .from(gradeLevels)
    .leftJoin(
      enrollments,
      and(
        eq(enrollments.gradeLevelId, gradeLevels.id),
        eq(enrollments.academicYearId, academicYearId),
        isNull(enrollments.endedOn),
      ),
    )
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .where(and(eq(gradeLevels.schoolId, schoolId), eq(gradeLevels.isActive, true)))
    .groupBy(gradeLevels.id, gradeLevels.name, gradeLevels.level)
    .orderBy(gradeLevels.level);

  return rows;
}

export type SectionSummary = {
  sectionId: string;
  sectionName: string;
  gradeName: string;
  level: number;
  studentCount: number;
  capacity: number | null;
  classTeacherName: string | null;
  subjectCount: number;
};

/** Sections with their roll counts, class teacher and subject count. */
export async function getSectionSummaries(
  db: Database,
  schoolId: string,
  academicYearId: string,
  options: { teacherId?: string; limit?: number } = {},
): Promise<SectionSummary[]> {
  const conditions = [
    eq(sections.schoolId, schoolId),
    eq(sections.academicYearId, academicYearId),
    eq(sections.isActive, true),
  ];

  const rows = await db
    .select({
      sectionId: sections.id,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
      level: gradeLevels.level,
      capacity: sections.capacity,
      teacherGiven: users.givenName,
      teacherFather: users.fatherName,
      // Outer columns are written table-qualified on purpose. Drizzle only
      // qualifies an interpolated column when the outer query has a JOIN;
      // without one it emits a bare "id", which Postgres then resolves against
      // the SUBQUERY's own table and silently counts 0 for every row. This
      // query does have joins today, so being explicit keeps it correct if a
      // join is ever removed.
      studentCount: sql<number>`(
        select count(*)::int from ${enrollments} e
        where e.section_id = ${sections}.${sql.identifier('id')}
          and e.ended_on is null
      )`,
      subjectCount: sql<number>`(
        select count(*)::int from ${sectionSubjects} ss
        where ss.section_id = ${sections}.${sql.identifier('id')}
      )`,
    })
    .from(sections)
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .leftJoin(users, eq(users.id, sections.classTeacherId))
    .where(and(...conditions))
    .orderBy(gradeLevels.level, sections.name)
    .limit(options.limit ?? 100);

  return rows.map((r) => ({
    sectionId: r.sectionId,
    sectionName: r.sectionName,
    gradeName: r.gradeName,
    level: r.level,
    studentCount: r.studentCount,
    capacity: r.capacity,
    subjectCount: r.subjectCount,
    classTeacherName: r.teacherGiven
      ? [r.teacherGiven, r.teacherFather].filter(Boolean).join(' ')
      : null,
  }));
}

export type TeacherAssignment = {
  sectionSubjectId: string;
  sectionId: string;
  sectionName: string;
  gradeName: string;
  subjectId: string;
  subjectName: string;
  studentCount: number;
};

/** The classes a specific teacher is assigned to teach. */
export async function getTeacherAssignments(
  db: Database,
  schoolId: string,
  teacherId: string,
  academicYearId: string,
): Promise<TeacherAssignment[]> {
  const rows = await db
    .select({
      sectionSubjectId: sectionSubjects.id,
      sectionId: sections.id,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
      subjectId: subjects.id,
      subjectName: subjects.name,
      studentCount: sql<number>`(
        select count(*)::int from ${enrollments} e
        where e.section_id = ${sections}.${sql.identifier('id')}
          and e.ended_on is null
      )`,
    })
    .from(sectionSubjects)
    .innerJoin(sections, eq(sections.id, sectionSubjects.sectionId))
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
    .where(
      and(
        eq(sectionSubjects.schoolId, schoolId),
        eq(sectionSubjects.teacherId, teacherId),
        eq(sectionSubjects.academicYearId, academicYearId),
      ),
    )
    .orderBy(gradeLevels.level, sections.name, subjects.name);

  return rows;
}

/** Sections that have no class teacher — an actionable setup gap. */
export async function getSectionsWithoutTeacher(
  db: Database,
  schoolId: string,
  academicYearId: string,
): Promise<{ id: string; name: string; gradeName: string }[]> {
  return db
    .select({ id: sections.id, name: sections.name, gradeName: gradeLevels.name })
    .from(sections)
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(
      and(
        eq(sections.schoolId, schoolId),
        eq(sections.academicYearId, academicYearId),
        isNull(sections.classTeacherId),
      ),
    )
    .orderBy(gradeLevels.level, sections.name);
}

/** Subject assignments still missing a teacher. */
export async function getUnassignedSubjects(
  db: Database,
  schoolId: string,
  academicYearId: string,
): Promise<{ count: number }> {
  const [row] = await db
    .select({ count: count() })
    .from(sectionSubjects)
    .where(
      and(
        eq(sectionSubjects.schoolId, schoolId),
        eq(sectionSubjects.academicYearId, academicYearId),
        isNull(sectionSubjects.teacherId),
      ),
    );
  return { count: row?.count ?? 0 };
}

/** Recently added students, for the activity panel. */
export async function getRecentStudents(
  db: Database,
  schoolId: string,
  limit = 5,
): Promise<
  { id: string; studentCode: string; givenName: string; fatherName: string; createdAt: Date }[]
> {
  return db
    .select({
      id: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      createdAt: students.createdAt,
    })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), isNull(students.deletedAt)))
    .orderBy(desc(students.createdAt))
    .limit(limit);
}
