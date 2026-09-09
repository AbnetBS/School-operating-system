import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listNotifications, countUnread } from '../../../lib/notifications/service.ts';
import { PageHeader } from '../../../components/ui.tsx';
import NotificationList from '../../../components/NotificationList.tsx';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const [items, unread] = await Promise.all([
    listNotifications(ctx.db, ctx.schoolId, ctx.user.userId, { limit: 50 }),
    countUnread(ctx.db, ctx.schoolId, ctx.user.userId),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={unread > 0 ? `${unread} unread` : 'You are up to date.'}
      />
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
