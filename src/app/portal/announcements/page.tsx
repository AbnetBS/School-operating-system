import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listVisibleAnnouncements } from '../../../lib/comms/announcements.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { Card, EmptyState } from '../../../components/ui.tsx';
import PortalAnnouncements from './PortalAnnouncements.tsx';

export const dynamic = 'force-dynamic';

export default async function PortalAnnouncementsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.announcements || !ctx.has('announcement.view')) {
    return (
      <Card>
        <EmptyState
          title="Notices are not available"
          description="The school has not enabled announcements."
        />
      </Card>
    );
  }

  const announcements = await listVisibleAnnouncements(ctx, { limit: 50 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Notices</h1>
        <p className="mt-1 text-sm text-ink-500">Announcements from the school.</p>
      </div>
      <PortalAnnouncements
        items={announcements.map((a) => ({
          id: a.id,
          title: a.title,
          titleAm: a.titleAm,
          body: a.body,
          bodyAm: a.bodyAm,
          isPinned: a.isPinned,
          isRead: a.isRead,
          authorName: a.authorName,
          publishedAt: (a.publishedAt ?? a.createdAt).toISOString(),
        }))}
        locale={ctx.locale}
      />
    </div>
  );
}
