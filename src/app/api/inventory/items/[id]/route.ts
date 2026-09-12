import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { inventoryItemSchema } from '../../../../../lib/operations/schema.ts';
import {
  getInventoryItemOwned,
  updateInventoryItem,
} from '../../../../../lib/operations/inventory.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('inventory');
    ctx.require('inventory.view');
    const { id } = await context.params;
    return ok(await getInventoryItemOwned(ctx, id));
  },
);

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = inventoryItemSchema.parse(await request.json().catch(() => ({})));
    return ok(await updateInventoryItem(ctx, id, input));
  },
);
