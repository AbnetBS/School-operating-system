import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { updateFeeStructureSchema, applyFeeSchema } from '../../../../../lib/finance/schema.ts';
import { updateFeeStructure, applyFeeStructure } from '../../../../../lib/finance/service.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('fees');
    ctx.require('fee.manage');

    const { id } = await context.params;
    const input = updateFeeStructureSchema.parse(await request.json().catch(() => ({})));
    return ok(await updateFeeStructure(ctx, id, input));
  },
);

/** Apply the fee, raising charges for everyone it matches. */
export const POST = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('fees');
    ctx.require('fee.manage');

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = applyFeeSchema.parse({ ...body, feeStructureId: id });
    return ok(await applyFeeStructure(ctx, input));
  },
);
