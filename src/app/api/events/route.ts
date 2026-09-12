import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created } from '../../../lib/api/respond.ts';
import { schoolEventSchema } from '../../../lib/operations/schema.ts';
import { listEvents, createEvent } from '../../../lib/operations/calendar.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('event.view');
  const url = new URL(request.url);
  return ok({
    events: await listEvents(ctx, {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      eventType: url.searchParams.get('eventType'),
    }),
  });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = schoolEventSchema.parse(await request.json().catch(() => ({})));
  return created(await createEvent(ctx, input));
});
