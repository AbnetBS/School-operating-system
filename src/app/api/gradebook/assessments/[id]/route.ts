import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok, badRequest, zodFields } from '../../../../../lib/api/respond.ts';
import { changeAssessmentStatus, GradebookError } from '../../../../../lib/gradebook/service.ts';
import { assessmentWorkflowSchema } from '../../../../../lib/gradebook/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gradebookError(error: unknown): NextResponse | null {
  if (error instanceof GradebookError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

/**
 * Move an assessment through submit → review → lock.
 *
 * Each transition checks its own permission inside the service, so a caller
 * cannot skip a step by posting the end state directly.
 */
export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('gradebook');

    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    if (!body) return badRequest('A valid request body is required.');

    const parsed = assessmentWorkflowSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
    }

    try {
      const result = await changeAssessmentStatus(
        ctx,
        id,
        parsed.data.action,
        parsed.data.reason || undefined,
      );
      return ok(result);
    } catch (error) {
      const handled = gradebookError(error);
      if (handled) return handled;
      throw error;
    }
  },
);
