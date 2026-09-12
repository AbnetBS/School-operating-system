import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../../lib/auth/context.ts';
import { route, ok, created } from '../../../../../../lib/api/respond.ts';
import { routeStopSchema } from '../../../../../../lib/operations/schema.ts';
import { listStops, addStop } from '../../../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('transport');
    ctx.require('transport.view');
    const { id } = await context.params;
    return ok({ stops: await listStops(ctx, id) });
  },
);

export const POST = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = routeStopSchema.parse(await request.json().catch(() => ({})));
    return created(await addStop(ctx, id, input));
  },
);
