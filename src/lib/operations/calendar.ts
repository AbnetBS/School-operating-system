/**
 * School calendar and document metadata.
 *
 * EVENTS REUSE THE ANNOUNCEMENT AUDIENCE MODEL rather than inventing a second
 * visibility system. "Visible to Grade 5 parents" must mean the same thing on a
 * notice and on the calendar, or the two will drift and a school will publish
 * something to the wrong people believing it matched.
 *
 * HOLIDAYS STAY WHERE THEY ARE. `attendance_holidays` has behaviour attached —
 * it suppresses registers. A calendar event is a note on a date. Merging them
 * would make every typo in an event title a change to attendance records.
 *
 * DOCUMENTS ARE METADATA ONLY. The bytes live behind an opaque storage key that
 * never reaches the client; every download re-checks permission and tenancy.
 * `visibleToPortal` defaults to FALSE so an internal note about a pupil cannot
 * become visible to their family by omission.
 */

import { and, asc, desc, eq, gte, lte, ilike, or, sql, count, inArray, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import { schoolEvents, documents } from '../../db/schema/operations.ts';
import { students, staff, enrollments } from '../../db/schema/people.ts';
import {
  users,
  academicYears,
  terms,
  sections,
  gradeLevels,
} from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { OperationsError, notFoundError } from './errors.ts';
import type { SchoolEventInput, DocumentMetaInput, EventAudience } from './schema.ts';

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type EventRow = {
  id: string;
  title: string;
  description: string | null;
  eventType: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
  audience: EventAudience;
  visibleToPortal: boolean;
  colour: string | null;
  termName: string | null;
};

function mapEvent(r: {
  id: string;
  title: string;
  description: string | null;
  eventType: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
  audience: unknown;
  visibleToPortal: boolean;
  colour: string | null;
  termName?: string | null;
}): EventRow {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    eventType: r.eventType,
    startDate: r.startDate,
    endDate: r.endDate,
    startTime: r.startTime,
    endTime: r.endTime,
    allDay: r.allDay,
    location: r.location,
    audience: (r.audience as EventAudience) ?? { kind: 'all' },
    visibleToPortal: r.visibleToPortal,
    colour: r.colour,
    termName: r.termName ?? null,
  };
}

/**
 * Events for a date range, as staff see them.
 *
 * Audience filtering is NOT applied here: a member of staff with `event.view`
 * sees the school's calendar. The portal has its own function below, which
 * applies the audience rule — keeping the two separate means a mistake in one
 * cannot silently widen the other.
 */
export async function listEvents(
  ctx: AuthContext,
  query: { from?: string | null; to?: string | null; eventType?: string | null } = {},
): Promise<EventRow[]> {
  const conditions: SQL[] = [eq(schoolEvents.schoolId, ctx.schoolId)];
  // An event that starts before the window but ends inside it still occurs
  // during the window, hence the coalesce.
  if (query.from) {
    conditions.push(sql`coalesce(${schoolEvents.endDate}, ${schoolEvents.startDate}) >= ${query.from}`);
  }
  if (query.to) conditions.push(lte(schoolEvents.startDate, query.to));
  if (query.eventType) conditions.push(eq(schoolEvents.eventType, query.eventType));

  const rows = await ctx.db
    .select({
      id: schoolEvents.id,
      title: schoolEvents.title,
      description: schoolEvents.description,
      eventType: schoolEvents.eventType,
      startDate: schoolEvents.startDate,
      endDate: schoolEvents.endDate,
      startTime: schoolEvents.startTime,
      endTime: schoolEvents.endTime,
      allDay: schoolEvents.allDay,
      location: schoolEvents.location,
      audience: schoolEvents.audience,
      visibleToPortal: schoolEvents.visibleToPortal,
      colour: schoolEvents.colour,
      termName: terms.name,
    })
    .from(schoolEvents)
    .leftJoin(terms, eq(terms.id, schoolEvents.termId))
    .where(and(...conditions))
    .orderBy(asc(schoolEvents.startDate), asc(schoolEvents.startTime));

  return rows.map(mapEvent);
}

