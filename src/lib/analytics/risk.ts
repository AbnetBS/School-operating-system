/**
 * Student early-warning view.
 *
 * ## This is not a black box
 *
 * The specification is emphatic, and it is right: a pupil is never reduced to
 * an opaque number. Every student here carries a list of `RiskSignal`s, each
 * naming the rule that fired, the configured threshold, and the pupil's actual
 * value. A teacher reading the screen can always answer "why is this child on
 * the list?" without asking anyone.
 *
 * The score exists only to order the list. It is the sum of the weights of the
 * signals that fired — all of them configurable per school under the `risk`
 * settings key — and it is always displayed next to the signals that produced
 * it, never alone.
 *
 * ## This never acts
 *
 * Nothing in this module suspends, fails, excludes or punishes anybody. It
 * produces a list for a human to review. The most it will do is emit the
 * existing `attendance.riskDetected` event, which the notification engine may
 * turn into a message to a teacher — a prompt for a conversation, not a
 * sanction.
 *
 * ## Finance is opt-in and off by default
 *
 * `risk.financeEnabled` defaults to false. A child is not "at risk" because
 * their family is late paying, and mixing a debt signal into a pastoral list
 * invites exactly the wrong intervention. A school may switch it on knowingly.
 */

import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { termResults } from '../../db/schema/academics.ts';
import { attendanceRecords } from '../../db/schema/attendance.ts';
import { studentCharges } from '../../db/schema/finance.ts';
import { sections, gradeLevels } from '../../db/schema/core.ts';
import { students, enrollments } from '../../db/schema/people.ts';
import { getSetting } from '../settings/service.ts';
import { getConsecutiveAbsences } from '../attendance/service.ts';
import type { RiskSettings } from '../settings/schemas.ts';

/** Why a pupil appears on the list. One per rule that fired. */
export type RiskSignal = {
  /** Stable machine key; the UI maps it to a translated sentence. */
  key:
    | 'attendance'
    | 'consecutiveAbsence'
    | 'academic'
    | 'decline'
    | 'failedSubjects'
    | 'finance';
  /** The pupil's actual figure. */
  value: number;
  /** The school's configured threshold that the value crossed. */
  threshold: number;
  /** Weight this signal contributed to the ordering score. */
  weight: number;
};

export type StudentRisk = {
  studentId: string;
  studentCode: string;
  givenName: string;
  fatherName: string;
  grandfatherName: string | null;
  sectionId: string | null;
  sectionName: string | null;
  gradeName: string | null;
  /** Sum of fired signal weights. Meaningless without `signals`. */
  score: number;
  signals: RiskSignal[];
  attendancePercent: number | null;
  averagePercent: number | null;
};

export type RiskReport = {
  students: StudentRisk[];
  total: number;
  /** Echoed back so the UI can explain the rules it is showing. */
  settings: RiskSettings;
  /** True when the school has switched the whole feature off. */
  disabled: boolean;
};

/**
 * Build the early-warning list for a school.
 *
 * Four bulk queries regardless of roll size — attendance, results, unpaid
 * charges and the roster — then combined in memory. Per-pupil queries would be
 * an N+1 across the whole school.
 */
