/**
 * Attendance validation schemas, shared by the client and the server.
 *
 * The submission format is deliberately a whole register at a time, not one
 * student per request. A class of 50 must be saved in a single round trip —
 * anything else is unusable on a 2G connection in a classroom.
 */

import { z } from 'zod';

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused', 'sick'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A valid date is required');

/** One student's mark within a submitted register. */
export const attendanceMarkSchema = z.object({
  studentId: z.string().min(1),
  status: z.enum(ATTENDANCE_STATUSES),
  minutesLate: z.coerce.number().int().min(0).max(600).optional().nullable(),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});

/**
 * A whole register.
 *
 * `idempotencyKey` makes offline replay safe: the same key submitted twice
 * updates the same session rather than creating a duplicate.
 */
export const submitAttendanceSchema = z.object({
  sectionId: z.string().min(1, 'A class must be selected'),
  /** Null or absent for a daily register; set for a per-subject register. */
  sectionSubjectId: z.string().optional().nullable(),
  periodId: z.string().optional().nullable(),
  date: isoDate,
  marks: z.array(attendanceMarkSchema).min(1, 'At least one student is required'),
  note: z.string().trim().max(500).optional().or(z.literal('')),
  idempotencyKey: z.string().trim().max(128).optional(),
  /** True when the client is flushing a queue saved while offline. */
  syncedOffline: z.boolean().default(false),
});

/** Correcting a single record after the register was taken. */
export const correctAttendanceSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
  minutesLate: z.coerce.number().int().min(0).max(600).optional().nullable(),
});

/** Bulk offline sync: several registers in one request. */
export const syncAttendanceSchema = z.object({
  registers: z.array(submitAttendanceSchema).min(1).max(50),
});

export const attendanceQuerySchema = z.object({
  sectionId: z.string().optional(),
  sectionSubjectId: z.string().optional(),
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  studentId: z.string().optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  termId: z.string().optional(),
});

export const attendanceReportSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  sectionId: z.string().optional(),
  gradeLevelId: z.string().optional(),
  termId: z.string().optional(),
  /** Only students at or below the risk threshold. */
  atRiskOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const holidaySchema = z.object({
  date: isoDate,
  endDate: isoDate.optional().or(z.literal('')),
  name: z.string().trim().min(1, 'A name is required').max(128),
  nameAm: z.string().trim().max(128).optional().or(z.literal('')),
  kind: z.enum(['holiday', 'exam', 'closure', 'break']).default('holiday'),
});

export type SubmitAttendanceInput = z.infer<typeof submitAttendanceSchema>;
export type CorrectAttendanceInput = z.infer<typeof correctAttendanceSchema>;
export type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;
export type AttendanceReportQuery = z.infer<typeof attendanceReportSchema>;
export type AttendanceMark = z.infer<typeof attendanceMarkSchema>;
export type HolidayInput = z.infer<typeof holidaySchema>;

/**
 * Deterministic idempotency key.
 *
 * Built from the identifying facts of a register so the same submission always
 * produces the same key, whether it is sent immediately or replayed from an
 * offline queue days later.
 */
export function buildIdempotencyKey(parts: {
  sectionId: string;
  sectionSubjectId?: string | null;
  date: string;
}): string {
  return [parts.sectionId, parts.sectionSubjectId ?? 'daily', parts.date].join(':');
}
