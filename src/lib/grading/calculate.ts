/**
 * Grading calculation engine.
 *
 * Takes a school's configured assessment structure and a set of raw marks, and
 * produces the subject total, percentage, letter grade and pass/fail result.
 *
 * The whole point is that the rules come from configuration. A school using
 * Quiz 10 / Assignment 10 / Test 20 / Mid 20 / Final 40 and a school using
 * Classwork 20 / Test 20 / Mid 25 / Final 35 both work here without a code
 * change — which is what §13 of the specification requires.
 *
 * Pure functions only: no database, no I/O, fully unit-testable.
 */

import type { AssessmentComponent, GradeBand, GradingSettings } from '../settings/schemas.ts';

export type RawMark = {
  /** Component key, e.g. 'quiz'. */
  componentKey: string;
  /** Which instance of a repeated component (1-based). */
  instance?: number;
  /** Mark achieved, or null when not yet entered / excused. */
  mark: number | null;
  /** Overrides the component's maxMark when an individual assessment differs. */
  maxMark?: number;
};

export type ComponentResult = {
  key: string;
  name: string;
  weightPercent: number;
  /** Average of the counted instances, as a percentage of that component. */
  percentage: number | null;
  /** The component's contribution to the subject total. */
  weightedScore: number | null;
  /** Marks that were entered for this component. */
  entered: number;
  expected: number;
  /** Instances dropped by a "drop lowest" rule. */
  dropped: number;
  isComplete: boolean;
};

export type SubjectResult = {
  components: ComponentResult[];
  /** Percentage over the components that have marks. */
  percentage: number | null;
  /** Percentage assuming unmarked components score zero — the "if nothing else is entered" view. */
  provisionalPercentage: number | null;
  letter: string | null;
  points: number | null;
  isPass: boolean | null;
  isComplete: boolean;
  /** Total weight of components that have been marked. */
  completedWeight: number;
};

export class GradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GradingError';
  }
}

/**
 * Validate a mark before it is stored.
 * Rejecting a mark above the maximum at this layer means the rule holds no
 * matter which entry point is used — the UI, the API, or a bulk import.
 */
