/**
 * Staff attendance and leave.
 *
 * NOT A COPY OF STUDENT ATTENDANCE. A student register is taken per section
 * per day by whoever teaches it; staff attendance is one daily status per
 * person, normally entered by an administrator for everyone at once. They
 * share a shape — a school-local date, a configurable status vocabulary, an
 * upsert so a resubmitted day is a correction rather than a duplicate — but
 * not a table.
 *
 * WORKING DAYS ARE CONFIGURED, NOT ASSUMED. Leave duration is counted from the
 * school's own `operations.workingDays`, so a school that works Saturday
 * mornings and one that does not both get a correct day count. Subtracting two
 * dates would over-count every request that spans a weekend.
 *
 * AN APPROVER CANNOT APPROVE THEMSELVES. Checked here and, for the attribution
 * half of it, by a CHECK in migration 0012. Same rule as grade approval.
 */

import { and, asc, desc, eq, gte, lte, sql, count, inArray, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import {
  staffAttendance,
  leaveTypes,
  leaveRequests,
} from '../../db/schema/operations.ts';
import { staff } from '../../db/schema/people.ts';
import { users, academicYears } from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { getSettings, getSetting } from '../settings/service.ts';
import { todayIso } from '../calendar/ethiopian.ts';
import { OperationsError, notFoundError } from './errors.ts';
import type {
  RecordStaffAttendanceInput,
  LeaveTypeInput,
  CreateLeaveRequestInput,
  DecideLeaveInput,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Working-day arithmetic
// ---------------------------------------------------------------------------

/** Day of week (0 = Sunday) for a YYYY-MM-DD string, computed in UTC. */
function dayOfWeek(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Count working days in an inclusive range, according to the school's own
 * working-day configuration.
 *
 * Exported because the leave form shows the count before submitting, and the
 * two must agree — the server recomputes it regardless of what the client sends.
 */
export function countWorkingDays(start: string, end: string, workingDays: number[]): number {
  if (end < start) return 0;
  const allowed = new Set(workingDays);
  let n = 0;
  let cursor = start;
  // A guard against a pathological range; 3 years of days is far more than any
  // legitimate leave request.
  for (let i = 0; i < 1200 && cursor <= end; i += 1) {
    if (allowed.has(dayOfWeek(cursor))) n += 1;
    cursor = nextDay(cursor);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Staff attendance
// ---------------------------------------------------------------------------

export type StaffAttendanceRow = {
  staffId: string;
  staffCode: string;
  name: string;
  jobTitle: string | null;
  staffType: string;
  status: string | null;
  checkIn: string | null;
  checkOut: string | null;
  minutesLate: number | null;
  reason: string | null;
  recordId: string | null;
};

/**
 * The marking sheet for one day: every active member of staff, with their mark
 * if one exists.
 *
 * A LEFT JOIN, deliberately. Returning only marked people would make it
 * impossible to tell "everyone was present" from "nobody has marked the
 * register" — the same distinction student attendance sessions exist to
 * preserve.
 */
export async function getStaffAttendanceSheet(
  ctx: AuthContext,
  date: string,
): Promise<StaffAttendanceRow[]> {
  const rows = await ctx.db
    .select({
      staffId: staff.id,
      staffCode: staff.staffCode,
      givenName: users.givenName,
      fatherName: users.fatherName,
      jobTitle: staff.jobTitle,
      staffType: staff.staffType,
      status: staffAttendance.status,
      checkIn: staffAttendance.checkIn,
      checkOut: staffAttendance.checkOut,
      minutesLate: staffAttendance.minutesLate,
      reason: staffAttendance.reason,
      recordId: staffAttendance.id,
    })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .leftJoin(
      staffAttendance,
      and(eq(staffAttendance.staffId, staff.id), eq(staffAttendance.date, date)),
    )
    .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.status, 'active')))
    .orderBy(asc(users.givenName), asc(staff.staffCode));

  return rows.map((r) => ({
    staffId: r.staffId,
    staffCode: r.staffCode,
    name: [r.givenName, r.fatherName].filter(Boolean).join(' '),
    jobTitle: r.jobTitle,
    staffType: r.staffType,
    status: r.status,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    minutesLate: r.minutesLate,
    reason: r.reason,
    recordId: r.recordId,
  }));
}

/**
 * Record or correct a day's staff attendance.
 *
 * An upsert on (staff_id, date): submitting the same day twice corrects it
 * rather than failing or duplicating. The unique index is what makes that safe
 * under a double-tapped submit.
 */
export async function recordStaffAttendance(
  ctx: AuthContext,
  input: RecordStaffAttendanceInput,
) {
  await ctx.requireModule('hr');
  ctx.require('staffAttendance.take');

  // Every id must be this school's active staff. Without this check a caller
  // could mark a person at another school by sending their id.
  const ids = [...new Set(input.entries.map((e) => e.staffId))];
  const owned = await ctx.db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.schoolId, ctx.schoolId), inArray(staff.id, ids)));

  if (owned.length !== ids.length) {
    throw notFoundError('Staff member');
  }

  const before = await ctx.db
    .select({ staffId: staffAttendance.staffId, status: staffAttendance.status })
    .from(staffAttendance)
    .where(
      and(eq(staffAttendance.schoolId, ctx.schoolId), eq(staffAttendance.date, input.date)),
    );
  const existing = new Map(before.map((r) => [r.staffId, r.status]));

  await ctx.db
    .insert(staffAttendance)
    .values(
      input.entries.map((e) => ({
        schoolId: ctx.schoolId,
        staffId: e.staffId,
        date: input.date,
        status: e.status,
        checkIn: e.checkIn ?? null,
        checkOut: e.checkOut ?? null,
        minutesLate: e.minutesLate ?? null,
        reason: e.reason ?? null,
        recordedBy: ctx.user.userId,
      })),
    )
    .onConflictDoUpdate({
      target: [staffAttendance.staffId, staffAttendance.date],
      set: {
        status: sql`excluded.status`,
        checkIn: sql`excluded.check_in`,
        checkOut: sql`excluded.check_out`,
        minutesLate: sql`excluded.minutes_late`,
        reason: sql`excluded.reason`,
        recordedBy: sql`excluded.recorded_by`,
        updatedAt: new Date(),
      },
    });

  const corrections = input.entries.filter(
    (e) => existing.has(e.staffId) && existing.get(e.staffId) !== e.status,
  );

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: existing.size > 0 ? 'staffAttendance.update' : 'staffAttendance.record',
    entityType: 'staffAttendance',
    entityId: input.date,
    summary: `${input.entries.length} staff marked for ${input.date}`,
    newValue: {
      date: input.date,
      counts: input.entries.reduce<Record<string, number>>((acc, e) => {
        acc[e.status] = (acc[e.status] ?? 0) + 1;
        return acc;
      }, {}),
      corrections: corrections.length,
    },
    ipAddress: ctx.ipAddress,
  });

  return { marked: input.entries.length, corrections: corrections.length };
}

