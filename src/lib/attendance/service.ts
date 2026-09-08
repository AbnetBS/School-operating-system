/**
 * Attendance service.
 *
 * KEY BEHAVIOURS
 * --------------
 * IDEMPOTENT SUBMISSION. Submitting the same register twice updates it rather
 * than duplicating it. This is what makes offline sync safe: a teacher's phone
 * can replay a queued register without the school seeing double absences.
 *
 * PERMISSION IS RELATIONSHIP-BASED. A teacher may only take a register for a
 * class they actually teach. That check happens here, against the database,
 * not in the UI.
 *
 * BACKDATING IS POLICY-DRIVEN. How far back a teacher may edit is a school
 * setting, not a constant. Someone with `attendance.editAny` bypasses it.
 *
 * PERCENTAGES EXCLUDE HOLIDAYS. A student is never marked down for a day the
 * school was closed, and the "missing registers" report never nags a teacher
 * about a public holiday.
 */

import { and, asc, desc, eq, gte, lte, inArray, isNull, sql, count, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import {
  attendanceSessions,
  attendanceRecords,
  attendanceChanges,
  attendanceHolidays,
} from '../../db/schema/attendance.ts';
import { students, enrollments } from '../../db/schema/people.ts';
import {
  sections,
  sectionSubjects,
  subjects,
  gradeLevels,
  academicYears,
  terms,
  users,
} from '../../db/schema/core.ts';
import { recordAudit } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { getSetting } from '../settings/service.ts';
import { todayIso } from '../calendar/ethiopian.ts';
import type { SubmitAttendanceInput, CorrectAttendanceInput, AttendanceStatus } from './schema.ts';
import { buildIdempotencyKey } from './schema.ts';

export type RosterStudent = {
  studentId: string;
  studentCode: string;
  givenName: string;
  fatherName: string;
  givenNameAm: string | null;
  gender: string | null;
  rollNumber: number | null;
  photoUrl: string | null;
  /** Existing mark, when the register has already been taken. */
  status: AttendanceStatus | null;
  reason: string | null;
  minutesLate: number | null;
  /** Attendance percentage so far, to flag at-risk students inline. */
  attendancePercent: number | null;
};

/**
 * The class list for taking a register, with any marks already recorded.
 *
 * One query builds the roster; a second overlays existing marks. Returning
 * both together means the mobile client needs a single request to render a
 * ready-to-edit register.
 */
export async function getRoster(
  db: Database,
  schoolId: string,
  options: {
    sectionId: string;
    sectionSubjectId?: string | null;
    date: string;
    academicYearId: string;
  },
): Promise<{
  students: RosterStudent[];
  session: typeof attendanceSessions.$inferSelect | null;
  isHoliday: { name: string; kind: string } | null;
}> {
  const { sectionId, sectionSubjectId, date, academicYearId } = options;

  // Students currently enrolled in this section.
  const roster = await db
    .select({
      studentId: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      givenNameAm: students.givenNameAm,
      gender: students.gender,
      rollNumber: enrollments.rollNumber,
      photoUrl: students.photoUrl,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.sectionId, sectionId),
        eq(enrollments.academicYearId, academicYearId),
        isNull(enrollments.endedOn),
        eq(students.status, 'active'),
      ),
    )
    .orderBy(asc(enrollments.rollNumber), asc(students.givenName));

  // The existing register for this exact class/date, if one was taken.
  const sessionWhere = sectionSubjectId
    ? and(
        eq(attendanceSessions.schoolId, schoolId),
        eq(attendanceSessions.sectionSubjectId, sectionSubjectId),
        eq(attendanceSessions.date, date),
      )
    : and(
        eq(attendanceSessions.schoolId, schoolId),
        eq(attendanceSessions.sectionId, sectionId),
        eq(attendanceSessions.date, date),
        isNull(attendanceSessions.sectionSubjectId),
      );

  const [session] = await db.select().from(attendanceSessions).where(sessionWhere).limit(1);

  const existing = session
    ? await db
        .select({
          studentId: attendanceRecords.studentId,
          status: attendanceRecords.status,
          reason: attendanceRecords.reason,
          minutesLate: attendanceRecords.minutesLate,
        })
        .from(attendanceRecords)
        .where(eq(attendanceRecords.sessionId, session.id))
    : [];

  const marks = new Map(existing.map((r) => [r.studentId, r]));

  // Attendance rate to date, so the teacher can see who is slipping while
  // taking the register. One grouped query rather than one per student.
  const studentIds = roster.map((r) => r.studentId);
  const rates = new Map<string, number>();
  if (studentIds.length > 0) {
    const rows = await db
      .select({
        studentId: attendanceRecords.studentId,
        total: count(),
        present: sql<number>`sum(case when ${attendanceRecords.status} in ('present','late','excused') then 1 else 0 end)::int`,
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.schoolId, schoolId),
          eq(attendanceRecords.academicYearId, academicYearId),
          inArray(attendanceRecords.studentId, studentIds),
        ),
      )
      .groupBy(attendanceRecords.studentId);

    for (const row of rows) {
      if (row.total > 0) rates.set(row.studentId, Math.round((row.present / row.total) * 1000) / 10);
    }
  }

  const [holiday] = await db
    .select({ name: attendanceHolidays.name, kind: attendanceHolidays.kind })
    .from(attendanceHolidays)
    .where(
      and(
        eq(attendanceHolidays.schoolId, schoolId),
        eq(attendanceHolidays.academicYearId, academicYearId),
        eq(attendanceHolidays.date, date),
      ),
    )
    .limit(1);

  return {
    students: roster.map((student) => {
      const mark = marks.get(student.studentId);
      return {
        ...student,
        status: (mark?.status as AttendanceStatus | undefined) ?? null,
        reason: mark?.reason ?? null,
        minutesLate: mark?.minutesLate ?? null,
        attendancePercent: rates.get(student.studentId) ?? null,
      };
    }),
    session: session ?? null,
    isHoliday: holiday ?? null,
  };
}

