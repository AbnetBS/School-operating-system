import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { decideLeaveSchema } from '../../../../../lib/operations/schema.ts';
import { decideLeaveRequest, cancelLeaveRequest } from '../../../../../lib/operations/hr.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Approve or reject. Rejecting without a reason is refused by the schema. */
export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = decideLeaveSchema.parse(await request.json().catch(() => ({})));
    return ok(await decideLeaveRequest(ctx, id, input));
  },
);

/** Withdraw a pending request. */
export const DELETE = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    return ok(await cancelLeaveRequest(ctx, id));
  },
);
