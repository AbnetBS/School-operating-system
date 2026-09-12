/**
 * Portal data access for students and parents.
 *
 * SECURITY IS THE WHOLE POINT OF THIS FILE. A parent portal that leaks another
 * family's child is worse than no portal. Three rules, enforced here on every
 * read and tested directly:
 *
 *  1. The viewer never chooses which student they are. `resolvePortalStudent`
 *     derives the allowed set from the session's relationships, then checks the
 *     requested id against it. A supplied id is only ever used to *select*
 *     among already-permitted students, never to grant access.
 *
 *  2. A refused id returns 404, not 403. A 403 confirms the record exists,
 *     which is itself a leak — it tells a probing parent that a given id is a
 *     real student at this school.
 *
 *  3. Unpublished results are invisible. Marks exist in the database from the
 *     moment a teacher types them; parents see them only once the school has
 *     published, when the school's configuration requires publication.
 *
 * Tenant isolation comes free from `ctx.schoolId` being baked into every query
 * — but it is tested explicitly rather than assumed.
 */

import { and, eq, desc, asc, sql, inArray } from 'drizzle-orm';

import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import { AuthError } from '../auth/context.ts';
import { students, enrollments, guardians, studentGuardians } from '../../db/schema/people.ts';
import {
  terms,
  sections,
  gradeLevels,
  subjects,
  sectionSubjects,
  academicYears,
  users,
} from '../../db/schema/core.ts';
import { reportCards, subjectResults, termResults } from '../../db/schema/academics.ts';
import { getSetting } from '../settings/service.ts';
import { getStudentAttendance } from '../attendance/service.ts';
import { getPublishedReportCard, type ReportCardView } from '../gradebook/reportCards.ts';

export type PortalStudent = {
  id: string;
  name: string;
  studentCode: string;
  gradeName: string | null;
  sectionName: string | null;
  photoUrl: string | null;
};

/**
 * Which students may this viewer see through a portal?
 *
 * Derived entirely from the session. A student sees themself; a parent sees
 * their linked children. Staff do not use the portal — they have the full
 * application — so no staff branch exists here by design.
 */
export async function listPortalStudents(ctx: AuthContext): Promise<PortalStudent[]> {
  const { db, schoolId } = ctx;

  const allowedIds = new Set<string>();
  if (ctx.relationships.ownStudentId) allowedIds.add(ctx.relationships.ownStudentId);
  for (const id of ctx.relationships.childStudentIds) allowedIds.add(id);

  if (allowedIds.size === 0) return [];

  const rows = await db
    .select({
      id: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
      photoUrl: students.photoUrl,
      gradeName: gradeLevels.name,
      sectionName: sections.name,
    })
    .from(students)
    .leftJoin(
      enrollments,
      and(
        eq(enrollments.studentId, students.id),
        sql`${enrollments.endedOn} is null`,
      ),
    )
    .leftJoin(gradeLevels, eq(gradeLevels.id, enrollments.gradeLevelId))
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    // The school filter is what makes a stale relationship from another tenant
    // impossible to exploit.
    .where(and(eq(students.schoolId, schoolId), inArray(students.id, [...allowedIds])))
    .orderBy(asc(students.givenName));

  return rows.map((r) => ({
    id: r.id,
    studentCode: r.studentCode,
    name: [r.givenName, r.fatherName, r.grandfatherName].filter(Boolean).join(' '),
    gradeName: r.gradeName,
    sectionName: r.sectionName,
    photoUrl: r.photoUrl,
  }));
}

/**
 * Resolve which student a portal request is about.
 *
 * `requestedId` may come from a query string, so it is treated as untrusted: it
 * can only pick from the set the viewer already has access to. Anything else is
 * a 404.
 */
export async function resolvePortalStudent(
  ctx: AuthContext,
  requestedId?: string | null,
): Promise<PortalStudent> {
  const available = await listPortalStudents(ctx);

  if (available.length === 0) {
    throw new AuthError('No student record is linked to this account', 404);
  }

  if (!requestedId) return available[0]!;

  const match = available.find((s) => s.id === requestedId);
  // 404, not 403 — see the note at the top of this file.
  if (!match) throw new AuthError('Student not found', 404);
  return match;
}

export type PortalTermOption = {
  id: string;
  name: string;
  sequence: number;
  isCurrent: boolean;
  /** Whether the student has a published report card for this term. */
  hasReportCard: boolean;
};

/** Terms a portal user can look at, newest first. */
export async function getPortalTerms(
  ctx: AuthContext,
  studentId: string,
): Promise<PortalTermOption[]> {
  const { db, schoolId } = ctx;

  const [currentYear] = await db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!currentYear) return [];

  const rows = await db
    .select({
      id: terms.id,
      name: terms.name,
      sequence: terms.sequence,
      isCurrent: terms.isCurrent,
      cardStatus: reportCards.status,
    })
    .from(terms)
    .leftJoin(
      reportCards,
      and(eq(reportCards.termId, terms.id), eq(reportCards.studentId, studentId)),
    )
    .where(and(eq(terms.schoolId, schoolId), eq(terms.academicYearId, currentYear.id)))
    .orderBy(asc(terms.sequence));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sequence: r.sequence,
    isCurrent: r.isCurrent,
    hasReportCard: r.cardStatus === 'published',
  }));
}

export type PortalResults = {
  termId: string;
  termName: string;
  published: boolean;
  /** Null when nothing has been published for this term. */
  card: ReportCardView | null;
  /**
   * Why results are unavailable, phrased for a parent rather than an engineer.
   */
  message: string | null;
};

/**
 * A student's results for a term, as a portal may show them.
 *
 * The publication check happens here, server-side. A parent cannot see a mark
 * by guessing a term id.
 */
