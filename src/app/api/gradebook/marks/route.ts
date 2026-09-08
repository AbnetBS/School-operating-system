import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import { getMarkSheet, saveMarks, GradebookError } from '../../../../lib/gradebook/service.ts';
import { saveMarksSchema } from '../../../../lib/gradebook/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gradebookError(error: unknown): NextResponse | null {
  if (error instanceof GradebookError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

/** The mark-entry grid for one assessment. */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('gradebook');
  ctx.requireAny('grade.view', 'grade.enter');

  const url = new URL(request.url);
  const assessmentId = url.searchParams.get('assessmentId');
  if (!assessmentId) return badRequest('An assessment must be specified.');

  try {
    return ok(await getMarkSheet(ctx, assessmentId));
  } catch (error) {
    const handled = gradebookError(error);
    if (handled) return handled;
    throw error;
  }
});

/**
 * Save a whole class's marks in one request.
 *
 * Partial success is normal and intentional: valid marks are kept and the
 * invalid ones come back keyed by student, so one mistyped number never
 * discards the rest of the class.
 */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('gradebook');
  ctx.require('grade.enter');

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('A valid request body is required.');

  const parsed = saveMarksSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  try {
    return ok(await saveMarks(ctx, parsed.data));
  } catch (error) {
    const handled = gradebookError(error);
    if (handled) return handled;
    throw error;
  }
});
