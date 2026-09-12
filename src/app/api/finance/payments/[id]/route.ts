import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { voidPaymentSchema } from '../../../../../lib/finance/schema.ts';
import { getReceipt, voidPayment } from '../../../../../lib/finance/payments.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One receipt. */
export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('payments');
    ctx.require('payment.view');

    const { id } = await context.params;
    const receipt = await getReceipt(ctx, id);

    // A payment id is scoped to the school by getReceipt, but the student
    // relationship still has to hold for a section-restricted user.
    await ctx.requireStudentAccess(receipt.payment.studentId);

    return ok(receipt);
  },
);

/** Void a payment. Separate permission — this reverses money. */
export const DELETE = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('payments');
    ctx.require('payment.void');

    const { id } = await context.params;
    const input = voidPaymentSchema.parse(await request.json().catch(() => ({})));
    return ok(await voidPayment(ctx, id, input.reason));
  },
);
