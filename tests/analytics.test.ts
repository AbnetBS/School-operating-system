/**
 * Group 9 analytics tests.
 *
 * Two complete schools are built with deliberately different data, then every
 * aggregate is asserted against numbers computed by hand from that fixture.
 * A test that only checked "returns an array" would pass against a query that
 * had lost its tenant filter, which is the exact failure this group is most
 * exposed to.
 *
 * The fixture is arithmetically small on purpose — 4 pupils, 10 attendance
 * days — so every expected figure in this file can be verified by reading the
 * seed function rather than trusting the code under test.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import {
  schools,
  users,
  academicYears,
  terms,
  gradeLevels,
  sections,
  subjects,
  sectionSubjects,
  schoolSettings,
} from '../src/db/schema/core.ts';
import { students, enrollments, staff, guardians } from '../src/db/schema/people.ts';
import { attendanceRecords, attendanceSessions } from '../src/db/schema/attendance.ts';
import { assessments, marks, subjectResults, termResults } from '../src/db/schema/academics.ts';
import { AuthError, type AuthContext } from '../src/lib/auth/context.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';
import { getRiskReport, getStudentRisk } from '../src/lib/analytics/risk.ts';
import {
  getSubjectPerformance,
  getMarksPipeline,
  getStudentTrends,
  getTermContext,
  getSubjectRanking,
} from '../src/lib/analytics/academic.ts';
import { globalSearch, MIN_QUERY_LENGTH } from '../src/lib/analytics/search.ts';
import { getTeacherCompletion } from '../src/lib/analytics/teachers.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  term1Id: string;
  term2Id: string;
  gradeId: string;
  sectionAId: string;
  sectionBId: string;
  subjectId: string;
  sectionSubjectAId: string;
  sectionSubjectBId: string;
  /** A pupil in section B whose only marks are unapproved. */
  draftPupilId: string;
  teacherUserId: string;
  /** Four pupils in section A with known attendance and results. */
  pupils: { id: string; code: string; name: string }[];
};

const A = {} as Fixture;
const B = {} as Fixture;
const stamp = Date.now();

function makeContext(
  fixture: Fixture,
  permissions: string[],
  options: { sectionIds?: string[]; modules?: Record<string, boolean> } = {},
): AuthContext {
  const set = new Set(permissions);
  return {
    db,
    user: { userId: fixture.teacherUserId, schoolId: fixture.schoolId, username: 'test' },
    schoolId: fixture.schoolId,
    permissions: set,
    roleKeys: ['tester'],
    relationships: {
      sectionIds: options.sectionIds ?? [],
      sectionSubjectIds: [],
      childStudentIds: [],
      ownStudentId: null,
      guardianId: null,
    },
    locale: 'en',
    ipAddress: '127.0.0.1',
    has: (p: string) => set.has(p),
    hasAny: (...ps: string[]) => ps.some((p) => set.has(p)),
    require(p: string) {
      if (!set.has(p)) throw new AuthError(`Missing permission: ${p}`, 403);
    },
    requireAny(...ps: string[]) {
      if (!ps.some((p) => set.has(p))) throw new AuthError('Missing permission', 403);
    },
    async requireModule() {},
    async requireStudentAccess() {},
    async canViewStudent() {
      return true;
    },
    requireSectionAccess() {},
    displayName: () => 'Tester',
  } as unknown as AuthContext;
}

/**
 * Builds one school.
 *
 * Section A gets four pupils with hand-chosen attendance and marks:
 *
 *   pupil 0 "Dawit"   — 10 days, 10 present            → 100%, avg 80
 *   pupil 1 "Hanna"   — 10 days,  5 present            →  50%, avg 40 (was 70)
 *   pupil 2 "Yonas"   — 10 days,  9 present            →  90%, avg 65
 *   pupil 3 "Marta"   — no attendance, no results      →  null
 *
 * Those figures drive every assertion below.
 */