export type StaffAttendanceSummary = {
  staffId: string;
  name: string;
  staffCode: string;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
  total: number;
  presentPercent: number;
};

/** Per-person totals over a range, for the HR report. */
export async function getStaffAttendanceSummary(
  ctx: AuthContext,
  from: string,
  to: string,
): Promise<StaffAttendanceSummary[]> {
  const rows = await ctx.db
    .select({
      staffId: staff.id,
      staffCode: staff.staffCode,
      givenName: users.givenName,
      fatherName: users.fatherName,
      present: sql<number>`count(*) filter (where ${staffAttendance.status} = 'present')::int`,
      absent: sql<number>`count(*) filter (where ${staffAttendance.status} = 'absent')::int`,
      late: sql<number>`count(*) filter (where ${staffAttendance.status} = 'late')::int`,
      onLeave: sql<number>`count(*) filter (where ${staffAttendance.status} = 'on_leave')::int`,
      total: sql<number>`count(${staffAttendance.id})::int`,
    })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .leftJoin(
      staffAttendance,
      and(
        eq(staffAttendance.staffId, staff.id),
        gte(staffAttendance.date, from),
        lte(staffAttendance.date, to),
      ),
    )
    .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.status, 'active')))
    .groupBy(staff.id, staff.staffCode, users.givenName, users.fatherName)
    .orderBy(asc(users.givenName));

  return rows.map((r) => {
    const total = Number(r.total ?? 0);
    const present = Number(r.present ?? 0) + Number(r.late ?? 0);
    return {
      staffId: r.staffId,
      staffCode: r.staffCode,
      name: [r.givenName, r.fatherName].filter(Boolean).join(' '),
      present: Number(r.present ?? 0),
      absent: Number(r.absent ?? 0),
      late: Number(r.late ?? 0),
      onLeave: Number(r.onLeave ?? 0),
      total,
      // Late still means the person came to work.
      presentPercent: total === 0 ? 0 : Math.round((present / total) * 1000) / 10,
    };
  });
}

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

