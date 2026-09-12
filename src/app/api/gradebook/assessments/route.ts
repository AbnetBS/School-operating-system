import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import {
  listAssessments,
  createAssessment,
  getTeachableClassSubjects,
  GradebookError,
} from '../../../../lib/gradebook/service.ts';
import { createAssessmentSchema } from '../../../../lib/gradebook/schema.ts';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Convert a GradebookError into its intended status rather than a blanket 500. */
function gradebookError(error: unknown): NextResponse | null {
  if (error instanceof GradebookError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

/**
 * Assessments for a class subject in a term, or the list of classes the
 * caller may open when no class is specified.
 */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('gradebook');
  ctx.requireAny('grade.view', 'grade.enter');

  const url = new URL(request.url);
  const sectionSubjectId = url.searchParams.get('sectionSubjectId');
  const termId = url.searchParams.get('termId');

  if (!sectionSubjectId) {
    return ok({ classes: await getTeachableClassSubjects(ctx) });
  }
  if (!termId) return badRequest('A term must be specified.');

  try {
    const result = await listAssessments(ctx, sectionSubjectId, termId);
    return ok(result);
  } catch (error) {
    const handled = gradebookError(error);
    if (handled) return handled;
    throw error;
  }
});

/** Create a piece of assessed work. */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('gradebook');
  ctx.require('grade.enter');

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('A valid request body is required.');

  const parsed = createAssessmentSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  try {
    const result = await createAssessment(ctx, parsed.data);
    return created(result);
  } catch (error) {
    const handled = gradebookError(error);
    if (handled) return handled;
    throw error;
  }
});
