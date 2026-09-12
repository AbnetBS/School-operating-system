import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created } from '../../../../lib/api/respond.ts';
import { leaveTypeSchema } from '../../../../lib/operations/schema.ts';
import { listLeaveTypes, createLeaveType } from '../../../../lib/operations/hr.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('hr');
  ctx.requireAny('leave.view', 'leave.request', 'leave.configure');
  const url = new URL(request.url);
  return ok({
    leaveTypes: await listLeaveTypes(ctx, url.searchParams.get('includeInactive') === '1'),
  });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = leaveTypeSchema.parse(await request.json().catch(() => ({})));
  return created(await createLeaveType(ctx, input));
});
