import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { vehicleSchema } from '../../../../../lib/operations/schema.ts';
import { updateVehicle } from '../../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = vehicleSchema.parse(await request.json().catch(() => ({})));
    return ok(await updateVehicle(ctx, id, input));
  },
);
