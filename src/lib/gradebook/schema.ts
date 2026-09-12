/**
 * Gradebook validation schemas, shared by the client and the server.
 *
 * The same schema object is imported by the form and by the route handler, so
 * a rule can never be enforced in one place and forgotten in the other. The
 * server always re-validates: a client check is a courtesy to the user, not a
 * security boundary.
 *
 * Marks are submitted a whole class at a time. A teacher entering 50 marks on a
 * slow connection must not make 50 requests.
 */

import { z } from 'zod';

export const ASSESSMENT_STATUSES = ['draft', 'submitted', 'approved', 'locked'] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export const REPORT_CARD_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'published',
] as const;
export type ReportCardStatus = (typeof REPORT_CARD_STATUSES)[number];

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A valid date is required');

/** Creating a piece of assessed work. */
export const createAssessmentSchema = z.object({
  sectionSubjectId: z.string().min(1, 'A class subject is required'),
  termId: z.string().min(1, 'A term is required'),
  /** Must match a key in the school's configured assessment structure. */
  componentKey: z
    .string()
    .trim()
    .min(1, 'An assessment type is required')
    .max(32),
  instance: z.coerce.number().int().min(1).max(20).default(1),
  title: z.string().trim().min(1, 'A title is required').max(120),
  titleAm: z.string().trim().max(120).optional().or(z.literal('')),
  maxMark: z.coerce
    .number()
    .positive('The maximum mark must be greater than zero')
    .max(1000, 'The maximum mark is unrealistically large'),
  assessedOn: isoDate.optional().or(z.literal('')),
});
export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;

export const updateAssessmentSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  titleAm: z.string().trim().max(120).optional().or(z.literal('')),
  maxMark: z.coerce.number().positive().max(1000).optional(),
  assessedOn: isoDate.optional().or(z.literal('')),
});

/**
 * One student's mark within a submitted batch.
 *
 * `mark: null` means "not entered". `excused: true` means the student did not
 * sit it and it must be dropped from the average rather than scored zero —
 * these are different things and the UI offers both.
 */
export const markEntrySchema = z
  .object({
    studentId: z.string().min(1),
    /**
     * Three states must survive parsing: a number, "not entered" (null), and
     * "excused" (also null, flagged separately).
     *
     * `z.coerce.number()` must never see null or an empty string: Number(null)
     * and Number('') are both 0, so a blank box would be stored as a scored
     * nought and silently drag the pupil's average down. Empty input is
     * normalised to null *before* any coercion is attempted.
     */
    mark: z
      .preprocess(
        (v) => (v === null || v === undefined || v === '' ? null : v),
        z.union([z.null(), z.coerce.number()]),
      )
      .transform((v) => (v === undefined ? null : v)),
    excused: z.boolean().default(false),
    note: z.string().trim().max(300).optional().or(z.literal('')),
  })
  .refine((m) => !(m.excused && m.mark !== null), {
    message: 'An excused student cannot also have a mark',
    path: ['mark'],
  })
  .refine((m) => m.mark === null || (Number.isFinite(m.mark) && m.mark >= 0), {
    message: 'A mark cannot be negative',
    path: ['mark'],
  });

/** A whole class's marks for one assessment. */
export const saveMarksSchema = z.object({
  assessmentId: z.string().min(1),
  entries: z.array(markEntrySchema).min(1, 'At least one mark is required'),
  /** Set when the teacher is finished and wants it reviewed. */
  submit: z.boolean().default(false),
});
export type SaveMarksInput = z.infer<typeof saveMarksSchema>;

/**
 * Changing the workflow state of an assessment.
 *
 * A reason is required when sending marks back or reopening a locked
 * assessment: those are the actions someone will later be asked to justify.
 */
export const assessmentWorkflowSchema = z
  .object({
    action: z.enum(['submit', 'approve', 'reject', 'lock', 'unlock']),
    reason: z.string().trim().max(500).optional().or(z.literal('')),
  })
  .refine((v) => !['reject', 'unlock'].includes(v.action) || (v.reason ?? '').trim().length > 0, {
    message: 'A reason is required',
    path: ['reason'],
  });

/** Editing a single mark after the fact (correction path). */
export const correctMarkSchema = z
  .object({
    mark: z.union([z.coerce.number().min(0), z.null()]),
    excused: z.boolean().default(false),
    reason: z.string().trim().max(500).optional().or(z.literal('')),
  })
  .refine((m) => !(m.excused && m.mark !== null), {
    message: 'An excused student cannot also have a mark',
    path: ['mark'],
  });

/** Report-card generation for a whole class or a single student. */
export const generateReportCardsSchema = z
  .object({
    termId: z.string().min(1, 'A term is required'),
    sectionId: z.string().min(1).optional(),
    studentId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.sectionId ?? v.studentId), {
    message: 'Choose a class or a student',
    path: ['sectionId'],
  });

export const reportCardCommentSchema = z.object({
  classTeacherComment: z.string().trim().max(1000).optional().or(z.literal('')),
  principalComment: z.string().trim().max(1000).optional().or(z.literal('')),
  conduct: z.string().trim().max(32).optional().or(z.literal('')),
});

export const reportCardWorkflowSchema = z
  .object({
    action: z.enum(['submit', 'approve', 'publish', 'unpublish']),
    reason: z.string().trim().max(500).optional().or(z.literal('')),
  })
  .refine((v) => v.action !== 'unpublish' || (v.reason ?? '').trim().length > 0, {
    message: 'A reason is required to withdraw a published report card',
    path: ['reason'],
  });

/** A named, reusable assessment structure. */
export const gradingConfigSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(80),
  nameAm: z.string().trim().max(80).optional().or(z.literal('')),
  description: z.string().trim().max(300).optional().or(z.literal('')),
  passMarkPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  components: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(32),
        name: z.string().trim().min(1).max(64),
        nameAm: z.string().trim().max(64).optional(),
        weightPercent: z.coerce.number().min(0).max(100),
        maxMark: z.coerce.number().positive().max(1000).default(100),
        instances: z.coerce.number().int().min(1).max(20).default(1),
        dropLowest: z.coerce.number().int().min(0).max(10).default(0),
        sortOrder: z.coerce.number().int().default(0),
      }),
    )
    .min(1, 'At least one assessment component is required')
    .refine(
      (components) => {
        const total = components.reduce((sum, c) => sum + c.weightPercent, 0);
        // Tolerance for schools using thirds (33.33 x 3).
        return Math.abs(total - 100) < 0.5;
      },
      { message: 'Component weights must add up to 100%' },
    )
    .refine(
      (components) => new Set(components.map((c) => c.key)).size === components.length,
      { message: 'Each component needs a distinct key' },
    )
    .refine((components) => components.every((c) => c.dropLowest < c.instances), {
      message: 'Cannot drop as many instances as exist — nothing would be left to count',
    }),
});
export type GradingConfigInput = z.infer<typeof gradingConfigSchema>;
