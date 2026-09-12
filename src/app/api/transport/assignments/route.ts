import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../../lib/api/respond.ts';
import { assignTransportSchema } from '../../../../lib/operations/schema.ts';
import { listRiders, assignTransport } from '../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('transport');
  ctx.require('transport.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);
  const { riders, total } = await listRiders(ctx, {
    routeId: url.searchParams.get('routeId'),
    studentId: url.searchParams.get('studentId'),
    limit: pagination.limit,
    offset: pagination.offset,
  });
  return ok(paged(riders, total, pagination));
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = assignTransportSchema.parse(await request.json().catch(() => ({})));
  return created(await assignTransport(ctx, input));
});
