/**
 * Gradebook service.
 *
 * Everything that reads or writes marks goes through here, so the rules hold
 * whichever entry point is used — the teacher's grid, an API client, or a later
 * bulk import.
 *
 * THE CONFIGURATION IS THE SPEC. `resolveGradingConfig` decides which
 * assessment structure applies to a class subject: a per-subject override if
 * one is attached, otherwise the school's default. Nothing in this file knows
 * what a "midterm" is; it only knows that an assessment names a component key
 * which must exist in the resolved configuration.
 *
 * PERMISSION IS RELATIONSHIP-BASED. Holding `grade.enter` does not let a
 * teacher touch every class — it lets them touch the classes they are actually
 * assigned to. `grade.editAny`-style breadth comes from `grade.overrideLocked`
 * and `grade.review`, which administrators hold.
 */

import { and, eq, inArray, sql, desc, asc } from 'drizzle-orm';

import type { Database } from '../../db/client.ts';
import type { AuthContext } from '../auth/context.ts';
import { AuthError } from '../auth/context.ts';
import {
  assessments,
  marks,
  markChanges,
  subjectResults,
  termResults,
  gradingConfigs,
} from '../../db/schema/academics.ts';
import {
  sectionSubjects,
  sections,
  subjects,
  terms,
  users,
} from '../../db/schema/core.ts';
import { students, enrollments } from '../../db/schema/people.ts';
import { getSetting } from '../settings/service.ts';
import { recordAudit } from '../audit/index.ts';
import {
  calculateSubjectResult,
  calculateTermAggregate,
  rankStudents,
  validateMark,
  type RawMark,
  type SubjectScore,
} from '../grading/calculate.ts';
import { assessmentComponentSchema, type AssessmentComponent } from '../settings/schemas.ts';
import type {
  CreateAssessmentInput,
  SaveMarksInput,
  AssessmentStatus,
} from './schema.ts';

export class GradebookError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GradebookError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

export type ResolvedGradingConfig = {
  components: AssessmentComponent[];
  passMarkPercent: number;
  /** Where the structure came from, for display and for debugging. */
  source: 'school' | 'override';
  configName: string | null;
};

/**
 * Which assessment structure applies to this class subject?
 *
 * Order: a `grading_configs` row attached to the section-subject wins;
 * otherwise the school's `grading.components` setting. This is the seam that
 * lets one school weight practical subjects differently without a code change.
 */
