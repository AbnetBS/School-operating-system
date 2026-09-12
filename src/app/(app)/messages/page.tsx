import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listThreads, listContacts } from '../../../lib/comms/messages.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';
import MessageInbox from './MessageInbox.tsx';

export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  if (!ctx.has('message.send')) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to messages"
          description="Ask an administrator if you believe this is wrong."
        />
      </Card>
    );
  }

  const [threads, contacts] = await Promise.all([
    listThreads(ctx, { limit: 50 }),
    listContacts(ctx),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description="Conversations with teachers, parents and colleagues."
      />
      <MessageInbox
        threads={threads.map((t) => ({
          id: t.id,
          subject: t.subject,
          kind: t.kind,
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
