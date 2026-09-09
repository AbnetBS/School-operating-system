import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getThread } from '../../../../lib/comms/messages.ts';
import { CommsError } from '../../../../lib/comms/announcements.ts';
import { PageHeader, Card } from '../../../../components/ui.tsx';
import ThreadView from './ThreadView.tsx';

export const dynamic = 'force-dynamic';

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.has('message.send')) notFound();

  const { id } = await params;

  // getThread throws a 404-shaped error for a thread the user is not in.
  // Rendering the standard not-found page keeps the response indistinguishable
  // from a thread that does not exist.
  let thread;
  try {
    thread = await getThread(ctx, id);
  } catch (error) {
    if (error instanceof CommsError && error.status === 404) notFound();
    throw error;
  }

  const others = thread.participants.filter((p) => p.userId !== ctx.user.userId);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/messages" className="text-sm text-brand-600 hover:underline">
          ← Back to messages
        </Link>
      </div>

      <PageHeader
        title={thread.subject}
        description={
          others.length > 0
            ? `With ${others.map((p) => p.name).join(', ')}`
            : 'No other participants'
        }
      />

      <Card>
        <ThreadView
          threadId={thread.id}
          initialMessages={thread.messages.map((m) => ({
            id: m.id,
            body: m.body,
            senderName: m.senderName,
            isMine: m.isMine,
            createdAt: m.createdAt.toISOString(),
          }))}
        />
      </Card>
    </div>
  );
}
