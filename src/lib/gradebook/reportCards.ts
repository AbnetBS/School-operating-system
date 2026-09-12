/**
 * Report cards.
 *
 * A report card is the document a school signs, prints and hands to a parent.
 * Two consequences shape this file:
 *
 *  1. WHAT IT CONTAINS IS CONFIGURED, NOT CODED. Rank, attendance, photo,
 *     comments, conduct, the approval chain and whether it reaches portals all
 *     come from `reportCard` settings. A school that does not rank its pupils
 *     gets no rank column — not a hidden one, an absent one.
 *
 *  2. PUBLICATION FREEZES THE FIGURES. The card stores a JSON snapshot at
 *     publication. If a mark is corrected next week the copy the parent already
 *     read does not silently change; a new version is issued instead. Schools
 *     archive these documents, so a retroactive edit is a correctness problem.
 */

import { and, eq, inArray, sql, asc } from 'drizzle-orm';

import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import { reportCards, termResults, subjectResults } from '../../db/schema/academics.ts';
import { terms, sections, subjects, sectionSubjects } from '../../db/schema/core.ts';
import { students, enrollments } from '../../db/schema/people.ts';
import { getSetting } from '../settings/service.ts';
import { recordAudit } from '../audit/index.ts';
import { getStudentAttendance } from '../attendance/service.ts';
import { GradebookError, recomputeTermResults, getStudentTermReport } from './service.ts';
import type { ReportCardStatus } from './schema.ts';

export type ReportCardSnapshot = {
  student: { id: string; name: string; studentCode: string };
  term: { id: string; name: string };
  subjects: {
    subjectName: string;
    subjectNameAm: string | null;
    percentage: number | null;
    letter: string | null;
    points: number | null;
    isPass: boolean | null;
    rank: number | null;
  }[];
  average: number | null;
  gpa: number | null;
  rankInSection: number | null;
  classSize: number | null;
  isPass: boolean | null;
  attendancePercent: number | null;
  generatedAt: string;
};

/**
 * May this caller act on this class?
 *
 * A permission such as reportCard.generate says *what* someone may do, never
 * *whose* data they may do it to. School-wide roles (an administrator, a
 * registrar) pass; everyone else must have a real relationship to the class.
 * Denial is a 404 so the endpoint cannot be used to discover which section
 * ids exist.
 */
function assertSectionAllowed(ctx: AuthContext, sectionId: string): void {
  if (ctx.hasAny('academic.manage', 'reportCard.publish', 'grade.review')) return;
  if (!ctx.relationships.sectionIds.includes(sectionId)) {
    throw new GradebookError('Not found', 404);
  }
}

/**
 * Generate (or refresh) report cards for a class.
 *
 * Idempotent: running it twice does not create duplicates. A card that has
 * already been published is left alone — regenerating would silently rewrite a
 * document a parent has already seen.
 */
