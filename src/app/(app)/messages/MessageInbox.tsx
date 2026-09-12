'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';

type Thread = {
  id: string;
  subject: string;
  kind: string;
  unreadCount: number;
  participantNames: string[];
  lastMessagePreview: string | null;
  lastMessageAt: string;
};

type Contact = {
  userId: string;
  name: string;
  role: 'staff' | 'parent' | 'student';
  detail: string | null;
};

export default function MessageInbox({
  threads,
  contacts,
}: {
  threads: Thread[];
  contacts: Contact[];
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setComposing((c) => !c)}
          className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {composing ? 'Cancel' : 'New message'}
        </button>
      </div>

      {composing && (
        <ComposeThread
          contacts={contacts}
          onDone={(threadId) => {
            setComposing(false);
            router.push(`/messages/${threadId}`);
          }}
        />
      )}

      {threads.length === 0 ? (
        <Card>
          <EmptyState
            title="No conversations yet"
            description={
              contacts.length === 0
                ? 'There is nobody you can message yet.'
                : 'Start one with the button above.'
            }
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-100">
            {threads.map((thread) => (
              <li key={thread.id}>
                <Link
                  href={`/messages/${thread.id}`}
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
                      {thread.unreadCount > 0 && (
                        <Badge tone="warn">{thread.unreadCount}</Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-ink-500">
                      {thread.participantNames.join(', ') || 'No other participants'}
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

function ComposeThread({
  contacts,
  onDone,
}: {
  contacts: Contact[];
  onDone: (threadId: string) => void;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const filtered = search
    ? contacts.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : contacts;

  async function submit() {
    setBusy(true);
    setError(null);
    setFields({});

    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, body, recipientUserIds: selected }),
    });

    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
      };
      setError(payload.error ?? 'Could not start the conversation.');
      setFields(payload.fields ?? {});
      return;
    }

    const { id } = (await response.json()) as { id: string };
    onDone(id);
  }

  if (contacts.length === 0) {
    return (
      <Card>
        <EmptyState
          title="There is nobody you can message yet"
          description="You can message the parents and pupils of the classes you teach, and your colleagues."
        />
      </Card>
    );
  }

  return (
    <Card title="New message">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700">Subject</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            placeholder="About Abel's reading"
          />
          {fields.subject && <p className="mt-1 text-xs text-red-600">{fields.subject}</p>}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700">
            Recipients {selected.length > 0 && `(${selected.length})`}
          </label>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-2 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            placeholder="Search by name"
          />
          <div className="max-h-56 overflow-y-auto rounded-lg border border-ink-100">
            <ul className="divide-y divide-ink-100">
              {filtered.map((contact) => {
                const isOn = selected.includes(contact.userId);
                return (
                  <li key={contact.userId}>
                    <button
                      type="button"
                      onClick={() =>
                        setSelected((s) =>
                          isOn ? s.filter((id) => id !== contact.userId) : [...s, contact.userId],
                        )
                      }
                      className={`tap-target flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                        isOn ? 'bg-brand-50' : 'hover:bg-ink-50'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink-800">
                          {contact.name}
                        </span>
                        {contact.detail && (
                          <span className="block truncate text-xs text-ink-500">
                            {contact.detail}
                          </span>
                        )}
                      </span>
                      <Badge tone={isOn ? 'good' : 'neutral'}>{contact.role}</Badge>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3 py-3 text-sm text-ink-500">No matching contacts.</li>
              )}
            </ul>
          </div>
          {fields.recipientUserIds && (
            <p className="mt-1 text-xs text-red-600">{fields.recipientUserIds}</p>
          )}
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
          {fields.body && <p className="mt-1 text-xs text-red-600">{fields.body}</p>}
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={busy || selected.length === 0}
          onClick={submit}
          className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </Card>
  );
}
