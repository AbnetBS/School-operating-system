import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { endTransport } from '../../../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  endDate: z
    .string({ error: 'Give the last day.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.'),
});

/** End a subscription. The row stays: last term's arrangement must remain readable. */
export const DELETE = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const { endDate } = bodySchema.parse(await request.json().catch(() => ({})));
    return ok(await endTransport(ctx, id, endDate));
  },
);
