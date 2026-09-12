/**
 * Announcements API.
 *
 * Reading returns only what the caller's audience buckets allow; writing is
 * gated on `announcement.create`, and a teacher without
 * `announcement.publishSchoolWide` can only address classes they teach.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created } from '../../../lib/api/respond.ts';
import { throttleByUser, MESSAGING_LIMIT } from '../../../lib/api/throttle.ts';
import { createAnnouncementSchema } from '../../../lib/comms/schema.ts';
import {
  listVisibleAnnouncements,
  listManageableAnnouncements,
  createAnnouncement,
} from '../../../lib/comms/announcements.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('announcements');
  ctx.require('announcement.view');

  const url = new URL(request.url);
  const scope = url.searchParams.get('scope');
  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = Number(url.searchParams.get('limit') ?? '30');

  if (scope === 'manage') {
    return ok({ announcements: await listManageableAnnouncements(ctx, { limit }) });
  }
  return ok({
    announcements: await listVisibleAnnouncements(ctx, { limit, unreadOnly }),
  });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('announcements');

  // Audit M3. An announcement fans out to an audience, so one request can
  // generate work proportional to the school roll.
  const throttled = throttleByUser(ctx.user.userId, 'message:announcement', MESSAGING_LIMIT);
  if (throttled) return throttled;

  const body = await request.json();
  const input = createAnnouncementSchema.parse(body);

  // CommsError carries its own status; the route wrapper maps it.
  return created(await createAnnouncement(ctx, input));
});
