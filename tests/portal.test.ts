/**
 * Portal tests.
 *
 * A parent portal that shows the wrong child is worse than no portal at all,
 * so most of this file is authorization rather than presentation. The cases
 * that matter:
 *
 *   - a parent sees their own children and nobody else's
 *   - a student sees only themself
 *   - a supplied id can select among permitted students but never grant access
 *   - a refused id returns 404, not 403 (a 403 confirms the record exists)
 *   - unpublished results are invisible until the school publishes them
 *   - nothing crosses a school boundary, even with a valid id from elsewhere
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';

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
import {
  students,
  enrollments,
  guardians,
  studentGuardians,
} from '../src/db/schema/people.ts';
import { assessments, marks, reportCards } from '../src/db/schema/academics.ts';
import {
  listPortalStudents,
  resolvePortalStudent,
  getPortalTerms,
  getPortalResults,
  getPortalSubjects,
  getPortalProgress,
  getPortalGuardianProfile,
} from '../src/lib/portal/service.ts';
import { AuthError } from '../src/lib/auth/context.ts';
import { createAssessment, saveMarks } from '../src/lib/gradebook/service.ts';
import {
  generateReportCards,
  changeReportCardStatus,
  getPublishedReportCard,
  getSectionReportCardStatus,
} from '../src/lib/gradebook/reportCards.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  termId: string;
  gradeId: string;
  sectionA: string;
  subjectId: string;
  ssMathA: string;
  adminUserId: string;
  parentUserId: string;
  studentUserId: string;
  guardianId: string;
  /** Two children of the same parent, plus one unrelated pupil. */
  childOne: string;
  childTwo: string;
  strangerStudent: string;
};

const A = {} as Fixture;
const B = {} as Fixture;

const STAFF_PERMS = [
  'grade.view',
  'grade.enter',
  'grade.submit',
  'grade.review',
  'grade.lock',
  'reportCard.view',
  'reportCard.generate',
  'reportCard.approve',
  'reportCard.publish',
  'student.view',
];

function makeContext(
  fixture: Fixture,
  userId: string,
  permissions: string[],
  relationships: {
    childStudentIds?: string[];
    ownStudentId?: string | null;
    guardianId?: string | null;
    sectionIds?: string[];
    sectionSubjectIds?: string[];
  },
) {
  return {
    db,
    schoolId: fixture.schoolId,
    user: { userId, givenName: 'Test', fatherName: 'User' },
    ipAddress: '127.0.0.1',
    has: (p: string) => permissions.includes(p),
    hasAny: (...list: string[]) => list.some((p) => permissions.includes(p)),
    require: (p: string) => {
      if (!permissions.includes(p)) {
        throw new AuthError(`Missing permission: ${p}`, 403);
      }
    },
    requireAny: (...list: string[]) => {
      if (!list.some((p) => permissions.includes(p))) {
        throw new AuthError('Missing permission', 403);
      }
    },
    displayName: () => 'Test User',
    relationships: {
      sectionIds: relationships.sectionIds ?? [],
      sectionSubjectIds: relationships.sectionSubjectIds ?? [],
      childStudentIds: relationships.childStudentIds ?? [],
      ownStudentId: relationships.ownStudentId ?? null,
      guardianId: relationships.guardianId ?? null,
    },
  } as never;
}