export async function resolveGradingConfig(
  db: Database,
  schoolId: string,
  sectionSubjectId: string,
): Promise<ResolvedGradingConfig> {
  const grading = await getSetting(db, schoolId, 'grading');

  const [link] = await db
    .select({ configId: sectionSubjects.gradingConfigId })
    .from(sectionSubjects)
    .where(and(eq(sectionSubjects.schoolId, schoolId), eq(sectionSubjects.id, sectionSubjectId)))
    .limit(1);

  if (link?.configId) {
    const [config] = await db
      .select()
      .from(gradingConfigs)
      .where(and(eq(gradingConfigs.schoolId, schoolId), eq(gradingConfigs.id, link.configId)))
      .limit(1);

    if (config?.isActive) {
      // Validate the stored JSON rather than trusting it: a config written by
      // an older version of the app must not crash mark entry today.
      const parsed = assessmentComponentSchema.array().safeParse(config.components);
      if (parsed.success && parsed.data.length > 0) {
        return {
          components: parsed.data,
          passMarkPercent: config.passMarkPercent ?? grading.passMarkPercent,
          source: 'override',
          configName: config.name,
        };
      }
    }
  }

  return {
    components: grading.components,
    passMarkPercent: grading.passMarkPercent,
    source: 'school',
    configName: null,
  };
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

/**
 * May this user enter or change marks for this class subject?
 *
 * Returns a reason rather than throwing so callers can convert it to the right
 * status code and message.
 */
export async function checkGradebookAccess(
  ctx: AuthContext,
  sectionSubjectId: string,
  intent: 'view' | 'enter' | 'review',
): Promise<{ allowed: true } | { allowed: false; reason: string; status: number }> {
  const { db, schoolId } = ctx;

  const [link] = await db
    .select({
      id: sectionSubjects.id,
      sectionId: sectionSubjects.sectionId,
      teacherId: sectionSubjects.teacherId,
    })
    .from(sectionSubjects)
    .where(and(eq(sectionSubjects.schoolId, schoolId), eq(sectionSubjects.id, sectionSubjectId)))
    .limit(1);

  // Not found and not-in-this-school are the same answer: a 404 reveals
  // nothing about another school's ids.
  if (!link) return { allowed: false, reason: 'Not found', status: 404 };

  if (intent === 'review') {
    if (!ctx.has('grade.review')) {
      return { allowed: false, reason: 'You are not allowed to review marks.', status: 403 };
    }
    return { allowed: true };
  }

  if (intent === 'view') {
    if (!ctx.hasAny('grade.view', 'grade.enter')) {
      return { allowed: false, reason: 'You are not allowed to view marks.', status: 403 };
    }
    // A teacher restricted to their own sections may not browse others'.
    if (ctx.has('restrict.ownSectionsOnly') && !ctx.has('grade.review')) {
      const own =
        ctx.relationships.sectionSubjectIds.includes(sectionSubjectId) ||
        ctx.relationships.sectionIds.includes(link.sectionId);
      if (!own) return { allowed: false, reason: 'Not found', status: 404 };
    }
    return { allowed: true };
  }

  // intent === 'enter'
  if (!ctx.has('grade.enter')) {
    return { allowed: false, reason: 'You are not allowed to enter marks.', status: 403 };
  }

  // Reviewers/administrators may enter for any class; a teacher may not.
  if (ctx.has('grade.review') || ctx.has('grade.overrideLocked')) return { allowed: true };

  const teaches =
    ctx.relationships.sectionSubjectIds.includes(sectionSubjectId) ||
    link.teacherId === ctx.user.userId;
  if (!teaches) {
    return { allowed: false, reason: 'You do not teach this subject to this class.', status: 403 };
  }

  return { allowed: true };
}

function assertAccess(
  result: { allowed: true } | { allowed: false; reason: string; status: number },
): void {
  if (!result.allowed) throw new GradebookError(result.reason, result.status);
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

export type AssessmentRow = {
  id: string;
  componentKey: string;
  componentName: string;
  instance: number;
  title: string;
  maxMark: number;
  assessedOn: string | null;
  status: AssessmentStatus;
  markedCount: number;
  studentCount: number;
};

/** Every assessment for a class subject in a term, with entry progress. */
export async function listAssessments(
  ctx: AuthContext,
  sectionSubjectId: string,
  termId: string,
): Promise<{ assessments: AssessmentRow[]; config: ResolvedGradingConfig }> {
  assertAccess(await checkGradebookAccess(ctx, sectionSubjectId, 'view'));
  const { db, schoolId } = ctx;

  const config = await resolveGradingConfig(db, schoolId, sectionSubjectId);

  const rows = await db
    .select({
      id: assessments.id,
      componentKey: assessments.componentKey,
      instance: assessments.instance,
      title: assessments.title,
      maxMark: assessments.maxMark,
      assessedOn: assessments.assessedOn,
      status: assessments.status,
      // The outer column MUST be table-qualified here. This query has no JOIN,
      // and without one Drizzle interpolates `assessments.id` as a bare "id",
      // which Postgres resolves against the subquery's own table: the count
      // then silently returns 0 for every assessment instead of erroring.
      // (Caught by test: "assessment progress counts real marks, not zero".)
      markedCount: sql<number>`(
        select count(*)::int from ${marks} m
        where m.assessment_id = ${assessments}.${sql.identifier('id')}
          and (m.mark is not null or m.is_excused)
      )`,
    })
    .from(assessments)
    .where(
      and(
        eq(assessments.schoolId, schoolId),
        eq(assessments.sectionSubjectId, sectionSubjectId),
        eq(assessments.termId, termId),
      ),
    )
    .orderBy(asc(assessments.componentKey), asc(assessments.instance));

  const studentCount = (await getClassRoster(ctx, sectionSubjectId)).length;
  const componentName = (key: string) =>
    config.components.find((c) => c.key === key)?.name ?? key;

  return {
    config,
    assessments: rows.map((r) => ({
      id: r.id,
      componentKey: r.componentKey,
      componentName: componentName(r.componentKey),
      instance: r.instance,
      title: r.title,
      maxMark: r.maxMark,
      assessedOn: r.assessedOn,
      status: r.status as AssessmentStatus,
      markedCount: r.markedCount,
      studentCount,
    })),
  };
}

/** Create a piece of assessed work. */
export async function createAssessment(
  ctx: AuthContext,
  input: CreateAssessmentInput,
): Promise<{ id: string }> {
  assertAccess(await checkGradebookAccess(ctx, input.sectionSubjectId, 'enter'));
  const { db, schoolId } = ctx;

  const config = await resolveGradingConfig(db, schoolId, input.sectionSubjectId);
  const component = config.components.find((c) => c.key === input.componentKey);

  // The component must exist in the school's configuration. This is what keeps
  // assessment types configurable instead of hard-coded: an unknown key is a
  // configuration problem, reported as such.
  if (!component) {
    throw new GradebookError(
      `"${input.componentKey}" is not one of this school's assessment types. Configured types: ${
        config.components.map((c) => c.key).join(', ') || 'none'
      }.`,
    );
  }

  if (input.instance > component.instances) {
    throw new GradebookError(
      `${component.name} is configured for ${component.instances} instance${
        component.instances === 1 ? '' : 's'
      }; cannot create number ${input.instance}.`,
    );
  }

  // The term must belong to this school and this class's year.
  const [term] = await db
    .select({ id: terms.id, academicYearId: terms.academicYearId, isLocked: terms.isLocked })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.id, input.termId)))
    .limit(1);
  if (!term) throw new GradebookError('That term does not exist.', 404);
  if (term.isLocked && !ctx.has('grade.overrideLocked')) {
    throw new GradebookError('That term is locked. Ask an administrator.', 403);
  }

  const [row] = await db
    .insert(assessments)
    .values({
      schoolId,
      academicYearId: term.academicYearId,
      termId: input.termId,
      sectionSubjectId: input.sectionSubjectId,
      componentKey: input.componentKey,
      instance: input.instance,
      title: input.title,
      titleAm: input.titleAm || null,
      maxMark: input.maxMark,
      assessedOn: input.assessedOn || null,
      createdBy: ctx.user.userId,
    })
    .returning({ id: assessments.id });

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'grade.enter',
    entityType: 'assessment',
    entityId: row!.id,
    summary: `Created assessment "${input.title}" (${component.name})`,
    newValue: { componentKey: input.componentKey, instance: input.instance, maxMark: input.maxMark },
    ipAddress: ctx.ipAddress,
  });

  return { id: row!.id };
}