export async function getPortalResults(
  ctx: AuthContext,
  studentId: string,
  termId: string,
): Promise<PortalResults> {
  const { db, schoolId } = ctx;

  const [term] = await db
    .select({ id: terms.id, name: terms.name })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.id, termId)))
    .limit(1);
  if (!term) throw new AuthError('Not found', 404);

  const settings = await getSetting(db, schoolId, 'reportCard');
  const card = await getPublishedReportCard(db, schoolId, studentId, termId);

  if (!card) {
    return {
      termId,
      termName: term.name,
      published: false,
      card: null,
      message: settings.publishToPortals
        ? 'Results for this term have not been published yet.'
        : 'No results have been recorded for this term yet.',
    };
  }

  return { termId, termName: term.name, published: true, card, message: null };
}

export type PortalAttendance = {
  percent: number | null;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  recent: { date: string; status: string; subjectName: string | null; reason: string | null }[];
};

/** Attendance for the portal. Read-only, current year. */
export async function getPortalAttendance(
  ctx: AuthContext,
  studentId: string,
  options: { termId?: string } = {},
): Promise<PortalAttendance | null> {
  const { db, schoolId } = ctx;

  const modules = await getSetting(db, schoolId, 'modules');
  if (!modules.attendance) return null;

  const [currentYear] = await db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!currentYear) return null;

  let from: string | undefined;
  let to: string | undefined;
  if (options.termId) {
    const [term] = await db
      .select({ startDate: terms.startDate, endDate: terms.endDate })
      .from(terms)
      .where(and(eq(terms.schoolId, schoolId), eq(terms.id, options.termId)))
      .limit(1);
    from = term?.startDate;
    to = term?.endDate;
  }

  const history = await getStudentAttendance(db, schoolId, studentId, {
    academicYearId: currentYear.id,
    from,
    to,
    limit: 30,
  });

  return {
    percent: history.summary.percent,
    present: history.summary.present,
    absent: history.summary.absent,
    late: history.summary.late,
    excused: history.summary.excused,
    total: history.summary.total,
    recent: history.records.map((r) => ({
      date: r.date,
      status: r.status,
      subjectName: r.subjectName ?? null,
      reason: r.reason ?? null,
    })),
  };
}

/** The student's subjects and who teaches them. */
export async function getPortalSubjects(
  ctx: AuthContext,
  studentId: string,
): Promise<{ subjectName: string; subjectNameAm: string | null; teacherName: string | null }[]> {
  const { db, schoolId } = ctx;

  const [enrolment] = await db
    .select({ sectionId: enrollments.sectionId, academicYearId: enrollments.academicYearId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.studentId, studentId),
        sql`${enrollments.endedOn} is null`,
      ),
    )
    .orderBy(desc(enrollments.enrolledOn))
    .limit(1);

  if (!enrolment?.sectionId) return [];

  const rows = await db
    .select({
      subjectName: subjects.name,
      subjectNameAm: subjects.nameAm,
      teacherGiven: users.givenName,
      teacherFather: users.fatherName,
    })
    .from(sectionSubjects)
    .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
    .leftJoin(users, eq(users.id, sectionSubjects.teacherId))
    .where(
      and(
        eq(sectionSubjects.schoolId, schoolId),
        eq(sectionSubjects.sectionId, enrolment.sectionId),
      ),
    )
    .orderBy(asc(subjects.name));

  return rows.map((r) => ({
    subjectName: r.subjectName,
    subjectNameAm: r.subjectNameAm,
    teacherName: [r.teacherGiven, r.teacherFather].filter(Boolean).join(' ') || null,
  }));
}

/**
 * Progress across terms, for the small trend line on the portal home.
 * Only published terms are included, for the same reason as everything else.
 */
export async function getPortalProgress(
  ctx: AuthContext,
  studentId: string,
): Promise<{ termName: string; sequence: number; average: number | null }[]> {
  const { db, schoolId } = ctx;

  const settings = await getSetting(db, schoolId, 'reportCard');

  const rows = await db
    .select({
      termName: terms.name,
      sequence: terms.sequence,
      average: termResults.average,
      cardStatus: reportCards.status,
    })
    .from(termResults)
    .innerJoin(terms, eq(terms.id, termResults.termId))
    .leftJoin(
      reportCards,
      and(eq(reportCards.termId, terms.id), eq(reportCards.studentId, studentId)),
    )
    .where(and(eq(termResults.schoolId, schoolId), eq(termResults.studentId, studentId)))
    .orderBy(asc(terms.sequence));

  return rows
    .filter((r) => !settings.publishToPortals || r.cardStatus === 'published')
    .map((r) => ({ termName: r.termName, sequence: r.sequence, average: r.average }));
}

/**
 * The parent's own contact record, so they can see what the school holds and
 * whom to contact about corrections.
 */
export async function getPortalGuardianProfile(
  ctx: AuthContext,
): Promise<{ name: string; phone: string | null; email: string | null; children: number } | null> {
  const { db, schoolId } = ctx;
  const guardianId = ctx.relationships.guardianId;
  if (!guardianId) return null;

  const [row] = await db
    .select({
      givenName: guardians.givenName,
      fatherName: guardians.fatherName,
      phone: guardians.phone,
      email: guardians.email,
    })
    .from(guardians)
    .where(and(eq(guardians.schoolId, schoolId), eq(guardians.id, guardianId)))
    .limit(1);
  if (!row) return null;

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(studentGuardians)
    .where(eq(studentGuardians.guardianId, guardianId));

  return {
    name: [row.givenName, row.fatherName].filter(Boolean).join(' '),
    phone: row.phone,
    email: row.email,
    children: count?.n ?? 0,
  };
}
