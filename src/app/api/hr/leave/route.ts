import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../../lib/api/respond.ts';
import { createLeaveRequestSchema } from '../../../../lib/operations/schema.ts';
import {
  listLeaveRequests,
  createLeaveRequest,
  getOwnStaffRecord,
} from '../../../../lib/operations/hr.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('hr');

  const url = new URL(request.url);
  const pagination = readPagination(url);

  // Without `leave.view` a person may still read their OWN requests. The
  // filter is forced server-side, not merely defaulted, so passing another
  // staffId in the query string changes nothing.
  let staffId = url.searchParams.get('staffId');
  if (!ctx.has('leave.view')) {
    ctx.require('leave.request');
    const own = await getOwnStaffRecord(ctx);
    if (!own) return ok(paged([], 0, pagination));
    staffId = own.id;
  }

  const { requests, total } = await listLeaveRequests(ctx, {
    status: url.searchParams.get('status'),
    staffId,
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    limit: pagination.limit,
    offset: pagination.offset,
  });
  return ok(paged(requests, total, pagination));
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = createLeaveRequestSchema.parse(await request.json().catch(() => ({})));
  return created(await createLeaveRequest(ctx, input));
});