// ---------------------------------------------------------------------------
// Roster and mark entry
// ---------------------------------------------------------------------------

export type ClassStudent = {
  studentId: string;
  studentCode: string;
  name: string;
  rollNumber: number | null;
};

/** Students currently enrolled in the section this class subject belongs to. */
export async function getClassRoster(
  ctx: AuthContext,
  sectionSubjectId: string,
): Promise<ClassStudent[]> {
  const { db, schoolId } = ctx;

  const [link] = await db
    .select({ sectionId: sectionSubjects.sectionId, academicYearId: sectionSubjects.academicYearId })
    .from(sectionSubjects)
    .where(and(eq(sectionSubjects.schoolId, schoolId), eq(sectionSubjects.id, sectionSubjectId)))
    .limit(1);
  if (!link) return [];

  const rows = await db
    .select({
      studentId: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
      rollNumber: enrollments.rollNumber,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.sectionId, link.sectionId),
        eq(enrollments.academicYearId, link.academicYearId),
        sql`${enrollments.endedOn} is null`,
        eq(enrollments.status, 'enrolled'),
      ),
    )
    .orderBy(asc(enrollments.rollNumber), asc(students.givenName));

  return rows.map((r) => ({
    studentId: r.studentId,
    studentCode: r.studentCode,
    name: [r.givenName, r.fatherName, r.grandfatherName].filter(Boolean).join(' '),
    rollNumber: r.rollNumber,
  }));
}

export type MarkSheetRow = ClassStudent & {
  mark: number | null;
  excused: boolean;
  note: string | null;
};

export type MarkSheet = {
  assessment: {
    id: string;
    title: string;
    componentKey: string;
    componentName: string;
    maxMark: number;
    status: AssessmentStatus;
    reviewNote: string | null;
  };
  rows: MarkSheetRow[];
  canEdit: boolean;
};

/** The entry grid for one assessment. */
export async function getMarkSheet(
  ctx: AuthContext,
  assessmentId: string,
): Promise<MarkSheet> {
  const { db, schoolId } = ctx;

  const [assessment] = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.schoolId, schoolId), eq(assessments.id, assessmentId)))
    .limit(1);
  if (!assessment) throw new GradebookError('Not found', 404);

  assertAccess(await checkGradebookAccess(ctx, assessment.sectionSubjectId, 'view'));

  const config = await resolveGradingConfig(db, schoolId, assessment.sectionSubjectId);
  const roster = await getClassRoster(ctx, assessment.sectionSubjectId);

  const existing = await db
    .select({
      studentId: marks.studentId,
      mark: marks.mark,
      isExcused: marks.isExcused,
      note: marks.note,
    })
    .from(marks)
    .where(and(eq(marks.schoolId, schoolId), eq(marks.assessmentId, assessmentId)));

  const byStudent = new Map(existing.map((m) => [m.studentId, m]));

  const entryAccess = await checkGradebookAccess(ctx, assessment.sectionSubjectId, 'enter');
  const locked = assessment.status === 'locked' || assessment.status === 'approved';
  const canEdit =
    entryAccess.allowed && (!locked || ctx.has('grade.overrideLocked'));

  return {
    assessment: {
      id: assessment.id,
      title: assessment.title,
      componentKey: assessment.componentKey,
      componentName:
        config.components.find((c) => c.key === assessment.componentKey)?.name ??
        assessment.componentKey,
      maxMark: assessment.maxMark,
      status: assessment.status as AssessmentStatus,
      reviewNote: assessment.reviewNote,
    },
    rows: roster.map((s) => {
      const m = byStudent.get(s.studentId);
      return {
        ...s,
        mark: m?.mark ?? null,
        excused: m?.isExcused ?? false,
        note: m?.note ?? null,
      };
    }),
    canEdit,
  };
}

