/**
 * A single announcement: read it, edit it, or mark it read.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, noContent } from '../../../../lib/api/respond.ts';
import { updateAnnouncementSchema } from '../../../../lib/comms/schema.ts';
import {
  getAnnouncement,
  updateAnnouncement,
  markAnnouncementRead,
} from '../../../../lib/comms/announcements.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('announcements');
    ctx.require('announcement.view');

    const { id } = await context.params;
    // Throws a 404 for anything outside the caller's audience.
    return ok({ announcement: await getAnnouncement(ctx, id) });
  },
);

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('announcements');

    const { id } = await context.params;
    const input = updateAnnouncementSchema.parse(await request.json());

    await updateAnnouncement(ctx, id, input);
    return ok({ id });
  },
);

/** Mark as read. Idempotent — reading twice is not an error. */
export const POST = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('announcements');
    ctx.require('announcement.view');

    const { id } = await context.params;
    await markAnnouncementRead(ctx, id);
    return noContent();
  },
);
