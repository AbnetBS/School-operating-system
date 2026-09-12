import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getThread } from '../../../../lib/comms/messages.ts';
import { CommsError } from '../../../../lib/comms/announcements.ts';
import { Card } from '../../../../components/ui.tsx';
import ThreadView from '../../../(app)/messages/[id]/ThreadView.tsx';

export const dynamic = 'force-dynamic';

export default async function PortalThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.has('message.send')) notFound();

  const { id } = await params;

  // Not a participant is indistinguishable from does not exist.
  let thread;
  try {
    thread = await getThread(ctx, id);
  } catch (error) {
    if (error instanceof CommsError && error.status === 404) notFound();
    throw error;
  }

  const others = thread.participants.filter((p) => p.userId !== ctx.user.userId);

  return (
    <div className="space-y-4">
      <Link href="/portal/messages" className="text-sm text-brand-600 hover:underline">
        ← Back to messages
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-ink-900">{thread.subject}</h1>
        {others.length > 0 && (
          <p className="mt-1 text-sm text-ink-500">With {others.map((p) => p.name).join(', ')}</p>
        )}
      </div>

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
