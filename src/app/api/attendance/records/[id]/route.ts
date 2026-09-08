import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok, badRequest, forbidden, zodFields } from '../../../../../lib/api/respond.ts';
import { correctRecord } from '../../../../../lib/attendance/service.ts';
import { correctAttendanceSchema } from '../../../../../lib/attendance/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Correct one student's mark. The change is logged and the tallies refreshed. */
export const PATCH = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  await ctx.requireModule('attendance');
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = correctAttendanceSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  try {
    await correctRecord(ctx, id, parsed.data);
  } catch (error) {
    // correctRecord attaches an HTTP status for policy refusals
    // (not assigned to the class, outside the backdating window).
    const status = (error as { status?: number }).status;
    if (status === 403) return forbidden((error as Error).message);
    if (status === 400) return badRequest((error as Error).message);
    throw error;
  }

  return ok({ updated: true });
});
