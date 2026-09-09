import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listThreads, listContacts } from '../../../lib/comms/messages.ts';
import { Card, EmptyState } from '../../../components/ui.tsx';
import PortalInbox from './PortalInbox.tsx';

export const dynamic = 'force-dynamic';

export default async function PortalMessagesPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  if (!ctx.has('message.send')) {
    return (
      <Card>
        <EmptyState
          title="Messages are not available"
          description="The school has not enabled messaging for your account."
        />
      </Card>
    );
  }

  const [threads, contacts] = await Promise.all([
    listThreads(ctx, { limit: 50 }),
    listContacts(ctx),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Messages</h1>
        <p className="mt-1 text-sm text-ink-500">
          Write to your child&rsquo;s teachers or the school office.
        </p>
      </div>
      <PortalInbox
        threads={threads.map((t) => ({
          id: t.id,
          subject: t.subject,
          unreadCount: t.unreadCount,
          participantNames: t.participantNames,
          lastMessagePreview: t.lastMessagePreview,
          lastMessageAt: t.lastMessageAt.toISOString(),
        }))}
        contacts={contacts}
      />
    </div>
  );
}
