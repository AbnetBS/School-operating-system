import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../../lib/api/respond.ts';
import { inventoryItemSchema } from '../../../../lib/operations/schema.ts';
import { listInventoryItems, createInventoryItem } from '../../../../lib/operations/inventory.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('inventory');
  ctx.require('inventory.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);
  const { items, total } = await listInventoryItems(ctx, {
    q: url.searchParams.get('q'),
    category: url.searchParams.get('category'),
    lowOnly: url.searchParams.get('lowOnly') === '1',
    includeInactive: url.searchParams.get('includeInactive') === '1',
    limit: pagination.limit,
    offset: pagination.offset,
  });
  return ok(paged(items, total, pagination));
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = inventoryItemSchema.parse(await request.json().catch(() => ({})));
  return created(await createInventoryItem(ctx, input));
});
