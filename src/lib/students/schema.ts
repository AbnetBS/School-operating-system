/**
 * Student validation schemas.
 *
 * The SAME schema is used by the client form and the server handler, so a
 * rule can never be enforced in one place and forgotten in the other — which
 * is the requirement in §59 ("validate both frontend and backend").
 */

import { z } from 'zod';

/** Ethiopian phone numbers: +251 9xx xxx xxx, 09xx xxx xxx, or 07xx for Ethio Telecom. */
const phoneRegex = /^(\+251|251|0)?[79]\d{8}$/;

export const phoneSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || phoneRegex.test(v.replace(/[\s()\-.]/g, '')), {
    message: 'Enter a valid Ethiopian phone number, e.g. 0911234567',
  })
  .transform((v) => v.replace(/[\s()\-.]/g, ''));

/**
 * Normalise a phone number to +251XXXXXXXXX so duplicates are detectable.
 *
 * Returns null for anything that is not a valid Ethiopian mobile number.
 * Callers such as the bulk importer rely on that null to reject bad data —
 * blindly prefixing "+251" would turn "12345" into a plausible-looking
 * +25112345 and store rubbish that can never be dialled.
 */
export function normalisePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/[\s()\-.]/g, '');
  if (digits === '') return null;
  if (!phoneRegex.test(digits)) return null;

  if (digits.startsWith('+251')) return digits;
  if (digits.startsWith('251')) return `+${digits}`;
  if (digits.startsWith('0')) return `+251${digits.slice(1)}`;
  return `+251${digits}`;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker to enter a valid date');

export const STUDENT_STATUSES = [
  'active',
  'transferred',
  'withdrawn',
  'graduated',
  'suspended',
  'inactive',
] as const;

export const GENDERS = ['male', 'female'] as const;

/**
 * Core student fields.
 *
 * Naming follows Ethiopian convention: given name, father's name and
 * grandfather's name are separate fields. Given and father's names are
 * required because that pair is how a student is identified in practice;
 * the grandfather's name is optional as some records lack it.
 */
export const studentBaseSchema = z.object({
  studentCode: z
    .string()
    .trim()
    .min(1, 'Student ID is required')
    .max(32, 'Student ID must be 32 characters or fewer')
    .regex(/^[A-Za-z0-9/\-_.]+$/, 'Student ID may contain letters, numbers, / - _ and .'),

  givenName: z.string().trim().min(1, 'Given name is required').max(64),
  fatherName: z.string().trim().min(1, "Father's name is required").max(64),
  grandfatherName: z.string().trim().max(64).optional().or(z.literal('')),

  givenNameAm: z.string().trim().max(64).optional().or(z.literal('')),
  fatherNameAm: z.string().trim().max(64).optional().or(z.literal('')),
  grandfatherNameAm: z.string().trim().max(64).optional().or(z.literal('')),

  gender: z.enum(GENDERS).optional().nullable(),
  dateOfBirth: isoDate.optional().or(z.literal('')),

  phone: phoneSchema.optional().or(z.literal('')),
  email: z.string().trim().email('Enter a valid email address').max(255).optional().or(z.literal('')),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  subCity: z.string().trim().max(64).optional().or(z.literal('')),
  woreda: z.string().trim().max(64).optional().or(z.literal('')),
  kebele: z.string().trim().max(64).optional().or(z.literal('')),

  emergencyContactName: z.string().trim().max(128).optional().or(z.literal('')),
  emergencyContactPhone: phoneSchema.optional().or(z.literal('')),
  emergencyContactRelation: z.string().trim().max(64).optional().or(z.literal('')),

  medicalNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  bloodGroup: z.string().trim().max(8).optional().or(z.literal('')),

  previousSchool: z.string().trim().max(200).optional().or(z.literal('')),
  admissionDate: isoDate.optional().or(z.literal('')),

  status: z.enum(STUDENT_STATUSES).default('active'),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),

  /** Values for school-defined custom fields. */
  customFields: z.record(z.string(), z.unknown()).default({}),
});

/** Creating a student also places them in a class. */
export const createStudentSchema = studentBaseSchema.extend({
  gradeLevelId: z.string().min(1, 'Select a grade level'),
  sectionId: z.string().optional().or(z.literal('')),
  enrolledOn: isoDate.optional().or(z.literal('')),
  rollNumber: z.coerce.number().int().min(1).max(999).optional().nullable(),

  /** Optionally create and link a guardian in the same step. */
  guardian: z
    .object({
      givenName: z.string().trim().min(1, "Guardian's given name is required").max(64),
      fatherName: z.string().trim().max(64).optional().or(z.literal('')),
      phone: phoneSchema.optional().or(z.literal('')),
      email: z.string().trim().email().max(255).optional().or(z.literal('')),
      relationship: z.string().trim().max(32).default('father'),
    })
    .optional(),
});

export const updateStudentSchema = studentBaseSchema.partial().extend({
  /** A status change must be explained, so the history is meaningful. */
  statusReason: z.string().trim().max(500).optional(),
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;

/** Query parameters for the student list. */
export const studentListSchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  gradeLevelId: z.string().optional(),
  sectionId: z.string().optional(),
  gender: z.enum(GENDERS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'code', 'created', 'grade']).default('name'),
});

export type StudentListQuery = z.infer<typeof studentListSchema>;

/** Turn empty strings into null, so blank form fields are not stored as "". */
export function emptyToNull<T extends Record<string, unknown>>(input: T): T {
  const out = { ...input };
  for (const [key, value] of Object.entries(out)) {
    if (value === '') (out as Record<string, unknown>)[key] = null;
  }
  return out;
}
