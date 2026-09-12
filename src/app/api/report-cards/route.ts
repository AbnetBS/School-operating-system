import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created, badRequest, zodFields } from '../../../lib/api/respond.ts';
import {
  generateReportCards,
  getSectionReportCardStatus,
  publishForSection,
} from '../../../lib/gradebook/reportCards.ts';
import { GradebookError } from '../../../lib/gradebook/service.ts';
import { generateReportCardsSchema } from '../../../lib/gradebook/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gradebookError(error: unknown): NextResponse | null {
  if (error instanceof GradebookError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

/** Report-card progress for a class. */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('reportCards');

  const url = new URL(request.url);
  const termId = url.searchParams.get('termId');
  const sectionId = url.searchParams.get('sectionId');
  if (!termId || !sectionId) return badRequest('A term and a class are required.');

  try {
    return ok({ students: await getSectionReportCardStatus(ctx, termId, sectionId) });
  } catch (error) {
    const handled = gradebookError(error);
    if (handled) return handled;
    throw error;
  }
});

/** Generate report cards for a class or a single student. */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('reportCards');
  ctx.require('reportCard.generate');

  const body = await request.json().catch(() => null);
  if (!body) return badRequest('A valid request body is required.');

  // Publishing a whole class is a separate, more consequential action than
  // generating drafts, so it carries its own permission check in the service.
  if (body.action === 'publishSection') {
    if (!body.termId || !body.sectionId) return badRequest('A term and a class are required.');
    try {
      return ok(
        await publishForSection(ctx, { termId: String(body.termId), sectionId: String(body.sectionId) }),
      );
    } catch (error) {
      const handled = gradebookError(error);
      if (handled) return handled;
      throw error;
    }
  }

  const parsed = generateReportCardsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  try {
    return created(await generateReportCards(ctx, parsed.data));
  } catch (error) {
    const handled = gradebookError(error);
    if (handled) return handled;
    throw error;
  }
});
