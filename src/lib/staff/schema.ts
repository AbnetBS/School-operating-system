/**
 * Staff validation schemas.
 *
 * A staff member is one person represented by two rows: a `users` row (the
 * login) and a `staff` row (the employment record). They are created together
 * so a registrar never has to do it twice, but they stay separate because a
 * school may have staff who never log in (a driver, a guard) and logins that
 * are not staff (a parent portal account).
 */

import { z } from 'zod';
import { phoneSchema, normalisePhone, emptyToNull } from '../students/schema.ts';

export const STAFF_TYPES = [
  'teacher',
  'admin',
  'finance',
  'librarian',
  'counsellor',
  'nurse',
  'driver',
  'support',
  'other',
] as const;

export const EMPLOYMENT_TYPES = ['permanent', 'contract', 'part_time', 'volunteer'] as const;

export const STAFF_STATUSES = ['active', 'on_leave', 'resigned', 'terminated'] as const;

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker to choose a valid date');

export const staffBaseSchema = z.object({
  // Ethiopian naming, same as students.
  givenName: z.string().trim().min(1, 'Given name is required').max(64),
  fatherName: z.string().trim().min(1, "Father's name is required").max(64),
  grandfatherName: z.string().trim().max(64).optional().or(z.literal('')),
  givenNameAm: z.string().trim().max(64).optional().or(z.literal('')),
  fatherNameAm: z.string().trim().max(64).optional().or(z.literal('')),
  grandfatherNameAm: z.string().trim().max(64).optional().or(z.literal('')),

  staffType: z.enum(STAFF_TYPES).default('teacher'),
  jobTitle: z.string().trim().max(128).optional().or(z.literal('')),
  department: z.string().trim().max(128).optional().or(z.literal('')),
  gender: z.enum(['female', 'male']).optional().nullable(),
  dateOfBirth: isoDate.optional().or(z.literal('')),
  phone: phoneSchema.optional().or(z.literal('')),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  qualification: z.string().trim().max(255).optional().or(z.literal('')),
  hireDate: isoDate.optional().or(z.literal('')),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional().nullable(),
  status: z.enum(STAFF_STATUSES).default('active'),
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export const createStaffSchema = staffBaseSchema.extend({
  /** Left blank to auto-generate from the configured format. */
  staffCode: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9/\-_.]*$/, 'Staff ID may contain letters, numbers, / - _ and .')
    .optional()
    .or(z.literal('')),

  /** Login details. A staff member without a username simply cannot sign in. */
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Username may contain letters, numbers, dot, dash and underscore')
    .optional()
    .or(z.literal('')),
  email: z.string().trim().email('Enter a valid email address').max(255).optional().or(z.literal('')),

  /** Role keys to assign. At least one is required when a login is created. */
  roleIds: z.array(z.string()).default([]),
});

export const updateStaffSchema = staffBaseSchema.partial().extend({
  roleIds: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export const staffListSchema = z.object({
  search: z.string().trim().max(100).optional(),
  staffType: z.enum(STAFF_TYPES).optional(),
  status: z.enum(STAFF_STATUSES).optional(),
  roleId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'code', 'type', 'created']).default('name'),
});

/** Assign a teacher to a section-subject, or make them a class teacher. */
export const assignTeacherSchema = z.object({
  /** An empty string deliberately clears the assignment. */
  teacherUserId: z.string(),
  sectionSubjectId: z.string().optional(),
  sectionId: z.string().optional(),
  /** 'subject' assigns them to teach; 'classTeacher' makes them homeroom. */
  kind: z.enum(['subject', 'classTeacher']),
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
export type StaffListQuery = z.infer<typeof staffListSchema>;
export type AssignTeacherInput = z.infer<typeof assignTeacherSchema>;

export { normalisePhone, emptyToNull };