export async function listLeaveTypes(ctx: AuthContext, includeInactive = false) {
  const conditions: SQL[] = [eq(leaveTypes.schoolId, ctx.schoolId)];
  if (!includeInactive) conditions.push(eq(leaveTypes.active, true));
  return await ctx.db
    .select()
    .from(leaveTypes)
    .where(and(...conditions))
    .orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name));
}

export async function createLeaveType(ctx: AuthContext, input: LeaveTypeInput) {
  await ctx.requireModule('hr');
  ctx.require('leave.configure');

  const [row] = await ctx.db
    .insert(leaveTypes)
    .values({
      schoolId: ctx.schoolId,
      key: input.key,
      name: input.name,
      nameAm: input.nameAm ?? null,
      daysPerYear: input.daysPerYear ?? null,
      paid: input.paid,
      requiresApproval: input.requiresApproval,
      active: input.active,
      sortOrder: input.sortOrder,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'leaveType.create',
    entityType: 'leaveType',
    entityId: row!.id,
    summary: row!.name,
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function updateLeaveType(ctx: AuthContext, typeId: string, input: LeaveTypeInput) {
  await ctx.requireModule('hr');
  ctx.require('leave.configure');

  const [before] = await ctx.db
    .select()
    .from(leaveTypes)
    .where(and(eq(leaveTypes.schoolId, ctx.schoolId), eq(leaveTypes.id, typeId)))
    .limit(1);
  if (!before) throw notFoundError('Leave type');

  const [row] = await ctx.db
    .update(leaveTypes)
    .set({
      key: input.key,
      name: input.name,
      nameAm: input.nameAm ?? null,
      daysPerYear: input.daysPerYear ?? null,
      paid: input.paid,
      requiresApproval: input.requiresApproval,
      active: input.active,
      sortOrder: input.sortOrder,
      updatedAt: new Date(),
    })
    .where(and(eq(leaveTypes.schoolId, ctx.schoolId), eq(leaveTypes.id, typeId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'leaveType.update',
    entityType: 'leaveType',
    entityId: typeId,
    summary: row!.name,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

export type LeaveRow = {
  id: string;
  staffId: string;
  staffName: string;
  staffCode: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  reason: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  createdAt: Date;
};

export async function listLeaveRequests(
  ctx: AuthContext,
  query: {
    status?: string | null;
    staffId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ requests: LeaveRow[]; total: number }> {
  const conditions: SQL[] = [eq(leaveRequests.schoolId, ctx.schoolId)];
  if (query.status) conditions.push(eq(leaveRequests.status, query.status));
  if (query.staffId) conditions.push(eq(leaveRequests.staffId, query.staffId));
  if (query.from) conditions.push(gte(leaveRequests.endDate, query.from));
  if (query.to) conditions.push(lte(leaveRequests.startDate, query.to));

  const where = and(...conditions) as SQL;
  const decider = users;

  const rows = await ctx.db
    .select({
      id: leaveRequests.id,
      staffId: leaveRequests.staffId,
      staffCode: staff.staffCode,
      givenName: sql<string>`requester.given_name`,
      fatherName: sql<string | null>`requester.father_name`,
      leaveTypeName: leaveTypes.name,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      days: leaveRequests.days,
      status: leaveRequests.status,
      reason: leaveRequests.reason,
      decisionNote: leaveRequests.decisionNote,
      decidedAt: leaveRequests.decidedAt,
      deciderGiven: decider.givenName,
      deciderFather: decider.fatherName,
      createdAt: leaveRequests.createdAt,
    })
    .from(leaveRequests)
    .innerJoin(staff, eq(staff.id, leaveRequests.staffId))
    .innerJoin(sql`${users} as requester`, sql`requester.id = ${staff.userId}`)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(decider, eq(decider.id, leaveRequests.decidedBy))
    .where(where)
    .orderBy(desc(leaveRequests.createdAt))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(leaveRequests)
    .where(where);

  return {
    requests: rows.map((r) => ({
      id: r.id,
      staffId: r.staffId,
      staffCode: r.staffCode,
      staffName: [r.givenName, r.fatherName].filter(Boolean).join(' '),
      leaveTypeName: r.leaveTypeName,
      startDate: r.startDate,
      endDate: r.endDate,
      days: r.days,
      status: r.status,
      reason: r.reason,
      decisionNote: r.decisionNote,
      decidedAt: r.decidedAt,
      decidedByName: r.deciderGiven
        ? [r.deciderGiven, r.deciderFather].filter(Boolean).join(' ')
        : null,
      createdAt: r.createdAt,
    })),
    total: totalRow?.total ?? 0,
  };
}

/** The staff record belonging to the signed-in user, if they have one. */
export async function getOwnStaffRecord(ctx: AuthContext) {
  const [row] = await ctx.db
    .select({ id: staff.id, staffCode: staff.staffCode })
    .from(staff)
    .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.userId, ctx.user.userId)))
    .limit(1);
  return row ?? null;
}

export async function createLeaveRequest(ctx: AuthContext, input: CreateLeaveRequestInput) {
  await ctx.requireModule('hr');

  const own = await getOwnStaffRecord(ctx);
  const isOwn = own?.id === input.staffId;

  // Requesting for yourself needs `leave.request`; filing on someone else's
  // behalf is an HR action and needs `leave.approve`.
  if (isOwn) {
    ctx.require('leave.request');
  } else {
    ctx.require('leave.approve');
  }

  const [person] = await ctx.db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.id, input.staffId)))
    .limit(1);
  if (!person) throw notFoundError('Staff member');

  const [type] = await ctx.db
    .select({ id: leaveTypes.id, name: leaveTypes.name })
    .from(leaveTypes)
    .where(
      and(
        eq(leaveTypes.schoolId, ctx.schoolId),
        eq(leaveTypes.id, input.leaveTypeId),
        eq(leaveTypes.active, true),
      ),
    )
    .limit(1);
  if (!type) throw notFoundError('Leave type');

  const { operations } = await getSettings(ctx.db, ctx.schoolId, ['operations']);

  // The server computes the duration. A client-supplied day count would let a
  // person claim two days of leave for a fortnight's absence.
  const days = countWorkingDays(input.startDate, input.endDate, operations.workingDays);
  if (days === 0) {
    throw new OperationsError('That range contains no working days.', 400, {
      startDate: 'Choose a range that includes at least one working day.',
    });
  }

  // Overlapping leave is almost always a double submission.
  const [clash] = await ctx.db
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.schoolId, ctx.schoolId),
        eq(leaveRequests.staffId, input.staffId),
        inArray(leaveRequests.status, ['pending', 'approved']),
        lte(leaveRequests.startDate, input.endDate),
        gte(leaveRequests.endDate, input.startDate),
      ),
    )
    .limit(1);
  if (clash) {
    throw new OperationsError('This person already has leave covering those dates.', 409);
  }

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  const [row] = await ctx.db
    .insert(leaveRequests)
    .values({
      schoolId: ctx.schoolId,
      staffId: input.staffId,
      leaveTypeId: input.leaveTypeId,
      academicYearId: year?.id ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      days,
      reason: input.reason ?? null,
      status: 'pending',
      requestedBy: ctx.user.userId,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'leave.request',
    entityType: 'leaveRequest',
    entityId: row!.id,
    summary: `${type.name}, ${days} day(s) from ${input.startDate}`,
    newValue: { days, startDate: input.startDate, endDate: input.endDate },
    ipAddress: ctx.ipAddress,
  });

  await emitEvent(ctx.db, ctx.schoolId, 'leave.requested', {
    leaveRequestId: row!.id,
    staffId: input.staffId,
    startDate: input.startDate,
    endDate: input.endDate,
    days,
  });

  return row!;
}

