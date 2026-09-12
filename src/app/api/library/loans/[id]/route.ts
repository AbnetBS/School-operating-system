import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok, badRequest } from '../../../../../lib/api/respond.ts';
import { returnLoanSchema } from '../../../../../lib/operations/schema.ts';
import { returnLoan, renewLoan } from '../../../../../lib/operations/library.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Return or renew.
 *
 * Two actions on one row, distinguished by an explicit `action` field rather
 * than by guessing from the body's shape — guessing would make a malformed
 * return silently renew.
 */
const bodySchema = z.discriminatedUnion('action', [
  // `.extend`, not `.and`: an intersection is not a plain object shape, and
  // Zod cannot read a discriminator through one.
  returnLoanSchema.extend({ action: z.literal('return') }),
  z.object({ action: z.literal('renew') }),
]);

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const raw = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return badRequest('Choose either return or renew.');

    if (parsed.data.action === 'renew') {
      return ok(await renewLoan(ctx, id));
    }
    return ok(await returnLoan(ctx, id, parsed.data));
  },
);
