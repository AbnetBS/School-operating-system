/**
 * Domain event bus and automation engine.
 *
 * Modules do not call each other. Attendance does not import the notification
 * module; the gradebook does not import analytics. Instead a module emits a
 * domain event, and handlers registered here react to it according to the
 * school's configuration.
 *
 * This is what makes §51 real rather than decorative:
 *
 *   attendance.recorded  → recalculate percentage
 *                        → evaluate risk thresholds
 *                        → notify guardian (if the school enables it)
 *                        → refresh dashboards
 *
 * Events are persisted before handlers run, so a failure is retryable and the
 * automation history is auditable. Handlers are isolated: one throwing does
 * not prevent the others, and never rolls back the originating action —
 * recording attendance must not fail because an SMS gateway is down.
 */

import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { domainEvents } from '../../db/schema/core.ts';

/** Payload shapes for each event type. */
export type DomainEventMap = {
  'attendance.recorded': {
    sectionId: string;
    subjectId: string | null;
    date: string;
    recordedBy: string;
    absentStudentIds: string[];
    lateStudentIds: string[];
    totalStudents: number;
  };
  'attendance.updated': {
    studentId: string;
    date: string;
    previousStatus: string;
    newStatus: string;
    changedBy: string;
  };
  'attendance.riskDetected': {
    studentId: string;
    attendancePercent: number;
    threshold: number;
    consecutiveAbsences: number;
  };
  'marks.submitted': {
    sectionSubjectId: string;
    termId: string;
    teacherId: string;
    studentCount: number;
  };
  'marks.approved': { sectionSubjectId: string; termId: string; approvedBy: string };
  'grade.changed': {
    studentId: string;
    subjectId: string;
    previousMark: number | null;
    newMark: number | null;
    changedBy: string;
    reason: string | null;
  };
  'reportCard.published': { termId: string; studentIds: string[]; publishedBy: string };
  'student.enrolled': { studentId: string; sectionId: string; academicYearId: string };
  'student.statusChanged': { studentId: string; from: string; to: string };
  'payment.recorded': {
    studentId: string;
    amountCents: number;
    method: string;
    receiptNumber: string;
    balanceCents: number;
  };
  'fee.due': { studentId: string; amountCents: number; dueDate: string };
  'announcement.published': { announcementId: string; audience: string };
  'homework.assigned': { homeworkId: string; sectionId: string; dueDate: string };

  // Group 8 - operations. Handlers for these live in the notification module;
  // the operations services emit and never notify directly, exactly as finance
  // does.
  'library.loanOverdue': {
    loanId: string;
    studentId: string | null;
    staffId: string | null;
    itemTitle: string;
    dueOn: string;
    daysOverdue: number;
  };
  'library.loanIssued': {
    loanId: string;
    studentId: string | null;
    staffId: string | null;
    itemTitle: string;
    dueOn: string;
  };
  'leave.requested': {
    leaveRequestId: string;
    staffId: string;
    startDate: string;
    endDate: string;
    days: number;
  };
  'leave.decided': {
    leaveRequestId: string;
    staffId: string;
    status: 'approved' | 'rejected';
    decidedBy: string;
  };
  'inventory.lowStock': {
    itemId: string;
    name: string;
    quantity: number;
    reorderLevel: number;
  };
  'maintenance.reported': {
    issueId: string;
    title: string;
    priority: string;
    location: string | null;
  };
  'event.published': {
    eventId: string;
    title: string;
    startDate: string;
    audience: string;
  };
};

export type DomainEventType = keyof DomainEventMap;

export type DomainEvent<T extends DomainEventType = DomainEventType> = {
  id?: string;
  schoolId: string;
  type: T;
  payload: DomainEventMap[T];
};

export type EventContext = {
  db: Database;
  schoolId: string;
  /** Emit a follow-on event from within a handler. */
  emit: <T extends DomainEventType>(type: T, payload: DomainEventMap[T]) => Promise<void>;
};

