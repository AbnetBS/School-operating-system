/**
 * Audit logging.
 *
 * Records who changed what, when, and from which value to which value.
 *
 * The entry is written with the same database handle as the change itself, so
 * when a caller passes a transaction the audit record commits or rolls back
 * atomically with the data. An audited change cannot succeed while its audit
 * entry silently fails.
 *
 * There is deliberately no update or delete function in this module.
 */

import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { auditLog } from '../../db/schema/core.ts';

/** Actions worth recording. Extend as modules are added. */
export const AUDIT_ACTIONS = {
  'auth.login': 'Signed in',
  'auth.loginFailed': 'Failed sign-in attempt',
  'auth.logout': 'Signed out',
  'auth.passwordChange': 'Changed password',
  'auth.passwordReset': 'Reset a password',

  'school.update': 'Updated school profile',
  'school.settingsUpdate': 'Changed school settings',
  'school.moduleToggle': 'Enabled or disabled a module',

  'user.create': 'Created a user account',
  'user.update': 'Updated a user account',
  'user.deactivate': 'Deactivated a user account',
  'user.roleChange': 'Changed a user\u2019s roles',
  'role.create': 'Created a role',
  'role.update': 'Updated a role',
  'role.permissionChange': 'Changed role permissions',

  'academicYear.create': 'Created an academic year',
  'academicYear.update': 'Updated an academic year',
  'academicYear.setCurrent': 'Changed the current academic year',
  'term.create': 'Created a term',
  'term.update': 'Updated a term',
  'gradeLevel.create': 'Created a grade level',
  'gradeLevel.update': 'Updated a grade level',
  'section.create': 'Created a section',
  'section.update': 'Updated a section',
  'subject.create': 'Created a subject',
  'subject.update': 'Updated a subject',
  'sectionSubject.assign': 'Assigned a teacher to a class subject',

  'student.create': 'Registered a student',
  'student.update': 'Updated student information',
  'student.statusChange': 'Changed a student\u2019s status',
  'student.sectionChange': 'Moved a student to a different section',
  'student.import': 'Imported students',
  'student.delete': 'Archived a student record',

  'guardian.create': 'Added a parent or guardian',
  'guardian.update': 'Updated a parent or guardian',
  'guardian.link': 'Linked a guardian to a student',

  'staff.create': 'Added a staff member',
  'staff.update': 'Updated a staff record',

  'attendance.record': 'Recorded attendance',
  'attendance.update': 'Changed an attendance record',

  'grade.enter': 'Entered marks',
  'grade.update': 'Changed a mark',
  'grade.submit': 'Submitted marks for review',
  'grade.approve': 'Approved marks',
  'grade.lock': 'Locked marks',
  'grade.unlock': 'Unlocked marks',
  'grade.overrideLocked': 'Changed a locked mark',

  'reportCard.generate': 'Generated report cards',
  'reportCard.approve': 'Approved a report card',
  'reportCard.publish': 'Published report cards',

  'fee.create': 'Created a fee',
  'fee.update': 'Updated a fee',
  'fee.assign': 'Assigned a fee to students',
  'payment.record': 'Recorded a payment',
  'payment.void': 'Voided a payment',

  'document.issue': 'Issued a document',
  'export.run': 'Exported data',
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export type AuditEntry = {
  schoolId: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
};

/**
 * Write an audit entry.
 * Pass a transaction as `db` to make the entry atomic with the change.
 */
export async function recordAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    schoolId: entry.schoolId,
    actorUserId: entry.actorUserId ?? null,
    actorName: entry.actorName ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary ?? null,
    previousValue: entry.previousValue === undefined ? null : (entry.previousValue as object),
    newValue: entry.newValue === undefined ? null : (entry.newValue as object),
    reason: entry.reason ?? null,
    ipAddress: entry.ipAddress ?? null,
  });
}

/**
 * Compute the changed fields between two versions of a record, so the audit
 * log stores "what changed" rather than two full copies of the row.
 */
export function diffValues<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
  ignore: string[] = ['updatedAt', 'createdAt'],
): { previous: Record<string, unknown>; next: Record<string, unknown> } | null {
  if (!before || !after) return null;
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (ignore.includes(key)) continue;
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      previous[key] = a ?? null;
      next[key] = b ?? null;
    }
  }
  return Object.keys(next).length > 0 ? { previous, next } : null;
}

export type AuditQuery = {
  schoolId: string;
  actorUserId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

/** Read the audit log. Always school-scoped, and always paginated. */
export async function queryAuditLog(db: Database, query: AuditQuery) {
  const conditions: SQL[] = [eq(auditLog.schoolId, query.schoolId)];
  if (query.actorUserId) conditions.push(eq(auditLog.actorUserId, query.actorUserId));
  if (query.action) conditions.push(eq(auditLog.action, query.action));
  if (query.entityType) conditions.push(eq(auditLog.entityType, query.entityType));
  if (query.entityId) conditions.push(eq(auditLog.entityId, query.entityId));
  if (query.from) conditions.push(gte(auditLog.createdAt, query.from));
  if (query.to) conditions.push(lte(auditLog.createdAt, query.to));

  const where = and(...conditions);
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;

  const [rows, counted] = await Promise.all([
    db.select().from(auditLog).where(where).orderBy(desc(auditLog.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLog).where(where),
  ]);

  return { rows, total: counted[0]?.count ?? 0, limit, offset };
}

/** Render an entry as a sentence, e.g. for the activity feed. */
export function describeAuditEntry(entry: {
  actorName: string | null;
  action: string;
  summary: string | null;
  previousValue: unknown;
  newValue: unknown;
}): string {
  const actor = entry.actorName ?? 'Someone';
  const verb = AUDIT_ACTIONS[entry.action as AuditAction] ?? entry.action;
  const target = entry.summary ? ` — ${entry.summary}` : '';

  // Single-field changes read best as "from X to Y".
  const prev = entry.previousValue as Record<string, unknown> | null;
  const next = entry.newValue as Record<string, unknown> | null;
  if (prev && next && typeof prev === 'object' && typeof next === 'object') {
    const keys = Object.keys(next);
    if (keys.length === 1) {
      const key = keys[0]!;
      return `${actor}: ${verb}${target} (${key}: ${format(prev[key])} → ${format(next[key])})`;
    }
  }
  return `${actor}: ${verb}${target}`;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