/**
 * Save a batch of marks.
 *
 * One bad mark does not discard the rest: valid entries are written and the
 * invalid ones are reported, exactly as the import wizard behaves. A teacher
 * who mistypes one number should not lose the other forty-nine.
 */
export async function saveMarks(
  ctx: AuthContext,
  input: SaveMarksInput,
): Promise<{ saved: number; changed: number; errors: Record<string, string>; status: AssessmentStatus }> {
  const { db, schoolId } = ctx;

  const [assessment] = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.schoolId, schoolId), eq(assessments.id, input.assessmentId)))
    .limit(1);
  if (!assessment) throw new GradebookError('Not found', 404);

  assertAccess(await checkGradebookAccess(ctx, assessment.sectionSubjectId, 'enter'));

  const isLocked = assessment.status === 'locked' || assessment.status === 'approved';
  if (isLocked && !ctx.has('grade.overrideLocked')) {
    throw new GradebookError(
      assessment.status === 'locked'
        ? 'These marks are locked. Ask someone with permission to unlock them.'
        : 'These marks have been approved and can no longer be changed.',
      403,
    );
  }

  // Only students actually in this class may receive a mark. Without this a
  // crafted request could attach a mark to any student id in the school.
  const roster = await getClassRoster(ctx, assessment.sectionSubjectId);
  const allowed = new Set(roster.map((r) => r.studentId));

  const existing = await db
    .select({ id: marks.id, studentId: marks.studentId, mark: marks.mark, isExcused: marks.isExcused })
    .from(marks)
    .where(and(eq(marks.schoolId, schoolId), eq(marks.assessmentId, input.assessmentId)));
  const byStudent = new Map(existing.map((m) => [m.studentId, m]));

  const errors: Record<string, string> = {};
  let saved = 0;
  let changed = 0;

  await db.transaction(async (tx) => {
    for (const entry of input.entries) {
      if (!allowed.has(entry.studentId)) {
        errors[entry.studentId] = 'That student is not in this class.';
        continue;
      }

      const check = validateMark(entry.mark, assessment.maxMark);
      if (!check.ok) {
        errors[entry.studentId] = check.error;
        continue;
      }

      const previous = byStudent.get(entry.studentId);
      const newMark = entry.excused ? null : entry.mark;
      const newExcused = entry.excused;

      if (previous) {
        const unchanged = previous.mark === newMark && previous.isExcused === newExcused;
        if (unchanged) {
          saved++;
          continue;
        }

        await tx
          .update(marks)
          .set({
            mark: newMark,
            isExcused: newExcused,
            note: entry.note || null,
            enteredBy: ctx.user.userId,
            enteredAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(marks.id, previous.id));

        // Grade changes are the most disputed record a school keeps, so every
        // change is written to its own history table, not just the audit log.
        await tx.insert(markChanges).values({
          schoolId,
          markId: previous.id,
          studentId: entry.studentId,
          previousMark: previous.mark,
          newMark,
          previousExcused: previous.isExcused,
          newExcused,
          wasLocked: isLocked,
          reason: isLocked ? 'Changed after lock' : null,
          changedBy: ctx.user.userId,
        });

        changed++;
        saved++;
      } else {
        await tx.insert(marks).values({
          schoolId,
          assessmentId: input.assessmentId,
          studentId: entry.studentId,
          mark: newMark,
          isExcused: newExcused,
          note: entry.note || null,
          enteredBy: ctx.user.userId,
        });
        saved++;
        changed++;
      }
    }

    if (input.submit && Object.keys(errors).length === 0) {
      await tx
        .update(assessments)
        .set({
          status: 'submitted',
          submittedAt: new Date(),
          submittedBy: ctx.user.userId,
          reviewNote: null,
          updatedAt: new Date(),
        })
        .where(eq(assessments.id, input.assessmentId));
    }

    await recordAudit(tx as unknown as Database, {
      schoolId,
      actorUserId: ctx.user.userId,
      actorName: ctx.displayName(),
      action: isLocked ? 'grade.overrideLocked' : 'grade.enter',
      entityType: 'assessment',
      entityId: input.assessmentId,
      summary: `${changed} mark${changed === 1 ? '' : 's'} recorded for "${assessment.title}"${
        isLocked ? ' (locked assessment overridden)' : ''
      }`,
      newValue: { saved, changed, submitted: input.submit },
      ipAddress: ctx.ipAddress,
    });
  });

  // Recompute the cached results so the report card and portals stay truthful.
  await recomputeForAssessment(ctx, input.assessmentId);

  const status: AssessmentStatus =
    input.submit && Object.keys(errors).length === 0
      ? 'submitted'
      : (assessment.status as AssessmentStatus);

  return { saved, changed, errors, status };
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

const WORKFLOW: Record<
  string,
  { from: AssessmentStatus[]; to: AssessmentStatus; permission: string; audit: 'grade.submit' | 'grade.approve' | 'grade.lock' | 'grade.unlock' | 'grade.update' }
> = {
  submit: { from: ['draft'], to: 'submitted', permission: 'grade.submit', audit: 'grade.submit' },
  approve: { from: ['submitted'], to: 'approved', permission: 'grade.review', audit: 'grade.approve' },
  reject: { from: ['submitted'], to: 'draft', permission: 'grade.review', audit: 'grade.update' },
  lock: { from: ['approved', 'submitted'], to: 'locked', permission: 'grade.lock', audit: 'grade.lock' },
  unlock: { from: ['locked'], to: 'approved', permission: 'grade.lock', audit: 'grade.unlock' },
};

/** Move an assessment through the submit → review → lock workflow. */
export async function changeAssessmentStatus(
  ctx: AuthContext,
  assessmentId: string,
  action: 'submit' | 'approve' | 'reject' | 'lock' | 'unlock',
  reason?: string,
): Promise<{ status: AssessmentStatus }> {
  const { db, schoolId } = ctx;
  const rule = WORKFLOW[action]!;

  const [assessment] = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.schoolId, schoolId), eq(assessments.id, assessmentId)))
    .limit(1);
  if (!assessment) throw new GradebookError('Not found', 404);

  if (!ctx.has(rule.permission as never)) {
    throw new GradebookError('You are not allowed to do this.', 403);
  }

  // Submitting is the teacher's own action, so it is also relationship-checked.
  if (action === 'submit') {
    assertAccess(await checkGradebookAccess(ctx, assessment.sectionSubjectId, 'enter'));
  }

  const current = assessment.status as AssessmentStatus;
  if (!rule.from.includes(current)) {
    throw new GradebookError(
      `Cannot ${action} marks that are currently "${current}".`,
      409,
    );
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: rule.to, updatedAt: now };
  if (action === 'submit') {
    patch.submittedAt = now;
    patch.submittedBy = ctx.user.userId;
    patch.reviewNote = null;
  }
  if (action === 'approve') {
    patch.approvedAt = now;
    patch.approvedBy = ctx.user.userId;
  }
  if (action === 'reject') {
    patch.reviewNote = reason ?? null;
    patch.submittedAt = null;
    patch.submittedBy = null;
  }
  if (action === 'lock') {
    patch.lockedAt = now;
    patch.lockedBy = ctx.user.userId;
  }
  if (action === 'unlock') {
    patch.lockedAt = null;
    patch.lockedBy = null;
  }

  await db.update(assessments).set(patch).where(eq(assessments.id, assessmentId));

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: rule.audit,
    entityType: 'assessment',
    entityId: assessmentId,
    summary: `Marks for "${assessment.title}" ${current} → ${rule.to}`,
    previousValue: { status: current },
    newValue: { status: rule.to },
    reason: reason || null,
    ipAddress: ctx.ipAddress,
  });

  if (action === 'approve' || action === 'reject' || action === 'unlock') {
    await recomputeForAssessment(ctx, assessmentId);
  }

  return { status: rule.to };
}

