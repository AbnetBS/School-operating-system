import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { transportRouteSchema } from '../../../../../lib/operations/schema.ts';
import { getRouteOwned, updateRoute, listStops } from '../../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('transport');
    ctx.require('transport.view');
    const { id } = await context.params;
    const routeRow = await getRouteOwned(ctx, id);
    return ok({ route: routeRow, stops: await listStops(ctx, id) });
  },
);

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = transportRouteSchema.parse(await request.json().catch(() => ({})));
    return ok(await updateRoute(ctx, id, input));
  },
);