export async function generateReportCards(
  ctx: AuthContext,
  options: { termId: string; sectionId?: string; studentId?: string },
): Promise<{ generated: number; skipped: number; studentIds: string[] }> {
  ctx.require('reportCard.generate');
  const { db, schoolId } = ctx;

  const [term] = await db
    .select({ id: terms.id, name: terms.name, academicYearId: terms.academicYearId })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.id, options.termId)))
    .limit(1);
  if (!term) throw new GradebookError('That term does not exist.', 404);

  // Resolve the target students, always scoped to this school.
  let targetStudentIds: string[] = [];
  let sectionId: string | null = null;

  if (options.studentId) {
    const [row] = await db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, schoolId), eq(students.id, options.studentId)))
      .limit(1);
    if (!row) throw new GradebookError('Not found', 404);
    targetStudentIds = [row.id];

    const [enrolment] = await db
      .select({ sectionId: enrollments.sectionId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.schoolId, schoolId),
          eq(enrollments.studentId, row.id),
          eq(enrollments.academicYearId, term.academicYearId),
          sql`${enrollments.endedOn} is null`,
        ),
      )
      .limit(1);
    sectionId = enrolment?.sectionId ?? null;
    // Same rule when a single student is named: the caller must be entitled
    // to that student's class.
    if (sectionId) assertSectionAllowed(ctx, sectionId);
  } else if (options.sectionId) {
    // Holding reportCard.generate is not enough: a class teacher may only
    // generate for classes they actually teach. Without this a restricted
    // teacher could produce (and read) any class's results.
    assertSectionAllowed(ctx, options.sectionId);

    const [section] = await db
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.schoolId, schoolId), eq(sections.id, options.sectionId)))
      .limit(1);
    if (!section) throw new GradebookError('Not found', 404);
    sectionId = section.id;

    const roster = await db
      .select({ studentId: enrollments.studentId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.schoolId, schoolId),
          eq(enrollments.sectionId, section.id),
          eq(enrollments.academicYearId, term.academicYearId),
          sql`${enrollments.endedOn} is null`,
          eq(enrollments.status, 'enrolled'),
        ),
      );
    targetStudentIds = roster.map((r) => r.studentId);
  }

  if (targetStudentIds.length === 0) {
    return { generated: 0, skipped: 0, studentIds: [] };
  }

  // Make sure the aggregates are current before snapshotting anything.
  if (sectionId) {
    await recomputeTermResults(db, schoolId, sectionId, options.termId);
  }

  const existing = await db
    .select({ id: reportCards.id, studentId: reportCards.studentId, status: reportCards.status })
    .from(reportCards)
    .where(
      and(
        eq(reportCards.schoolId, schoolId),
        eq(reportCards.termId, options.termId),
        inArray(reportCards.studentId, targetStudentIds),
      ),
    );
  const byStudent = new Map(existing.map((e) => [e.studentId, e]));

  let generated = 0;
  let skipped = 0;

  for (const studentId of targetStudentIds) {
    const current = byStudent.get(studentId);
    // Never silently rewrite a document that is already in a parent's hands.
    if (current && current.status === 'published') {
      skipped++;
      continue;
    }

    if (current) {
      await db
        .update(reportCards)
        .set({ generatedAt: new Date(), generatedBy: ctx.user.userId, updatedAt: new Date() })
        .where(eq(reportCards.id, current.id));
    } else {
      await db.insert(reportCards).values({
        schoolId,
        studentId,
        termId: options.termId,
        status: 'draft',
        generatedBy: ctx.user.userId,
      });
    }
    generated++;
  }

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'reportCard.generate',
    entityType: 'reportCard',
    entityId: options.sectionId ?? options.studentId ?? null,
    summary: `Generated ${generated} report card${generated === 1 ? '' : 's'} for ${term.name}${
      skipped > 0 ? ` (${skipped} already published, left unchanged)` : ''
    }`,
    newValue: { termId: options.termId, generated, skipped },
    ipAddress: ctx.ipAddress,
  });

  return { generated, skipped, studentIds: targetStudentIds };
}

