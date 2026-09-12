import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, notFound, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import {
  getReportCard,
  changeReportCardStatus,
  saveReportCardComments,
} from '../../../../lib/gradebook/reportCards.ts';
import { GradebookError } from '../../../../lib/gradebook/service.ts';
import {
  reportCardWorkflowSchema,
  reportCardCommentSchema,
} from '../../../../lib/gradebook/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gradebookError(error: unknown): NextResponse | null {
  if (error instanceof GradebookError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

/** One report card, for staff. */
export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('reportCards');
    ctx.requireAny('reportCard.view', 'reportCard.generate');

    const { id } = await context.params;
    const card = await getReportCard(ctx.db, ctx.schoolId, id);
    // A card belonging to another school is simply not found.
    if (!card) return notFound();
    return ok(card);
  },
);

/** Comments, or a workflow transition. */
export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('reportCards');

    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    if (!body) return badRequest('A valid request body is required.');

    try {
      if (typeof body.action === 'string') {
        const parsed = reportCardWorkflowSchema.safeParse(body);
        if (!parsed.success) {
          return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
        }
        return ok(
          await changeReportCardStatus(ctx, id, parsed.data.action, parsed.data.reason || undefined),
        );
      }

      const parsed = reportCardCommentSchema.safeParse(body);
      if (!parsed.success) {
        return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
      }
      await saveReportCardComments(ctx, id, parsed.data);
      return ok({ saved: true });
    } catch (error) {
      const handled = gradebookError(error);
      if (handled) return handled;
      throw error;
    }
  },
);
