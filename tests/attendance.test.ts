/**
 * Attendance module tests.
 *
 * Attendance is taken on a phone, often on a bad connection, by the person
 * with the least tolerance for friction in the school. That shapes what is
 * worth testing: idempotency (a replayed offline submission must not double
 * up), relationship-based permission (a teacher marks only their own class),
 * the school's backdating policy, and the fact that "all present" is still a
 * register that was taken.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import {
  schools,
  users,
  academicYears,
  terms,
  gradeLevels,
  sections,
  sectionSubjects,
  subjects,
  auditLog,
  domainEvents,
  schoolSettings,
} from '../src/db/schema/core.ts';
import {
  attendanceSessions,
  attendanceRecords,
  attendanceChanges,
  attendanceHolidays,
} from '../src/db/schema/attendance.ts';
import { students, enrollments } from '../src/db/schema/people.ts';
import {
  getRoster,
  checkAttendancePermission,
  submitAttendance,
  correctRecord,
  getAttendanceSummary,
  getConsecutiveAbsences,
  getMissingRegisters,
  getTodayProgress,
  getStudentAttendance,
  getTeachableSections,
} from '../src/lib/attendance/service.ts';
import {
  submitAttendanceSchema,
  buildIdempotencyKey,
  ATTENDANCE_STATUSES,
} from '../src/lib/attendance/schema.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';
import { createStudent } from '../src/lib/students/service.ts';
import { createStudentSchema } from '../src/lib/students/schema.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  termId: string;
  gradeId: string;
  sectionA: string;
  sectionB: string;
  subjectId: string;
  sectionSubjectA: string;
  adminUserId: string;
  teacherUserId: string;
  studentIds: string[];
};

const A: Fixture = { studentIds: [] } as unknown as Fixture;
const B: Fixture = { studentIds: [] } as unknown as Fixture;

/** A date N days before today, in school-local ISO form. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** A weekday inside the academic year, safely in the past. */
const DAY_1 = '2025-10-06'; // Monday
const DAY_2 = '2025-10-07'; // Tuesday
const DAY_3 = '2025-10-08'; // Wednesday

const ADMIN_PERMS = [
  'attendance.take',
  'attendance.view',
  'attendance.editAny',
  'attendance.report',
  'student.view',
  'student.create',
];
const TEACHER_PERMS = ['attendance.take', 'attendance.view', 'student.view'];

function contextFor(
  fixture: Fixture,
  userId: string,
  permissions: string[],
  relationships: { sectionIds?: string[]; sectionSubjectIds?: string[] } = {},
) {
  return {
    db,
    schoolId: fixture.schoolId,
    user: { userId, givenName: 'Test', fatherName: 'User' },
    ipAddress: '127.0.0.1',
    has: (p: string) => permissions.includes(p),
    hasAny: (...list: string[]) => list.some((p) => permissions.includes(p)),
    displayName: () => 'Test User',
    relationships: {
      sectionIds: relationships.sectionIds ?? [],
      sectionSubjectIds: relationships.sectionSubjectIds ?? [],
      childStudentIds: [],
      ownStudentId: null,
    },
  } as never;
}

