/**
 * Messaging API: the inbox, the contact list, and starting a conversation.
 *
 * Access to a thread is membership, not role. Who may be messaged is derived
 * from real relationships — see `listContacts`.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created } from '../../../lib/api/respond.ts';
import { throttleByUser, MESSAGING_LIMIT } from '../../../lib/api/throttle.ts';
import { createThreadSchema } from '../../../lib/comms/schema.ts';
import { listThreads, listContacts, createThread } from '../../../lib/comms/messages.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('message.send');

  const url = new URL(request.url);
  const view = url.searchParams.get('view');

  if (view === 'contacts') {
    return ok({ contacts: await listContacts(ctx) });
  }

  const limit = Number(url.searchParams.get('limit') ?? '30');
  return ok({ threads: await listThreads(ctx, { limit }) });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();

  // Audit M3. A thread fans out to every recipient, so the cost is per
  // recipient rather than per request. Well above human composition speed.
  const throttled = throttleByUser(ctx.user.userId, 'message:thread', MESSAGING_LIMIT);
  if (throttled) return throttled;

  const input = createThreadSchema.parse(await request.json());
  return created(await createThread(ctx, input));
});
