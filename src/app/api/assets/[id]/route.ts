import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok } from '../../../../lib/api/respond.ts';
import { assetSchema } from '../../../../lib/operations/schema.ts';
import { getAssetOwned, updateAsset } from '../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('maintenance');
    ctx.require('asset.view');
    const { id } = await context.params;
    return ok(await getAssetOwned(ctx, id));
  },
);

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = assetSchema.parse(await request.json().catch(() => ({})));
    return ok(await updateAsset(ctx, id, input));
  },
);