/** Build the snapshot payload for one student. */
async function buildSnapshot(
  db: Database,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<ReportCardSnapshot | null> {
  const report = await getStudentTermReport(db, schoolId, studentId, termId);
  if (!report) return null;

  const settings = await getSetting(db, schoolId, 'reportCard');

  let attendancePercent: number | null = null;
  if (settings.showAttendance) {
    try {
      // Attendance is reported for the term's own date range, not the whole
      // year — a Term 1 card must not quote Term 2 attendance.
      const [termRow] = await db
        .select({
          academicYearId: terms.academicYearId,
          startDate: terms.startDate,
          endDate: terms.endDate,
        })
        .from(terms)
        .where(and(eq(terms.schoolId, schoolId), eq(terms.id, termId)))
        .limit(1);

      if (termRow) {
        const history = await getStudentAttendance(db, schoolId, studentId, {
          academicYearId: termRow.academicYearId,
          from: termRow.startDate,
          to: termRow.endDate,
          limit: 1,
        });
        attendancePercent = history.summary.percent;
      }
    } catch {
      // Attendance is supplementary on a report card; if the module is off or
      // the term has no sessions, the card is still valid without it.
      attendancePercent = null;
    }
  }

  return {
    student: report.student,
    term: { id: report.term.id, name: report.term.name },
    subjects: report.subjects.map((s) => ({
      subjectName: s.subjectName,
      subjectNameAm: s.subjectNameAm,
      percentage: s.percentage,
      letter: s.letter,
      points: s.points,
      isPass: s.isPass,
      rank: settings.showRank ? s.rank : null,
    })),
    average: report.average,
    gpa: report.showGpa ? report.gpa : null,
    rankInSection: settings.showRank ? report.rankInSection : null,
    classSize: report.classSize,
    isPass: report.isPass,
    attendancePercent,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Move a report card through draft → pending_approval → approved → published.
 *
 * The chain itself is configured: a school with no review step publishes
 * straight from draft.
 */
export async function changeReportCardStatus(
  ctx: AuthContext,
  reportCardId: string,
  action: 'submit' | 'approve' | 'publish' | 'unpublish',
  reason?: string,
): Promise<{ status: ReportCardStatus }> {
  const { db, schoolId } = ctx;

  const [card] = await db
    .select()
    .from(reportCards)
    .where(and(eq(reportCards.schoolId, schoolId), eq(reportCards.id, reportCardId)))
    .limit(1);
  if (!card) throw new GradebookError('Not found', 404);

  const settings = await getSetting(db, schoolId, 'reportCard');
  const requiresApproval = settings.approvalChain.includes('reportCard.approve');

  const current = card.status as ReportCardStatus;
  const now = new Date();
  const patch: Record<string, unknown> = { updatedAt: now };
  let next: ReportCardStatus;

  switch (action) {
    case 'submit': {
      ctx.require('reportCard.generate');
      if (current !== 'draft') {
        throw new GradebookError(`Cannot submit a report card that is "${current}".`, 409);
      }
      next = requiresApproval ? 'pending_approval' : 'approved';
      if (!requiresApproval) {
        patch.approvedAt = now;
        patch.approvedBy = ctx.user.userId;
      }
      break;
    }
    case 'approve': {
      ctx.require('reportCard.approve');
      if (current !== 'pending_approval' && current !== 'draft') {
        throw new GradebookError(`Cannot approve a report card that is "${current}".`, 409);
      }
      next = 'approved';
      patch.approvedAt = now;
      patch.approvedBy = ctx.user.userId;
      break;
    }
    case 'publish': {
      ctx.require('reportCard.publish');
      // Publishing without approval would defeat the point of an approval chain.
      if (requiresApproval && current !== 'approved') {
        throw new GradebookError('This report card must be approved before it is published.', 409);
      }
      next = 'published';
      patch.publishedAt = now;
      patch.publishedBy = ctx.user.userId;
      // Freeze the figures as published.
      patch.snapshot = await buildSnapshot(db, schoolId, card.studentId, card.termId);
      break;
    }
    case 'unpublish': {
      ctx.require('reportCard.publish');
      if (current !== 'published') {
        throw new GradebookError('That report card is not published.', 409);
      }
      next = 'approved';
      patch.publishedAt = null;
      patch.publishedBy = null;
      // A withdrawn card that is republished must be a new version, so the
      // parent can tell the document changed.
      patch.version = card.version + 1;
      break;
    }
  }

  patch.status = next;
  await db.update(reportCards).set(patch).where(eq(reportCards.id, reportCardId));

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action:
      action === 'approve'
        ? 'reportCard.approve'
        : action === 'publish' || action === 'unpublish'
          ? 'reportCard.publish'
          : 'reportCard.generate',
    entityType: 'reportCard',
    entityId: reportCardId,
    summary: `Report card ${current} → ${next}`,
    previousValue: { status: current },
    newValue: { status: next },
    reason: reason || null,
    ipAddress: ctx.ipAddress,
  });

  return { status: next };
}

/** Publish every approved card for a class in one action. */
export async function publishForSection(
  ctx: AuthContext,
  options: { termId: string; sectionId: string },
): Promise<{ published: number; blocked: number }> {
  ctx.require('reportCard.publish');
  assertSectionAllowed(ctx, options.sectionId);
  const { db, schoolId } = ctx;

  const settings = await getSetting(db, schoolId, 'reportCard');
  const requiresApproval = settings.approvalChain.includes('reportCard.approve');

  const [term] = await db
    .select({ academicYearId: terms.academicYearId })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.id, options.termId)))
    .limit(1);
  if (!term) throw new GradebookError('Not found', 404);

  const roster = await db
    .select({ studentId: enrollments.studentId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.sectionId, options.sectionId),
        eq(enrollments.academicYearId, term.academicYearId),
        sql`${enrollments.endedOn} is null`,
      ),
    );
  if (roster.length === 0) return { published: 0, blocked: 0 };

  const cards = await db
    .select({ id: reportCards.id, studentId: reportCards.studentId, status: reportCards.status })
    .from(reportCards)
    .where(
      and(
        eq(reportCards.schoolId, schoolId),
        eq(reportCards.termId, options.termId),
        inArray(
          reportCards.studentId,
          roster.map((r) => r.studentId),
        ),
      ),
    );

  let published = 0;
  let blocked = 0;

  for (const card of cards) {
    if (card.status === 'published') continue;
    if (requiresApproval && card.status !== 'approved') {
      blocked++;
      continue;
    }
    const snapshot = await buildSnapshot(db, schoolId, card.studentId, options.termId);
    await db
      .update(reportCards)
      .set({
        status: 'published',
        publishedAt: new Date(),
        publishedBy: ctx.user.userId,
        snapshot,
        updatedAt: new Date(),
      })
      .where(eq(reportCards.id, card.id));
    published++;
  }

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'reportCard.publish',
    entityType: 'section',
    entityId: options.sectionId,
    summary: `Published ${published} report card${published === 1 ? '' : 's'}${
      blocked > 0 ? `; ${blocked} still awaiting approval` : ''
    }`,
    newValue: { termId: options.termId, published, blocked },
    ipAddress: ctx.ipAddress,
  });

  return { published, blocked };
}