/**
 * Approve or reject a request.
 *
 * Approving marks the covered working days as `on_leave` in the attendance
 * table, so the HR report does not later count an approved absence against the
 * person. That write is an upsert for the same reason as the register: the day
 * may already have been marked.
 */
export async function decideLeaveRequest(
  ctx: AuthContext,
  requestId: string,
  input: DecideLeaveInput,
) {
  await ctx.requireModule('hr');
  ctx.require('leave.approve');

  const own = await getOwnStaffRecord(ctx);

  // Read the settings BEFORE opening the transaction.
  //
  // PGlite runs on a single connection, so a query issued against `ctx.db`
  // while a transaction is open on that same connection waits for a
  // transaction that is itself waiting for the query — a deadlock that
  // presents as a request hanging until the client gives up. Anything a
  // transaction needs must be fetched first, or fetched through `tx`.
  const { operations } = await getSettings(ctx.db, ctx.schoolId, ['operations']);
  const workingDays = new Set(operations.workingDays);

  const result = await ctx.db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.schoolId, ctx.schoolId), eq(leaveRequests.id, requestId)))
      .for('update');

    if (!request) throw notFoundError('Leave request');
    if (request.status !== 'pending') {
      throw new OperationsError(`This request has already been ${request.status}.`, 409);
    }
    // Self-approval is the classic hole in an approval workflow.
    if (own && own.id === request.staffId) {
      throw new OperationsError('You cannot decide your own leave request.', 403);
    }

    const [updated] = await tx
      .update(leaveRequests)
      .set({
        status: input.decision,
        decidedBy: ctx.user.userId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(leaveRequests.schoolId, ctx.schoolId), eq(leaveRequests.id, requestId)))
      .returning();

    if (input.decision === 'approved') {
      const allowed = workingDays;
      const marks: { date: string }[] = [];
      let cursor = request.startDate;
      for (let i = 0; i < 1200 && cursor <= request.endDate; i += 1) {
        if (allowed.has(dayOfWeek(cursor))) marks.push({ date: cursor });
        cursor = nextDay(cursor);
      }

      if (marks.length > 0) {
        await tx
          .insert(staffAttendance)
          .values(
            marks.map((m) => ({
              schoolId: ctx.schoolId,
              staffId: request.staffId,
              date: m.date,
              status: 'on_leave',
              leaveRequestId: request.id,
              recordedBy: ctx.user.userId,
            })),
          )
          .onConflictDoUpdate({
            target: [staffAttendance.staffId, staffAttendance.date],
            set: {
              status: sql`excluded.status`,
              leaveRequestId: sql`excluded.leave_request_id`,
              updatedAt: new Date(),
            },
          });
      }
    }

    return updated!;
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: input.decision === 'approved' ? 'leave.approve' : 'leave.reject',
    entityType: 'leaveRequest',
    entityId: requestId,
    summary: `${input.decision} — ${result.days} day(s) from ${result.startDate}`,
    reason: input.note ?? null,
    newValue: { status: input.decision },
    ipAddress: ctx.ipAddress,
  });

  await emitEvent(ctx.db, ctx.schoolId, 'leave.decided', {
    leaveRequestId: requestId,
    staffId: result.staffId,
    status: input.decision,
    decidedBy: ctx.user.userId,
  });

  return result;
}

