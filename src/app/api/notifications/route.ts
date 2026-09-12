/**
 * Notifications API.
 *
 * A user can only ever read or modify their own. There is no parameter that
 * names another user — the session supplies the identity.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok } from '../../../lib/api/respond.ts';
import { markReadSchema } from '../../../lib/comms/schema.ts';
import {
  listNotifications,
  countUnread,
  markNotificationsRead,
} from '../../../lib/notifications/service.ts';
import { countUnreadMessages } from '../../../lib/comms/messages.ts';
import { countUnreadAnnouncements } from '../../../lib/comms/announcements.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();

  const url = new URL(request.url);
  const view = url.searchParams.get('view');

  // Badge counts for the navigation, in one round trip.
  if (view === 'counts') {
    const [notifications, messages, announcements] = await Promise.all([
      countUnread(ctx.db, ctx.schoolId, ctx.user.userId),
      countUnreadMessages(ctx),
      ctx.has('announcement.view') ? countUnreadAnnouncements(ctx) : Promise.resolve(0),
    ]);
    return ok({ notifications, messages, announcements });
  }

  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = Number(url.searchParams.get('limit') ?? '30');

  const [items, unread] = await Promise.all([
    listNotifications(ctx.db, ctx.schoolId, ctx.user.userId, { limit, unreadOnly }),
    countUnread(ctx.db, ctx.schoolId, ctx.user.userId),
  ]);

  return ok({ notifications: items, unread });
});

/** Mark read. With no ids, marks everything read. */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = markReadSchema.parse(await request.json().catch(() => ({})));

  const updated = await markNotificationsRead(
    ctx.db,
    ctx.schoolId,
    ctx.user.userId,
    input.notificationIds,
  );

  return ok({ updated, unread: await countUnread(ctx.db, ctx.schoolId, ctx.user.userId) });
});
