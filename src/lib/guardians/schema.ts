/**
 * Guardian validation schemas, shared by the client form and the API.
 *
 * A guardian is a person, not a login. Portal access is created separately and
 * on demand, because most Ethiopian parents will be reached by SMS long before
 * they ever open a web portal.
 */

import { z } from 'zod';
import { phoneSchema, normalisePhone, emptyToNull } from '../students/schema.ts';

/** Relationship to the student. Free-form, with common values offered in the UI. */
export const RELATIONSHIPS = [
  'father',
  'mother',
  'grandparent',
  'uncle',
  'aunt',
  'sibling',
  'sponsor',
  'guardian',
  'other',
] as const;

export const PREFERRED_CHANNELS = ['sms', 'inapp', 'email'] as const;

export const guardianBaseSchema = z.object({
  givenName: z.string().trim().min(1, 'Given name is required').max(64),
  fatherName: z.string().trim().max(64).optional().or(z.literal('')),
  grandfatherName: z.string().trim().max(64).optional().or(z.literal('')),

  givenNameAm: z.string().trim().max(64).optional().or(z.literal('')),
  fatherNameAm: z.string().trim().max(64).optional().or(z.literal('')),
  grandfatherNameAm: z.string().trim().max(64).optional().or(z.literal('')),

  phone: phoneSchema.optional().or(z.literal('')),
  altPhone: phoneSchema.optional().or(z.literal('')),
  email: z
    .string()
    .trim()
    .email('Enter a valid email address')
    .max(255)
    .optional()
    .or(z.literal('')),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  occupation: z.string().trim().max(128).optional().or(z.literal('')),
  nationalId: z.string().trim().max(64).optional().or(z.literal('')),
  preferredChannel: z.enum(PREFERRED_CHANNELS).default('sms'),
});

export const createGuardianSchema = guardianBaseSchema.extend({
  /** Optionally link to a student in the same step. */
  studentId: z.string().optional().or(z.literal('')),
  relationship: z.enum(RELATIONSHIPS).default('father'),
  isPrimary: z.boolean().default(false),
  canPickUp: z.boolean().default(true),
  receivesFeeNotices: z.boolean().default(true),
});

export const updateGuardianSchema = guardianBaseSchema.partial();

/** Linking an existing guardian to a student. */
export const linkGuardianSchema = z.object({
  guardianId: z.string().min(1, 'Select a guardian'),
  studentId: z.string().min(1, 'Select a student'),
  relationship: z.enum(RELATIONSHIPS).default('father'),
  isPrimary: z.boolean().default(false),
  canPickUp: z.boolean().default(true),
  receivesFeeNotices: z.boolean().default(true),
});

export const updateLinkSchema = z.object({
  relationship: z.enum(RELATIONSHIPS).optional(),
  isPrimary: z.boolean().optional(),
  canPickUp: z.boolean().optional(),
  receivesFeeNotices: z.boolean().optional(),
});

export const guardianListSchema = z.object({
  search: z.string().trim().max(100).optional(),
  hasPortal: z.enum(['yes', 'no']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'children', 'created']).default('name'),
});

export type CreateGuardianInput = z.infer<typeof createGuardianSchema>;
export type UpdateGuardianInput = z.infer<typeof updateGuardianSchema>;
export type LinkGuardianInput = z.infer<typeof linkGuardianSchema>;
export type GuardianListQuery = z.infer<typeof guardianListSchema>;

export { normalisePhone, emptyToNull };