/** Save the teacher's or principal's comment. */
export async function saveReportCardComments(
  ctx: AuthContext,
  reportCardId: string,
  input: { classTeacherComment?: string; principalComment?: string; conduct?: string },
): Promise<void> {
  const { db, schoolId } = ctx;

  const [card] = await db
    .select()
    .from(reportCards)
    .where(and(eq(reportCards.schoolId, schoolId), eq(reportCards.id, reportCardId)))
    .limit(1);
  if (!card) throw new GradebookError('Not found', 404);

  // A published card is a signed document; commenting on it later would change
  // what the parent already read.
  if (card.status === 'published' && !ctx.has('reportCard.publish')) {
    throw new GradebookError('This report card has been published and cannot be edited.', 403);
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.classTeacherComment !== undefined) {
    ctx.requireAny('reportCard.generate', 'grade.enter');
    patch.classTeacherComment = input.classTeacherComment || null;
  }
  if (input.principalComment !== undefined) {
    // The principal's comment is a distinct authority from the class teacher's.
    ctx.require('reportCard.approve');
    patch.principalComment = input.principalComment || null;
  }
  if (input.conduct !== undefined) {
    ctx.requireAny('reportCard.generate', 'grade.enter');
    patch.conduct = input.conduct || null;
  }

  await db.update(reportCards).set(patch).where(eq(reportCards.id, reportCardId));

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'reportCard.generate',
    entityType: 'reportCard',
    entityId: reportCardId,
    summary: 'Updated report card comments',
    newValue: patch,
    ipAddress: ctx.ipAddress,
  });
}

export type ReportCardView = {
  id: string;
  status: ReportCardStatus;
  version: number;
  classTeacherComment: string | null;
  principalComment: string | null;
  conduct: string | null;
  publishedAt: string | null;
  /** Live figures, or the frozen snapshot when published. */
  data: ReportCardSnapshot | null;
  settings: {
    showRank: boolean;
    showAttendance: boolean;
    showPhoto: boolean;
    showClassAverage: boolean;
    showTeacherComment: boolean;
    showPrincipalComment: boolean;
    showConduct: boolean;
    showSignatures: boolean;
    headerText: string | null;
    footerText: string | null;
  };
};