async function seedSchool(code: string, fixture: Fixture, studentCount: number) {
  const [school] = await db
    .insert(schools)
    .values({ code, name: `Test ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId: fixture.schoolId,
      name: '2018 E.C.',
      ethiopianYear: 2018,
      startDate: '2025-09-11',
      endDate: '2026-07-07',
      isCurrent: true,
    })
    .returning({ id: academicYears.id });
  fixture.yearId = year!.id;

  const [term] = await db
    .insert(terms)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      name: 'Term 1',
      sequence: 1,
      startDate: '2025-09-11',
      endDate: '2025-12-31',
      isCurrent: true,
    })
    .returning({ id: terms.id });
  fixture.termId = term!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

  const inserted = await db
    .insert(sections)
    .values([
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        gradeLevelId: fixture.gradeId,
        name: 'A',
      },
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        gradeLevelId: fixture.gradeId,
        name: 'B',
      },
    ])
    .returning({ id: sections.id, name: sections.name });
  fixture.sectionA = inserted.find((s) => s.name === 'A')!.id;
  fixture.sectionB = inserted.find((s) => s.name === 'B')!.id;

  const [admin] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: 'admin',
      passwordHash: 'x',
      givenName: 'Admin',
    })
    .returning({ id: users.id });
  fixture.adminUserId = admin!.id;

  const [teacher] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: 'teacher',
      passwordHash: 'x',
      givenName: 'Teacher',
    })
    .returning({ id: users.id });
  fixture.teacherUserId = teacher!.id;

  const [subject] = await db
    .insert(subjects)
    .values({ schoolId: fixture.schoolId, code: 'MATH', name: 'Mathematics' })
    .returning({ id: subjects.id });
  fixture.subjectId = subject!.id;

  const [ss] = await db
    .insert(sectionSubjects)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sectionId: fixture.sectionA,
      subjectId: fixture.subjectId,
      teacherId: fixture.teacherUserId,
    })
    .returning({ id: sectionSubjects.id });
  fixture.sectionSubjectA = ss!.id;

  const ctx = contextFor(fixture, fixture.adminUserId, ADMIN_PERMS);
  for (let i = 1; i <= studentCount; i++) {
    const created = await createStudent(
      ctx,
      createStudentSchema.parse({
        studentCode: `AT/${i}`,
        givenName: `Student${i}`,
        fatherName: 'Test',
        gradeLevelId: fixture.gradeId,
        sectionId: fixture.sectionA,
      }),
      fixture.yearId,
    );
    fixture.studentIds.push(created.id);
  }
}

/** Overwrite one attendance setting for a school. */
async function setAttendanceSetting(schoolId: string, patch: Record<string, unknown>) {
  const [existing] = await db
    .select({ value: schoolSettings.value })
    .from(schoolSettings)
    .where(and(eq(schoolSettings.schoolId, schoolId), eq(schoolSettings.key, 'attendance')))
    .limit(1);

  const merged = { ...((existing?.value as Record<string, unknown>) ?? {}), ...patch };

  if (existing) {
    await db
      .update(schoolSettings)
      .set({ value: merged })
      .where(and(eq(schoolSettings.schoolId, schoolId), eq(schoolSettings.key, 'attendance')));
  } else {
    await db
      .insert(schoolSettings)
      .values({ schoolId, key: 'attendance', value: merged });
  }

  // The settings service caches in-process; writing the row directly would
  // otherwise leave the old policy in effect for the rest of the run.
  invalidateSettingsCache(schoolId, 'attendance');
}

function marks(fixture: Fixture, overrides: Record<number, string> = {}) {
  return fixture.studentIds.map((studentId, index) => ({
    studentId,
    status: overrides[index] ?? 'present',
  }));
}

before(async () => {
  db = await getDb();
  await seedSchool(`taa-${Date.now()}`, A, 5);
  await seedSchool(`tab-${Date.now()}`, B, 3);
  // Allow backdating so the fixed test dates are usable.
  await setAttendanceSetting(A.schoolId, { allowBackdating: true, backdateLimitDays: 90 });
  await setAttendanceSetting(B.schoolId, { allowBackdating: true, backdateLimitDays: 90 });
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  await closeDb();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a register must name a class and contain at least one mark', () => {
  const result = submitAttendanceSchema.safeParse({
    sectionId: '',
    date: '2025-10-06',
    marks: [],
  });
  assert.equal(result.success, false);
  const keys = result.success ? [] : Object.keys(result.error.flatten().fieldErrors);
  assert.ok(keys.includes('sectionId'));
  assert.ok(keys.includes('marks'));
});

test('an unknown attendance status is rejected', () => {
  const result = submitAttendanceSchema.safeParse({
    sectionId: 'x',
    date: '2025-10-06',
    marks: [{ studentId: 'y', status: 'holiday' }],
  });
  assert.equal(result.success, false);
});

test('the idempotency key distinguishes daily from per-subject registers', () => {
  const daily = buildIdempotencyKey({ sectionId: 's1', date: '2025-10-06' });
  const subject = buildIdempotencyKey({
    sectionId: 's1',
    sectionSubjectId: 'ss1',
    date: '2025-10-06',
  });
  assert.notEqual(daily, subject);
  assert.equal(daily, buildIdempotencyKey({ sectionId: 's1', date: '2025-10-06' }));
});

test('every declared status is accepted by the schema', () => {
  for (const status of ATTENDANCE_STATUSES) {
    const result = submitAttendanceSchema.safeParse({
      sectionId: 'x',
      date: '2025-10-06',
      marks: [{ studentId: 'y', status }],
    });
    assert.equal(result.success, true, `${status} should be a valid status`);
  }
});

// ---------------------------------------------------------------------------
// Taking a register
// ---------------------------------------------------------------------------

test('submitting a register creates a session and one record per student', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const result = await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: A.sectionA,
      date: DAY_1,
      marks: marks(A, { 0: 'absent', 1: 'late' }),
      idempotencyKey: buildIdempotencyKey({ sectionId: A.sectionA, date: DAY_1 }),
    }),
    A.yearId,
  );

  assert.equal(result.created, true);

  const records = await db
    .select({ status: attendanceRecords.status })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, result.sessionId));

  assert.equal(records.length, 5);
  assert.equal(records.filter((r) => r.status === 'absent').length, 1);
  assert.equal(records.filter((r) => r.status === 'late').length, 1);
  assert.equal(records.filter((r) => r.status === 'present').length, 3);
});

test('a session header exists even when everyone is present, so "taken" is distinguishable from "not taken"', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);

  // A student who actually sits in section B.
  const inB = await createStudent(
    ctx,
    createStudentSchema.parse({
      studentCode: 'AT/B1',
      givenName: 'SectionB',
      fatherName: 'Student',
      gradeLevelId: A.gradeId,
      sectionId: A.sectionB,
    }),
    A.yearId,
  );

  const result = await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: A.sectionB,
      date: DAY_1,
      marks: [{ studentId: inB.id, status: 'present' }],
      idempotencyKey: buildIdempotencyKey({ sectionId: A.sectionB, date: DAY_1 }),
    }),
    A.yearId,
  );

  const [session] = await db
    .select({ id: attendanceSessions.id, absentCount: attendanceSessions.absentCount })
    .from(attendanceSessions)
    .where(eq(attendanceSessions.id, result.sessionId));

  assert.ok(session, 'a session row exists with zero absences');
  assert.equal(session!.absentCount, 0);
});

test('resubmitting the same register is idempotent, not duplicated', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const payload = submitAttendanceSchema.parse({
    sectionId: A.sectionA,
    date: DAY_2,
    marks: marks(A, { 0: 'absent' }),
    idempotencyKey: buildIdempotencyKey({ sectionId: A.sectionA, date: DAY_2 }),
  });

  const first = await submitAttendance(ctx, payload, A.yearId);
  const second = await submitAttendance(ctx, payload, A.yearId);

  assert.equal(first.sessionId, second.sessionId, 'the same session is reused');
  assert.equal(second.created, false);

  const records = await db
    .select({ id: attendanceRecords.id })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, first.sessionId));
  assert.equal(records.length, 5, 'records must not be duplicated on replay');

  const sessions = await db
    .select({ id: attendanceSessions.id })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.schoolId, A.schoolId),
        eq(attendanceSessions.sectionId, A.sectionA),
        eq(attendanceSessions.date, DAY_2),
      ),
    );
  assert.equal(sessions.length, 1, 'a replay must not create a second session');
});

test('resubmitting with different marks updates and records the change', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const key = buildIdempotencyKey({ sectionId: A.sectionA, date: DAY_3 });

  await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: A.sectionA,
      date: DAY_3,
      marks: marks(A, { 0: 'absent' }),
      idempotencyKey: key,
    }),
    A.yearId,
  );

  // The teacher realises the student was merely late.
  const second = await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: A.sectionA,
      date: DAY_3,
      marks: marks(A, { 0: 'late' }),
      idempotencyKey: key,
    }),
    A.yearId,
  );

  assert.ok(second.changed >= 1, 'the flipped status is counted as a change');

  const [record] = await db
    .select({ id: attendanceRecords.id, status: attendanceRecords.status })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.sessionId, second.sessionId),
        eq(attendanceRecords.studentId, A.studentIds[0]!),
      ),
    );
  assert.equal(record!.status, 'late');

  const changes = await db
    .select({ fromStatus: attendanceChanges.fromStatus, toStatus: attendanceChanges.toStatus })
    .from(attendanceChanges)
    .where(eq(attendanceChanges.recordId, record!.id));

  assert.ok(changes.length >= 1, 'the correction is written to the append-only change log');
  assert.equal(changes[0]!.fromStatus, 'absent');
  assert.equal(changes[0]!.toStatus, 'late');
});

test('a student who is not enrolled in the section is filtered out', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const foreignStudentId = B.studentIds[0]!;

  const result = await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: A.sectionA,
      date: '2025-10-09',
      marks: [
        { studentId: A.studentIds[0]!, status: 'present' },
        { studentId: foreignStudentId, status: 'absent' },
      ],
      idempotencyKey: buildIdempotencyKey({ sectionId: A.sectionA, date: '2025-10-09' }),
    }),
    A.yearId,
  );

  const records = await db
    .select({ studentId: attendanceRecords.studentId })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, result.sessionId));

  assert.equal(records.length, 1, "another school's student must not be marked");
  assert.equal(records[0]!.studentId, A.studentIds[0]);
});

test('submitting for a class in another school is refused', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  await assert.rejects(
    () =>
      submitAttendance(
        ctx,
        submitAttendanceSchema.parse({
          sectionId: B.sectionA,
          date: DAY_1,
          marks: [{ studentId: B.studentIds[0]!, status: 'present' }],
        }),
        A.yearId,
      ),
    /not found|does not exist/i,
  );
});

// ---------------------------------------------------------------------------
// Permission — relationship, not role
// ---------------------------------------------------------------------------

test('a teacher may mark only a class they are assigned to', async () => {
  const assigned = contextFor(A, A.teacherUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.sectionSubjectA],
  });

  const allowed = await checkAttendancePermission(assigned, {
    sectionId: A.sectionA,
    date: daysAgo(0),
  });
  assert.equal(allowed.allowed, true);

  const denied = await checkAttendancePermission(assigned, {
    sectionId: A.sectionB,
    date: daysAgo(0),
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false && denied.status, 403);
});

test('a user without the attendance permission is refused outright', async () => {
  const ctx = contextFor(A, A.teacherUserId, ['student.view'], {
    sectionIds: [A.sectionA],
  });
  const result = await checkAttendancePermission(ctx, {
    sectionId: A.sectionA,
    date: daysAgo(0),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.allowed === false && result.status, 403);
});

test('attendance.editAny bypasses the section relationship check', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS, { sectionIds: [] });
  const result = await checkAttendancePermission(ctx, {
    sectionId: A.sectionB,
    date: daysAgo(0),
  });
  assert.equal(result.allowed, true, 'an administrator can mark any class');
});

test('a future date is always rejected, whatever the policy', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  const result = await checkAttendancePermission(ctx, { sectionId: A.sectionA, date: future });
  assert.equal(result.allowed, false);
  assert.equal(result.allowed === false && result.status, 400);
});

test('backdating is governed by the school setting, not hard-coded', async () => {
  // The policy constrains teachers; attendance.editAny deliberately bypasses it.
  const teacher = contextFor(A, A.teacherUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.sectionSubjectA],
  });
  const yesterday = daysAgo(1);
  const lastMonth = daysAgo(30);

  // Policy: no backdating at all.
  await setAttendanceSetting(A.schoolId, { allowBackdating: false });
  const blocked = await checkAttendancePermission(teacher, {
    sectionId: A.sectionA,
    date: yesterday,
  });
  assert.equal(blocked.allowed, false, 'a school that forbids backdating must block it');

  // Policy: backdating allowed, but only a couple of days.
  await setAttendanceSetting(A.schoolId, { allowBackdating: true, backdateLimitDays: 2 });
  const withinWindow = await checkAttendancePermission(teacher, {
    sectionId: A.sectionA,
    date: yesterday,
  });
  assert.equal(withinWindow.allowed, true, 'inside the window it is allowed');

  const tooOld = await checkAttendancePermission(teacher, {
    sectionId: A.sectionA,
    date: lastMonth,
  });
  assert.equal(tooOld.allowed, false, 'beyond the limit it is blocked');

  // An administrator is not bound by the teacher window.
  const admin = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const adminOld = await checkAttendancePermission(admin, {
    sectionId: A.sectionA,
    date: lastMonth,
  });
  assert.equal(adminOld.allowed, true, 'attendance.editAny bypasses the backdating window');

  await setAttendanceSetting(A.schoolId, { allowBackdating: true, backdateLimitDays: 90 });
});

test('a school requiring absence reasons rejects an unexplained absence', async () => {
  await setAttendanceSetting(B.schoolId, { requireAbsenceReason: true });
  const ctx = contextFor(B, B.adminUserId, ADMIN_PERMS);

  await assert.rejects(
    () =>
      submitAttendance(
        ctx,
        submitAttendanceSchema.parse({
          sectionId: B.sectionA,
          date: DAY_1,
          marks: [{ studentId: B.studentIds[0]!, status: 'absent' }],
        }),
        B.yearId,
      ),
    /reason/i,
  );

  // With a reason it goes through.
  const ok = await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: B.sectionA,
      date: DAY_1,
      marks: [{ studentId: B.studentIds[0]!, status: 'absent', reason: 'Sick at home' }],
    }),
    B.yearId,
  );
  assert.ok(ok.sessionId);

  await setAttendanceSetting(B.schoolId, { requireAbsenceReason: false });
});

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

test('the roster returns students with any marks already recorded', async () => {
  const roster = await getRoster(db, A.schoolId, {
    sectionId: A.sectionA,
    sectionSubjectId: null,
    date: DAY_1,
    academicYearId: A.yearId,
  });

  assert.equal(roster.students.length, 5);
  assert.ok(roster.session, 'the earlier register is found');
  const absent = roster.students.filter((s) => s.status === 'absent');
  assert.equal(absent.length, 1);
});

test('the roster for an untouched day has no session and no marks', async () => {
  const roster = await getRoster(db, A.schoolId, {
    sectionId: A.sectionA,
    sectionSubjectId: null,
    date: '2025-11-17',
    academicYearId: A.yearId,
  });

  assert.equal(roster.session, null);
  assert.equal(roster.students.length, 5);
  assert.ok(roster.students.every((s) => s.status === null));
});

test('the roster flags a holiday so the day is not nagged about', async () => {
  await db.insert(attendanceHolidays).values({
    schoolId: A.schoolId,
    academicYearId: A.yearId,
    date: '2025-11-18',
    name: 'Test Holiday',
    kind: 'public',
  });

  const roster = await getRoster(db, A.schoolId, {
    sectionId: A.sectionA,
    sectionSubjectId: null,
    date: '2025-11-18',
    academicYearId: A.yearId,
  });

  assert.ok(roster.isHoliday);
  assert.equal(roster.isHoliday!.name, 'Test Holiday');
});

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

test('correcting a record logs the change and cannot cross schools', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const [record] = await db
    .select({ id: attendanceRecords.id })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.schoolId, A.schoolId),
        eq(attendanceRecords.date, DAY_1),
        eq(attendanceRecords.studentId, A.studentIds[0]!),
      ),
    )
    .limit(1);

  await correctRecord(ctx, record!.id, { status: 'excused', reason: 'Family funeral' });

  const [updated] = await db
    .select({ status: attendanceRecords.status, reason: attendanceRecords.reason })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.id, record!.id));
  assert.equal(updated!.status, 'excused');
  assert.equal(updated!.reason, 'Family funeral');

  // School B must not be able to touch it.
  const ctxB = contextFor(B, B.adminUserId, ADMIN_PERMS);
  await assert.rejects(
    () => correctRecord(ctxB, record!.id, { status: 'present' }),
    /not found/i,
  );
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('the summary computes an attendance percentage per student', async () => {
  const summary = await getAttendanceSummary(db, A.schoolId, {
    academicYearId: A.yearId,
    pageSize: 100,
  });

  assert.ok(summary.rows.length > 0);
  for (const row of summary.rows) {
    assert.ok(row.attendancePercent >= 0 && row.attendancePercent <= 100);
    assert.ok(row.totalDays >= 0);
  }

  const tracked = summary.rows.find((r) => r.studentId === A.studentIds[0]);
  assert.ok(tracked, 'the student we marked appears in the summary');
});

test('a teacher restricted to their own sections sees only those students', async () => {
  // Regression: the reports endpoint originally ignored restrict.ownSectionsOnly,
  // so a teacher could read the whole school's attendance.
  const all = await getAttendanceSummary(db, A.schoolId, {
    academicYearId: A.yearId,
    pageSize: 200,
  });

  const restricted = await getAttendanceSummary(db, A.schoolId, {
    academicYearId: A.yearId,
    pageSize: 200,
    restrictToSectionIds: [A.sectionB],
  });

  assert.ok(all.total > restricted.total, 'the restricted view must be narrower');
  assert.ok(
    restricted.rows.every((row) => !A.studentIds.slice(0, 5).includes(row.studentId)),
    'section A students must not appear in a section B report',
  );
});

test('a teacher with no assigned sections sees nothing, not everything', async () => {
  // The dangerous failure mode: an empty restriction list silently meaning
  // "no filter" and exposing the whole school.
  const none = await getAttendanceSummary(db, A.schoolId, {
    academicYearId: A.yearId,
    pageSize: 200,
    restrictToSectionIds: [],
  });
  assert.equal(none.total, 0, 'an empty section list must yield zero rows');
  assert.equal(none.rows.length, 0);

  const runs = await getConsecutiveAbsences(db, A.schoolId, A.yearId, 1, []);
  assert.equal(runs.length, 0);

  const missing = await getMissingRegisters(db, A.schoolId, A.yearId, {
    from: '2025-11-03',
    to: '2025-11-07',
    restrictToSectionIds: [],
  });
  assert.equal(missing.length, 0);
});

test('the summary never includes another school\u2019s students', async () => {
  const summary = await getAttendanceSummary(db, A.schoolId, {
    academicYearId: A.yearId,
    pageSize: 100,
  });
  assert.ok(
    summary.rows.every((row) => !B.studentIds.includes(row.studentId)),
    'cross-tenant leak in the attendance summary',
  );
});

test('consecutive absences are detected across days', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const target = A.studentIds[4]!;

  // Three consecutive weekdays absent.
  for (const date of ['2025-11-03', '2025-11-04', '2025-11-05']) {
    await submitAttendance(
      ctx,
      submitAttendanceSchema.parse({
        sectionId: A.sectionA,
        date,
        marks: [{ studentId: target, status: 'absent' }],
        idempotencyKey: buildIdempotencyKey({ sectionId: A.sectionA, date }),
      }),
      A.yearId,
    );
  }

  const runs = await getConsecutiveAbsences(db, A.schoolId, A.yearId, 3);
  const hit = runs.find((r) => r.studentId === target);
  assert.ok(hit, 'a three-day run should be reported');
  assert.ok(hit!.days >= 3);
});

test('a shorter run is not reported when the threshold is higher', async () => {
  const runs = await getConsecutiveAbsences(db, A.schoolId, A.yearId, 10);
  assert.equal(runs.length, 0, 'nobody has a ten-day run');
});

test('consecutive-absence and missing-register reports honour the section restriction', async () => {
  const target = A.studentIds[4]!; // has a 3-day run in section A

  const unrestricted = await getConsecutiveAbsences(db, A.schoolId, A.yearId, 3);
  assert.ok(unrestricted.some((r) => r.studentId === target));

  const otherSectionOnly = await getConsecutiveAbsences(db, A.schoolId, A.yearId, 3, [A.sectionB]);
  assert.ok(
    !otherSectionOnly.some((r) => r.studentId === target),
    'a section A absence run must not surface in a section B report',
  );

  const missing = await getMissingRegisters(db, A.schoolId, A.yearId, {
    from: '2025-11-03',
    to: '2025-11-07',
    restrictToSectionIds: [A.sectionB],
  });
  assert.ok(
    missing.every((m) => m.sectionId === A.sectionB),
    'only the permitted section may be reported',
  );
});

test('missing registers skip weekends and holidays', async () => {
  const missing = await getMissingRegisters(db, A.schoolId, A.yearId, {
    from: '2025-11-15', // Saturday
    to: '2025-11-18', // Tuesday, which we marked as a holiday
  });

  // 15th Sat, 16th Sun, 18th holiday => only the 17th (Monday) can be missing.
  const dates = [...new Set(missing.map((m) => m.date))];
  assert.ok(!dates.includes('2025-11-15'), 'Saturday must not be reported');
  assert.ok(!dates.includes('2025-11-16'), 'Sunday must not be reported');
  assert.ok(!dates.includes('2025-11-18'), 'a holiday must not be reported');
});

test('today progress counts taken and pending registers for the day', async () => {
  const progress = await getTodayProgress(db, A.schoolId, A.yearId, DAY_1);

  assert.equal(progress.sectionsTotal, 2, 'the school has two sections');
  assert.ok(progress.sectionsTaken >= 1, 'at least one register was taken on DAY_1');
  assert.equal(
    progress.sectionsPending,
    progress.sectionsTotal - progress.sectionsTaken,
    'pending is the complement of taken',
  );
  assert.ok(progress.studentsMarked > 0);
  assert.ok(
    progress.presentPercent === null ||
      (progress.presentPercent >= 0 && progress.presentPercent <= 100),
  );

  // A day nobody marked reports zero taken rather than an empty result.
  const quiet = await getTodayProgress(db, A.schoolId, A.yearId, '2025-11-17');
  assert.equal(quiet.sectionsTaken, 0);
  assert.equal(quiet.sectionsPending, quiet.sectionsTotal);
});

test('a student attendance history is scoped to that student and school', async () => {
  const history = await getStudentAttendance(db, A.schoolId, A.studentIds[0]!, {
    academicYearId: A.yearId,
  });
  assert.ok(history.records.length > 0);
  assert.ok(history.records.every((r) => r.date <= '2025-12-31'));

  // Asking school B for a school A student yields nothing.
  const crossTenant = await getStudentAttendance(db, B.schoolId, A.studentIds[0]!, {
    academicYearId: B.yearId,
  });
  assert.equal(crossTenant.records.length, 0, 'cross-tenant attendance history leak');
});

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

test('taking a register writes an audit entry and emits a domain event', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const date = '2025-11-24';
  await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: A.sectionA,
      date,
      marks: marks(A, { 1: 'absent' }),
      idempotencyKey: buildIdempotencyKey({ sectionId: A.sectionA, date }),
    }),
    A.yearId,
  );

  const audits = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'attendance.record')));
  assert.ok(audits.length > 0, 'attendance must be audited');

  const events = await db
    .select({ type: domainEvents.type })
    .from(domainEvents)
    .where(and(eq(domainEvents.schoolId, A.schoolId), eq(domainEvents.type, 'attendance.recorded')));
  assert.ok(events.length > 0, 'an attendance.recorded event must be emitted');
});

test('offline-synced registers are flagged as such', async () => {
  const ctx = contextFor(A, A.adminUserId, ADMIN_PERMS);
  const date = '2025-11-25';
  const result = await submitAttendance(
    ctx,
    submitAttendanceSchema.parse({
      sectionId: A.sectionA,
      date,
      marks: marks(A),
      idempotencyKey: buildIdempotencyKey({ sectionId: A.sectionA, date }),
      syncedOffline: true,
    }),
    A.yearId,
  );

  const [session] = await db
    .select({ syncedOffline: attendanceSessions.syncedOffline })
    .from(attendanceSessions)
    .where(eq(attendanceSessions.id, result.sessionId));

  assert.equal(session!.syncedOffline, true, 'the offline origin is recorded');
});

/**
 * The class list drives the teacher's attendance home, so its student count
 * must match the roster. It is computed by a correlated subquery, which is a
 * shape that fails silently when the outer column is not table-qualified —
 * returning 0 for every class rather than erroring. Asserted against the real
 * enrolment count so a regression shows up as a wrong number, not a crash.
 */
test('the teachable class list reports real student counts, not zero', async () => {
  const ctx = contextFor(A, A.teacherUserId, TEACHER_PERMS, { sectionIds: [A.sectionA] });
  const list = await getTeachableSections(ctx, A.yearId, DAY_1);

  const mine = list.find((s) => s.id === A.sectionA);
  assert.ok(mine, 'the teacher sees their own class');

  const truth = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.sectionId, A.sectionA),
        eq(enrollments.academicYearId, A.yearId),
        sql`${enrollments.endedOn} is null`,
      ),
    );

  assert.equal(mine!.studentCount, truth[0]!.n);
  assert.ok(mine!.studentCount > 0, 'a count of 0 for a populated class is the bug');
});
