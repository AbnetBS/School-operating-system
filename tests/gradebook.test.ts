/**
 * Gradebook tests.
 *
 * A mark is the most disputed record a school holds, so the things worth
 * testing are: that the assessment structure genuinely comes from configuration
 * (two schools with different structures must both work), that the workflow
 * cannot be short-circuited, that a teacher can only touch their own classes,
 * that a locked mark stays locked, and that a mark can never cross a tenant
 * boundary.
 *
 * Two schools are seeded with deliberately different grading configurations,
 * mirroring the two demo schools, because "configurable" is only demonstrated
 * by two different configurations producing two different correct answers.
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
  subjects,
  sectionSubjects,
  auditLog,
  schoolSettings,
} from '../src/db/schema/core.ts';
import { students, enrollments } from '../src/db/schema/people.ts';
import {
  assessments,
  marks,
  markChanges,
  subjectResults,
  termResults,
  gradingConfigs,
} from '../src/db/schema/academics.ts';
import {
  createAssessment,
  saveMarks,
  getMarkSheet,
  listAssessments,
  changeAssessmentStatus,
  checkGradebookAccess,
  resolveGradingConfig,
  recomputeSubjectResults,
  recomputeTermResults,
  getStudentTermReport,
  getClassRoster,
  getTeachableClassSubjects,
  GradebookError,
} from '../src/lib/gradebook/service.ts';
import {
  createAssessmentSchema,
  saveMarksSchema,
  gradingConfigSchema,
  markEntrySchema,
} from '../src/lib/gradebook/schema.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  termId: string;
  term2Id: string;
  gradeId: string;
  sectionA: string;
  sectionB: string;
  mathId: string;
  englishId: string;
  ssMathA: string;
  ssEnglishA: string;
  ssMathB: string;
  adminUserId: string;
  teacherUserId: string;
  otherTeacherId: string;
  studentIds: string[];
};

const A = { studentIds: [] } as unknown as Fixture;
const B = { studentIds: [] } as unknown as Fixture;

const ADMIN_PERMS = [
  'grade.view',
  'grade.enter',
  'grade.submit',
  'grade.review',
  'grade.lock',
  'grade.overrideLocked',
  'grade.configure',
  'reportCard.view',
  'reportCard.generate',
  'reportCard.approve',
  'reportCard.publish',
  'student.view',
];
const TEACHER_PERMS = ['grade.view', 'grade.enter', 'grade.submit', 'student.view'];

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
    require: (p: string) => {
      if (!permissions.includes(p)) {
        const e = new Error(`Missing permission: ${p}`) as Error & { status: number };
        e.status = 403;
        throw e;
      }
    },
    requireAny: (...list: string[]) => {
      if (!list.some((p) => permissions.includes(p))) {
        const e = new Error('Missing permission') as Error & { status: number };
        e.status = 403;
        throw e;
      }
    },
    displayName: () => 'Test User',
    relationships: {
      sectionIds: relationships.sectionIds ?? [],
      sectionSubjectIds: relationships.sectionSubjectIds ?? [],
      childStudentIds: [],
      ownStudentId: null,
      guardianId: null,
    },
  } as never;
}

/**
 * @param components the school's assessment structure — deliberately different
 *   between the two seeded schools so configurability is actually exercised.
 */