// ---------------------------------------------------------------------------
// Result computation
// ---------------------------------------------------------------------------

/** Recompute cached results for everyone affected by one assessment. */
export async function recomputeForAssessment(
  ctx: AuthContext,
  assessmentId: string,
): Promise<void> {
  const { db, schoolId } = ctx;
  const [assessment] = await db
    .select({
      sectionSubjectId: assessments.sectionSubjectId,
      termId: assessments.termId,
    })
    .from(assessments)
    .where(and(eq(assessments.schoolId, schoolId), eq(assessments.id, assessmentId)))
    .limit(1);
  if (!assessment) return;

  await recomputeSubjectResults(db, schoolId, assessment.sectionSubjectId, assessment.termId);
}

/**
 * Recompute every student's result for one class subject in one term.
 *
 * Reads all marks for the term in one query rather than per student: a class of
 * 50 with 8 assessments is 400 rows, which is one round trip, not 50.
 */
export async function recomputeSubjectResults(
  db: Database,
  schoolId: string,
  sectionSubjectId: string,
  termId: string,
): Promise<void> {
  const config = await resolveGradingConfig(db, schoolId, sectionSubjectId);
  const grading = await getSetting(db, schoolId, 'grading');

  const [link] = await db
    .select({
      subjectId: sectionSubjects.subjectId,
      sectionId: sectionSubjects.sectionId,
      academicYearId: sectionSubjects.academicYearId,
    })
    .from(sectionSubjects)
    .where(and(eq(sectionSubjects.schoolId, schoolId), eq(sectionSubjects.id, sectionSubjectId)))
    .limit(1);
  if (!link) return;

  const termAssessments = await db
    .select({
      id: assessments.id,
      componentKey: assessments.componentKey,
      instance: assessments.instance,
      maxMark: assessments.maxMark,
    })
    .from(assessments)
    .where(
      and(
        eq(assessments.schoolId, schoolId),
        eq(assessments.sectionSubjectId, sectionSubjectId),
        eq(assessments.termId, termId),
      ),
    );

  const roster = await db
    .select({ studentId: enrollments.studentId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.sectionId, link.sectionId),
        eq(enrollments.academicYearId, link.academicYearId),
        sql`${enrollments.endedOn} is null`,
        eq(enrollments.status, 'enrolled'),
      ),
    );

  if (roster.length === 0) return;

  const assessmentIds = termAssessments.map((a) => a.id);
  const allMarks =
    assessmentIds.length > 0
      ? await db
          .select({
            assessmentId: marks.assessmentId,
            studentId: marks.studentId,
            mark: marks.mark,
            isExcused: marks.isExcused,
          })
          .from(marks)
          .where(and(eq(marks.schoolId, schoolId), inArray(marks.assessmentId, assessmentIds)))
      : [];

  const marksByStudent = new Map<string, typeof allMarks>();
  for (const m of allMarks) {
    const list = marksByStudent.get(m.studentId) ?? [];
    list.push(m);
    marksByStudent.set(m.studentId, list);
  }
  const assessmentById = new Map(termAssessments.map((a) => [a.id, a]));

  const computed: { studentId: string; percentage: number | null; result: ReturnType<typeof calculateSubjectResult> }[] = [];

  for (const { studentId } of roster) {
    const studentMarks = marksByStudent.get(studentId) ?? [];

    const raw: RawMark[] = [];
    for (const a of termAssessments) {
      const m = studentMarks.find((x) => x.assessmentId === a.id);
      // An excused assessment is omitted entirely, so it neither counts as zero
      // nor as an outstanding mark.
      if (m?.isExcused) continue;
      raw.push({
        componentKey: a.componentKey,
        instance: a.instance,
        mark: m?.mark ?? null,
        maxMark: a.maxMark,
      });
    }

    const result = calculateSubjectResult(
      raw,
      {
        components: config.components,
        bands: grading.bands,
        passMarkPercent: config.passMarkPercent,
        decimalPlaces: grading.decimalPlaces,
        roundTotals: grading.roundTotals,
      },
      config.components,
    );

    computed.push({ studentId, percentage: result.percentage, result });
  }

  // Rank within the subject, when the school ranks at all.
  const ranked = grading.useRanking
    ? rankStudents(computed.map((c) => ({ studentId: c.studentId, average: c.percentage })))
    : [];
  const rankByStudent = new Map(ranked.map((r) => [r.studentId, r.rank]));

  for (const entry of computed) {
    const r = entry.result;
    const values = {
      schoolId,
      studentId: entry.studentId,
      termId,
      sectionSubjectId,
      subjectId: link.subjectId,
      percentage: r.percentage,
      provisionalPercentage: r.provisionalPercentage,
      letter: r.letter,
      points: r.points,
      isPass: r.isPass,
      isComplete: r.isComplete,
      rank: rankByStudent.get(entry.studentId) ?? null,
      breakdown: r.components,
      computedAt: new Date(),
    };

    await db
      .insert(subjectResults)
      .values(values)
      .onConflictDoUpdate({
        target: [subjectResults.studentId, subjectResults.termId, subjectResults.sectionSubjectId],
        set: {
          percentage: values.percentage,
          provisionalPercentage: values.provisionalPercentage,
          letter: values.letter,
          points: values.points,
          isPass: values.isPass,
          isComplete: values.isComplete,
          rank: values.rank,
          breakdown: values.breakdown,
          computedAt: values.computedAt,
        },
      });
  }
}

