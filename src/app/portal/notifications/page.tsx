import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listNotifications, countUnread } from '../../../lib/notifications/service.ts';
import NotificationList from '../../../components/NotificationList.tsx';

export const dynamic = 'force-dynamic';

export default async function PortalNotificationsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const [items, unread] = await Promise.all([
    listNotifications(ctx.db, ctx.schoolId, ctx.user.userId, { limit: 50 }),
    countUnread(ctx.db, ctx.schoolId, ctx.user.userId),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Alerts</h1>
        <p className="mt-1 text-sm text-ink-500">
          {unread > 0 ? `${unread} unread` : 'You are up to date.'}
        </p>
      </div>
      <NotificationList
        initial={items.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          linkPath: n.linkPath,
          readAt: n.readAt ? n.readAt.toISOString() : null,
          createdAt: n.createdAt.toISOString(),
        }))}
        initialUnread={unread}
      />
    </div>
  );
}
