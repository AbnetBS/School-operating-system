import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../../../../lib/api/respond.ts';
import { stockMovementSchema } from '../../../../../../lib/operations/schema.ts';
import { listMovements, recordMovement } from '../../../../../../lib/operations/inventory.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('inventory');
    ctx.require('inventory.view');

    const { id } = await context.params;
    const pagination = readPagination(new URL(request.url));
    const { movements, total } = await listMovements(ctx, id, {
      limit: pagination.limit,
      offset: pagination.offset,
    });
    return ok(paged(movements, total, pagination));
  },
);

/**
 * Record a receipt, issue, adjustment or loss.
 *
 * The client sends a positive magnitude; the service decides the sign from the
 * movement type. See `recordMovement` for why.
 */
export const POST = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = stockMovementSchema.parse(await request.json().catch(() => ({})));
    return created(await recordMovement(ctx, id, input));
  },
);