/**
 * Recompute term aggregates for every student in a section.
 * Called before generating report cards, and after a subject result changes.
 */
export async function recomputeTermResults(
  db: Database,
  schoolId: string,
  sectionId: string,
  termId: string,
): Promise<void> {
  const grading = await getSetting(db, schoolId, 'grading');

  const [term] = await db
    .select({ academicYearId: terms.academicYearId })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.id, termId)))
    .limit(1);
  if (!term) return;

  const roster = await db
    .select({ studentId: enrollments.studentId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.sectionId, sectionId),
        eq(enrollments.academicYearId, term.academicYearId),
        sql`${enrollments.endedOn} is null`,
        eq(enrollments.status, 'enrolled'),
      ),
    );
  if (roster.length === 0) return;

  const studentIds = roster.map((r) => r.studentId);

  const results = await db
    .select({
      studentId: subjectResults.studentId,
      subjectId: subjectResults.subjectId,
      subjectName: subjects.name,
      percentage: subjectResults.percentage,
      points: subjectResults.points,
      isPass: subjectResults.isPass,
      creditWeight: subjects.creditWeight,
      countsTowardAverage: subjects.countsTowardAverage,
    })
    .from(subjectResults)
    .innerJoin(subjects, eq(subjects.id, subjectResults.subjectId))
    .where(
      and(
        eq(subjectResults.schoolId, schoolId),
        eq(subjectResults.termId, termId),
        inArray(subjectResults.studentId, studentIds),
      ),
    );

  const byStudent = new Map<string, SubjectScore[]>();
  for (const r of results) {
    const list = byStudent.get(r.studentId) ?? [];
    list.push({
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      percentage: r.percentage,
      points: r.points,
      creditWeight: r.creditWeight ?? 1,
      countsTowardAverage: r.countsTowardAverage ?? true,
      isPass: r.isPass,
    });
    byStudent.set(r.studentId, list);
  }

  const aggregates = studentIds.map((studentId) => {
    const scores = byStudent.get(studentId) ?? [];
    const agg = calculateTermAggregate(scores, {
      passMarkPercent: grading.passMarkPercent,
      decimalPlaces: grading.decimalPlaces,
      useGpa: grading.useGpa,
    });
    return { studentId, agg };
  });

  const ranked = grading.useRanking
    ? rankStudents(aggregates.map((a) => ({ studentId: a.studentId, average: a.agg.average })))
    : [];
  const rankByStudent = new Map(ranked.map((r) => [r.studentId, r.rank]));

  for (const { studentId, agg } of aggregates) {
    const values = {
      schoolId,
      studentId,
      termId,
      sectionId,
      average: agg.average,
      gpa: agg.gpa,
      totalSubjects: agg.totalSubjects,
      passedSubjects: agg.passedSubjects,
      failedSubjects: agg.failedSubjects,
      isPass: agg.isPass,
      rankInSection: rankByStudent.get(studentId) ?? null,
      classSize: studentIds.length,
      computedAt: new Date(),
    };

    await db
      .insert(termResults)
      .values(values)
      .onConflictDoUpdate({
        target: [termResults.studentId, termResults.termId],
        set: {
          sectionId: values.sectionId,
          average: values.average,
          gpa: values.gpa,
          totalSubjects: values.totalSubjects,
          passedSubjects: values.passedSubjects,
          failedSubjects: values.failedSubjects,
          isPass: values.isPass,
          rankInSection: values.rankInSection,
          classSize: values.classSize,
          computedAt: values.computedAt,
        },
      });
  }
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

