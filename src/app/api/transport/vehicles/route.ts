import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created } from '../../../../lib/api/respond.ts';
import { vehicleSchema } from '../../../../lib/operations/schema.ts';
import { listVehicles, createVehicle } from '../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('transport');
  ctx.require('transport.view');
  const url = new URL(request.url);
  return ok({ vehicles: await listVehicles(ctx, url.searchParams.get('includeRetired') === '1') });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = vehicleSchema.parse(await request.json().catch(() => ({})));
  return created(await createVehicle(ctx, input));
});
