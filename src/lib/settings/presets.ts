/**
 * Configuration presets for common Ethiopian school structures.
 *
 * These are starting points offered during setup, not fixed behaviour. A
 * school picks the closest preset and then edits any of it. The presets exist
 * to prove the configurability claim: two schools with genuinely different
 * academic and grading structures are represented purely as data.
 */

import type { GradingSettings, AcademicSettings, GradeBand } from './schemas.ts';

/**
 * Grade bands used widely in Ethiopian general education.
 * A ≥ 90, B 80–89, C 60–79, D 50–59, F < 50.
 */
export const ETHIOPIAN_STANDARD_BANDS: GradeBand[] = [
  { letter: 'A', minPercent: 90, maxPercent: 100, points: 4, description: 'Excellent', descriptionAm: 'እጅግ በጣም ጥሩ', isPass: true },
  { letter: 'B', minPercent: 80, maxPercent: 89.99, points: 3, description: 'Very good', descriptionAm: 'በጣም ጥሩ', isPass: true },
  { letter: 'C', minPercent: 60, maxPercent: 79.99, points: 2, description: 'Good', descriptionAm: 'ጥሩ', isPass: true },
  { letter: 'D', minPercent: 50, maxPercent: 59.99, points: 1, description: 'Satisfactory', descriptionAm: 'አጥጋቢ', isPass: true },
  { letter: 'F', minPercent: 0, maxPercent: 49.99, points: 0, description: 'Fail', descriptionAm: 'ወድቋል', isPass: false },
];

/** A finer scale used by some private and international-track schools. */
export const EXTENDED_BANDS: GradeBand[] = [
  { letter: 'A+', minPercent: 95, maxPercent: 100, points: 4, description: 'Outstanding', isPass: true },
  { letter: 'A', minPercent: 90, maxPercent: 94.99, points: 4, description: 'Excellent', isPass: true },
  { letter: 'B+', minPercent: 85, maxPercent: 89.99, points: 3.5, description: 'Very good', isPass: true },
  { letter: 'B', minPercent: 80, maxPercent: 84.99, points: 3, description: 'Good', isPass: true },
  { letter: 'C+', minPercent: 70, maxPercent: 79.99, points: 2.5, description: 'Above average', isPass: true },
  { letter: 'C', minPercent: 60, maxPercent: 69.99, points: 2, description: 'Average', isPass: true },
  { letter: 'D', minPercent: 50, maxPercent: 59.99, points: 1, description: 'Below average', isPass: true },
  { letter: 'F', minPercent: 0, maxPercent: 49.99, points: 0, description: 'Fail', isPass: false },
];

export type SchoolPreset = {
  key: string;
  name: string;
  description: string;
  academic: Partial<AcademicSettings>;
  grading: Partial<GradingSettings>;
};

export const SCHOOL_PRESETS: Record<string, SchoolPreset> = {
  /**
   * Primary / general secondary school on three terms with continuous
   * assessment — the most common structure in Ethiopian schools.
   */
  threeTermPrimary: {
    key: 'threeTermPrimary',
    name: 'Three-term primary / secondary',
    description:
      'Grades 1–8 or 1–12 on three terms, with continuous assessment and a final exam each term.',
    academic: {
      termStructure: 'term',
      termsPerYear: 3,
      useSubjectSelection: false,
      studentCodeFormat: '{year}/{seq}',
    },
    grading: {
      displayMode: 'both',
      passMarkPercent: 50,
      useRanking: true,
      rankScope: 'section',
      useGpa: false,
      bands: ETHIOPIAN_STANDARD_BANDS,
      components: [
        { key: 'quiz', name: 'Quiz', nameAm: 'ፈጣን ፈተና', weightPercent: 10, maxMark: 100, instances: 2, dropLowest: 0, sortOrder: 1 },
        { key: 'assignment', name: 'Assignment', nameAm: 'የቤት ሥራ', weightPercent: 10, maxMark: 100, instances: 2, dropLowest: 0, sortOrder: 2 },
        { key: 'test', name: 'Test', nameAm: 'ፈተና', weightPercent: 20, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 3 },
        { key: 'midterm', name: 'Mid-term exam', nameAm: 'የመንፈቅ ፈተና', weightPercent: 20, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 4 },
        { key: 'final', name: 'Final exam', nameAm: 'የመጨረሻ ፈተና', weightPercent: 40, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 5 },
      ],
    },
  },

  /**
   * Preparatory / secondary school on two semesters, with streams and GPA —
   * the structure used for Grades 9–12 in many schools.
   */
  twoSemesterSecondary: {
    key: 'twoSemesterSecondary',
    name: 'Two-semester secondary / preparatory',
    description:
      'Grades 9–12 on two semesters with natural and social science streams, GPA and no ranking.',
    academic: {
      termStructure: 'semester',
      termsPerYear: 2,
      useSubjectSelection: true,
      studentCodeFormat: '{year}-{seq}',
    },
    grading: {
      displayMode: 'both',
      passMarkPercent: 50,
      useRanking: false,
      useGpa: true,
      bands: EXTENDED_BANDS,
      components: [
        { key: 'classwork', name: 'Classwork', nameAm: 'የክፍል ሥራ', weightPercent: 20, maxMark: 100, instances: 3, dropLowest: 1, sortOrder: 1 },
        { key: 'test', name: 'Test', nameAm: 'ፈተና', weightPercent: 20, maxMark: 100, instances: 2, dropLowest: 0, sortOrder: 2 },
        { key: 'midterm', name: 'Mid-semester exam', nameAm: 'የመንፈቅ ፈተና', weightPercent: 25, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 3 },
        { key: 'final', name: 'Final exam', nameAm: 'የመጨረሻ ፈተና', weightPercent: 35, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 4 },
      ],
    },
  },

  /** Kindergarten: descriptive assessment, no marks, no ranking. */
  kindergarten: {
    key: 'kindergarten',
    name: 'Kindergarten',
    description: 'KG levels with descriptive assessment rather than numeric marks.',
    academic: {
      termStructure: 'term',
      termsPerYear: 3,
      useSubjectSelection: false,
    },
    grading: {
      displayMode: 'letter',
      passMarkPercent: 0,
      useRanking: false,
      useGpa: false,
      bands: [
        { letter: 'E', minPercent: 80, maxPercent: 100, description: 'Excellent', descriptionAm: 'በጣም ጥሩ', isPass: true },
        { letter: 'V', minPercent: 60, maxPercent: 79.99, description: 'Very good', descriptionAm: 'ጥሩ', isPass: true },
        { letter: 'G', minPercent: 40, maxPercent: 59.99, description: 'Good', descriptionAm: 'አጥጋቢ', isPass: true },
        { letter: 'N', minPercent: 0, maxPercent: 39.99, description: 'Needs support', descriptionAm: 'ድጋፍ ይፈልጋል', isPass: true },
      ],
      components: [
        { key: 'observation', name: 'Continuous observation', nameAm: 'ቀጣይ ምልከታ', weightPercent: 60, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 1 },
        { key: 'activity', name: 'Activity', nameAm: 'ተግባር', weightPercent: 40, maxMark: 100, instances: 1, dropLowest: 0, sortOrder: 2 },
      ],
    },
  },
};

export const PRESET_KEYS = Object.keys(SCHOOL_PRESETS);