export type StudentSubjectResult = {
  subjectId: string;
  subjectName: string;
  subjectNameAm: string | null;
  percentage: number | null;
  letter: string | null;
  points: number | null;
  isPass: boolean | null;
  isComplete: boolean;
  rank: number | null;
  teacherName: string | null;
};

export type StudentTermReport = {
  student: { id: string; name: string; studentCode: string };
  term: { id: string; name: string; sequence: number };
  subjects: StudentSubjectResult[];
  average: number | null;
  gpa: number | null;
  rankInSection: number | null;
  classSize: number | null;
  isPass: boolean | null;
  totalSubjects: number;
  passedSubjects: number;
  failedSubjects: number;
  /** Whether the school shows rank at all. */
  showRank: boolean;
  showGpa: boolean;
};

/**
 * One student's results for a term.
 *
 * Callers are responsible for having established that the viewer may see this
 * student — portals do that with `requireStudentAccess`.
 */
export async function getStudentTermReport(
  db: Database,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<StudentTermReport | null> {
  const [student] = await db
    .select({
      id: students.id,
      studentCode: students.studentCode,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
    })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), eq(students.id, studentId)))
    .limit(1);
  if (!student) return null;

  const [term] = await db
    .select({ id: terms.id, name: terms.name, sequence: terms.sequence })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.id, termId)))
    .limit(1);
  if (!term) return null;

  const grading = await getSetting(db, schoolId, 'grading');

  const rows = await db
    .select({
      subjectId: subjectResults.subjectId,
      subjectName: subjects.name,
      subjectNameAm: subjects.nameAm,
      percentage: subjectResults.percentage,
      letter: subjectResults.letter,
      points: subjectResults.points,
      isPass: subjectResults.isPass,
      isComplete: subjectResults.isComplete,
      rank: subjectResults.rank,
      teacherGiven: users.givenName,
      teacherFather: users.fatherName,
    })
    .from(subjectResults)
    .innerJoin(subjects, eq(subjects.id, subjectResults.subjectId))
    .leftJoin(sectionSubjects, eq(sectionSubjects.id, subjectResults.sectionSubjectId))
    .leftJoin(users, eq(users.id, sectionSubjects.teacherId))
    .where(
      and(
        eq(subjectResults.schoolId, schoolId),
        eq(subjectResults.studentId, studentId),
        eq(subjectResults.termId, termId),
      ),
    )
    .orderBy(asc(subjects.name));

  const [aggregate] = await db
    .select()
    .from(termResults)
    .where(
      and(
        eq(termResults.schoolId, schoolId),
        eq(termResults.studentId, studentId),
        eq(termResults.termId, termId),
      ),
    )
    .limit(1);

  return {
    student: {
      id: student.id,
      studentCode: student.studentCode,
      name: [student.givenName, student.fatherName, student.grandfatherName]
        .filter(Boolean)
        .join(' '),
    },
    term: { id: term.id, name: term.name, sequence: term.sequence },
    subjects: rows.map((r) => ({
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      subjectNameAm: r.subjectNameAm,
      percentage: r.percentage,
      letter: r.letter,
      points: r.points,
      isPass: r.isPass,
      isComplete: r.isComplete,
      rank: grading.useRanking ? r.rank : null,
      teacherName: [r.teacherGiven, r.teacherFather].filter(Boolean).join(' ') || null,
    })),
    average: aggregate?.average ?? null,
    gpa: grading.useGpa ? (aggregate?.gpa ?? null) : null,
    rankInSection: grading.useRanking ? (aggregate?.rankInSection ?? null) : null,
    classSize: aggregate?.classSize ?? null,
    isPass: aggregate?.isPass ?? null,
    totalSubjects: aggregate?.totalSubjects ?? rows.length,
    passedSubjects: aggregate?.passedSubjects ?? 0,
    failedSubjects: aggregate?.failedSubjects ?? 0,
    showRank: grading.useRanking,
    showGpa: grading.useGpa,
  };
}