/**
 * Events a portal user may see for one pupil.
 *
 * Three gates, all applied in SQL so nothing is filtered after the fact:
 *   1. `visible_to_portal` must be true;
 *   2. the audience must be 'all', or name a role the viewer holds, or name
 *      the pupil's own section or grade;
 *   3. the school must match.
 *
 * A parent therefore sees the whole-school sports day and their own child's
 * grade meeting, and never the staff briefing.
 */
export async function listPortalEvents(
  ctx: AuthContext,
  studentId: string,
  query: { from?: string | null; to?: string | null } = {},
): Promise<EventRow[]> {
  // The caller must already have proved they may see this pupil; this is a
  // second, independent check rather than a substitute for the first.
  await ctx.requireStudentAccess(studentId);

  const [enrolment] = await ctx.db
    .select({ sectionId: enrollments.sectionId, gradeLevelId: enrollments.gradeLevelId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, ctx.schoolId),
        eq(enrollments.studentId, studentId),
        eq(enrollments.status, 'enrolled'),
      ),
    )
    .orderBy(desc(enrollments.enrolledOn))
    .limit(1);

  const sectionId = enrolment?.sectionId ?? null;
  const gradeId = enrolment?.gradeLevelId ?? null;
  const roleKeys = ctx.roleKeys ?? [];

  const conditions: SQL[] = [
    eq(schoolEvents.schoolId, ctx.schoolId),
    eq(schoolEvents.visibleToPortal, true),
  ];
  if (query.from) {
    conditions.push(sql`coalesce(${schoolEvents.endDate}, ${schoolEvents.startDate}) >= ${query.from}`);
  }
  if (query.to) conditions.push(lte(schoolEvents.startDate, query.to));

  // Audience match, expressed against the JSONB column.
  //
  // The role list is passed as a BOUND PARAMETER, never interpolated into the
  // SQL text. Role keys are school-configurable strings; building an array
  // literal from them by hand would put user-controlled text into the query,
  // and hand-rolled quote escaping is exactly the kind of thing that is
  // correct until the day it is not.
  conditions.push(sql`(
    ${schoolEvents.audience}->>'kind' = 'all'
    or (
      ${schoolEvents.audience}->>'kind' = 'roles'
      and exists (
        select 1
        from jsonb_array_elements_text(${schoolEvents.audience}->'roles') as r(v)
        join jsonb_array_elements_text(${JSON.stringify(roleKeys)}::jsonb) as mine(v)
          on mine.v = r.v
      )
    )
    or (
      ${schoolEvents.audience}->>'kind' = 'sections'
      and ${sectionId ? sql`${schoolEvents.audience}->'sectionIds' ? ${sectionId}` : sql`false`}
    )
    or (
      ${schoolEvents.audience}->>'kind' = 'grades'
      and ${gradeId ? sql`${schoolEvents.audience}->'gradeIds' ? ${gradeId}` : sql`false`}
    )
  )`);

  const rows = await ctx.db
    .select({
      id: schoolEvents.id,
      title: schoolEvents.title,
      description: schoolEvents.description,
      eventType: schoolEvents.eventType,
      startDate: schoolEvents.startDate,
      endDate: schoolEvents.endDate,
      startTime: schoolEvents.startTime,
      endTime: schoolEvents.endTime,
      allDay: schoolEvents.allDay,
      location: schoolEvents.location,
      audience: schoolEvents.audience,
      visibleToPortal: schoolEvents.visibleToPortal,
      colour: schoolEvents.colour,
    })
    .from(schoolEvents)
    .where(and(...conditions))
    .orderBy(asc(schoolEvents.startDate), asc(schoolEvents.startTime));

  return rows.map(mapEvent);
}

