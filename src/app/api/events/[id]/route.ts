import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, noContent } from '../../../../lib/api/respond.ts';
import { schoolEventSchema } from '../../../../lib/operations/schema.ts';
import { getEventOwned, updateEvent, deleteEvent } from '../../../../lib/operations/calendar.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    ctx.require('event.view');
    const { id } = await context.params;
    return ok(await getEventOwned(ctx, id));
  },
);

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = schoolEventSchema.parse(await request.json().catch(() => ({})));
    return ok(await updateEvent(ctx, id, input));
  },
);

export const DELETE = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    await deleteEvent(ctx, id);
    return noContent();
  },
);