async function seedSchool(code: string, fixture: Fixture) {
  const [school] = await db
    .insert(schools)
    .values({ code, name: `Portal ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  await db.insert(schoolSettings).values({
    schoolId: fixture.schoolId,
    key: 'grading',
    value: {
      displayMode: 'both',
      passMarkPercent: 50,
      decimalPlaces: 1,
      roundTotals: true,
      useRanking: true,
      rankScope: 'section',
      useGpa: false,
      bands: [
        { letter: 'A', minPercent: 90, maxPercent: 100, points: 4, isPass: true },
        { letter: 'B', minPercent: 80, maxPercent: 89.99, points: 3, isPass: true },
        { letter: 'C', minPercent: 50, maxPercent: 79.99, points: 2, isPass: true },
        { letter: 'F', minPercent: 0, maxPercent: 49.99, points: 0, isPass: false },
      ],
      components: [
        { key: 'final', name: 'Final', weightPercent: 100, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 1 },
      ],
      minAttendancePercentForPass: null,
    },
  });
  invalidateSettingsCache(fixture.schoolId, 'grading');

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

  const [section] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: 'A',
    })
    .returning({ id: sections.id });
  fixture.sectionA = section!.id;

  const [subject] = await db
    .insert(subjects)
    .values({ schoolId: fixture.schoolId, code: 'MATH', name: 'Mathematics' })
    .returning({ id: subjects.id });
  fixture.subjectId = subject!.id;

  const [admin] = await db
    .insert(users)
    .values({ schoolId: fixture.schoolId, username: 'admin', passwordHash: 'x', givenName: 'Admin' })
    .returning({ id: users.id });
  fixture.adminUserId = admin!.id;

  const [parentUser] = await db
    .insert(users)
    .values({ schoolId: fixture.schoolId, username: 'parent', passwordHash: 'x', givenName: 'Parent' })
    .returning({ id: users.id });
  fixture.parentUserId = parentUser!.id;

  const [studentUser] = await db
    .insert(users)
    .values({ schoolId: fixture.schoolId, username: 'pupil', passwordHash: 'x', givenName: 'Pupil' })
    .returning({ id: users.id });
  fixture.studentUserId = studentUser!.id;

  const [link] = await db
    .insert(sectionSubjects)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sectionId: fixture.sectionA,
      subjectId: fixture.subjectId,
      teacherId: fixture.adminUserId,
    })
    .returning({ id: sectionSubjects.id });
  fixture.ssMathA = link!.id;

  const names = ['ChildOne', 'ChildTwo', 'Stranger'];
  const ids: string[] = [];
  for (const name of names) {
    const [student] = await db
      .insert(students)
      .values({
        schoolId: fixture.schoolId,
        studentCode: `${code}/${name}`,
        givenName: name,
        fatherName: 'Family',
        status: 'active',
      })
      .returning({ id: students.id });
    ids.push(student!.id);
    await db.insert(enrollments).values({
      schoolId: fixture.schoolId,
      studentId: student!.id,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      sectionId: fixture.sectionA,
      enrolledOn: '2025-09-11',
      status: 'enrolled',
    });
  }
  [fixture.childOne, fixture.childTwo, fixture.strangerStudent] = ids as [string, string, string];

  // One guardian, two children — siblings share the guardian row.
  const [guardian] = await db
    .insert(guardians)
    .values({
      schoolId: fixture.schoolId,
      givenName: 'Almaz',
      fatherName: 'Bekele',
      phone: '+251911000111',
      userId: fixture.parentUserId,
    })
    .returning({ id: guardians.id });
  fixture.guardianId = guardian!.id;

  await db.insert(studentGuardians).values([
    {
      schoolId: fixture.schoolId,
      studentId: fixture.childOne,
      guardianId: fixture.guardianId,
      relationship: 'mother',
      isPrimary: true,
    },
    {
      schoolId: fixture.schoolId,
      studentId: fixture.childTwo,
      guardianId: fixture.guardianId,
      relationship: 'mother',
      isPrimary: true,
    },
  ]);

  // Link the student user to their own record.
  await db
    .update(students)
    .set({ userId: fixture.studentUserId })
    .where(eq(students.id, fixture.childOne));
}

before(async () => {
  db = await getDb();
  await seedSchool(`pA-${Date.now()}`, A);
  await seedSchool(`pB-${Date.now()}`, B);
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  await closeDb();
});

const parentCtx = () =>
  makeContext(A, A.parentUserId, ['portal.parent'], {
    childStudentIds: [A.childOne, A.childTwo],
    guardianId: A.guardianId,
  });

const studentCtx = () =>
  makeContext(A, A.studentUserId, ['portal.student'], { ownStudentId: A.childOne });

const staffCtx = () => makeContext(A, A.adminUserId, STAFF_PERMS, {});

// ---------------------------------------------------------------------------
// Who can see whom
// ---------------------------------------------------------------------------

test('a parent sees exactly their own children', async () => {
  const list = await listPortalStudents(parentCtx());
  const ids = list.map((s) => s.id).sort();
  assert.deepEqual(ids, [A.childOne, A.childTwo].sort());
  assert.ok(!ids.includes(A.strangerStudent), 'another family\u2019s child must not appear');
});

test('a student sees only themself', async () => {
  const list = await listPortalStudents(studentCtx());
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, A.childOne);
});

test('the portal shows the child\u2019s current class', async () => {
  const list = await listPortalStudents(parentCtx());
  const child = list.find((s) => s.id === A.childOne)!;
  assert.equal(child.gradeName, 'Grade 5');
  assert.equal(child.sectionName, 'A');
  assert.match(child.name, /ChildOne/);
});

test('a parent may switch between their own children', async () => {
  const first = await resolvePortalStudent(parentCtx(), A.childOne);
  const second = await resolvePortalStudent(parentCtx(), A.childTwo);
  assert.equal(first.id, A.childOne);
  assert.equal(second.id, A.childTwo);
});

test('with no id supplied the first permitted child is used', async () => {
  const chosen = await resolvePortalStudent(parentCtx(), null);
  assert.ok([A.childOne, A.childTwo].includes(chosen.id));
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

test('a parent requesting another family\u2019s child gets 404, not 403', async () => {
  await assert.rejects(
    () => resolvePortalStudent(parentCtx(), A.strangerStudent),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(
        (error as AuthError).status,
        404,
        'a 403 would confirm the student exists at this school',
      );
      return true;
    },
  );
});

test('a student requesting a classmate gets 404', async () => {
  await assert.rejects(
    () => resolvePortalStudent(studentCtx(), A.childTwo),
    (error: unknown) => error instanceof AuthError && (error as AuthError).status === 404,
  );
});

test('a student id from another school is refused', async () => {
  await assert.rejects(
    () => resolvePortalStudent(parentCtx(), B.childOne),
    (error: unknown) => error instanceof AuthError && (error as AuthError).status === 404,
  );
});

test('a stale relationship pointing at another school yields nothing', async () => {
  // A deliberately corrupted session: the relationship names a real student,
  // but one that belongs to school B while the context is scoped to school A.
  const crossTenant = makeContext(A, A.parentUserId, ['portal.parent'], {
    childStudentIds: [B.childOne, B.childTwo],
    guardianId: A.guardianId,
  });

  const list = await listPortalStudents(crossTenant);
  assert.equal(list.length, 0, 'the school filter must defeat a stale cross-tenant id');

  await assert.rejects(
    () => resolvePortalStudent(crossTenant, B.childOne),
    (error: unknown) => error instanceof AuthError,
  );
});

test('an account with no linked student is told so, not shown someone else', async () => {
  const orphan = makeContext(A, A.parentUserId, ['portal.parent'], {
    childStudentIds: [],
    guardianId: null,
  });
  const list = await listPortalStudents(orphan);
  assert.equal(list.length, 0);

  await assert.rejects(
    () => resolvePortalStudent(orphan, null),
    (error: unknown) => error instanceof AuthError && (error as AuthError).status === 404,
  );
});

// ---------------------------------------------------------------------------
// Publication gating
// ---------------------------------------------------------------------------

test('results are invisible until the school publishes them', async () => {
  // Enter and approve a mark, then generate a card but do not publish it.
  const { id: assessmentId } = await createAssessment(staffCtx(), {
    sectionSubjectId: A.ssMathA,
    termId: A.termId,
    componentKey: 'final',
    instance: 1,
    title: 'Final',
    maxMark: 100,
    assessedOn: '',
  });

  await saveMarks(staffCtx(), {
    assessmentId,
    entries: [
      { studentId: A.childOne, mark: 85, excused: false, note: '' },
      { studentId: A.childTwo, mark: 60, excused: false, note: '' },
      { studentId: A.strangerStudent, mark: 95, excused: false, note: '' },
    ],
    submit: false,
  });

  await generateReportCards(staffCtx(), { termId: A.termId, sectionId: A.sectionA });

  const beforePublish = await getPortalResults(parentCtx(), A.childOne, A.termId);
  assert.equal(beforePublish.published, false);
  assert.equal(beforePublish.card, null, 'an unpublished card must not reach a parent');
  assert.match(beforePublish.message!, /not been published/i);
});

test('a published card becomes visible, with the configured content', async () => {
  const [card] = await db
    .select({ id: reportCards.id })
    .from(reportCards)
    .where(
      and(eq(reportCards.schoolId, A.schoolId), eq(reportCards.studentId, A.childOne)),
    );

  await changeReportCardStatus(staffCtx(), card!.id, 'approve');
  await changeReportCardStatus(staffCtx(), card!.id, 'publish');

  const after = await getPortalResults(parentCtx(), A.childOne, A.termId);
  assert.equal(after.published, true);
  assert.ok(after.card, 'the parent can now see the card');
  assert.equal(after.card!.status, 'published');
  assert.equal(after.card!.data!.subjects.length, 1);
  assert.equal(after.card!.data!.subjects[0]!.percentage, 85);
});

test('publishing one child\u2019s card does not reveal the sibling\u2019s', async () => {
  const sibling = await getPortalResults(parentCtx(), A.childTwo, A.termId);
  assert.equal(sibling.published, false, 'child two was never published');
  assert.equal(sibling.card, null);
});

test('a published card is served from its frozen snapshot', async () => {
  // Change the underlying mark after publication.
  const [assessment] = await db
    .select({ id: assessments.id })
    .from(assessments)
    .where(eq(assessments.schoolId, A.schoolId))
    .limit(1);

  await saveMarks(staffCtx(), {
    assessmentId: assessment!.id,
    entries: [{ studentId: A.childOne, mark: 12, excused: false, note: '' }],
    submit: false,
  });

  const after = await getPortalResults(parentCtx(), A.childOne, A.termId);
  assert.equal(
    after.card!.data!.subjects[0]!.percentage,
    85,
    'the published document must not silently change under the parent',
  );

  // Restore for later assertions.
  await saveMarks(staffCtx(), {
    assessmentId: assessment!.id,
    entries: [{ studentId: A.childOne, mark: 85, excused: false, note: '' }],
    submit: false,
  });
});

test('a parent cannot read a published card belonging to another family', async () => {
  // Publish the stranger's card as staff.
  await generateReportCards(staffCtx(), {
    termId: A.termId,
    studentId: A.strangerStudent,
  });
  const [strangerCard] = await db
    .select({ id: reportCards.id })
    .from(reportCards)
    .where(
      and(eq(reportCards.schoolId, A.schoolId), eq(reportCards.studentId, A.strangerStudent)),
    );
  await changeReportCardStatus(staffCtx(), strangerCard!.id, 'approve');
  await changeReportCardStatus(staffCtx(), strangerCard!.id, 'publish');

  // Even though it is published, it is not this parent's child.
  await assert.rejects(
    () => resolvePortalStudent(parentCtx(), A.strangerStudent),
    (error: unknown) => error instanceof AuthError && (error as AuthError).status === 404,
  );

  // And the direct service call is scoped by school, so a cross-school id is
  // null rather than another school's document.
  const foreign = await getPublishedReportCard(db, A.schoolId, B.childOne, A.termId);
  assert.equal(foreign, null);
});

test('the term list marks which terms actually have a published card', async () => {
  const terms = await getPortalTerms(parentCtx(), A.childOne);
  assert.ok(terms.length >= 1);
  assert.equal(terms[0]!.hasReportCard, true);

  const siblingTerms = await getPortalTerms(parentCtx(), A.childTwo);
  assert.equal(siblingTerms[0]!.hasReportCard, false);
});

test('progress only includes published terms', async () => {
  const published = await getPortalProgress(parentCtx(), A.childOne);
  assert.ok(published.length >= 1);

  const unpublished = await getPortalProgress(parentCtx(), A.childTwo);
  assert.equal(unpublished.length, 0, 'an unpublished term must not appear in the trend');
});

// ---------------------------------------------------------------------------
// Other portal reads
// ---------------------------------------------------------------------------

test('a portal user sees their subjects and teachers', async () => {
  const subjectList = await getPortalSubjects(parentCtx(), A.childOne);
  assert.equal(subjectList.length, 1);
  assert.equal(subjectList[0]!.subjectName, 'Mathematics');
});

test('a parent sees their own contact record', async () => {
  const profile = await getPortalGuardianProfile(parentCtx());
  assert.ok(profile);
  assert.equal(profile!.name, 'Almaz Bekele');
  assert.equal(profile!.phone, '+251911000111');
  assert.equal(profile!.children, 2, 'both siblings are linked to one guardian row');
});

test('a student account has no guardian profile', async () => {
  const profile = await getPortalGuardianProfile(studentCtx());
  assert.equal(profile, null);
});

test('requesting results for a term from another school is refused', async () => {
  await assert.rejects(
    () => getPortalResults(parentCtx(), A.childOne, B.termId),
    (error: unknown) => error instanceof AuthError && (error as AuthError).status === 404,
  );
});

// ---------------------------------------------------------------------------
// Report-card generation is scoped to the caller's own classes
// ---------------------------------------------------------------------------

/**
 * Regression: generateReportCards checked only that the caller held
 * reportCard.generate, never that the class was theirs. A class teacher —
 * a role that legitimately holds that permission so they can prepare their
 * own class — could therefore generate, and then read, every other class's
 * results. A permission says what you may do, never whose data you may do it to.
 */
test('a class teacher cannot generate report cards for another class', async () => {
  const [otherSection] = await db
    .insert(sections)
    .values({
      schoolId: A.schoolId,
      academicYearId: A.yearId,
      gradeLevelId: A.gradeId,
      name: 'Z',
    })
    .returning({ id: sections.id });

  // A class teacher of section A only.
  const classTeacher = makeContext(
    A,
    A.adminUserId,
    ['reportCard.view', 'reportCard.generate', 'grade.view'],
    { sectionIds: [A.sectionA] },
  );

  await assert.rejects(
    () => generateReportCards(classTeacher, { termId: A.termId, sectionId: otherSection!.id }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 404, 'a 403 would confirm the class exists');
      return true;
    },
  );

  // Their own class still works.
  const own = await generateReportCards(classTeacher, {
    termId: A.termId,
    sectionId: A.sectionA,
  });
  assert.ok(own.generated + own.skipped > 0, 'the teacher can still prepare their own class');
});

test('a class teacher cannot read another class\u2019s report card progress', async () => {
  const [otherSection] = await db
    .select({ id: sections.id })
    .from(sections)
    .where(and(eq(sections.schoolId, A.schoolId), eq(sections.name, 'Z')))
    .limit(1);

  const classTeacher = makeContext(A, A.adminUserId, ['reportCard.view'], {
    sectionIds: [A.sectionA],
  });

  await assert.rejects(
    () => getSectionReportCardStatus(classTeacher, A.termId, otherSection!.id),
    (error: unknown) => (error as { status?: number }).status === 404,
  );

  const own = await getSectionReportCardStatus(classTeacher, A.termId, A.sectionA);
  assert.ok(own.length > 0);
});

test('school-wide staff are not restricted to one class', async () => {
  const [otherSection] = await db
    .select({ id: sections.id })
    .from(sections)
    .where(and(eq(sections.schoolId, A.schoolId), eq(sections.name, 'Z')))
    .limit(1);

  // An administrator has no section relationships at all, and must still pass.
  const office = makeContext(A, A.adminUserId, [...STAFF_PERMS, 'academic.manage'], {});
  const rows = await getSectionReportCardStatus(office, A.termId, otherSection!.id);
  assert.ok(Array.isArray(rows), 'office staff see every class');
});