/** Classes a teacher may open a gradebook for. */
export async function getTeachableClassSubjects(
  ctx: AuthContext,
): Promise<
  {
    sectionSubjectId: string;
    sectionId: string;
    sectionName: string;
    gradeName: string;
    subjectName: string;
    studentCount: number;
  }[]
> {
  const { db, schoolId } = ctx;

  const canSeeAll = ctx.has('grade.review') && !ctx.has('restrict.ownSectionsOnly');

  const rows = await db
    .select({
      sectionSubjectId: sectionSubjects.id,
      sectionId: sections.id,
      sectionName: sections.name,
      gradeName: sql<string>`(select name from grade_levels where id = ${sections.gradeLevelId})`,
      subjectName: subjects.name,
      studentCount: sql<number>`(
        select count(*)::int from ${enrollments} e
        where e.section_id = ${sections}.${sql.identifier('id')}
          and e.ended_on is null
          and e.status = 'enrolled'
      )`,
    })
    .from(sectionSubjects)
    .innerJoin(sections, eq(sections.id, sectionSubjects.sectionId))
    .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
    .where(
      canSeeAll
        ? eq(sectionSubjects.schoolId, schoolId)
        : and(
            eq(sectionSubjects.schoolId, schoolId),
            ctx.relationships.sectionSubjectIds.length > 0
              ? inArray(sectionSubjects.id, ctx.relationships.sectionSubjectIds)
              : sql`false`,
          ),
    )
    .orderBy(asc(sections.name), asc(subjects.name));

  return rows;
}