export async function getEventOwned(ctx: AuthContext, eventId: string) {
  const [row] = await ctx.db
    .select()
    .from(schoolEvents)
    .where(and(eq(schoolEvents.schoolId, ctx.schoolId), eq(schoolEvents.id, eventId)))
    .limit(1);
  if (!row) throw notFoundError('Event');
  return row;
}

/**
 * Verify that every id named in an audience belongs to this school.
 *
 * Without this, an event could be addressed to another school's section or
 * grade. It leaks nothing — every read is school-scoped, so the other school
 * never sees the event — but it silently matches nobody, which is worse than
 * an error: the author believes they have told Grade 5 something and no one
 * receives it.
 *
 * ROLES ARE DELIBERATELY NOT CHECKED HERE. A role audience holds role *keys*,
 * not ids: `teacher` means "teachers of this school" because the match in
 * `listPortalEvents` is against the reader's OWN `ctx.roleKeys`. A key from
 * another school is therefore not a foreign reference — it is the same word —
 * so there is no tenancy question to answer, and requiring a `roles` row would
 * reject a school that addresses a role key it has not defined yet.
 */
async function assertAudienceOwned(ctx: AuthContext, audience: EventAudience): Promise<void> {
  if (audience.kind === 'sections') {
    const rows = await ctx.db
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.schoolId, ctx.schoolId), inArray(sections.id, audience.sectionIds)));
    if (rows.length !== new Set(audience.sectionIds).size) throw notFoundError('Section');
  } else if (audience.kind === 'grades') {
    const rows = await ctx.db
      .select({ id: gradeLevels.id })
      .from(gradeLevels)
      .where(
        and(eq(gradeLevels.schoolId, ctx.schoolId), inArray(gradeLevels.id, audience.gradeIds)),
      );
    if (rows.length !== new Set(audience.gradeIds).size) throw notFoundError('Grade level');
  }
}

export async function createEvent(ctx: AuthContext, input: SchoolEventInput) {
  ctx.require('event.manage');
  await assertAudienceOwned(ctx, input.audience);

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  if (input.termId) {
    const [term] = await ctx.db
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.schoolId, ctx.schoolId), eq(terms.id, input.termId)))
      .limit(1);
    if (!term) throw notFoundError('Term');
  }

  const [row] = await ctx.db
    .insert(schoolEvents)
    .values({
      schoolId: ctx.schoolId,
      academicYearId: year?.id ?? null,
      termId: input.termId ?? null,
      title: input.title,
      description: input.description ?? null,
      eventType: input.eventType,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      startTime: input.allDay ? null : (input.startTime ?? null),
      endTime: input.allDay ? null : (input.endTime ?? null),
      allDay: input.allDay,
      location: input.location ?? null,
      audience: input.audience,
      visibleToPortal: input.visibleToPortal,
      colour: input.colour ?? null,
      createdBy: ctx.user.userId,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'event.create',
    entityType: 'schoolEvent',
    entityId: row!.id,
    summary: `${row!.title} on ${row!.startDate}`,
    newValue: { title: row!.title, startDate: row!.startDate, eventType: row!.eventType },
    ipAddress: ctx.ipAddress,
  });

  await emitEvent(ctx.db, ctx.schoolId, 'event.published', {
    eventId: row!.id,
    title: row!.title,
    startDate: row!.startDate,
    audience: (input.audience as { kind: string }).kind,
  });

  return row!;
}

