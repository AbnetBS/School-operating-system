import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { discountSchema, cancelChargeSchema } from '../../../../../lib/finance/schema.ts';
import { setChargeDiscount, cancelCharge } from '../../../../../lib/finance/service.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Set or change a discount / scholarship / waiver. */
export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('fees');
    ctx.require('fee.manage');

    const { id } = await context.params;
    const input = discountSchema.parse(await request.json().catch(() => ({})));
    return ok(await setChargeDiscount(ctx, id, input));
  },
);

/** Cancel a charge. Refused if money has been paid against it. */
export const DELETE = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('fees');
    ctx.require('fee.manage');

    const { id } = await context.params;
    const input = cancelChargeSchema.parse(await request.json().catch(() => ({})));
    return ok(await cancelCharge(ctx, id, input.reason));
  },
);