export function validateMark(
  mark: number | null,
  maxMark: number,
): { ok: true } | { ok: false; error: string } {
  if (mark === null) return { ok: true };
  if (typeof mark !== 'number' || !Number.isFinite(mark)) {
    return { ok: false, error: 'Mark must be a number.' };
  }
  if (mark < 0) return { ok: false, error: 'Mark cannot be negative.' };
  if (mark > maxMark) {
    return { ok: false, error: `Mark cannot be greater than the maximum of ${maxMark}.` };
  }
  return { ok: true };
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Compute one component's percentage, applying any "drop lowest" rule. */
function computeComponent(component: AssessmentComponent, marks: RawMark[]): ComponentResult {
  const relevant = marks.filter((m) => m.componentKey === component.key);
  const entered = relevant.filter((m) => m.mark !== null);

  const base: ComponentResult = {
    key: component.key,
    name: component.name,
    weightPercent: component.weightPercent,
    percentage: null,
    weightedScore: null,
    entered: entered.length,
    expected: component.instances,
    dropped: 0,
    isComplete: false,
  };

  if (entered.length === 0) return base;

  // Convert each mark to a percentage of its own maximum, so components with
  // different maxima (a 20-mark quiz, a 100-mark exam) combine correctly.
  const percentages = entered.map((m) => {
    const max = m.maxMark ?? component.maxMark;
    if (!(max > 0)) throw new GradingError(`Component "${component.key}" has an invalid maximum`);
    return (m.mark! / max) * 100;
  });

  // Drop the lowest N, but never drop everything.
  let counted = percentages;
  let dropped = 0;
  if (component.dropLowest > 0 && percentages.length > component.dropLowest) {
    counted = [...percentages].sort((a, b) => b - a).slice(0, percentages.length - component.dropLowest);
    dropped = percentages.length - counted.length;
  }

  const average = counted.reduce((s, p) => s + p, 0) / counted.length;

  return {
    ...base,
    percentage: average,
    weightedScore: (average * component.weightPercent) / 100,
    dropped,
    isComplete: entered.length >= component.instances - component.dropLowest,
  };
}

/** Find the band a percentage falls into. */
export function resolveBand(percentage: number, bands: GradeBand[]): GradeBand | null {
  for (const band of bands) {
    if (percentage >= band.minPercent && percentage <= band.maxPercent) return band;
  }
  // Guard against gaps in a school's configured bands: fall back to the
  // closest band below, so a valid mark always yields a grade.
  const below = bands
    .filter((b) => b.minPercent <= percentage)
    .sort((a, b) => b.minPercent - a.minPercent);
  return below[0] ?? null;
}

/**
 * Calculate a subject result from raw marks and a grading configuration.
 *
 * `percentage` normalises over the components actually marked, so a mid-term
 * view is meaningful before the final exam is entered. `provisionalPercentage`
 * treats missing components as zero, which is what the final result becomes if
 * nothing further is entered.
 */
export function calculateSubjectResult(
  marks: RawMark[],
  settings: Pick<GradingSettings, 'components' | 'bands' | 'passMarkPercent' | 'decimalPlaces' | 'roundTotals'>,
  componentOverride?: AssessmentComponent[],
): SubjectResult {
  const components = componentOverride ?? settings.components;

  if (components.length === 0) {
    throw new GradingError(
      'No assessment components are configured. Configure the gradebook before entering marks.',
    );
  }

  const results = components.map((c) => computeComponent(c, marks));

  const completedWeight = results
    .filter((r) => r.percentage !== null)
    .reduce((s, r) => s + r.weightPercent, 0);

  const totalWeight = components.reduce((s, c) => s + c.weightPercent, 0);
  const earned = results.reduce((s, r) => s + (r.weightedScore ?? 0), 0);

  const dp = settings.decimalPlaces ?? 1;

  // Normalised over marked components only.
  const percentage = completedWeight > 0 ? round((earned / completedWeight) * 100, dp) : null;
  // Assuming everything unmarked scores zero.
  const provisionalPercentage = totalWeight > 0 ? round((earned / totalWeight) * 100, dp) : null;

  const isComplete = results.every((r) => r.isComplete);
  // Grade against the final figure once complete; against progress until then.
  const gradingBasis = isComplete ? provisionalPercentage : percentage;

  const band = gradingBasis === null ? null : resolveBand(gradingBasis, settings.bands);

  return {
    components: results.map((r) => ({
      ...r,
      percentage: r.percentage === null ? null : round(r.percentage, dp),
      weightedScore: r.weightedScore === null ? null : round(r.weightedScore, dp),
    })),
    percentage,
    provisionalPercentage,
    letter: band?.letter ?? null,
    points: band?.points ?? null,
    isPass: gradingBasis === null ? null : gradingBasis >= settings.passMarkPercent,
    isComplete,
    completedWeight,
  };
}

// ---------------------------------------------------------------------------
// Aggregates across subjects
// ---------------------------------------------------------------------------

export type SubjectScore = {
  subjectId: string;
  subjectName: string;
  percentage: number | null;
  points: number | null;
  creditWeight: number;
  countsTowardAverage: boolean;
  isPass: boolean | null;
};

export type TermAggregate = {
  average: number | null;
  gpa: number | null;
  totalSubjects: number;
  passedSubjects: number;
  failedSubjects: number;
  incompleteSubjects: number;
  isPass: boolean | null;
};

/** Average and GPA across a student's subjects for a term. */
export function calculateTermAggregate(
  scores: SubjectScore[],
  settings: Pick<GradingSettings, 'passMarkPercent' | 'decimalPlaces' | 'useGpa'>,
): TermAggregate {
  const counted = scores.filter((s) => s.countsTowardAverage && s.percentage !== null);
  const dp = settings.decimalPlaces ?? 1;

  const totalCredit = counted.reduce((s, x) => s + x.creditWeight, 0);
  const average =
    totalCredit > 0
      ? round(counted.reduce((s, x) => s + x.percentage! * x.creditWeight, 0) / totalCredit, dp)
      : null;

  let gpa: number | null = null;
  if (settings.useGpa) {
    const withPoints = counted.filter((s) => s.points !== null);
    const gpaCredit = withPoints.reduce((s, x) => s + x.creditWeight, 0);
    gpa =
      gpaCredit > 0
        ? round(withPoints.reduce((s, x) => s + x.points! * x.creditWeight, 0) / gpaCredit, 2)
        : null;
  }

  const passed = scores.filter((s) => s.isPass === true).length;
  const failed = scores.filter((s) => s.isPass === false).length;
  const incomplete = scores.filter((s) => s.isPass === null).length;

  return {
    average,
    gpa,
    totalSubjects: scores.length,
    passedSubjects: passed,
    failedSubjects: failed,
    incompleteSubjects: incomplete,
    isPass: average === null ? null : average >= settings.passMarkPercent && failed === 0,
  };
}

/**
 * Rank students by average, using competition ranking so that ties share a
 * position and the next rank skips accordingly (1, 2, 2, 4).
 */
export function rankStudents<T extends { studentId: string; average: number | null }>(
  students: T[],
): (T & { rank: number | null })[] {
  const ranked = students
    .filter((s) => s.average !== null)
    .sort((a, b) => b.average! - a.average!);

  const withRank = new Map<string, number>();
  let position = 0;
  let previousAverage: number | null = null;
  ranked.forEach((s, index) => {
    if (previousAverage === null || s.average! < previousAverage) {
      position = index + 1;
      previousAverage = s.average!;
    }
    withRank.set(s.studentId, position);
  });

  return students.map((s) => ({ ...s, rank: withRank.get(s.studentId) ?? null }));
}

/** Classify a performance trend across successive term averages. */
export function performanceTrend(
  averages: (number | null)[],
): 'improving' | 'declining' | 'stable' | 'insufficient_data' {
  const values = averages.filter((a): a is number => a !== null);
  if (values.length < 2) return 'insufficient_data';
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const delta = last - first;
  if (Math.abs(delta) < 2) return 'stable';
  return delta > 0 ? 'improving' : 'declining';
}
