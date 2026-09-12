'use client';

/**
 * Parent/student inbox.
 *
 * Same services and API as the staff inbox — the difference is only the shell
 * and the wording. There is no second messaging implementation.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';

type Thread = {
  id: string;
  subject: string;
  unreadCount: number;
  participantNames: string[];
  lastMessagePreview: string | null;
  lastMessageAt: string;
};

type Contact = { userId: string; name: string; role: string; detail: string | null };

export default function PortalInbox({
  threads,
  contacts,
}: {
  threads: Thread[];
  contacts: Contact[];
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!recipient || !subject.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);

    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, body, recipientUserIds: [recipient] }),
    });

    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'Could not send the message.');
      return;
    }

    const { id } = (await response.json()) as { id: string };
    router.push(`/portal/messages/${id}`);
  }

  return (
    <div className="space-y-4">
      {contacts.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setComposing((c) => !c)}
            className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {composing ? 'Cancel' : 'New message'}
          </button>
        </div>
      )}

      {composing && (
        <Card title="New message">
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">To</label>
              <select
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="">Choose a person</option>
                {contacts.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.name}
                    {c.detail ? ` — ${c.detail}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">Subject</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">Message</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                maxLength={2000}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              />
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={busy || !recipient || !subject.trim() || !body.trim()}
              className="tap-target w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 sm:w-auto"
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </Card>
      )}

      {threads.length === 0 ? (
        <Card>
          <EmptyState
            title="No conversations yet"
            description={
              contacts.length === 0
                ? 'There is nobody you can message yet.'
                : "Write to your child's teachers using the button above."
            }
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-100">
            {threads.map((thread) => (
              <li key={thread.id}>
                <Link
                  href={`/portal/messages/${thread.id}`}
                  className="tap-target -mx-4 flex items-start gap-3 px-4 py-3 hover:bg-ink-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p
                        className={`truncate text-sm ${
                          thread.unreadCount > 0
                            ? 'font-semibold text-ink-900'
                            : 'font-medium text-ink-800'
                        }`}
                      >
                        {thread.subject}
                      </p>
                      {thread.unreadCount > 0 && <Badge tone="warn">{thread.unreadCount}</Badge>}
                    </div>
                    <p className="truncate text-xs text-ink-500">
                      {thread.participantNames.join(', ')}
                    </p>
                    {thread.lastMessagePreview && (
                      <p className="mt-1 truncate text-sm text-ink-600">
                        {thread.lastMessagePreview}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-ink-400">
                    {new Date(thread.lastMessageAt).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
