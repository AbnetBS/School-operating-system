import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSubjectResult,
  calculateTermAggregate,
  rankStudents,
  resolveBand,
  validateMark,
  performanceTrend,
  GradingError,
  type RawMark,
} from '../src/lib/grading/calculate.ts';
import { SCHOOL_PRESETS, ETHIOPIAN_STANDARD_BANDS } from '../src/lib/settings/presets.ts';
import { gradingSettingsSchema } from '../src/lib/settings/schemas.ts';

const schoolA = gradingSettingsSchema.parse(SCHOOL_PRESETS.threeTermPrimary!.grading);
const schoolB = gradingSettingsSchema.parse(SCHOOL_PRESETS.twoSemesterSecondary!.grading);

test('two schools with different weightings both calculate correctly', () => {
  // School A: quiz 10, assignment 10, test 20, midterm 20, final 40
  const marksA: RawMark[] = [
    { componentKey: 'quiz', instance: 1, mark: 80 },
    { componentKey: 'quiz', instance: 2, mark: 90 },
    { componentKey: 'assignment', instance: 1, mark: 100 },
    { componentKey: 'assignment', instance: 2, mark: 90 },
    { componentKey: 'test', mark: 70 },
    { componentKey: 'midterm', mark: 60 },
    { componentKey: 'final', mark: 75 },
  ];
  const a = calculateSubjectResult(marksA, schoolA);
  // quiz avg 85*0.10=8.5, assignment 95*0.10=9.5, test 70*0.20=14,
  // midterm 60*0.20=12, final 75*0.40=30  => 74
  assert.equal(a.provisionalPercentage, 74);
  assert.equal(a.letter, 'C');
  assert.equal(a.isPass, true);
  assert.equal(a.isComplete, true);

  // School B: classwork 20 (best 2 of 3), test 20, midterm 25, final 35
  const marksB: RawMark[] = [
    { componentKey: 'classwork', instance: 1, mark: 60 },
    { componentKey: 'classwork', instance: 2, mark: 90 },
    { componentKey: 'classwork', instance: 3, mark: 80 },
    { componentKey: 'test', instance: 1, mark: 70 },
    { componentKey: 'test', instance: 2, mark: 80 },
    { componentKey: 'midterm', mark: 88 },
    { componentKey: 'final', mark: 92 },
  ];
  const b = calculateSubjectResult(marksB, schoolB);
  // classwork drops lowest (60): avg(90,80)=85 *0.20 = 17
  // test avg 75 *0.20 = 15; midterm 88*0.25 = 22; final 92*0.35 = 32.2 => 86.2
  assert.equal(b.provisionalPercentage, 86.2);
  assert.equal(b.letter, 'B+');
  assert.equal(b.isPass, true);
});

test('drop-lowest never drops every instance', () => {
  const marks: RawMark[] = [{ componentKey: 'classwork', instance: 1, mark: 50 }];
  const r = calculateSubjectResult(marks, schoolB);
  const classwork = r.components.find((c) => c.key === 'classwork')!;
  assert.equal(classwork.percentage, 50);
  assert.equal(classwork.dropped, 0);
});

test('components with different maximum marks combine correctly', () => {
  const settings = gradingSettingsSchema.parse({
    passMarkPercent: 50,
    bands: ETHIOPIAN_STANDARD_BANDS,
    components: [
      { key: 'quiz', name: 'Quiz', weightPercent: 50, maxMark: 20, instances: 1 },
      { key: 'final', name: 'Final', weightPercent: 50, maxMark: 100, instances: 1 },
    ],
  });
  // 10/20 = 50%, 80/100 = 80% => (50*0.5)+(80*0.5) = 65
  const r = calculateSubjectResult(
    [
      { componentKey: 'quiz', mark: 10 },
      { componentKey: 'final', mark: 80 },
    ],
    settings,
  );
  assert.equal(r.provisionalPercentage, 65);
});

test('partial marks: percentage normalises, provisional assumes zero', () => {
  // Only the midterm (20%) is entered, scoring 90.
  const r = calculateSubjectResult([{ componentKey: 'midterm', mark: 90 }], schoolA);
  assert.equal(r.percentage, 90); // 90% of the marked portion
  assert.equal(r.provisionalPercentage, 18); // 90 * 0.20 of the whole
  assert.equal(r.completedWeight, 20);
  assert.equal(r.isComplete, false);
  // Grading uses the normalised figure while incomplete, so a strong student
  // is not shown as failing mid-term.
  assert.equal(r.letter, 'A');
});

test('no marks entered yields nulls rather than zero', () => {
  const r = calculateSubjectResult([], schoolA);
  assert.equal(r.percentage, null);
  assert.equal(r.provisionalPercentage, 0);
  assert.equal(r.letter, null);
  assert.equal(r.isPass, null);
  assert.equal(r.isComplete, false);
});

test('missing configuration is an error, not a silent zero', () => {
  const empty = gradingSettingsSchema.parse({ components: [], bands: [] });
  assert.throws(() => calculateSubjectResult([], empty), GradingError);
});