export async function updateEvent(ctx: AuthContext, eventId: string, input: SchoolEventInput) {
  ctx.require('event.manage');
  await assertAudienceOwned(ctx, input.audience);
  const before = await getEventOwned(ctx, eventId);

  const [row] = await ctx.db
    .update(schoolEvents)
    .set({
      termId: input.termId ?? null,
      title: input.title,
      description: input.description ?? null,
      eventType: input.eventType,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      startTime: input.allDay ? null : (input.startTime ?? null),
      endTime: input.allDay ? null : (input.endTime ?? null),
      allDay: input.allDay,
      location: input.location ?? null,
      audience: input.audience,
      visibleToPortal: input.visibleToPortal,
      colour: input.colour ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(schoolEvents.schoolId, ctx.schoolId), eq(schoolEvents.id, eventId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'event.update',
    entityType: 'schoolEvent',
    entityId: eventId,
    summary: row!.title,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function deleteEvent(ctx: AuthContext, eventId: string) {
  ctx.require('event.manage');
  const before = await getEventOwned(ctx, eventId);

  await ctx.db
    .delete(schoolEvents)
    .where(and(eq(schoolEvents.schoolId, ctx.schoolId), eq(schoolEvents.id, eventId)));

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'event.delete',
    entityType: 'schoolEvent',
    entityId: eventId,
    summary: before.title,
    previousValue: { title: before.title, startDate: before.startDate },
    ipAddress: ctx.ipAddress,
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentRow = {
  id: string;
  ownerType: string;
  ownerId: string | null;
  ownerName: string | null;
  title: string;
  category: string;
  description: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  visibleToPortal: boolean;
  expiresOn: string | null;
  uploadedByName: string | null;
  createdAt: Date;
};

/**
 * Documents, filtered by owner.
 *
 * The caller must have proved access to the owner BEFORE calling: a student's
 * documents are only listable by someone who may see that student. This
 * function enforces the school boundary and nothing else, which is why it is
 * never exposed directly to a route without a gate in front.
 */
export async function listDocuments(
  ctx: AuthContext,
  query: {
    ownerType?: string | null;
    ownerId?: string | null;
    category?: string | null;
    q?: string | null;
    portalOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ documents: DocumentRow[]; total: number }> {
  const conditions: SQL[] = [eq(documents.schoolId, ctx.schoolId)];
  if (query.ownerType) conditions.push(eq(documents.ownerType, query.ownerType));
  if (query.ownerId) conditions.push(eq(documents.ownerId, query.ownerId));
  if (query.category) conditions.push(eq(documents.category, query.category));
  if (query.portalOnly) conditions.push(eq(documents.visibleToPortal, true));
  if (query.q) {
    const needle = `%${query.q}%`;
    const match = or(ilike(documents.title, needle), ilike(documents.fileName, needle));
    if (match) conditions.push(match);
  }
  const where = and(...conditions) as SQL;

  const rows = await ctx.db
    .select({
      id: documents.id,
      ownerType: documents.ownerType,
      ownerId: documents.ownerId,
      title: documents.title,
      category: documents.category,
      description: documents.description,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      sizeBytes: documents.sizeBytes,
      visibleToPortal: documents.visibleToPortal,
      expiresOn: documents.expiresOn,
      createdAt: documents.createdAt,
      uploaderGiven: users.givenName,
      uploaderFather: users.fatherName,
      studentGiven: students.givenName,
      studentFather: students.fatherName,
      staffGiven: sql<string | null>`staff_user.given_name`,
      staffFather: sql<string | null>`staff_user.father_name`,
    })
    .from(documents)
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .leftJoin(
      students,
      and(eq(students.id, documents.ownerId), eq(documents.ownerType, 'student')),
    )
    .leftJoin(staff, and(eq(staff.id, documents.ownerId), eq(documents.ownerType, 'staff')))
    .leftJoin(sql`${users} as staff_user`, sql`staff_user.id = ${staff.userId}`)
    .where(where)
    .orderBy(desc(documents.createdAt))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db.select({ total: count() }).from(documents).where(where);

  return {
    documents: rows.map((r) => ({
      id: r.id,
      ownerType: r.ownerType,
      ownerId: r.ownerId,
      ownerName: r.studentGiven
        ? [r.studentGiven, r.studentFather].filter(Boolean).join(' ')
        : r.staffGiven
          ? [r.staffGiven, r.staffFather].filter(Boolean).join(' ')
          : null,
      title: r.title,
      category: r.category,
      description: r.description,
      fileName: r.fileName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      visibleToPortal: r.visibleToPortal,
      expiresOn: r.expiresOn,
      uploadedByName: r.uploaderGiven
        ? [r.uploaderGiven, r.uploaderFather].filter(Boolean).join(' ')
        : null,
      createdAt: r.createdAt,
    })),
    total: totalRow?.total ?? 0,
  };
}

/**
 * Fetch a document row, enforcing school ownership AND access to its owner.
 *
 * This is the function every download must go through. It is the single place
 * where "may this person read this file?" is decided, so there is one thing to
 * audit rather than one per route.
 */
export async function getDocumentForAccess(
  ctx: AuthContext,
  documentId: string,
  options: { portal?: boolean } = {},
) {
  const [row] = await ctx.db
    .select()
    .from(documents)
    .where(and(eq(documents.schoolId, ctx.schoolId), eq(documents.id, documentId)))
    .limit(1);
  if (!row) throw notFoundError('Document');

  if (options.portal) {
    // A portal user may only ever read a document explicitly published to
    // them, about their own child or themselves.
    if (!row.visibleToPortal) throw notFoundError('Document');
    if (row.ownerType !== 'student' || !row.ownerId) throw notFoundError('Document');
    await ctx.requireStudentAccess(row.ownerId);
    return row;
  }

  ctx.require('document.view');

  // A staff document is personal data: seeing it needs staff.view, not merely
  // document.view.
  if (row.ownerType === 'staff') ctx.require('staff.view');
  // A pupil's document follows the pupil's own access rule, including
  // restrict.ownSectionsOnly.
  if (row.ownerType === 'student' && row.ownerId) {
    await ctx.requireStudentAccess(row.ownerId);
  }

  return row;
}

/**
 * Record an uploaded file.
 *
 * The storage key is produced by the caller (the upload route) after the bytes
 * are safely written; this function never touches a filesystem.
 */
export async function createDocument(
  ctx: AuthContext,
  input: DocumentMetaInput & {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    checksum?: string | null;
  },
) {
  await ctx.requireModule('documents');
  ctx.require('document.upload');

  // The owner must exist inside this school. Without this a document could be
  // filed against an id belonging to another school and then listed there.
  if (input.ownerType === 'student') {
    await ctx.requireStudentAccess(input.ownerId!);
  } else if (input.ownerType === 'staff') {
    ctx.require('staff.view');
    const [person] = await ctx.db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.id, input.ownerId!)))
      .limit(1);
    if (!person) throw notFoundError('Staff member');
  }

  const [row] = await ctx.db
    .insert(documents)
    .values({
      schoolId: ctx.schoolId,
      ownerType: input.ownerType,
      ownerId: input.ownerType === 'school' ? null : input.ownerId!,
      title: input.title,
      category: input.category,
      description: input.description ?? null,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
      checksum: input.checksum ?? null,
      visibleToPortal: input.visibleToPortal,
      expiresOn: input.expiresOn ?? null,
      uploadedBy: ctx.user.userId,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'document.upload',
    entityType: 'document',
    entityId: row!.id,
    summary: `${row!.title} (${row!.fileName})`,
    newValue: {
      ownerType: row!.ownerType,
      ownerId: row!.ownerId,
      category: row!.category,
      visibleToPortal: row!.visibleToPortal,
    },
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function deleteDocument(ctx: AuthContext, documentId: string) {
  await ctx.requireModule('documents');
  ctx.require('document.delete');

  // Reuse the access rule rather than re-implementing it.
  const row = await getDocumentForAccess(ctx, documentId);

  await ctx.db
    .delete(documents)
    .where(and(eq(documents.schoolId, ctx.schoolId), eq(documents.id, documentId)));

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'document.delete',
    entityType: 'document',
    entityId: documentId,
    summary: row.title,
    previousValue: { title: row.title, fileName: row.fileName, ownerType: row.ownerType },
    ipAddress: ctx.ipAddress,
  });

  return row;
}