async function seed(fixture: Fixture, code: string, name: string) {
  const [school] = await db
    .insert(schools)
    .values({ code, name, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  await db.insert(schoolSettings).values([
    {
      schoolId: fixture.schoolId,
      key: 'modules',
      value: { library: true, fees: true, documents: true, transport: false, inventory: false },
    },
    {
      schoolId: fixture.schoolId,
      key: 'risk',
      value: {
        enabled: true,
        attendanceThresholdPercent: 85,
        attendanceWeight: 30,
        consecutiveAbsenceDays: 3,
        consecutiveAbsenceWeight: 25,
        academicThresholdPercent: 50,
        academicWeight: 25,
        declinePoints: 15,
        declineWeight: 20,
        financeEnabled: false,
        attentionScore: 40,
      },
    },
  ]);

  const [teacher] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: `teacher-${code}`,
      passwordHash: 'x',
      givenName: 'Almaz',
      fatherName: 'Tesfaye',
    })
    .returning({ id: users.id });
  fixture.teacherUserId = teacher!.id;

  await db.insert(staff).values({
    schoolId: fixture.schoolId,
    userId: teacher!.id,
    staffCode: `STF-${code}`,
    staffType: 'teacher',
    status: 'active',
  });

  await db.insert(guardians).values({
    schoolId: fixture.schoolId,
    givenName: 'Tigist',
    fatherName: 'Bekele',
    phone: `+2519${String(stamp).slice(-8)}`,
  });

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

  const [t1] = await db
    .insert(terms)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sequence: 1,
      name: 'Term 1',
      startDate: '2025-09-11',
      endDate: '2025-12-20',
      isCurrent: false,
    })
    .returning({ id: terms.id });
  fixture.term1Id = t1!.id;

  const [t2] = await db
    .insert(terms)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sequence: 2,
      name: 'Term 2',
      startDate: '2026-01-05',
      endDate: '2026-04-10',
      isCurrent: true,
    })
    .returning({ id: terms.id });
  fixture.term2Id = t2!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

  const [sectionA] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: 'A',
      classTeacherId: teacher!.id,
    })
    .returning({ id: sections.id });
  fixture.sectionAId = sectionA!.id;

  const [sectionB] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: 'B',
    })
    .returning({ id: sections.id });
  fixture.sectionBId = sectionB!.id;

  const [subject] = await db
    .insert(subjects)
    .values({
      schoolId: fixture.schoolId,
      name: 'Mathematics',
      code: `MATH-${code}`,
      isActive: true,
    })
    .returning({ id: subjects.id });
  fixture.subjectId = subject!.id;

  const [ssA] = await db
    .insert(sectionSubjects)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sectionId: fixture.sectionAId,
      subjectId: fixture.subjectId,
      teacherId: teacher!.id,
    })
    .returning({ id: sectionSubjects.id });
  fixture.sectionSubjectAId = ssA!.id;

  // Section B teaches the same subject but has no teacher and no marks —
  // it must show up as a gap, not disappear.
  const [ssB] = await db
    .insert(sectionSubjects)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sectionId: fixture.sectionBId,
      subjectId: fixture.subjectId,
      teacherId: null,
    })
    .returning({ id: sectionSubjects.id });
  fixture.sectionSubjectBId = ssB!.id;

  const names = ['Dawit', 'Hanna', 'Yonas', 'Marta'];
  fixture.pupils = [];
  for (let i = 0; i < names.length; i++) {
    const [pupil] = await db
      .insert(students)
      .values({
        schoolId: fixture.schoolId,
        studentCode: `${code}/00${i + 1}`,
        givenName: names[i]!,
        fatherName: 'Getachew',
        gender: i % 2 === 0 ? 'male' : 'female',
        status: 'active',
      })
      .returning({ id: students.id });
    fixture.pupils.push({ id: pupil!.id, code: `${code}/00${i + 1}`, name: names[i]! });

    await db.insert(enrollments).values({
      schoolId: fixture.schoolId,
      studentId: pupil!.id,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      sectionId: fixture.sectionAId,
      status: 'enrolled',
      enrolledOn: '2025-09-11',
    });
  }

  // ---- attendance: 10 school days ----------------------------------------
  const days = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 5).padStart(2, '0')}`);
  const presentCounts = [10, 5, 9]; // pupil 3 (Marta) has none at all

  for (const [dayIndex, date] of days.entries()) {
    const [session] = await db
      .insert(attendanceSessions)
      .values({
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        termId: fixture.term2Id,
        sectionId: fixture.sectionAId,
        date,
        takenBy: teacher!.id,
      })
      .returning({ id: attendanceSessions.id });

    for (let p = 0; p < 3; p++) {
      // Hanna's absences are the LAST five days, giving a run of 5 that the
      // consecutive-absence rule must find.
      let status = 'present';
      if (p === 1 && dayIndex >= 5) status = 'absent';
      if (p === 2 && dayIndex === 0) status = 'absent';

      await db.insert(attendanceRecords).values({
        schoolId: fixture.schoolId,
        sessionId: session!.id,
        academicYearId: fixture.yearId,
        termId: fixture.term2Id,
        sectionId: fixture.sectionAId,
        studentId: fixture.pupils[p]!.id,
        date,
        status,
      });
    }
  }
  void presentCounts;

  // ---- results ------------------------------------------------------------
  // An approved assessment, so approved-only analytics can see the marks.
  const [approved] = await db
    .insert(assessments)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      termId: fixture.term2Id,
      sectionSubjectId: fixture.sectionSubjectAId,
      componentKey: 'test',
      instance: 1,
      title: 'Mid-term test',
      maxMark: 100,
      status: 'approved',
    })
    .returning({ id: assessments.id });

  // A draft assessment with NO marks at all: four missing cells, and it must
  // be excluded from approved-only averages.
  await db.insert(assessments).values({
    schoolId: fixture.schoolId,
    academicYearId: fixture.yearId,
    termId: fixture.term2Id,
    sectionSubjectId: fixture.sectionSubjectAId,
    componentKey: 'quiz',
    instance: 1,
    title: 'Quiz 1',
    maxMark: 20,
    status: 'draft',
  });

  // A submitted assessment awaiting approval.
  await db.insert(assessments).values({
    schoolId: fixture.schoolId,
    academicYearId: fixture.yearId,
    termId: fixture.term2Id,
    sectionSubjectId: fixture.sectionSubjectAId,
    componentKey: 'quiz',
    instance: 2,
    title: 'Quiz 2',
    maxMark: 20,
    status: 'submitted',
  });

  const currentAverages = [80, 40, 65];
  const previousAverages = [78, 70, 66];

  for (let p = 0; p < 3; p++) {
    await db.insert(marks).values({
      schoolId: fixture.schoolId,
      assessmentId: approved!.id,
      studentId: fixture.pupils[p]!.id,
      mark: currentAverages[p]!,
      enteredBy: teacher!.id,
    });

    await db.insert(subjectResults).values({
      schoolId: fixture.schoolId,
      studentId: fixture.pupils[p]!.id,
      termId: fixture.term2Id,
      sectionSubjectId: fixture.sectionSubjectAId,
      subjectId: fixture.subjectId,
      percentage: currentAverages[p]!,
      isPass: currentAverages[p]! >= 50,
      isComplete: true,
    });

    await db.insert(termResults).values({
      schoolId: fixture.schoolId,
      studentId: fixture.pupils[p]!.id,
      termId: fixture.term2Id,
      sectionId: fixture.sectionAId,
      average: currentAverages[p]!,
      totalSubjects: 1,
      passedSubjects: currentAverages[p]! >= 50 ? 1 : 0,
      failedSubjects: currentAverages[p]! >= 50 ? 0 : 1,
    });

    await db.insert(termResults).values({
      schoolId: fixture.schoolId,
      studentId: fixture.pupils[p]!.id,
      termId: fixture.term1Id,
      sectionId: fixture.sectionAId,
      average: previousAverages[p]!,
      totalSubjects: 1,
      passedSubjects: 1,
      failedSubjects: 0,
    });
  }

  // ---- section B: a result backed ONLY by an unapproved assessment --------
  // This is what makes the "approved results only" rule testable. Section A
  // has an approved assessment, so a query that ignored approval would still
  // look right there. Here, if approval is ignored, an average appears for a
  // class whose marks no one has signed off.
  const [draftPupil] = await db
    .insert(students)
    .values({
      schoolId: fixture.schoolId,
      studentCode: `${code}/010`,
      givenName: 'Selam',
      fatherName: 'Girma',
      gender: 'female',
      status: 'active',
    })
    .returning({ id: students.id });
  fixture.draftPupilId = draftPupil!.id;

  await db.insert(enrollments).values({
    schoolId: fixture.schoolId,
    studentId: draftPupil!.id,
    academicYearId: fixture.yearId,
    gradeLevelId: fixture.gradeId,
    sectionId: fixture.sectionBId,
    status: 'enrolled',
    enrolledOn: '2025-09-11',
  });

  await db.insert(assessments).values({
    schoolId: fixture.schoolId,
    academicYearId: fixture.yearId,
    termId: fixture.term2Id,
    sectionSubjectId: fixture.sectionSubjectBId,
    componentKey: 'test',
    instance: 1,
    title: 'Unapproved test',
    maxMark: 100,
    status: 'draft',
  });

  await db.insert(subjectResults).values({
    schoolId: fixture.schoolId,
    studentId: draftPupil!.id,
    termId: fixture.term2Id,
    sectionSubjectId: fixture.sectionSubjectBId,
    subjectId: fixture.subjectId,
    percentage: 33,
    isPass: false,
    isComplete: false,
  });
}

before(async () => {
  db = await getDb();
  await seed(A, `an-a-${stamp}`, 'Analytics School A');
  await seed(B, `an-b-${stamp}`, 'Analytics School B');
  invalidateSettingsCache();
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  invalidateSettingsCache();
  await closeDb();
});

// ---------------------------------------------------------------------------
// Risk: explainable, configurable, never a bare score
// ---------------------------------------------------------------------------

test('risk report flags the low-attendance pupil with a named, quantified signal', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    previousTermId: A.term1Id,
  });

  const hanna = report.students.find((s) => s.givenName === 'Hanna');
  assert.ok(hanna, 'Hanna is at 50% attendance and must be listed');

  const attendance = hanna.signals.find((s) => s.key === 'attendance');
  assert.ok(attendance, 'the reason must be stated, not implied by a score');
  assert.equal(attendance.value, 50, 'the pupil’s real figure is shown');
  assert.equal(attendance.threshold, 85, 'the configured threshold is shown beside it');
});

test('every listed pupil carries at least one signal — no unexplained entries', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    previousTermId: A.term1Id,
  });

  for (const student of report.students) {
    assert.ok(
      student.signals.length > 0,
      `${student.givenName} appears with no explanation, which is exactly what the spec forbids`,
    );
    assert.equal(
      student.score,
      student.signals.reduce((sum, s) => sum + s.weight, 0),
      'the score must equal the sum of the visible signals, or it is a black box',
    );
  }
});

test('a pupil with a good record is not flagged', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    previousTermId: A.term1Id,
  });
  assert.equal(
    report.students.find((s) => s.givenName === 'Dawit'),
    undefined,
    'Dawit is at 100% attendance with a rising average',
  );
});

test('the consecutive-absence rule finds Hanna’s run of five', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    previousTermId: A.term1Id,
  });
  const hanna = report.students.find((s) => s.givenName === 'Hanna')!;
  const run = hanna.signals.find((s) => s.key === 'consecutiveAbsence');
  assert.ok(run, 'five absences in a row must raise the consecutive signal');
  assert.equal(run.value, 5);
});

test('the decline rule fires on a 30-point fall and not on a 1-point one', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    previousTermId: A.term1Id,
    includeAll: true,
  });

  const hanna = report.students.find((s) => s.givenName === 'Hanna')!;
  assert.ok(
    hanna.signals.some((s) => s.key === 'decline'),
    'Hanna fell 70 → 40, well past the 15-point threshold',
  );

  const yonas = report.students.find((s) => s.givenName === 'Yonas');
  assert.equal(
    yonas?.signals.some((s) => s.key === 'decline') ?? false,
    false,
    'Yonas fell 66 → 65, which is inside normal variation',
  );
});

test('raising the threshold in settings changes who is listed — nothing is hard-coded', async () => {
  await db
    .update(schoolSettings)
    .set({ value: { enabled: true, attendanceThresholdPercent: 95, attentionScore: 10 } })
    .where(eq(schoolSettings.schoolId, A.schoolId));
  invalidateSettingsCache();

  const report = await getRiskReport(db, A.schoolId, A.yearId, { termId: A.term2Id });
  const yonas = report.students.find((s) => s.givenName === 'Yonas');
  assert.ok(yonas, 'at a 95% threshold, Yonas (90%) is now below it');

  // Restore for the remaining tests.
  await db
    .update(schoolSettings)
    .set({
      value: {
        enabled: true,
        attendanceThresholdPercent: 85,
        attendanceWeight: 30,
        consecutiveAbsenceDays: 3,
        consecutiveAbsenceWeight: 25,
        academicThresholdPercent: 50,
        academicWeight: 25,
        declinePoints: 15,
        declineWeight: 20,
        financeEnabled: false,
        attentionScore: 40,
      },
    })
    .where(eq(schoolSettings.schoolId, A.schoolId));
  invalidateSettingsCache();
});

test('disabling the feature returns nothing at all', async () => {
  await db
    .update(schoolSettings)
    .set({ value: { enabled: false } })
    .where(eq(schoolSettings.schoolId, B.schoolId));
  invalidateSettingsCache();

  const report = await getRiskReport(db, B.schoolId, B.yearId, { termId: B.term2Id });
  assert.equal(report.disabled, true);
  assert.equal(report.students.length, 0);
  assert.equal(report.total, 0);
});

test('a pupil with no attendance and no marks raises no signals', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    includeAll: true,
  });
  const marta = report.students.find((s) => s.givenName === 'Marta');
  assert.equal(
    marta,
    undefined,
    'absence of data is not evidence of risk; Marta must not be flagged',
  );
});

test('risk never leaks across schools', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    includeAll: true,
  });
  const foreign = B.pupils.map((p) => p.id);
  for (const student of report.students) {
    assert.ok(
      !foreign.includes(student.studentId),
      'school A’s risk list contained a pupil from school B',
    );
  }
});

test('risk is scoped by school, not merely by academic year', async () => {
  // School A's own year id is passed while asking for school B. If the roster
  // query leaned on the year join for isolation instead of filtering
  // school_id, this would return school A's pupils under school B's identity.
  const crossed = await getRiskReport(db, B.schoolId, A.yearId, {
    termId: A.term2Id,
    includeAll: true,
  });
  assert.equal(
    crossed.students.length,
    0,
    'a mismatched school/year pair must yield nothing, never another school’s pupils',
  );

  // And the reverse: school B's year queried as school A.
  const reversed = await getRiskReport(db, A.schoolId, B.yearId, {
    termId: B.term2Id,
    includeAll: true,
  });
  assert.equal(reversed.students.length, 0);
});

test('a section-restricted teacher with no sections sees nobody', async () => {
  const report = await getRiskReport(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    restrictToSectionIds: [],
    includeAll: true,
  });
  assert.equal(report.students.length, 0, 'an empty restriction must mean none, never all');
});

test('a single-pupil lookup cannot reach another school', async () => {
  const foreign = await getStudentRisk(db, A.schoolId, A.yearId, B.pupils[1]!.id, {
    termId: A.term2Id,
  });
  assert.equal(foreign, null, 'a forged student id from another school must return nothing');
});

// ---------------------------------------------------------------------------
// Academic intelligence
// ---------------------------------------------------------------------------

test('subject performance reports the real average of approved marks', async () => {
  const { rows, basis } = await getSubjectPerformance(db, A.schoolId, A.term2Id);
  assert.equal(basis, 'approved');

  const sectionA = rows.find((r) => r.sectionId === A.sectionAId);
  assert.ok(sectionA);
  // (80 + 40 + 65) / 3 = 61.666… → 61.7
  assert.equal(sectionA.averagePercent, 61.7);
  assert.equal(sectionA.passCount, 2, 'Dawit and Yonas passed');
  assert.equal(sectionA.failCount, 1, 'Hanna did not');
  assert.equal(sectionA.studentCount, 4, 'the roll is four, including the unmarked pupil');
  assert.equal(sectionA.missingResults, 1, 'Marta has no result yet');
});

test('a class-subject with no approved marks still appears, as a gap', async () => {
  const { rows } = await getSubjectPerformance(db, A.schoolId, A.term2Id);
  const sectionB = rows.find((r) => r.sectionId === A.sectionBId);
  assert.ok(sectionB, 'a subject nobody has marked must not vanish from the report');
  assert.equal(sectionB.teacherName, null);
  assert.equal(
    sectionB.averagePercent,
    null,
    'section B’s only result comes from a DRAFT assessment; official analytics must not report it',
  );
  assert.equal(sectionB.missingResults, 1, 'its one pupil is still awaiting an official result');
});

test('unapproved marks are reported only when explicitly asked for', async () => {
  // The same class, the same term, the same data — the only difference is the
  // basis. This is what proves the approved-only rule is real rather than an
  // accident of the fixture.
  const official = await getSubjectPerformance(db, A.schoolId, A.term2Id, { basis: 'approved' });
  const provisional = await getSubjectPerformance(db, A.schoolId, A.term2Id, { basis: 'all' });

  assert.equal(official.basis, 'approved');
  assert.equal(provisional.basis, 'all');

  assert.equal(
    official.rows.find((r) => r.sectionId === A.sectionBId)!.averagePercent,
    null,
  );
  assert.equal(
    provisional.rows.find((r) => r.sectionId === A.sectionBId)!.averagePercent,
    33,
    'the draft mark is visible only on an explicitly provisional view',
  );
});

test('subject performance is scoped to the school', async () => {
  const { rows } = await getSubjectPerformance(db, A.schoolId, A.term2Id);
  const foreign = [B.sectionAId, B.sectionBId];
  assert.ok(
    rows.every((r) => !foreign.includes(r.sectionId)),
    'school A’s academic report included school B’s classes',
  );
});

test('a restricted teacher sees only their own section’s performance', async () => {
  const { rows } = await getSubjectPerformance(db, A.schoolId, A.term2Id, {
    restrictToSectionIds: [A.sectionAId],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sectionId, A.sectionAId);
});

test('the marks pipeline counts what is missing and what awaits approval', async () => {
  const pipeline = await getMarksPipeline(db, A.schoolId, A.term2Id);

  assert.equal(pipeline.approved, 1, 'the mid-term test');
  assert.equal(pipeline.pendingApproval, 1, 'Quiz 2 is submitted and waiting on a human');
  assert.equal(pipeline.draft, 2, 'Quiz 1 in section A and the unapproved test in section B');

  // Section A (roll 4): approved test 3 marked → 1 missing; Quiz 1 → 4;
  // Quiz 2 → 4. Section B (roll 1): unapproved test, 0 marked → 1.
  assert.equal(pipeline.missingMarks, 10);
  assert.equal(pipeline.incompleteAssessments, 4);
});

test('student trends compute the change between two real terms', async () => {
  const trends = await getStudentTrends(db, A.schoolId, A.term2Id, A.term1Id);
  const hanna = trends.find((t) => t.givenName === 'Hanna')!;
  assert.equal(hanna.currentAverage, 40);
  assert.equal(hanna.previousAverage, 70);
  assert.equal(hanna.changePoints, -30);

  const dawit = trends.find((t) => t.givenName === 'Dawit')!;
  assert.equal(dawit.changePoints, 2, '78 → 80 is a two-point improvement');
});

test('with no previous term, no change is invented', async () => {
  const trends = await getStudentTrends(db, A.schoolId, A.term2Id, null);
  assert.ok(trends.length > 0);
  assert.ok(
    trends.every((t) => t.changePoints === null && t.previousAverage === null),
    'a school in its first term must show no comparison rather than a fabricated baseline',
  );
});

test('the decline filter returns only genuine falls', async () => {
  const declining = await getStudentTrends(db, A.schoolId, A.term2Id, A.term1Id, {
    minDeclinePoints: 15,
  });
  assert.equal(declining.length, 1);
  assert.equal(declining[0]!.givenName, 'Hanna');
});

test('term context finds the current term and the one before it', async () => {
  const context = await getTermContext(db, A.schoolId, A.yearId, '2026-02-01');
  assert.equal(context.currentTermId, A.term2Id);
  assert.equal(context.currentTermName, 'Term 2');
  assert.equal(context.previousTermId, A.term1Id);
});

test('subject ranking is school-scoped and ordered', async () => {
  const ranking = await getSubjectRanking(db, A.schoolId, A.term2Id);
  assert.equal(ranking.length, 1);
  assert.equal(ranking[0]!.subjectName, 'Mathematics');
  // Four results across both sections: 80, 40, 65 and section B's 33.
  assert.equal(ranking[0]!.resultCount, 4);
  assert.equal(ranking[0]!.averagePercent, 54.5);
});

test('an empty section restriction yields no academic data, on every query', async () => {
  // Each of these has its own restriction handling, so each is checked. A
  // single one passing would not prove the others close the same door.
  const ranking = await getSubjectRanking(db, A.schoolId, A.term2Id, {
    restrictToSectionIds: [],
  });
  assert.equal(ranking.length, 0, 'subject ranking must return nothing');

  const performance = await getSubjectPerformance(db, A.schoolId, A.term2Id, {
    restrictToSectionIds: [],
  });
  assert.equal(performance.rows.length, 0, 'subject performance must return nothing');

  const pipeline = await getMarksPipeline(db, A.schoolId, A.term2Id, {
    restrictToSectionIds: [],
  });
  assert.equal(pipeline.approved, 0, 'the marks pipeline must count nothing');
  assert.equal(pipeline.pendingApproval, 0);
  assert.equal(pipeline.missingMarks, 0);

  const trends = await getStudentTrends(db, A.schoolId, A.term2Id, A.term1Id, {
    restrictToSectionIds: [],
  });
  assert.equal(trends.length, 0, 'student trends must return nothing');
});

// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------

test('search finds a pupil by name and by code', async () => {
  const ctx = makeContext(A, ['student.view']);

  const byName = await globalSearch(ctx, 'Dawit');
  assert.equal(byName.hits.length, 1);
  assert.equal(byName.hits[0]!.kind, 'student');
  assert.ok(byName.hits[0]!.title.startsWith('Dawit'));
  assert.ok(byName.hits[0]!.href.startsWith('/students/'));

  const byCode = await globalSearch(ctx, A.pupils[0]!.code);
  assert.equal(byCode.hits.length, 1);
  assert.equal(byCode.hits[0]!.id, A.pupils[0]!.id);
});

test('search never returns another school’s records', async () => {
  const ctx = makeContext(A, ['student.view', 'staff.view', 'guardian.view', 'academic.view']);
  // Every fixture name is identical across the two schools, so a missing
  // tenant filter would double every result.
  const results = await globalSearch(ctx, 'Hanna');
  assert.equal(results.hits.length, 1, 'exactly one Hanna belongs to school A');
  assert.equal(results.hits[0]!.id, A.pupils[1]!.id);
});

test('search returns nothing for a source the caller cannot see', async () => {
  const ctx = makeContext(A, ['student.view']);
  const results = await globalSearch(ctx, 'Almaz');
  assert.equal(results.hits.length, 0, 'a caller without staff.view must not find staff');
  assert.ok(!results.searched.includes('staff'), 'the source must not even be queried');
});

test('a permitted caller does find staff', async () => {
  const ctx = makeContext(A, ['staff.view']);
  const results = await globalSearch(ctx, 'Almaz');
  assert.equal(results.hits.length, 1);
  assert.equal(results.hits[0]!.kind, 'staff');
});

test('a disabled module is not searched even with the permission', async () => {
  const ctx = makeContext(A, ['transport.view']);
  const results = await globalSearch(ctx, 'Route');
  assert.ok(
    !results.searched.includes('route'),
    'transport is off for this school; holding the permission must not reach the data',
  );
});

test('a section-restricted teacher finds only their own pupils', async () => {
  const ctx = makeContext(A, ['student.view', 'restrict.ownSectionsOnly'], {
    sectionIds: [A.sectionBId],
  });
  const results = await globalSearch(ctx, 'Dawit');
  assert.equal(
    results.hits.length,
    0,
    'Dawit is in section A; a teacher restricted to B must not find him',
  );
});

test('a restricted teacher with no sections finds nobody', async () => {
  const ctx = makeContext(A, ['student.view', 'restrict.ownSectionsOnly'], { sectionIds: [] });
  const results = await globalSearch(ctx, 'Dawit');
  assert.equal(results.hits.length, 0, 'no sections must mean no pupils, never all pupils');
});

test('a restricted teacher is not given the guardian directory', async () => {
  const ctx = makeContext(A, ['guardian.view', 'restrict.ownSectionsOnly'], {
    sectionIds: [A.sectionAId],
  });
  const results = await globalSearch(ctx, 'Tigist');
  assert.ok(!results.searched.includes('guardian'));
  assert.equal(results.hits.length, 0);
});

test('a wildcard cannot be used to enumerate the school', async () => {
  const ctx = makeContext(A, ['student.view']);
  // Two characters, so this clears the minimum-length guard and genuinely
  // exercises the escaping rather than being rejected before it.
  const results = await globalSearch(ctx, '%%');
  assert.equal(
    results.hits.length,
    0,
    'a bare LIKE wildcard must be escaped, not executed as a match-everything query',
  );
});

test('an underscore is treated as a literal, not a single-character wildcard', async () => {
  const ctx = makeContext(A, ['student.view']);
  const results = await globalSearch(ctx, '_awit');
  assert.equal(results.hits.length, 0, 'Dawit must not match the LIKE pattern "_awit"');
});

test('a too-short query does no work', async () => {
  const ctx = makeContext(A, ['student.view']);
  const results = await globalSearch(ctx, 'D');
  assert.equal(results.hits.length, 0);
  assert.equal(results.searched.length, 0, 'nothing should be queried below the minimum length');
  assert.equal(MIN_QUERY_LENGTH, 2);
});

test('search is case-insensitive', async () => {
  const ctx = makeContext(A, ['student.view']);
  const lower = await globalSearch(ctx, 'dawit');
  assert.equal(lower.hits.length, 1);
});

test('the kind filter restricts which sources run', async () => {
  const ctx = makeContext(A, ['student.view', 'staff.view']);
  const results = await globalSearch(ctx, 'a', { kinds: ['student'] });
  assert.ok(!results.searched.includes('staff'));
});

// ---------------------------------------------------------------------------
// Teacher completion — operational visibility, not a league table
// ---------------------------------------------------------------------------

test('teacher completion reports real workload counts', async () => {
  const rows = await getTeacherCompletion(db, A.schoolId, A.yearId, { termId: A.term2Id });
  assert.equal(rows.length, 1, 'only one teacher holds assignments in the fixture');

  const teacher = rows[0]!;
  assert.equal(teacher.teacherName, 'Almaz Tesfaye');
  assert.equal(teacher.sectionCount, 1, 'assigned to section A only');
  assert.equal(teacher.subjectCount, 1);
  assert.equal(teacher.studentCount, 4, 'section A’s roll');
  assert.equal(teacher.registersTaken, 10, 'ten sessions were recorded');
  assert.equal(teacher.assessmentCount, 3, 'the test plus two quizzes');
  assert.equal(teacher.pendingApproval, 1, 'Quiz 2 awaits approval');
  assert.equal(teacher.missingMarks, 9, '1 + 4 + 4 empty cells in their own classes');
});

test('teacher completion exposes no ranking or score', async () => {
  const rows = await getTeacherCompletion(db, A.schoolId, A.yearId, { termId: A.term2Id });
  const keys = Object.keys(rows[0]!);
  for (const forbidden of ['score', 'rank', 'rating', 'completionRate', 'percentile']) {
    assert.ok(
      !keys.includes(forbidden),
      `teacher rows must not carry "${forbidden}" — the spec requires visibility, not scoring`,
    );
  }
});

test('teacher completion is school-scoped', async () => {
  const rows = await getTeacherCompletion(db, A.schoolId, A.yearId, { termId: A.term2Id });
  assert.ok(
    rows.every((r) => r.teacherId !== B.teacherUserId),
    'school A’s teacher list included school B’s teacher',
  );
});

test('a teacher restricted to no sections yields no rows', async () => {
  const rows = await getTeacherCompletion(db, A.schoolId, A.yearId, {
    termId: A.term2Id,
    restrictToSectionIds: [],
  });
  assert.equal(rows.length, 0);
});

test('with no term, marks figures stay at zero rather than guessing', async () => {
  const rows = await getTeacherCompletion(db, A.schoolId, A.yearId, { termId: null });
  assert.equal(rows[0]!.assessmentCount, 0);
  assert.equal(rows[0]!.missingMarks, 0);
  assert.equal(rows[0]!.registersTaken, 10, 'attendance does not depend on a term');
});
