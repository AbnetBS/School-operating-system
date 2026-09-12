import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created } from '../../../../lib/api/respond.ts';
import { transportRouteSchema } from '../../../../lib/operations/schema.ts';
import { listRoutes, createRoute } from '../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('transport');
  ctx.require('transport.view');
  const url = new URL(request.url);
  return ok({ routes: await listRoutes(ctx, url.searchParams.get('includeInactive') === '1') });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = transportRouteSchema.parse(await request.json().catch(() => ({})));
  return created(await createRoute(ctx, input));
});
