import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../lib/api/respond.ts';
import { assetSchema } from '../../../lib/operations/schema.ts';
import { listAssets, createAsset } from '../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('maintenance');
  ctx.require('asset.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);
  const { assets, total } = await listAssets(ctx, {
    q: url.searchParams.get('q'),
    status: url.searchParams.get('status'),
    category: url.searchParams.get('category'),
    sectionId: url.searchParams.get('sectionId'),
    limit: pagination.limit,
    offset: pagination.offset,
  });
  return ok(paged(assets, total, pagination));
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = assetSchema.parse(await request.json().catch(() => ({})));
  return created(await createAsset(ctx, input));
});
