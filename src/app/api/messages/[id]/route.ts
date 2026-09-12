/**
 * One conversation: read its history, or post to it.
 *
 * Both operations check thread membership first and answer 404 — never 403 —
 * for a thread the caller does not belong to, so ids cannot be probed.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created } from '../../../../lib/api/respond.ts';
import { sendMessageSchema } from '../../../../lib/comms/schema.ts';
import { getThread, sendMessage } from '../../../../lib/comms/messages.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    ctx.require('message.send');

    const { id } = await context.params;
    return ok({ thread: await getThread(ctx, id) });
  },
);

export const POST = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();

    const { id } = await context.params;
    const body = await request.json();

    // The path is authoritative; a body that names a different thread cannot
    // redirect the message somewhere the caller does not belong.
    const input = sendMessageSchema.parse({ ...body, threadId: id });

    const result = await sendMessage(ctx, input);
    // A duplicate submission returns the original message rather than a new
    // one, and says so, so the client can tell the difference.
    return result.duplicate ? ok(result) : created(result);
  },
);