async function seedSchool(
  code: string,
  fixture: Fixture,
  studentCount: number,
  grading: Record<string, unknown>,
) {
  const [school] = await db
    .insert(schools)
    .values({ code, name: `Test ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  await db.insert(schoolSettings).values({
    schoolId: fixture.schoolId,
    key: 'grading',
    value: grading,
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

  const insertedTerms = await db
    .insert(terms)
    .values([
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        name: 'Term 1',
        sequence: 1,
        startDate: '2025-09-11',
        endDate: '2025-12-31',
        isCurrent: true,
      },
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        name: 'Term 2',
        sequence: 2,
        startDate: '2026-01-01',
        endDate: '2026-04-30',
      },
    ])
    .returning({ id: terms.id, sequence: terms.sequence });
  fixture.termId = insertedTerms.find((t) => t.sequence === 1)!.id;
  fixture.term2Id = insertedTerms.find((t) => t.sequence === 2)!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

  const insertedSections = await db
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
  fixture.sectionA = insertedSections.find((s) => s.name === 'A')!.id;
  fixture.sectionB = insertedSections.find((s) => s.name === 'B')!.id;

  const insertedSubjects = await db
    .insert(subjects)
    .values([
      { schoolId: fixture.schoolId, code: 'MATH', name: 'Mathematics' },
      { schoolId: fixture.schoolId, code: 'ENG', name: 'English' },
    ])
    .returning({ id: subjects.id, code: subjects.code });
  fixture.mathId = insertedSubjects.find((s) => s.code === 'MATH')!.id;
  fixture.englishId = insertedSubjects.find((s) => s.code === 'ENG')!.id;

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

  const [other] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: 'other',
      passwordHash: 'x',
      givenName: 'Other',
    })
    .returning({ id: users.id });
  fixture.otherTeacherId = other!.id;

  const links = await db
    .insert(sectionSubjects)
    .values([
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        sectionId: fixture.sectionA,
        subjectId: fixture.mathId,
        teacherId: fixture.teacherUserId,
      },
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        sectionId: fixture.sectionA,
        subjectId: fixture.englishId,
        teacherId: fixture.otherTeacherId,
      },
      {
        schoolId: fixture.schoolId,
        academicYearId: fixture.yearId,
        sectionId: fixture.sectionB,
        subjectId: fixture.mathId,
        teacherId: fixture.otherTeacherId,
      },
    ])
    .returning({ id: sectionSubjects.id, sectionId: sectionSubjects.sectionId, subjectId: sectionSubjects.subjectId });

  fixture.ssMathA = links.find((l) => l.sectionId === fixture.sectionA && l.subjectId === fixture.mathId)!.id;
  fixture.ssEnglishA = links.find((l) => l.sectionId === fixture.sectionA && l.subjectId === fixture.englishId)!.id;
  fixture.ssMathB = links.find((l) => l.sectionId === fixture.sectionB)!.id;

  for (let i = 1; i <= studentCount; i++) {
    const [student] = await db
      .insert(students)
      .values({
        schoolId: fixture.schoolId,
        studentCode: `${code}/${String(i).padStart(3, '0')}`,
        givenName: `Student${i}`,
        fatherName: 'Test',
        status: 'active',
      })
      .returning({ id: students.id });
    fixture.studentIds.push(student!.id);

    await db.insert(enrollments).values({
      schoolId: fixture.schoolId,
      studentId: student!.id,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      sectionId: fixture.sectionA,
      enrolledOn: '2025-09-11',
      status: 'enrolled',
      rollNumber: i,
    });
  }
}

const BANDS = [
  { letter: 'A', minPercent: 90, maxPercent: 100, points: 4, isPass: true },
  { letter: 'B', minPercent: 80, maxPercent: 89.99, points: 3, isPass: true },
  { letter: 'C', minPercent: 60, maxPercent: 79.99, points: 2, isPass: true },
  { letter: 'D', minPercent: 50, maxPercent: 59.99, points: 1, isPass: true },
  { letter: 'F', minPercent: 0, maxPercent: 49.99, points: 0, isPass: false },
];

/** School A: quiz 20 (x2), midterm 30, final 50. Ranking on, GPA off. */
const GRADING_A = {
  displayMode: 'both',
  passMarkPercent: 50,
  decimalPlaces: 1,
  roundTotals: true,
  useRanking: true,
  rankScope: 'section',
  useGpa: false,
  bands: BANDS,
  components: [
    { key: 'quiz', name: 'Quiz', weightPercent: 20, maxMark: 100, instances: 2, dropLowest: 0, sortOrder: 1 },
    { key: 'midterm', name: 'Midterm', weightPercent: 30, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 2 },
    { key: 'final', name: 'Final', weightPercent: 50, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 3 },
  ],
  minAttendancePercentForPass: null,
};

/** School B: coursework 40 (x4, drop lowest 1), final 60. Ranking off, GPA on. */
const GRADING_B = {
  displayMode: 'points',
  passMarkPercent: 60,
  decimalPlaces: 2,
  roundTotals: true,
  useRanking: false,
  rankScope: 'section',
  useGpa: true,
  bands: BANDS,
  components: [
    { key: 'coursework', name: 'Coursework', weightPercent: 40, maxMark: 50, instances: 4, dropLowest: 1, sortOrder: 1 },
    { key: 'final', name: 'Final Exam', weightPercent: 60, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 2 },
  ],
  minAttendancePercentForPass: null,
};

before(async () => {
  db = await getDb();
  await seedSchool(`gbA-${Date.now()}`, A, 4, GRADING_A);
  await seedSchool(`gbB-${Date.now()}`, B, 3, GRADING_B);
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  await closeDb();
});

const admin = () => contextFor(A, A.adminUserId, ADMIN_PERMS);
const teacher = () =>
  contextFor(A, A.teacherUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('each school resolves its own assessment structure', async () => {
  const configA = await resolveGradingConfig(db, A.schoolId, A.ssMathA);
  const configB = await resolveGradingConfig(db, B.schoolId, B.ssMathA);

  assert.deepEqual(
    configA.components.map((c) => c.key),
    ['quiz', 'midterm', 'final'],
  );
  assert.deepEqual(
    configB.components.map((c) => c.key),
    ['coursework', 'final'],
  );
  assert.equal(configA.passMarkPercent, 50);
  assert.equal(configB.passMarkPercent, 60, 'school B has a higher pass mark');
  assert.equal(configA.source, 'school');
});

test('a per-subject grading config overrides the school default', async () => {
  const [config] = await db
    .insert(gradingConfigs)
    .values({
      schoolId: A.schoolId,
      name: 'Practical subjects',
      components: [
        { key: 'practical', name: 'Practical', weightPercent: 70, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 1 },
        { key: 'final', name: 'Final', weightPercent: 30, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 2 },
      ],
      passMarkPercent: 40,
    })
    .returning({ id: gradingConfigs.id });

  await db
    .update(sectionSubjects)
    .set({ gradingConfigId: config!.id })
    .where(eq(sectionSubjects.id, A.ssEnglishA));

  const overridden = await resolveGradingConfig(db, A.schoolId, A.ssEnglishA);
  assert.equal(overridden.source, 'override');
  assert.equal(overridden.configName, 'Practical subjects');
  assert.deepEqual(overridden.components.map((c) => c.key), ['practical', 'final']);
  assert.equal(overridden.passMarkPercent, 40);

  // The default is untouched for other subjects.
  const untouched = await resolveGradingConfig(db, A.schoolId, A.ssMathA);
  assert.equal(untouched.source, 'school');

  // Reset so later tests see the school default.
  await db
    .update(sectionSubjects)
    .set({ gradingConfigId: null })
    .where(eq(sectionSubjects.id, A.ssEnglishA));
});

test('an assessment type outside the configuration is refused', async () => {
  await assert.rejects(
    () =>
      createAssessment(admin(), {
        sectionSubjectId: A.ssMathA,
        termId: A.termId,
        componentKey: 'homework', // not configured at school A
        instance: 1,
        title: 'Homework 1',
        maxMark: 20,
        assessedOn: '',
      }),
    (error: unknown) =>
      error instanceof GradebookError && /not one of this school's assessment types/.test(error.message),
  );
});

test('more instances than configured are refused', async () => {
  await assert.rejects(
    () =>
      createAssessment(admin(), {
        sectionSubjectId: A.ssMathA,
        termId: A.termId,
        componentKey: 'midterm', // configured for 1 instance
        instance: 2,
        title: 'Second midterm',
        maxMark: 100,
        assessedOn: '',
      }),
    (error: unknown) => error instanceof GradebookError && /configured for 1 instance/.test(error.message),
  );
});

test('component weights must total 100 in a custom config', () => {
  const bad = gradingConfigSchema.safeParse({
    name: 'Broken',
    components: [
      { key: 'a', name: 'A', weightPercent: 30, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 0 },
      { key: 'b', name: 'B', weightPercent: 30, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 1 },
    ],
  });
  assert.equal(bad.success, false);

  const good = gradingConfigSchema.safeParse({
    name: 'Fine',
    components: [
      { key: 'a', name: 'A', weightPercent: 40, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 0 },
      { key: 'b', name: 'B', weightPercent: 60, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 1 },
    ],
  });
  assert.equal(good.success, true);
});

test('a config cannot drop every instance of a component', () => {
  const result = gradingConfigSchema.safeParse({
    name: 'Drops everything',
    components: [
      { key: 'a', name: 'A', weightPercent: 100, maxMark: 100, instances: 2, dropLowest: 2, sortOrder: 0 },
    ],
  });
  assert.equal(result.success, false);
});

test('duplicate component keys are refused', () => {
  const result = gradingConfigSchema.safeParse({
    name: 'Duplicates',
    components: [
      { key: 'quiz', name: 'Quiz A', weightPercent: 50, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 0 },
      { key: 'quiz', name: 'Quiz B', weightPercent: 50, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 1 },
    ],
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Creating assessments and entering marks
// ---------------------------------------------------------------------------

let quizId = '';
let midtermId = '';

test('a teacher creates an assessment for their own class', async () => {
  const { id } = await createAssessment(teacher(), {
    sectionSubjectId: A.ssMathA,
    termId: A.termId,
    componentKey: 'quiz',
    instance: 1,
    title: 'Quiz 1',
    maxMark: 20,
    assessedOn: '2025-10-06',
  });
  quizId = id;
  assert.ok(quizId);

  const [row] = await db.select().from(assessments).where(eq(assessments.id, quizId));
  assert.equal(row!.status, 'draft');
  assert.equal(row!.maxMark, 20);
  assert.equal(row!.schoolId, A.schoolId);
});

test('a teacher cannot create an assessment for a class they do not teach', async () => {
  await assert.rejects(
    () =>
      createAssessment(teacher(), {
        sectionSubjectId: A.ssMathB, // taught by someone else
        termId: A.termId,
        componentKey: 'quiz',
        instance: 1,
        title: 'Not mine',
        maxMark: 20,
        assessedOn: '',
      }),
    (error: unknown) => error instanceof GradebookError && error.status === 403,
  );
});

test('the same component instance cannot be created twice', async () => {
  await assert.rejects(
    () =>
      createAssessment(teacher(), {
        sectionSubjectId: A.ssMathA,
        termId: A.termId,
        componentKey: 'quiz',
        instance: 1,
        title: 'Quiz 1 again',
        maxMark: 20,
        assessedOn: '',
      }),
    'a duplicate quiz 1 would silently halve everyone\u2019s quiz average',
  );
});

test('the mark sheet lists the whole class, unmarked', async () => {
  const sheet = await getMarkSheet(teacher(), quizId);
  assert.equal(sheet.rows.length, 4);
  assert.equal(sheet.canEdit, true);
  assert.ok(sheet.rows.every((r) => r.mark === null && !r.excused));
  assert.equal(sheet.assessment.componentName, 'Quiz');
});

test('marks are saved for the class in one call', async () => {
  const sheet = await getMarkSheet(teacher(), quizId);
  const result = await saveMarks(teacher(), {
    assessmentId: quizId,
    entries: sheet.rows.map((r, i) => ({
      studentId: r.studentId,
      mark: [20, 15, 10, 5][i]!,
      excused: false,
      note: '',
    })),
    submit: false,
  });

  assert.equal(result.saved, 4);
  assert.equal(result.changed, 4);
  assert.deepEqual(result.errors, {});

  const stored = await db.select().from(marks).where(eq(marks.assessmentId, quizId));
  assert.equal(stored.length, 4);
});

test('a mark above the maximum is rejected without discarding the good ones', async () => {
  const { id } = await createAssessment(teacher(), {
    sectionSubjectId: A.ssMathA,
    termId: A.termId,
    componentKey: 'quiz',
    instance: 2,
    title: 'Quiz 2',
    maxMark: 20,
    assessedOn: '',
  });

  const sheet = await getMarkSheet(teacher(), id);
  const result = await saveMarks(teacher(), {
    assessmentId: id,
    entries: [
      { studentId: sheet.rows[0]!.studentId, mark: 18, excused: false, note: '' },
      { studentId: sheet.rows[1]!.studentId, mark: 25, excused: false, note: '' }, // over max
      { studentId: sheet.rows[2]!.studentId, mark: 12, excused: false, note: '' },
    ],
    submit: false,
  });

  assert.equal(result.saved, 2, 'the two valid marks are kept');
  assert.ok(result.errors[sheet.rows[1]!.studentId], 'the invalid one is reported');
  assert.match(result.errors[sheet.rows[1]!.studentId]!, /greater than the maximum/);
});

test('a mark for a student outside the class is refused', async () => {
  const outsider = B.studentIds[0]!; // a student at the other school
  const result = await saveMarks(teacher(), {
    assessmentId: quizId,
    entries: [{ studentId: outsider, mark: 20, excused: false, note: '' }],
    submit: false,
  });

  assert.equal(result.saved, 0);
  assert.match(result.errors[outsider]!, /not in this class/);

  const leaked = await db
    .select()
    .from(marks)
    .where(and(eq(marks.assessmentId, quizId), eq(marks.studentId, outsider)));
  assert.equal(leaked.length, 0, 'no cross-school mark was written');
});

test('a negative mark is rejected by the schema and the service', async () => {
  const parsed = saveMarksSchema.safeParse({
    assessmentId: quizId,
    entries: [{ studentId: A.studentIds[0], mark: -1, excused: false }],
  });
  assert.equal(parsed.success, false, 'the shared schema rejects it client-side too');

  const result = await saveMarks(teacher(), {
    assessmentId: quizId,
    entries: [{ studentId: A.studentIds[0]!, mark: -1, excused: false, note: '' }],
    submit: false,
  });
  assert.ok(result.errors[A.studentIds[0]!], 'and the server rejects it independently');
});

/**
 * Regression: `z.coerce.number()` turns both null and '' into 0, because
 * Number(null) === 0. With the coercion ordered first in a union, clearing a
 * mark box stored a scored NOUGHT instead of "not entered" — quietly dragging
 * the pupil's average down with no error anywhere. Blank input is normalised
 * to null before coercion is attempted.
 */
test('a blank mark is "not entered", never a zero', () => {
  const blank = markEntrySchema.parse({ studentId: 's', mark: '', excused: false });
  assert.equal(blank.mark, null, 'an empty box is not a score of nought');

  const omitted = markEntrySchema.parse({ studentId: 's', excused: false });
  assert.equal(omitted.mark, null);

  const explicitNull = markEntrySchema.parse({ studentId: 's', mark: null, excused: true });
  assert.equal(explicitNull.mark, null, 'an excused pupil must not become a zero');
  assert.equal(explicitNull.excused, true);

  // A real zero still survives — it is a legitimate, different result.
  const zero = markEntrySchema.parse({ studentId: 's', mark: 0, excused: false });
  assert.equal(zero.mark, 0);

  // Numbers arriving as strings from a form still coerce.
  const typed = markEntrySchema.parse({ studentId: 's', mark: '7', excused: false });
  assert.equal(typed.mark, 7);
});

test('an excused student is not the same as a zero', async () => {
  const { id } = await createAssessment(admin(), {
    sectionSubjectId: A.ssMathA,
    termId: A.term2Id,
    componentKey: 'quiz',
    instance: 1,
    title: 'Excusal probe',
    maxMark: 10,
    assessedOn: '',
  });

  await saveMarks(admin(), {
    assessmentId: id,
    entries: [
      { studentId: A.studentIds[0]!, mark: null, excused: true, note: 'ill' },
      { studentId: A.studentIds[1]!, mark: 0, excused: false, note: '' },
    ],
    submit: false,
  });

  const rows = await db.select().from(marks).where(eq(marks.assessmentId, id));
  const excused = rows.find((r) => r.studentId === A.studentIds[0]);
  const zero = rows.find((r) => r.studentId === A.studentIds[1]);

  assert.equal(excused!.isExcused, true);
  assert.equal(excused!.mark, null);
  assert.equal(zero!.isExcused, false);
  assert.equal(zero!.mark, 0);
});

test('every mark change is written to the change history', async () => {
  const sheet = await getMarkSheet(teacher(), quizId);
  const target = sheet.rows[0]!;
  const before = target.mark;

  await saveMarks(teacher(), {
    assessmentId: quizId,
    entries: [{ studentId: target.studentId, mark: 19, excused: false, note: '' }],
    submit: false,
  });

  const history = await db
    .select()
    .from(markChanges)
    .where(and(eq(markChanges.schoolId, A.schoolId), eq(markChanges.studentId, target.studentId)));

  assert.ok(history.length >= 1);
  const latest = history[history.length - 1]!;
  assert.equal(latest.previousMark, before);
  assert.equal(latest.newMark, 19);
});

test('re-saving an unchanged mark records no spurious change', async () => {
  const sheet = await getMarkSheet(teacher(), quizId);
  const target = sheet.rows[2]!;

  const countBefore = (
    await db.select().from(markChanges).where(eq(markChanges.studentId, target.studentId))
  ).length;

  const result = await saveMarks(teacher(), {
    assessmentId: quizId,
    entries: [{ studentId: target.studentId, mark: target.mark, excused: false, note: '' }],
    submit: false,
  });

  assert.equal(result.changed, 0, 'nothing actually changed');

  const countAfter = (
    await db.select().from(markChanges).where(eq(markChanges.studentId, target.studentId))
  ).length;
  assert.equal(countAfter, countBefore, 'no history row for a non-change');
});

// ---------------------------------------------------------------------------
// Calculation, using each school's own configuration
// ---------------------------------------------------------------------------

test("school A's weighting produces the configured result", async () => {
  // Fresh subject with a full set of marks for one student.
  const student = A.studentIds[0]!;

  const quiz1 = await createAssessment(admin(), {
    sectionSubjectId: A.ssEnglishA,
    termId: A.termId,
    componentKey: 'quiz',
    instance: 1,
    title: 'Q1',
    maxMark: 100,
    assessedOn: '',
  });
  const quiz2 = await createAssessment(admin(), {
    sectionSubjectId: A.ssEnglishA,
    termId: A.termId,
    componentKey: 'quiz',
    instance: 2,
    title: 'Q2',
    maxMark: 100,
    assessedOn: '',
  });
  const mid = await createAssessment(admin(), {
    sectionSubjectId: A.ssEnglishA,
    termId: A.termId,
    componentKey: 'midterm',
    instance: 1,
    title: 'Mid',
    maxMark: 100,
    assessedOn: '',
  });
  const fin = await createAssessment(admin(), {
    sectionSubjectId: A.ssEnglishA,
    termId: A.termId,
    componentKey: 'final',
    instance: 1,
    title: 'Final',
    maxMark: 100,
    assessedOn: '',
  });

  // quiz avg 80 → 16 ; midterm 70 → 21 ; final 90 → 45 ; total 82
  await saveMarks(admin(), { assessmentId: quiz1.id, entries: [{ studentId: student, mark: 70, excused: false, note: '' }], submit: false });
  await saveMarks(admin(), { assessmentId: quiz2.id, entries: [{ studentId: student, mark: 90, excused: false, note: '' }], submit: false });
  await saveMarks(admin(), { assessmentId: mid.id, entries: [{ studentId: student, mark: 70, excused: false, note: '' }], submit: false });
  await saveMarks(admin(), { assessmentId: fin.id, entries: [{ studentId: student, mark: 90, excused: false, note: '' }], submit: false });

  const [result] = await db
    .select()
    .from(subjectResults)
    .where(
      and(
        eq(subjectResults.studentId, student),
        eq(subjectResults.termId, A.termId),
        eq(subjectResults.sectionSubjectId, A.ssEnglishA),
      ),
    );

  assert.ok(result, 'a subject result was cached');
  assert.equal(result!.percentage, 82, '0.2*80 + 0.3*70 + 0.5*90 = 82');
  assert.equal(result!.letter, 'B');
  assert.equal(result!.isPass, true);
  assert.equal(result!.isComplete, true);
});

test("school B's different weighting and drop-lowest produce a different result", async () => {
  const student = B.studentIds[0]!;
  const bAdmin = contextFor(B, B.adminUserId, ADMIN_PERMS);

  // coursework out of 50, four instances, lowest dropped
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const { id } = await createAssessment(bAdmin, {
      sectionSubjectId: B.ssMathA,
      termId: B.termId,
      componentKey: 'coursework',
      instance: i,
      title: `CW${i}`,
      maxMark: 50,
      assessedOn: '',
    });
    ids.push(id);
  }
  const fin = await createAssessment(bAdmin, {
    sectionSubjectId: B.ssMathA,
    termId: B.termId,
    componentKey: 'final',
    instance: 1,
    title: 'Final',
    maxMark: 100,
    assessedOn: '',
  });

  // 40/50=80, 45/50=90, 50/50=100, 25/50=50(dropped) → avg of best 3 = 90
  const scores = [40, 45, 50, 25];
  for (let i = 0; i < 4; i++) {
    await saveMarks(bAdmin, {
      assessmentId: ids[i]!,
      entries: [{ studentId: student, mark: scores[i]!, excused: false, note: '' }],
      submit: false,
    });
  }
  await saveMarks(bAdmin, {
    assessmentId: fin.id,
    entries: [{ studentId: student, mark: 70, excused: false, note: '' }],
    submit: false,
  });

  const [result] = await db
    .select()
    .from(subjectResults)
    .where(
      and(
        eq(subjectResults.studentId, student),
        eq(subjectResults.termId, B.termId),
        eq(subjectResults.sectionSubjectId, B.ssMathA),
      ),
    );

  // 0.4*90 + 0.6*70 = 36 + 42 = 78
  assert.equal(result!.percentage, 78, 'drop-lowest and 40/60 weighting applied');
  assert.equal(result!.isPass, true, '78 clears school B\u2019s higher 60% pass mark');
});

test('ranking appears only for the school that enables it', async () => {
  await recomputeSubjectResults(db, A.schoolId, A.ssEnglishA, A.termId);
  const [rankedA] = await db
    .select({ rank: subjectResults.rank })
    .from(subjectResults)
    .where(
      and(
        eq(subjectResults.studentId, A.studentIds[0]!),
        eq(subjectResults.sectionSubjectId, A.ssEnglishA),
        eq(subjectResults.termId, A.termId),
      ),
    );
  assert.ok(rankedA!.rank !== null, 'school A ranks');

  const [rankedB] = await db
    .select({ rank: subjectResults.rank })
    .from(subjectResults)
    .where(
      and(
        eq(subjectResults.studentId, B.studentIds[0]!),
        eq(subjectResults.sectionSubjectId, B.ssMathA),
        eq(subjectResults.termId, B.termId),
      ),
    );
  assert.equal(rankedB!.rank, null, 'school B deliberately does not rank');
});

test('term aggregates and GPA follow the school configuration', async () => {
  await recomputeTermResults(db, A.schoolId, A.sectionA, A.termId);
  await recomputeTermResults(db, B.schoolId, B.sectionA, B.termId);

  const [aggA] = await db
    .select()
    .from(termResults)
    .where(and(eq(termResults.studentId, A.studentIds[0]!), eq(termResults.termId, A.termId)));
  const [aggB] = await db
    .select()
    .from(termResults)
    .where(and(eq(termResults.studentId, B.studentIds[0]!), eq(termResults.termId, B.termId)));

  assert.ok(aggA!.average !== null);
  assert.equal(aggA!.gpa, null, 'school A does not use GPA');
  assert.ok(aggA!.rankInSection !== null, 'school A ranks');

  assert.ok(aggB!.gpa !== null, 'school B uses GPA');
  assert.equal(aggB!.rankInSection, null, 'school B does not rank');
});

test('a student term report reflects the school display settings', async () => {
  const report = await getStudentTermReport(db, A.schoolId, A.studentIds[0]!, A.termId);
  assert.ok(report);
  assert.equal(report!.showRank, true);
  assert.equal(report!.showGpa, false);
  assert.ok(report!.subjects.length >= 1);

  const reportB = await getStudentTermReport(db, B.schoolId, B.studentIds[0]!, B.termId);
  assert.equal(reportB!.showRank, false);
  assert.equal(reportB!.showGpa, true);
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

test('marks move draft → submitted → approved → locked', async () => {
  const { status: submitted } = await changeAssessmentStatus(teacher(), quizId, 'submit');
  assert.equal(submitted, 'submitted');

  const { status: approved } = await changeAssessmentStatus(admin(), quizId, 'approve');
  assert.equal(approved, 'approved');

  const { status: locked } = await changeAssessmentStatus(admin(), quizId, 'lock');
  assert.equal(locked, 'locked');
});

test('a teacher cannot approve their own marks', async () => {
  const { id } = await createAssessment(teacher(), {
    sectionSubjectId: A.ssMathA,
    termId: A.term2Id,
    componentKey: 'midterm',
    instance: 1,
    title: 'Self approval probe',
    maxMark: 100,
    assessedOn: '',
  });
  await changeAssessmentStatus(teacher(), id, 'submit');

  await assert.rejects(
    () => changeAssessmentStatus(teacher(), id, 'approve'),
    (error: unknown) => error instanceof GradebookError && error.status === 403,
    'approving requires grade.review, which a teacher does not hold',
  );
});

test('an invalid workflow transition is refused', async () => {
  // quizId is locked by now; it cannot be submitted again.
  await assert.rejects(
    () => changeAssessmentStatus(admin(), quizId, 'submit'),
    (error: unknown) => error instanceof GradebookError && error.status === 409,
  );
});

test('a locked mark cannot be changed without the override permission', async () => {
  const sheet = await getMarkSheet(teacher(), quizId);
  await assert.rejects(
    () =>
      saveMarks(teacher(), {
        assessmentId: quizId,
        entries: [{ studentId: sheet.rows[0]!.studentId, mark: 1, excused: false, note: '' }],
        submit: false,
      }),
    (error: unknown) => error instanceof GradebookError && error.status === 403,
  );
});

test('an override of a locked mark is permitted, recorded and flagged', async () => {
  const sheet = await getMarkSheet(admin(), quizId);
  const target = sheet.rows[0]!;

  const result = await saveMarks(admin(), {
    assessmentId: quizId,
    entries: [{ studentId: target.studentId, mark: 17, excused: false, note: '' }],
    submit: false,
  });
  assert.equal(result.changed, 1);

  const history = await db
    .select()
    .from(markChanges)
    .where(and(eq(markChanges.studentId, target.studentId), eq(markChanges.wasLocked, true)));
  assert.ok(history.length >= 1, 'the override is flagged in the history');

  const audits = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'grade.overrideLocked')));
  assert.ok(audits.length >= 1, 'and audited under its own action');
});

test('rejecting marks requires a reason and returns them to draft', async () => {
  const { id } = await createAssessment(teacher(), {
    sectionSubjectId: A.ssMathA,
    termId: A.term2Id,
    componentKey: 'final',
    instance: 1,
    title: 'Rejection probe',
    maxMark: 100,
    assessedOn: '',
  });
  await changeAssessmentStatus(teacher(), id, 'submit');

  const { status } = await changeAssessmentStatus(admin(), id, 'reject', 'Two marks are missing');
  assert.equal(status, 'draft');

  const [row] = await db.select().from(assessments).where(eq(assessments.id, id));
  assert.equal(row!.reviewNote, 'Two marks are missing');
  assert.equal(row!.submittedAt, null, 'the submission is cleared so it can be re-sent');
});

test('unlocking is audited and restores editability', async () => {
  const { status } = await changeAssessmentStatus(admin(), quizId, 'unlock', 'Correcting a transcription error');
  assert.equal(status, 'approved');

  const audits = await db
    .select({ reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'grade.unlock')));
  assert.ok(audits.some((a) => a.reason === 'Correcting a transcription error'));
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('a teacher may only enter marks for their own class subjects', async () => {
  const own = await checkGradebookAccess(teacher(), A.ssMathA, 'enter');
  assert.equal(own.allowed, true);

  const other = await checkGradebookAccess(teacher(), A.ssMathB, 'enter');
  assert.equal(other.allowed, false);
  assert.equal(other.allowed === false && other.status, 403);
});

test('a class subject from another school is reported as not found', async () => {
  const foreign = await checkGradebookAccess(teacher(), B.ssMathA, 'enter');
  assert.equal(foreign.allowed, false);
  assert.equal(
    foreign.allowed === false && foreign.status,
    404,
    'a 403 would confirm the id exists somewhere',
  );
});

test('a user without grade.enter cannot enter marks at all', async () => {
  const viewer = contextFor(A, A.otherTeacherId, ['grade.view'], {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });
  const result = await checkGradebookAccess(viewer, A.ssMathA, 'enter');
  assert.equal(result.allowed, false);
  assert.equal(result.allowed === false && result.status, 403);
});

test('a restricted teacher cannot browse another class\u2019s marks', async () => {
  const restricted = contextFor(
    A,
    A.teacherUserId,
    [...TEACHER_PERMS, 'restrict.ownSectionsOnly'],
    { sectionIds: [A.sectionA], sectionSubjectIds: [A.ssMathA] },
  );

  const own = await checkGradebookAccess(restricted, A.ssMathA, 'view');
  assert.equal(own.allowed, true);

  const other = await checkGradebookAccess(restricted, A.ssMathB, 'view');
  assert.equal(other.allowed, false);
  assert.equal(other.allowed === false && other.status, 404);
});

test('reading a mark sheet from another school is refused', async () => {
  const [foreign] = await db
    .select({ id: assessments.id })
    .from(assessments)
    .where(eq(assessments.schoolId, B.schoolId))
    .limit(1);

  await assert.rejects(
    () => getMarkSheet(admin(), foreign!.id),
    (error: unknown) => error instanceof GradebookError && error.status === 404,
    'even a school admin cannot reach another school\u2019s assessment',
  );
});

test('the teachable class list is limited to the teacher\u2019s own subjects', async () => {
  const mine = await getTeachableClassSubjects(teacher());
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.sectionSubjectId, A.ssMathA);

  const all = await getTeachableClassSubjects(admin());
  assert.ok(all.length >= 3, 'a reviewer sees every class');
  assert.ok(all.every((c) => c.sectionSubjectId !== B.ssMathA), 'but never another school\u2019s');
});

test('the class roster contains only currently enrolled students', async () => {
  const roster = await getClassRoster(teacher(), A.ssMathA);
  assert.equal(roster.length, 4);
  assert.ok(roster.every((r) => A.studentIds.includes(r.studentId)));

  // End one enrolment; the roster must shrink.
  await db
    .update(enrollments)
    .set({ endedOn: '2025-11-01' })
    .where(
      and(eq(enrollments.studentId, A.studentIds[3]!), eq(enrollments.schoolId, A.schoolId)),
    );

  const after = await getClassRoster(teacher(), A.ssMathA);
  assert.equal(after.length, 3, 'a withdrawn student is not on the mark sheet');

  await db
    .update(enrollments)
    .set({ endedOn: null })
    .where(
      and(eq(enrollments.studentId, A.studentIds[3]!), eq(enrollments.schoolId, A.schoolId)),
    );
});

test('listing assessments reports entry progress', async () => {
  const { assessments: list, config } = await listAssessments(teacher(), A.ssMathA, A.termId);
  assert.ok(list.length >= 2);
  assert.equal(config.source, 'school');

  const quiz = list.find((a) => a.id === quizId)!;
  assert.equal(quiz.markedCount, 4);
  assert.equal(quiz.studentCount, 4);
  assert.equal(quiz.componentName, 'Quiz');
});

test('creating an assessment writes an audit entry', async () => {
  const audits = await db
    .select({ summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'grade.enter')));
  assert.ok(audits.some((a) => /Created assessment/.test(a.summary ?? '')));
});

// ---------------------------------------------------------------------------
// Regression: correlated subqueries must reference the OUTER table
// ---------------------------------------------------------------------------

/**
 * A correlated subquery written as `where e.section_id = ${sections.id}`
 * renders a bare "id", which Postgres happily resolves against the SUBQUERY's
 * own table. The query does not error — it silently returns 0 for every row.
 * That shipped in the dashboard and in attendance before it was caught here,
 * so both the shape and its consequences are pinned by tests.
 */
test('assessment progress counts real marks, not zero', async () => {
  const { assessments: list } = await listAssessments(teacher(), A.ssMathA, A.termId);
  const quiz = list.find((a) => a.id === quizId)!;

  const truth = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marks)
    .where(
      and(eq(marks.assessmentId, quizId), sql`(${marks.mark} is not null or ${marks.isExcused})`),
    );

  assert.equal(quiz.markedCount, truth[0]!.n);
  assert.ok(quiz.markedCount > 0, 'a correlated subquery returning 0 for everything is the bug');
});

test('teachable class list reports a real student count', async () => {
  const mine = await getTeachableClassSubjects(teacher());
  const cls = mine.find((c) => c.sectionSubjectId === A.ssMathA)!;

  const truth = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.sectionId, A.sectionA),
        sql`${enrollments.endedOn} is null`,
        eq(enrollments.status, 'enrolled'),
      ),
    );

  assert.equal(cls.studentCount, truth[0]!.n);
  assert.ok(cls.studentCount > 0);
});