/**
 * Read one report card.
 *
 * A published card is served from its snapshot so it matches the printed copy
 * exactly; an unpublished one is computed live so staff see current figures.
 */
export async function getReportCard(
  db: Database,
  schoolId: string,
  reportCardId: string,
): Promise<ReportCardView | null> {
  const [card] = await db
    .select()
    .from(reportCards)
    .where(and(eq(reportCards.schoolId, schoolId), eq(reportCards.id, reportCardId)))
    .limit(1);
  if (!card) return null;

  const settings = await getSetting(db, schoolId, 'reportCard');

  const data =
    card.status === 'published' && card.snapshot
      ? (card.snapshot as ReportCardSnapshot)
      : await buildSnapshot(db, schoolId, card.studentId, card.termId);

  return {
    id: card.id,
    status: card.status as ReportCardStatus,
    version: card.version,
    classTeacherComment: card.classTeacherComment,
    principalComment: card.principalComment,
    conduct: card.conduct,
    publishedAt: card.publishedAt?.toISOString() ?? null,
    data,
    settings: {
      showRank: settings.showRank,
      showAttendance: settings.showAttendance,
      showPhoto: settings.showPhoto,
      showClassAverage: settings.showClassAverage,
      showTeacherComment: settings.showTeacherComment,
      showPrincipalComment: settings.showPrincipalComment,
      showConduct: settings.showConduct,
      showSignatures: settings.showSignatures,
      headerText: settings.headerText ?? null,
      footerText: settings.footerText ?? null,
    },
  };
}

/**
 * A student's report card for a term, if they are allowed to see it.
 *
 * This is the portal path. Unpublished results are invisible when the school
 * requires publication, regardless of what id is supplied.
 */
export async function getPublishedReportCard(
  db: Database,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<ReportCardView | null> {
  const settings = await getSetting(db, schoolId, 'reportCard');

  const [card] = await db
    .select()
    .from(reportCards)
    .where(
      and(
        eq(reportCards.schoolId, schoolId),
        eq(reportCards.studentId, studentId),
        eq(reportCards.termId, termId),
      ),
    )
    .limit(1);

  if (!card) return null;
  if (settings.publishToPortals && card.status !== 'published') return null;

  return getReportCard(db, schoolId, card.id);
}

/** Report-card progress for a class, for the staff list view. */
export async function getSectionReportCardStatus(
  ctx: AuthContext,
  termId: string,
  sectionId: string,
): Promise<
  {
    reportCardId: string | null;
    studentId: string;
    studentName: string;
    studentCode: string;
    status: ReportCardStatus | 'not_generated';
    average: number | null;
    rank: number | null;
  }[]
> {
  ctx.requireAny('reportCard.view', 'reportCard.generate');
  assertSectionAllowed(ctx, sectionId);
  const { db, schoolId } = ctx;

  const [term] = await db
    .select({ academicYearId: terms.academicYearId })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.id, termId)))
    .limit(1);
  if (!term) return [];

  const rows = await db
    .select({
      studentId: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
      reportCardId: reportCards.id,
      status: reportCards.status,
      average: termResults.average,
      rank: termResults.rankInSection,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .leftJoin(
      reportCards,
      and(eq(reportCards.studentId, students.id), eq(reportCards.termId, termId)),
    )
    .leftJoin(
      termResults,
      and(eq(termResults.studentId, students.id), eq(termResults.termId, termId)),
    )
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.sectionId, sectionId),
        eq(enrollments.academicYearId, term.academicYearId),
        sql`${enrollments.endedOn} is null`,
        eq(enrollments.status, 'enrolled'),
      ),
    )
    .orderBy(asc(enrollments.rollNumber), asc(students.givenName));

  const grading = await getSetting(db, schoolId, 'grading');

  return rows.map((r) => ({
    reportCardId: r.reportCardId,
    studentId: r.studentId,
    studentCode: r.studentCode,
    studentName: [r.givenName, r.fatherName, r.grandfatherName].filter(Boolean).join(' '),
    status: (r.status as ReportCardStatus) ?? 'not_generated',
    average: r.average,
    rank: grading.useRanking ? r.rank : null,
  }));
}