export type EventHandler<T extends DomainEventType = DomainEventType> = {
  /** Stable name, used in logs and to prevent duplicate registration. */
  name: string;
  event: T;
  handle: (payload: DomainEventMap[T], ctx: EventContext) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const globalForBus = globalThis as unknown as {
  __sosHandlers?: Map<string, EventHandler[]>;
};
const handlers: Map<string, EventHandler[]> = (globalForBus.__sosHandlers ??= new Map());

export function registerHandler<T extends DomainEventType>(handler: EventHandler<T>): void {
  const list = handlers.get(handler.event) ?? [];
  // Idempotent registration: Next.js re-evaluates modules on hot reload, and
  // without this a handler would run twice per event in development.
  if (list.some((h) => h.name === handler.name)) return;
  // A handler is registered for one specific event type, but the registry
  // stores handlers for all of them. The map key guarantees a handler is only
  // ever invoked with its own payload type, which the type system cannot
  // express here, so the erasure through `unknown` is deliberate.
  list.push(handler as unknown as EventHandler);
  handlers.set(handler.event, list);
}

export function getHandlers(event: DomainEventType): EventHandler[] {
  return handlers.get(event) ?? [];
}

export function clearHandlers(): void {
  handlers.clear();
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

/**
 * Persist an event and process it.
 *
 * `db` should be the request's database handle. When called inside a
 * transaction the event row is written atomically with the change; handlers
 * then run after the fact via `processEvent`.
 */
export async function emitEvent<T extends DomainEventType>(
  db: Database,
  schoolId: string,
  type: T,
  payload: DomainEventMap[T],
  options: { processNow?: boolean } = {},
): Promise<string> {
  const rows = await db
    .insert(domainEvents)
    .values({ schoolId, type, payload: payload as object })
    .returning({ id: domainEvents.id });

  const eventId = rows[0]!.id;

  if (options.processNow !== false) {
    // Deliberately not awaited into the caller's critical path failure mode:
    // handler errors are recorded on the event row, not thrown at the user.
    await processEvent(db, { id: eventId, schoolId, type, payload });
  }

  return eventId;
}

/** Run every handler registered for an event. */
export async function processEvent(db: Database, event: DomainEvent): Promise<void> {
  const list = getHandlers(event.type);
  if (list.length === 0) {
    await markProcessed(db, event.id);
    return;
  }

  const ctx: EventContext = {
    db,
    schoolId: event.schoolId,
    emit: async (type, payload) => {
      await emitEvent(db, event.schoolId, type, payload);
    },
  };

  const errors: string[] = [];
  for (const handler of list) {
    try {
      await handler.handle(event.payload as never, ctx);
    } catch (error) {
      // One failing automation must not block the others, and must never undo
      // the action that triggered it.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${handler.name}: ${message}`);
      console.error(`[automation] handler "${handler.name}" failed for ${event.type}:`, error);
    }
  }

  if (event.id) {
    if (errors.length > 0) {
      await db
        .update(domainEvents)
        .set({
          attempts: sql`${domainEvents.attempts} + 1`,
          lastError: errors.join('; ').slice(0, 2000),
        })
        .where(eq(domainEvents.id, event.id));
    } else {
      await markProcessed(db, event.id);
    }
  }
}

async function markProcessed(db: Database, eventId?: string): Promise<void> {
  if (!eventId) return;
  await db
    .update(domainEvents)
    .set({ processedAt: new Date(), lastError: null })
    .where(eq(domainEvents.id, eventId));
}

/**
 * Retry events whose handlers previously failed. Intended for a scheduled job.
 * Events are abandoned after `maxAttempts` so a permanently broken handler
 * does not retry forever.
 */
export async function processPendingEvents(
  db: Database,
  options: { limit?: number; maxAttempts?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const limit = options.limit ?? 50;
  const maxAttempts = options.maxAttempts ?? 5;

  const pending = await db
    .select()
    .from(domainEvents)
    .where(and(isNull(domainEvents.processedAt), lt(domainEvents.attempts, maxAttempts)))
    .orderBy(asc(domainEvents.createdAt))
    .limit(limit);

  let processed = 0;
  let failed = 0;
  for (const row of pending) {
    await processEvent(db, {
      id: row.id,
      schoolId: row.schoolId,
      type: row.type as DomainEventType,
      payload: row.payload as never,
    });
    const [after] = await db
      .select({ processedAt: domainEvents.processedAt })
      .from(domainEvents)
      .where(eq(domainEvents.id, row.id))
      .limit(1);
    if (after?.processedAt) processed++;
    else failed++;
  }

  return { processed, failed };
}