test('band resolution including boundaries and gaps', () => {
  assert.equal(resolveBand(90, ETHIOPIAN_STANDARD_BANDS)?.letter, 'A');
  assert.equal(resolveBand(89.99, ETHIOPIAN_STANDARD_BANDS)?.letter, 'B');
  assert.equal(resolveBand(50, ETHIOPIAN_STANDARD_BANDS)?.letter, 'D');
  assert.equal(resolveBand(49.99, ETHIOPIAN_STANDARD_BANDS)?.letter, 'F');
  assert.equal(resolveBand(0, ETHIOPIAN_STANDARD_BANDS)?.letter, 'F');
  assert.equal(resolveBand(100, ETHIOPIAN_STANDARD_BANDS)?.letter, 'A');
  // A gap in configuration still yields a grade rather than null.
  const gapped = [
    { letter: 'A', minPercent: 90, maxPercent: 100, isPass: true },
    { letter: 'F', minPercent: 0, maxPercent: 49, isPass: false },
  ];
  assert.equal(resolveBand(70, gapped)?.letter, 'F');
});

test('mark validation rejects impossible values', () => {
  assert.equal(validateMark(50, 100).ok, true);
  assert.equal(validateMark(100, 100).ok, true);
  assert.equal(validateMark(null, 100).ok, true);
  assert.equal(validateMark(101, 100).ok, false);
  assert.equal(validateMark(-1, 100).ok, false);
  assert.equal(validateMark(Number.NaN, 100).ok, false);
  assert.equal(validateMark(Infinity, 100).ok, false);
  const r = validateMark(150, 100);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /maximum of 100/);
});

test('weights must total 100 percent', () => {
  const bad = gradingSettingsSchema.safeParse({
    components: [
      { key: 'a', name: 'A', weightPercent: 40, maxMark: 100, instances: 1 },
      { key: 'b', name: 'B', weightPercent: 40, maxMark: 100, instances: 1 },
    ],
  });
  assert.equal(bad.success, false);

  // Thirds must be accepted despite not summing exactly to 100.
  const thirds = gradingSettingsSchema.safeParse({
    components: [
      { key: 'a', name: 'A', weightPercent: 33.33, maxMark: 100, instances: 1 },
      { key: 'b', name: 'B', weightPercent: 33.33, maxMark: 100, instances: 1 },
      { key: 'c', name: 'C', weightPercent: 33.34, maxMark: 100, instances: 1 },
    ],
  });
  assert.equal(thirds.success, true);
});

test('overlapping grade bands are rejected', () => {
  const bad = gradingSettingsSchema.safeParse({
    bands: [
      { letter: 'A', minPercent: 80, maxPercent: 100, isPass: true },
      { letter: 'B', minPercent: 70, maxPercent: 85, isPass: true },
    ],
  });
  assert.equal(bad.success, false);
});

test('term aggregate honours credit weights and non-counting subjects', () => {
  const agg = calculateTermAggregate(
    [
      { subjectId: '1', subjectName: 'Maths', percentage: 80, points: 3, creditWeight: 2, countsTowardAverage: true, isPass: true },
      { subjectId: '2', subjectName: 'English', percentage: 60, points: 2, creditWeight: 1, countsTowardAverage: true, isPass: true },
      { subjectId: '3', subjectName: 'PE', percentage: 100, points: 4, creditWeight: 1, countsTowardAverage: false, isPass: true },
    ],
    { passMarkPercent: 50, decimalPlaces: 1, useGpa: true },
  );
  // (80*2 + 60*1) / 3 = 73.3 — PE excluded
  assert.equal(agg.average, 73.3);
  assert.equal(agg.gpa, 2.67);
  assert.equal(agg.passedSubjects, 3);
  assert.equal(agg.isPass, true);
});

test('a failed subject blocks an overall pass even with a good average', () => {
  const agg = calculateTermAggregate(
    [
      { subjectId: '1', subjectName: 'Maths', percentage: 95, points: 4, creditWeight: 1, countsTowardAverage: true, isPass: true },
      { subjectId: '2', subjectName: 'Physics', percentage: 40, points: 0, creditWeight: 1, countsTowardAverage: true, isPass: false },
    ],
    { passMarkPercent: 50, decimalPlaces: 1, useGpa: false },
  );
  assert.equal(agg.average, 67.5);
  assert.equal(agg.failedSubjects, 1);
  assert.equal(agg.isPass, false);
});

test('ranking uses competition ranking for ties', () => {
  const ranked = rankStudents([
    { studentId: 'a', average: 90 },
    { studentId: 'b', average: 85 },
    { studentId: 'c', average: 85 },
    { studentId: 'd', average: 70 },
    { studentId: 'e', average: null },
  ]);
  const byId = Object.fromEntries(ranked.map((r) => [r.studentId, r.rank]));
  assert.equal(byId.a, 1);
  assert.equal(byId.b, 2);
  assert.equal(byId.c, 2); // tie shares position
  assert.equal(byId.d, 4); // next rank skips 3
  assert.equal(byId.e, null); // unranked without an average
});

test('performance trend detection', () => {
  assert.equal(performanceTrend([58, 64, 72]), 'improving');
  assert.equal(performanceTrend([72, 64, 58]), 'declining');
  assert.equal(performanceTrend([70, 70.5, 71]), 'stable');
  assert.equal(performanceTrend([70]), 'insufficient_data');
  assert.equal(performanceTrend([null, null]), 'insufficient_data');
  assert.equal(performanceTrend([null, 60, 80]), 'improving');
});

test('kindergarten preset works with descriptive bands and no ranking', () => {
  const kg = gradingSettingsSchema.parse(SCHOOL_PRESETS.kindergarten!.grading);
  assert.equal(kg.useRanking, false);
  const r = calculateSubjectResult(
    [
      { componentKey: 'observation', mark: 85 },
      { componentKey: 'activity', mark: 75 },
    ],
    kg,
  );
  // 85*0.6 + 75*0.4 = 81
  assert.equal(r.provisionalPercentage, 81);
  assert.equal(r.letter, 'E');
});