/** Withdraw a request. Only the requester, and only while it is pending. */
export async function cancelLeaveRequest(ctx: AuthContext, requestId: string) {
  await ctx.requireModule('hr');

  const own = await getOwnStaffRecord(ctx);

  const [request] = await ctx.db
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.schoolId, ctx.schoolId), eq(leaveRequests.id, requestId)))
    .limit(1);
  if (!request) throw notFoundError('Leave request');

  const isOwn = own?.id === request.staffId;
  if (!isOwn) ctx.require('leave.approve');
  else ctx.require('leave.request');

  if (request.status !== 'pending') {
    throw new OperationsError(`This request has already been ${request.status}.`, 409);
  }

  const [updated] = await ctx.db
    .update(leaveRequests)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(leaveRequests.schoolId, ctx.schoolId), eq(leaveRequests.id, requestId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'leave.cancel',
    entityType: 'leaveRequest',
    entityId: requestId,
    summary: 'Request withdrawn',
    ipAddress: ctx.ipAddress,
  });

  return updated!;
}

/**
 * Days of each leave type a person has already taken this academic year.
 * Used by the request form to show the balance against `daysPerYear`.
 */
export async function getLeaveBalance(ctx: AuthContext, staffId: string) {
  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  const rows = await ctx.db
    .select({
      leaveTypeId: leaveTypes.id,
      name: leaveTypes.name,
      daysPerYear: leaveTypes.daysPerYear,
      taken: sql<number>`coalesce(sum(${leaveRequests.days}) filter (
        where ${leaveRequests.status} = 'approved'
      ), 0)::int`,
      pending: sql<number>`coalesce(sum(${leaveRequests.days}) filter (
        where ${leaveRequests.status} = 'pending'
      ), 0)::int`,
    })
    .from(leaveTypes)
    .leftJoin(
      leaveRequests,
      and(
        eq(leaveRequests.leaveTypeId, leaveTypes.id),
        eq(leaveRequests.staffId, staffId),
        year ? eq(leaveRequests.academicYearId, year.id) : sql`true`,
      ),
    )
    .where(and(eq(leaveTypes.schoolId, ctx.schoolId), eq(leaveTypes.active, true)))
    .groupBy(leaveTypes.id, leaveTypes.name, leaveTypes.daysPerYear, leaveTypes.sortOrder)
    .orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name));

  return rows.map((r) => ({
    leaveTypeId: r.leaveTypeId,
    name: r.name,
    daysPerYear: r.daysPerYear,
    taken: Number(r.taken ?? 0),
    pending: Number(r.pending ?? 0),
    remaining:
      r.daysPerYear === null ? null : r.daysPerYear - Number(r.taken ?? 0) - Number(r.pending ?? 0),
  }));
}

/** Convenience for the "who is off today?" panel on the dashboard. */
export async function getWhoIsOut(ctx: AuthContext, date?: string) {
  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const day = date ?? todayIso(locale.timezone);

  return await ctx.db
    .select({
      staffId: staff.id,
      name: sql<string>`${users.givenName} || coalesce(' ' || ${users.fatherName}, '')`,
      staffCode: staff.staffCode,
      status: staffAttendance.status,
      reason: staffAttendance.reason,
    })
    .from(staffAttendance)
    .innerJoin(staff, eq(staff.id, staffAttendance.staffId))
    .innerJoin(users, eq(users.id, staff.userId))
    .where(
      and(
        eq(staffAttendance.schoolId, ctx.schoolId),
        eq(staffAttendance.date, day),
        inArray(staffAttendance.status, ['absent', 'on_leave']),
      ),
    )
    .orderBy(asc(users.givenName));
}