/**
 * Check whether the caller may take or edit this register.
 *
 * Returns a reason string when refused, so the API can give a useful message
 * instead of a bare 403.
 */
export async function checkAttendancePermission(
  ctx: AuthContext,
  options: { sectionId: string; sectionSubjectId?: string | null; date: string },
): Promise<{ allowed: true } | { allowed: false; reason: string; status: number }> {
  const { db, schoolId } = ctx;

  if (!ctx.has('attendance.take') && !ctx.has('attendance.editAny')) {
    return { allowed: false, reason: 'You are not allowed to record attendance.', status: 403 };
  }

  const canEditAny = ctx.has('attendance.editAny');

  // A teacher may only mark a class they are actually assigned to.
  if (!canEditAny) {
    const teachesSection = ctx.relationships.sectionIds.includes(options.sectionId);
    if (!teachesSection) {
      return {
        allowed: false,
        reason: 'You are not assigned to this class.',
        status: 403,
      };
    }

    // For a per-subject register, it must be their own subject period.
    if (options.sectionSubjectId) {
      const owns = ctx.relationships.sectionSubjectIds.includes(options.sectionSubjectId);
      const [row] = await db
        .select({ id: sections.id })
        .from(sections)
        .where(and(eq(sections.schoolId, schoolId), eq(sections.id, options.sectionId), eq(sections.classTeacherId, ctx.user.userId)))
        .limit(1);
      // Either they teach that subject, or they are the class teacher.
      if (!owns && !row) {
        return {
          allowed: false,
          reason: 'You do not teach this subject to this class.',
          status: 403,
        };
      }
    }
  }

  // Backdating policy.
  const settings = await getSetting(db, schoolId, 'attendance');
  const localeSettings = await getSetting(db, schoolId, 'locale');
  const today = todayIso(localeSettings.timezone);

  if (options.date > today) {
    return { allowed: false, reason: 'Attendance cannot be recorded for a future date.', status: 400 };
  }

  if (!canEditAny && options.date < today) {
    if (!settings.allowBackdating) {
      return {
        allowed: false,
        reason: 'Attendance for past dates can only be changed by an administrator.',
        status: 403,
      };
    }
    const limit = settings.backdateLimitDays ?? 7;
    const daysBack = Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${options.date}T00:00:00Z`)) / 86_400_000,
    );
    if (daysBack > limit) {
      return {
        allowed: false,
        reason: `Attendance can only be edited up to ${limit} day${limit === 1 ? '' : 's'} back. Ask an administrator.`,
        status: 403,
      };
    }
  }

  return { allowed: true };
}

/**
 * Save a register.
 *
 * Idempotent by (section, subject, date): re-submitting replaces the marks and
 * records what changed, rather than creating a second session.
 */
export async function submitAttendance(
  ctx: AuthContext,
  input: SubmitAttendanceInput,
  academicYearId: string,
): Promise<{ sessionId: string; created: boolean; changed: number }> {
  const { db, schoolId } = ctx;

  const settings = await getSetting(db, schoolId, 'attendance');

  // The section must exist in this school and year.
  const [section] = await db
    .select({ id: sections.id, name: sections.name })
    .from(sections)
    .where(
      and(
        eq(sections.schoolId, schoolId),
        eq(sections.id, input.sectionId),
        eq(sections.academicYearId, academicYearId),
      ),
    )
    .limit(1);
  if (!section) throw new Error('That class does not exist in the current academic year.');

  if (input.sectionSubjectId) {
    const [link] = await db
      .select({ id: sectionSubjects.id })
      .from(sectionSubjects)
      .where(
        and(
          eq(sectionSubjects.schoolId, schoolId),
          eq(sectionSubjects.id, input.sectionSubjectId),
          eq(sectionSubjects.sectionId, input.sectionId),
        ),
      )
      .limit(1);
    if (!link) throw new Error('That subject is not taught to this class.');
  }

  // Reject any student who is not actually enrolled in this section. Without
  // this a crafted payload could write attendance for someone else's student.
  const enrolled = await db
    .select({ studentId: enrollments.studentId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.sectionId, input.sectionId),
        eq(enrollments.academicYearId, academicYearId),
        isNull(enrollments.endedOn),
      ),
    );
  const enrolledIds = new Set(enrolled.map((e) => e.studentId));
  const marks = input.marks.filter((m) => enrolledIds.has(m.studentId));
  if (marks.length === 0) {
    throw new Error('None of the submitted students are enrolled in this class.');
  }

  // Some schools require a reason whenever a student is marked absent.
  if (settings.requireAbsenceReason) {
    const missing = marks.filter((m) => m.status === 'absent' && !m.reason?.trim());
    if (missing.length > 0) {
      throw new Error('This school requires a reason for every absence.');
    }
  }

  // Which term the date falls in, for term-scoped reporting.
  const [term] = await db
    .select({ id: terms.id })
    .from(terms)
    .where(
      and(
        eq(terms.schoolId, schoolId),
        eq(terms.academicYearId, academicYearId),
        lte(terms.startDate, input.date),
        gte(terms.endDate, input.date),
      ),
    )
    .limit(1);

  const idempotencyKey =
    input.idempotencyKey ||
    buildIdempotencyKey({
      sectionId: input.sectionId,
      sectionSubjectId: input.sectionSubjectId,
      date: input.date,
    });

  const tally = {
    presentCount: marks.filter((m) => m.status === 'present').length,
    absentCount: marks.filter((m) => m.status === 'absent').length,
    lateCount: marks.filter((m) => m.status === 'late').length,
    excusedCount: marks.filter((m) => m.status === 'excused' || m.status === 'sick').length,
    totalCount: marks.length,
  };

  // Find an existing register for this class/date.
  const sessionWhere = input.sectionSubjectId
    ? and(
        eq(attendanceSessions.schoolId, schoolId),
        eq(attendanceSessions.sectionSubjectId, input.sectionSubjectId),
        eq(attendanceSessions.date, input.date),
      )
    : and(
        eq(attendanceSessions.schoolId, schoolId),
        eq(attendanceSessions.sectionId, input.sectionId),
        eq(attendanceSessions.date, input.date),
        isNull(attendanceSessions.sectionSubjectId),
      );

  const [existingSession] = await db.select().from(attendanceSessions).where(sessionWhere).limit(1);

  let sessionId: string;
  let wasCreated = false;

  if (existingSession) {
    sessionId = existingSession.id;
    await db
      .update(attendanceSessions)
      .set({ ...tally, takenBy: ctx.user.userId, takenAt: new Date(), note: input.note || null, updatedAt: new Date() })
      .where(eq(attendanceSessions.id, sessionId));
  } else {
    const [session] = await db
      .insert(attendanceSessions)
      .values({
        schoolId,
        academicYearId,
        termId: term?.id ?? null,
        sectionId: input.sectionId,
        sectionSubjectId: input.sectionSubjectId || null,
        periodId: input.periodId || null,
        date: input.date,
        mode: input.sectionSubjectId ? 'perSubject' : 'daily',
        takenBy: ctx.user.userId,
        syncedOffline: input.syncedOffline,
        idempotencyKey,
        note: input.note || null,
        ...tally,
      })
      .returning({ id: attendanceSessions.id });
    sessionId = session!.id;
    wasCreated = true;
  }

  // Existing marks, so corrections can be detected and logged.
  const previous = await db
    .select({
      id: attendanceRecords.id,
      studentId: attendanceRecords.studentId,
      status: attendanceRecords.status,
    })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, sessionId));
  const previousByStudent = new Map(previous.map((p) => [p.studentId, p]));

  let changed = 0;
  const changeRows: (typeof attendanceChanges.$inferInsert)[] = [];

  for (const mark of marks) {
    const before = previousByStudent.get(mark.studentId);

    if (before) {
      if (before.status === mark.status) continue;
      await db
        .update(attendanceRecords)
        .set({
          status: mark.status,
          reason: mark.reason || null,
          minutesLate: mark.minutesLate ?? null,
          updatedAt: new Date(),
        })
        .where(eq(attendanceRecords.id, before.id));
      changeRows.push({
        schoolId,
        recordId: before.id,
        studentId: mark.studentId,
        fromStatus: before.status,
        toStatus: mark.status,
        reason: mark.reason || null,
        changedBy: ctx.user.userId,
      });
      changed++;
    } else {
      await db.insert(attendanceRecords).values({
        schoolId,
        sessionId,
        studentId: mark.studentId,
        date: input.date,
        sectionId: input.sectionId,
        academicYearId,
        termId: term?.id ?? null,
        status: mark.status,
        minutesLate: mark.minutesLate ?? null,
        reason: mark.reason || null,
      });
      changed++;
    }
  }

  if (changeRows.length > 0) {
    await db.insert(attendanceChanges).values(changeRows);
  }

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: wasCreated ? 'attendance.record' : 'attendance.update',
    entityType: 'attendance_session',
    entityId: sessionId,
    summary: `${wasCreated ? 'Recorded' : 'Updated'} attendance for ${section.name} on ${input.date} — ${tally.absentCount} absent, ${tally.lateCount} late`,
    newValue: { ...tally, date: input.date, syncedOffline: input.syncedOffline },
    ipAddress: ctx.ipAddress,
  });

  // Announce to the rest of the system. Notification and at-risk rules react
  // to this rather than being called directly, so attendance stays decoupled.
  await emitEvent(db, schoolId, 'attendance.recorded', {
    sectionId: input.sectionId,
    subjectId: input.sectionSubjectId ?? null,
    date: input.date,
    recordedBy: ctx.user.userId,
    absentStudentIds: marks.filter((m) => m.status === 'absent').map((m) => m.studentId),
    lateStudentIds: marks.filter((m) => m.status === 'late').map((m) => m.studentId),
    totalStudents: marks.length,
  });

  return { sessionId, created: wasCreated, changed };
}

/** Correct one student's mark after the fact. */
export async function correctRecord(
  ctx: AuthContext,
  recordId: string,
  input: CorrectAttendanceInput,
): Promise<void> {
  const { db, schoolId } = ctx;

  const [record] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.schoolId, schoolId), eq(attendanceRecords.id, recordId)))
    .limit(1);
  if (!record) throw new Error('Attendance record not found');

  const permission = await checkAttendancePermission(ctx, {
    sectionId: record.sectionId,
    date: record.date,
  });
  if (!permission.allowed) {
    const error = new Error(permission.reason) as Error & { status?: number };
    error.status = permission.status;
    throw error;
  }

  if (record.status === input.status) return;

  await db
    .update(attendanceRecords)
    .set({
      status: input.status,
      reason: input.reason || null,
      minutesLate: input.minutesLate ?? null,
      updatedAt: new Date(),
    })
    .where(eq(attendanceRecords.id, recordId));

  await db.insert(attendanceChanges).values({
    schoolId,
    recordId,
    studentId: record.studentId,
    fromStatus: record.status,
    toStatus: input.status,
    reason: input.reason || null,
    changedBy: ctx.user.userId,
  });

  // Keep the session tallies honest after a correction.
  await refreshSessionCounts(db, record.sessionId);

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'attendance.update',
    entityType: 'attendance_record',
    entityId: recordId,
    summary: `Changed attendance from ${record.status} to ${input.status} on ${record.date}`,
    previousValue: { status: record.status },
    newValue: { status: input.status },
    reason: input.reason || null,
    ipAddress: ctx.ipAddress,
  });

  await emitEvent(db, schoolId, 'attendance.updated', {
    studentId: record.studentId,
    date: record.date,
    previousStatus: record.status,
    newStatus: input.status,
    changedBy: ctx.user.userId,
  });
}

/** Recompute a session's cached counts from its records. */
export async function refreshSessionCounts(db: Database, sessionId: string): Promise<void> {
  const [row] = await db
    .select({
      total: count(),
      present: sql<number>`sum(case when status = 'present' then 1 else 0 end)::int`,
      absent: sql<number>`sum(case when status = 'absent' then 1 else 0 end)::int`,
      late: sql<number>`sum(case when status = 'late' then 1 else 0 end)::int`,
      excused: sql<number>`sum(case when status in ('excused','sick') then 1 else 0 end)::int`,
    })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, sessionId));

  await db
    .update(attendanceSessions)
    .set({
      totalCount: row?.total ?? 0,
      presentCount: row?.present ?? 0,
      absentCount: row?.absent ?? 0,
      lateCount: row?.late ?? 0,
      excusedCount: row?.excused ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(attendanceSessions.id, sessionId));
}

export type StudentAttendanceSummary = {
  studentId: string;
  studentCode: string;
  givenName: string;
  fatherName: string;
  sectionName: string | null;
  gradeName: string | null;
  totalDays: number;
  presentDays: number;
  absentDays: number;
  lateDays: number;
  excusedDays: number;
  attendancePercent: number;
  consecutiveAbsences: number;
  atRisk: boolean;
};

/**
 * Per-student attendance summary for a date range.
 *
 * Computed in SQL so a whole school can be summarised in one query rather than
 * one per student.
 */
export async function getAttendanceSummary(
  db: Database,
  schoolId: string,
  options: {
    academicYearId: string;
    from?: string;
    to?: string;
    sectionId?: string;
    gradeLevelId?: string;
    termId?: string;
    atRiskOnly?: boolean;
    page?: number;
    pageSize?: number;
    /**
     * Narrows the report to these sections. Applied as a WHERE clause, so a
     * restricted teacher's query never reads other sections' rows. An empty
     * array means "no sections", which correctly yields nothing.
     */
    restrictToSectionIds?: string[];
  },
): Promise<{ rows: StudentAttendanceSummary[]; total: number; threshold: number }> {
  const settings = await getSetting(db, schoolId, 'attendance');
  const threshold = settings.riskThresholdPercent ?? 85;

  const conditions: SQL[] = [
    eq(attendanceRecords.schoolId, schoolId),
    eq(attendanceRecords.academicYearId, options.academicYearId),
  ];
  if (options.from) conditions.push(gte(attendanceRecords.date, options.from));
  if (options.to) conditions.push(lte(attendanceRecords.date, options.to));
  if (options.termId) conditions.push(eq(attendanceRecords.termId, options.termId));
  if (options.sectionId) conditions.push(eq(attendanceRecords.sectionId, options.sectionId));

  const studentConditions: SQL[] = [eq(students.schoolId, schoolId)];
  if (options.gradeLevelId) {
    studentConditions.push(eq(enrollments.gradeLevelId, options.gradeLevelId));
  }

  // Section restriction for teachers who may only see their own classes.
  if (options.restrictToSectionIds) {
    if (options.restrictToSectionIds.length === 0) {
      // No assigned sections must mean no rows, never "everything".
      studentConditions.push(sql`false`);
    } else {
      studentConditions.push(inArray(enrollments.sectionId, options.restrictToSectionIds));
    }
  }

  const presentExpr = sql<number>`sum(case when ${attendanceRecords.status} in ('present','late','excused','sick') then 1 else 0 end)::int`;
  const percentExpr = sql<number>`case when count(${attendanceRecords.id}) = 0 then 100
    else round(100.0 * sum(case when ${attendanceRecords.status} in ('present','late','excused','sick') then 1 else 0 end) / count(${attendanceRecords.id}), 1) end`;

  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;

  const base = db
    .select({
      studentId: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
      totalDays: count(attendanceRecords.id),
      presentDays: sql<number>`sum(case when ${attendanceRecords.status} = 'present' then 1 else 0 end)::int`,
      absentDays: sql<number>`sum(case when ${attendanceRecords.status} = 'absent' then 1 else 0 end)::int`,
      lateDays: sql<number>`sum(case when ${attendanceRecords.status} = 'late' then 1 else 0 end)::int`,
      excusedDays: sql<number>`sum(case when ${attendanceRecords.status} in ('excused','sick') then 1 else 0 end)::int`,
      attendancePercent: percentExpr,
    })
    .from(students)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.studentId, students.id),
        eq(enrollments.academicYearId, options.academicYearId),
        isNull(enrollments.endedOn),
      ),
    )
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .leftJoin(gradeLevels, eq(gradeLevels.id, enrollments.gradeLevelId))
    .leftJoin(attendanceRecords, and(eq(attendanceRecords.studentId, students.id), ...conditions))
    .where(and(...studentConditions, ...(options.sectionId ? [eq(enrollments.sectionId, options.sectionId)] : [])))
    .groupBy(
      students.id,
      students.studentCode,
      students.givenName,
      students.fatherName,
      sections.name,
      gradeLevels.name,
    );

  const all = await base;

  const withRisk = all.map((row) => ({
    ...row,
    attendancePercent: Number(row.attendancePercent ?? 100),
    consecutiveAbsences: 0,
    atRisk: row.totalDays > 0 && Number(row.attendancePercent ?? 100) < threshold,
  }));

  const filtered = options.atRiskOnly ? withRisk.filter((r) => r.atRisk) : withRisk;
  filtered.sort((a, b) => a.attendancePercent - b.attendancePercent);

  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    threshold,
  };
}

/**
 * Students whose recent record trips the school's alert rules.
 *
 * Used by the dashboard and by the automation engine.
 */
export async function getAtRiskStudents(
  db: Database,
  schoolId: string,
  academicYearId: string,
  limit = 20,
) {
  const settings = await getSetting(db, schoolId, 'attendance');
  const threshold = settings.riskThresholdPercent ?? 85;

  const summary = await getAttendanceSummary(db, schoolId, {
    academicYearId,
    atRiskOnly: true,
    pageSize: limit,
  });

  return { students: summary.rows, threshold, total: summary.total };
}

/**
 * Consecutive absences ending on the most recent record, per student.
 * Separated from the summary because it needs ordered scanning.
 */
export async function getConsecutiveAbsences(
  db: Database,
  schoolId: string,
  academicYearId: string,
  minimum: number,
  /** Restricts the scan to these sections; an empty array yields nothing. */
  restrictToSectionIds?: string[],
): Promise<{ studentId: string; givenName: string; fatherName: string; days: number; lastDate: string }[]> {
  if (restrictToSectionIds && restrictToSectionIds.length === 0) return [];

  const rows = await db
    .select({
      studentId: attendanceRecords.studentId,
      date: attendanceRecords.date,
      status: attendanceRecords.status,
      givenName: students.givenName,
      fatherName: students.fatherName,
    })
    .from(attendanceRecords)
    .innerJoin(students, eq(students.id, attendanceRecords.studentId))
    .where(
      and(
        eq(attendanceRecords.schoolId, schoolId),
        eq(attendanceRecords.academicYearId, academicYearId),
        ...(restrictToSectionIds
          ? [inArray(attendanceRecords.sectionId, restrictToSectionIds)]
          : []),
      ),
    )
    .orderBy(asc(attendanceRecords.studentId), desc(attendanceRecords.date));

  const out: { studentId: string; givenName: string; fatherName: string; days: number; lastDate: string }[] = [];
  let currentId: string | null = null;
  let streak = 0;
  let lastDate = '';
  let name = { givenName: '', fatherName: '' };
  let closed = false;

  const flush = () => {
    if (currentId && streak >= minimum) {
      out.push({ studentId: currentId, ...name, days: streak, lastDate });
    }
  };

  for (const row of rows) {
    if (row.studentId !== currentId) {
      flush();
      currentId = row.studentId;
      streak = 0;
      closed = false;
      lastDate = row.date;
      name = { givenName: row.givenName, fatherName: row.fatherName };
    }
    if (closed) continue;
    if (row.status === 'absent') {
      streak++;
    } else {
      // The run ends at the first non-absent day going backwards.
      closed = true;
    }
  }
  flush();

  return out.sort((a, b) => b.days - a.days);
}

/**
 * Registers that were expected but never taken.
 *
 * Excludes weekends (per the school's configured school days) and holidays,
 * so the report only lists genuine omissions.
 */
export async function getMissingRegisters(
  db: Database,
  schoolId: string,
  academicYearId: string,
  options: {
    from: string;
    to: string;
    sectionId?: string;
    /** Restricts to these sections; an empty array yields nothing. */
    restrictToSectionIds?: string[];
  },
): Promise<{ sectionId: string; sectionName: string; gradeName: string; date: string }[]> {
  if (options.restrictToSectionIds && options.restrictToSectionIds.length === 0) return [];

  const settings = await getSetting(db, schoolId, 'attendance');
  const schoolDays = new Set(settings.schoolDays ?? [1, 2, 3, 4, 5]);

  const sectionRows = await db
    .select({ id: sections.id, name: sections.name, gradeName: gradeLevels.name })
    .from(sections)
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(
      and(
        eq(sections.schoolId, schoolId),
        eq(sections.academicYearId, academicYearId),
        eq(sections.isActive, true),
        ...(options.sectionId ? [eq(sections.id, options.sectionId)] : []),
        ...(options.restrictToSectionIds
          ? [inArray(sections.id, options.restrictToSectionIds)]
          : []),
      ),
    );

  const taken = await db
    .select({ sectionId: attendanceSessions.sectionId, date: attendanceSessions.date })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.schoolId, schoolId),
        eq(attendanceSessions.academicYearId, academicYearId),
        gte(attendanceSessions.date, options.from),
        lte(attendanceSessions.date, options.to),
        isNull(attendanceSessions.sectionSubjectId),
      ),
    );
  const takenSet = new Set(taken.map((t) => `${t.sectionId}:${t.date}`));

  const holidays = await db
    .select({ date: attendanceHolidays.date })
    .from(attendanceHolidays)
    .where(
      and(
        eq(attendanceHolidays.schoolId, schoolId),
        eq(attendanceHolidays.academicYearId, academicYearId),
      ),
    );
  const holidaySet = new Set(holidays.map((h) => h.date));

  const missing: { sectionId: string; sectionName: string; gradeName: string; date: string }[] = [];

  for (
    let time = Date.parse(`${options.from}T00:00:00Z`);
    time <= Date.parse(`${options.to}T00:00:00Z`);
    time += 86_400_000
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    const weekday = new Date(time).getUTCDay();
    if (!schoolDays.has(weekday)) continue;
    if (holidaySet.has(date)) continue;

    for (const section of sectionRows) {
      if (!takenSet.has(`${section.id}:${date}`)) {
        missing.push({
          sectionId: section.id,
          sectionName: section.name,
          gradeName: section.gradeName,
          date,
        });
      }
    }
  }

  return missing;
}

/** Today's register-taking progress, for the dashboard. */
export async function getTodayProgress(
  db: Database,
  schoolId: string,
  academicYearId: string,
  date: string,
) {
  const [sectionTotal] = await db
    .select({ total: count() })
    .from(sections)
    .where(
      and(
        eq(sections.schoolId, schoolId),
        eq(sections.academicYearId, academicYearId),
        eq(sections.isActive, true),
      ),
    );

  const [takenRow] = await db
    .select({
      taken: count(),
      absent: sql<number>`coalesce(sum(${attendanceSessions.absentCount}),0)::int`,
      late: sql<number>`coalesce(sum(${attendanceSessions.lateCount}),0)::int`,
      present: sql<number>`coalesce(sum(${attendanceSessions.presentCount}),0)::int`,
      total: sql<number>`coalesce(sum(${attendanceSessions.totalCount}),0)::int`,
    })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.schoolId, schoolId),
        eq(attendanceSessions.academicYearId, academicYearId),
        eq(attendanceSessions.date, date),
        isNull(attendanceSessions.sectionSubjectId),
      ),
    );

  const sectionsTotal = sectionTotal?.total ?? 0;
  const taken = takenRow?.taken ?? 0;
  const marked = takenRow?.total ?? 0;
  const present = takenRow?.present ?? 0;

  return {
    sectionsTotal,
    sectionsTaken: taken,
    sectionsPending: Math.max(0, sectionsTotal - taken),
    studentsMarked: marked,
    absent: takenRow?.absent ?? 0,
    late: takenRow?.late ?? 0,
    present,
    presentPercent: marked > 0 ? Math.round((present / marked) * 1000) / 10 : null,
  };
}

/** Sections the caller may take attendance for, with today's status. */
export async function getTeachableSections(
  ctx: AuthContext,
  academicYearId: string,
  date: string,
) {
  const { db, schoolId } = ctx;
  const canAll = ctx.has('attendance.editAny') || ctx.has('academic.manage');

  const conditions: SQL[] = [
    eq(sections.schoolId, schoolId),
    eq(sections.academicYearId, academicYearId),
    eq(sections.isActive, true),
  ];

  if (!canAll) {
    const ids = ctx.relationships.sectionIds;
    if (ids.length === 0) return [];
    conditions.push(inArray(sections.id, ids));
  }

  const rows = await db
    .select({
      id: sections.id,
      name: sections.name,
      gradeName: gradeLevels.name,
      gradeLevel: gradeLevels.level,
      // Table-qualified deliberately: Drizzle only qualifies an interpolated
      // column when the outer query has a JOIN. Without one it emits a bare
      // "id" that Postgres binds to the subquery's own table, silently
      // yielding 0/null for every row. Explicit qualification is join-proof.
      studentCount: sql<number>`(
        select count(*)::int from ${enrollments} e
        where e.section_id = ${sections}.${sql.identifier('id')} and e.ended_on is null
          and e.academic_year_id = ${academicYearId}
      )`,
      sessionId: sql<string | null>`(
        select s.id from ${attendanceSessions} s
        where s.section_id = ${sections}.${sql.identifier('id')} and s.date = ${date}
          and s.section_subject_id is null limit 1
      )`,
      absentToday: sql<number | null>`(
        select s.absent_count from ${attendanceSessions} s
        where s.section_id = ${sections}.${sql.identifier('id')} and s.date = ${date}
          and s.section_subject_id is null limit 1
      )`,
    })
    .from(sections)
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(and(...conditions))
    .orderBy(asc(gradeLevels.level), asc(sections.name));

  return rows;
}

/** One student's attendance history, for their profile and the parent portal. */
export async function getStudentAttendance(
  db: Database,
  schoolId: string,
  studentId: string,
  options: { academicYearId: string; from?: string; to?: string; limit?: number },
) {
  const conditions: SQL[] = [
    eq(attendanceRecords.schoolId, schoolId),
    eq(attendanceRecords.studentId, studentId),
    eq(attendanceRecords.academicYearId, options.academicYearId),
  ];
  if (options.from) conditions.push(gte(attendanceRecords.date, options.from));
  if (options.to) conditions.push(lte(attendanceRecords.date, options.to));

  const [records, totals] = await Promise.all([
    db
      .select({
        id: attendanceRecords.id,
        date: attendanceRecords.date,
        status: attendanceRecords.status,
        reason: attendanceRecords.reason,
        minutesLate: attendanceRecords.minutesLate,
        subjectName: subjects.name,
      })
      .from(attendanceRecords)
      .leftJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
      .leftJoin(sectionSubjects, eq(sectionSubjects.id, attendanceSessions.sectionSubjectId))
      .leftJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
      .where(and(...conditions))
      .orderBy(desc(attendanceRecords.date))
      .limit(options.limit ?? 60),

    db
      .select({
        total: count(),
        present: sql<number>`sum(case when status = 'present' then 1 else 0 end)::int`,
        absent: sql<number>`sum(case when status = 'absent' then 1 else 0 end)::int`,
        late: sql<number>`sum(case when status = 'late' then 1 else 0 end)::int`,
        excused: sql<number>`sum(case when status in ('excused','sick') then 1 else 0 end)::int`,
      })
      .from(attendanceRecords)
      .where(and(...conditions)),
  ]);

  const t = totals[0];
  const total = t?.total ?? 0;
  const attended = (t?.present ?? 0) + (t?.late ?? 0) + (t?.excused ?? 0);

  return {
    records,
    summary: {
      total,
      present: t?.present ?? 0,
      absent: t?.absent ?? 0,
      late: t?.late ?? 0,
      excused: t?.excused ?? 0,
      percent: total > 0 ? Math.round((attended / total) * 1000) / 10 : null,
    },
  };
}