export async function getRiskReport(
  db: Database,
  schoolId: string,
  academicYearId: string,
  options: {
    termId?: string | null;
    previousTermId?: string | null;
    sectionId?: string;
    /** Narrow to one pupil, for a profile page. */
    studentId?: string;
    /** Teacher restriction. Empty array yields nothing, never everything. */
    restrictToSectionIds?: string[];
    /** Include pupils below the attention score too. */
    includeAll?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<RiskReport> {
  const settings = await getSetting(db, schoolId, 'risk');

  if (!settings.enabled) {
    return { students: [], total: 0, settings, disabled: true };
  }

  const restrict = options.restrictToSectionIds;
  if (restrict && restrict.length === 0) {
    return { students: [], total: 0, settings, disabled: false };
  }

  // ---- roster -------------------------------------------------------------
  const rosterConditions: SQL[] = [
    // Redundant today — `enrollments.academic_year_id` already implies the
    // school, because an academic year belongs to exactly one school and the
    // integrity migrations enforce the pair. It is kept deliberately: the day
    // someone makes the year optional, or joins from a different direction,
    // this is the condition that stops the query becoming cross-tenant.
    eq(students.schoolId, schoolId),
    isNull(students.deletedAt),
    eq(students.status, 'active'),
    eq(enrollments.academicYearId, academicYearId),
    isNull(enrollments.endedOn),
  ];
  if (options.sectionId) rosterConditions.push(eq(enrollments.sectionId, options.sectionId));
  if (options.studentId) rosterConditions.push(eq(students.id, options.studentId));
  if (restrict) rosterConditions.push(inArray(enrollments.sectionId, restrict));

  const roster = await db
    .select({
      studentId: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
      sectionId: enrollments.sectionId,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
    })
    .from(students)
    .innerJoin(enrollments, eq(enrollments.studentId, students.id))
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .leftJoin(gradeLevels, eq(gradeLevels.id, enrollments.gradeLevelId))
    .where(and(...rosterConditions));

  if (roster.length === 0) {
    return { students: [], total: 0, settings, disabled: false };
  }

  const studentIds = roster.map((r) => r.studentId);

  // ---- attendance ---------------------------------------------------------
  const attendanceRows =
    settings.attendanceEnabled || settings.consecutiveAbsenceEnabled
      ? await db
          .select({
            studentId: attendanceRecords.studentId,
            total: sql<number>`count(*)::int`,
            present: sql<number>`count(*) filter (where ${attendanceRecords.status} in ('present','late','excused','sick'))::int`,
          })
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.schoolId, schoolId),
              eq(attendanceRecords.academicYearId, academicYearId),
              inArray(attendanceRecords.studentId, studentIds),
            ),
          )
          .groupBy(attendanceRecords.studentId)
      : [];

  const attendanceBy = new Map(
    attendanceRows.map((r) => [
      r.studentId,
      r.total > 0 ? Math.round((r.present / r.total) * 1000) / 10 : null,
    ]),
  );

  // ---- consecutive absences ----------------------------------------------
  // Delegated to the attendance module, which already owns this definition and
  // is already tested. Re-deriving "how many days in a row" here would give the
  // school two answers to the same question, and eventually they would differ.
  const consecutiveBy = new Map<string, number>();
  if (settings.consecutiveAbsenceEnabled) {
    const runs = await getConsecutiveAbsences(
      db,
      schoolId,
      academicYearId,
      settings.consecutiveAbsenceDays,
      restrict,
    );
    for (const run of runs) consecutiveBy.set(run.studentId, run.days);
  }

  // ---- academic -----------------------------------------------------------
  const resultsBy = new Map<
    string,
    { average: number | null; failed: number; previous: number | null }
  >();
  if ((settings.academicEnabled || settings.declineEnabled) && options.termId) {
    const previousExpr = options.previousTermId
      ? sql<number | null>`(
          select tr2.average from ${termResults} tr2
          where tr2.student_id = ${termResults}.${sql.identifier('student_id')}
            and tr2.term_id = ${options.previousTermId}
        )`
      : sql<number | null>`null::float8`;

    const rows = await db
      .select({
        studentId: termResults.studentId,
        average: termResults.average,
        failed: termResults.failedSubjects,
        previous: previousExpr,
      })
      .from(termResults)
      .where(
        and(
          eq(termResults.schoolId, schoolId),
          eq(termResults.termId, options.termId),
          inArray(termResults.studentId, studentIds),
        ),
      );

    for (const row of rows) {
      resultsBy.set(row.studentId, {
        average: row.average === null ? null : Number(row.average),
        failed: row.failed,
        previous: row.previous === null ? null : Number(row.previous),
      });
    }
  }

  // ---- finance (opt-in) ---------------------------------------------------
  const outstandingBy = new Map<string, number>();
  if (settings.financeEnabled) {
    const rows = await db
      .select({
        studentId: studentCharges.studentId,
        outstanding: sql<number>`coalesce(sum(
          ${studentCharges.netAmountCents} - coalesce((
            select sum(pa.amount_cents) from payment_allocations pa
            join payments p on p.id = pa.payment_id
            where pa.charge_id = ${studentCharges}.${sql.identifier('id')}
              and p.status = 'completed'
          ), 0)
        ), 0)::int`,
      })
      .from(studentCharges)
      .where(
        and(
          eq(studentCharges.schoolId, schoolId),
          eq(studentCharges.status, 'active'),
          inArray(studentCharges.studentId, studentIds),
          sql`${studentCharges.dueDate} is not null and ${studentCharges.dueDate} < current_date`,
        ),
      )
      .groupBy(studentCharges.studentId);

    for (const row of rows) {
      if (row.outstanding > 0) outstandingBy.set(row.studentId, row.outstanding);
    }
  }

  // ---- combine ------------------------------------------------------------
  const assessed: StudentRisk[] = roster.map((student) => {
    const signals: RiskSignal[] = [];
    const attendancePercent = attendanceBy.get(student.studentId) ?? null;
    const result = resultsBy.get(student.studentId);

    if (
      settings.attendanceEnabled &&
      attendancePercent !== null &&
      attendancePercent <= settings.attendanceThresholdPercent
    ) {
      signals.push({
        key: 'attendance',
        value: attendancePercent,
        threshold: settings.attendanceThresholdPercent,
        weight: settings.attendanceWeight,
      });
    }

    const run = consecutiveBy.get(student.studentId) ?? 0;
    if (settings.consecutiveAbsenceEnabled && run >= settings.consecutiveAbsenceDays) {
      signals.push({
        key: 'consecutiveAbsence',
        value: run,
        threshold: settings.consecutiveAbsenceDays,
        weight: settings.consecutiveAbsenceWeight,
      });
    }

    if (
      settings.academicEnabled &&
      result?.average !== null &&
      result?.average !== undefined &&
      result.average <= settings.academicThresholdPercent
    ) {
      signals.push({
        key: 'academic',
        value: result.average,
        threshold: settings.academicThresholdPercent,
        weight: settings.academicWeight,
      });
    }

    if (settings.academicEnabled && result && result.failed > 0) {
      signals.push({
        key: 'failedSubjects',
        value: result.failed,
        threshold: 1,
        // Carried by the academic weight; failing subjects is the same
        // concern as a low average, not a second independent one.
        weight: 0,
      });
    }

    if (
      settings.declineEnabled &&
      result?.average != null &&
      result?.previous != null &&
      result.previous - result.average >= settings.declinePoints
    ) {
      signals.push({
        key: 'decline',
        value: Math.round((result.previous - result.average) * 10) / 10,
        threshold: settings.declinePoints,
        weight: settings.declineWeight,
      });
    }

    const owed = outstandingBy.get(student.studentId);
    if (settings.financeEnabled && owed) {
      signals.push({
        key: 'finance',
        value: owed,
        threshold: 0,
        weight: settings.financeWeight,
      });
    }

    return {
      studentId: student.studentId,
      studentCode: student.studentCode,
      givenName: student.givenName,
      fatherName: student.fatherName,
      grandfatherName: student.grandfatherName,
      sectionId: student.sectionId,
      sectionName: student.sectionName,
      gradeName: student.gradeName,
      score: signals.reduce((sum, s) => sum + s.weight, 0),
      signals,
      attendancePercent,
      averagePercent: result?.average ?? null,
    };
  });

  const flagged = options.includeAll
    ? assessed.filter((s) => s.signals.length > 0)
    : assessed.filter((s) => s.score >= settings.attentionScore);

  flagged.sort((a, b) => b.score - a.score || a.givenName.localeCompare(b.givenName));

  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  const start = (page - 1) * pageSize;

  return {
    students: flagged.slice(start, start + pageSize),
    total: flagged.length,
    settings,
    disabled: false,
  };
}

/**
 * The risk picture for one pupil, for the student profile and parent portal.
 *
 * Deliberately the same code path as the list: a school must never see one
 * explanation on the overview and a different one on the profile.
 */
export async function getStudentRisk(
  db: Database,
  schoolId: string,
  academicYearId: string,
  studentId: string,
  options: {
    termId?: string | null;
    previousTermId?: string | null;
    /** Carried through so a restricted teacher cannot profile another class. */
    restrictToSectionIds?: string[];
  } = {},
): Promise<StudentRisk | null> {
  // Narrowed by studentId in the roster query, so this reads one pupil's rows
  // rather than the school's and filtering afterwards.
  const report = await getRiskReport(db, schoolId, academicYearId, {
    ...options,
    studentId,
    includeAll: true,
    pageSize: 1,
  });
  return report.students[0] ?? null;
}
