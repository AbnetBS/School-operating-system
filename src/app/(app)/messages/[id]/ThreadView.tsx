'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

type Message = {
  id: string;
  body: string;
  senderName: string | null;
  isMine: boolean;
  createdAt: string;
};

export default function ThreadView({
  threadId,
  initialMessages,
}: {
  threadId: string;
  initialMessages: Message[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  async function send() {
    const trimmed = body.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);

    const response = await fetch(`/api/messages/${threadId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: trimmed }),
    });

    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'Could not send the message.');
      return;
    }

    const result = (await response.json()) as { id: string; duplicate: boolean };

    // The server treats an identical repeat as the same message, so a
    // double-tap does not add a second bubble here either.
    if (!result.duplicate) {
      setMessages((current) => [
        ...current,
        {
          id: result.id,
          body: trimmed,
          senderName: null,
          isMine: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    }

    setBody('');
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <ul className="max-h-[28rem] space-y-3 overflow-y-auto">
        {messages.map((message) => (
          <li
            key={message.id}
            className={`flex ${message.isMine ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2 sm:max-w-[70%] ${
                message.isMine
                  ? 'bg-brand-600 text-white'
                  : 'bg-ink-100 text-ink-800'
              }`}
            >
              {!message.isMine && message.senderName && (
                <p className="mb-0.5 text-xs font-medium opacity-70">{message.senderName}</p>
              )}
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.body}</p>
              <p
                className={`mt-1 text-[11px] ${
                  message.isMine ? 'text-white/70' : 'text-ink-500'
                }`}
              >
                {new Date(message.createdAt).toLocaleString()}
              </p>
            </div>
          </li>
        ))}
        <div ref={endRef} />
      </ul>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-end gap-2 border-t border-ink-100 pt-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter makes a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={2000}
          placeholder="Write a reply"
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-ink-200 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || body.trim().length === 0}
          className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
