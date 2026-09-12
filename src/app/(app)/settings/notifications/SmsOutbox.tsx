'use client';

/**
 * SMS outbox.
 *
 * This exists so a school can see the truth: what was actually sent, what is
 * waiting, and what was never sent because no provider is connected. A row
 * with status `unconfigured` is not a failure of the school's — it is the
 * system being honest that nothing left the building.
 */

import { useState } from 'react';
import { Card, Badge, EmptyState } from '../../../../components/ui.tsx';

type Message = {
  id: string;
  toPhone: string;
  body: string;
  status: string;
  provider: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
};

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  sent: 'good',
  queued: 'info',
  failed: 'bad',
  unconfigured: 'warn',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  sent: 'Sent',
  queued: 'Waiting',
  failed: 'Failed',
  unconfigured: 'Not sent — no provider',
  cancelled: 'Cancelled',
};

export default function SmsOutbox({
  summary,
  messages,
}: {
  summary: { status: string; count: number }[];
  messages: Message[];
}) {
  const [filter, setFilter] = useState<string>('all');

  const visible =
    filter === 'all' ? messages : messages.filter((m) => m.status === filter);
  const total = summary.reduce((sum, row) => sum + row.count, 0);

  return (
    <Card title="SMS outbox">
      {total === 0 ? (
        <EmptyState
          title="Nothing sent yet"
          description="Outgoing text messages will be listed here with their real delivery status."
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <FilterChip
              label={`All (${total})`}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            {summary.map((row) => (
              <FilterChip
                key={row.status}
                label={`${STATUS_LABEL[row.status] ?? row.status} (${row.count})`}
                active={filter === row.status}
                onClick={() => setFilter(row.status)}
              />
            ))}
          </div>

          {/* Mobile */}
          <ul className="divide-y divide-ink-100 sm:hidden">
            {visible.map((m) => (
              <li key={m.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm text-ink-800">{m.toPhone}</span>
                  <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>
                    {STATUS_LABEL[m.status] ?? m.status}
                  </Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-600">{m.body}</p>
                <p className="mt-1 text-xs text-ink-400">
                  {new Date(m.createdAt).toLocaleString()}
                </p>
                {m.error && <p className="mt-1 text-xs text-red-600">{m.error}</p>}
              </li>
            ))}
          </ul>

          {/* Desktop */}
          <div className="-mx-4 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 font-medium">To</th>
                  <th className="px-4 py-2 font-medium">Message</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {visible.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-sm text-ink-800">
                      {m.toPhone}
                    </td>
                    <td className="max-w-md px-4 py-2 text-sm text-ink-600">
                      <span className="line-clamp-2">{m.body}</span>
                      {m.error && <span className="block text-xs text-red-600">{m.error}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>
                        {STATUS_LABEL[m.status] ?? m.status}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {new Date(m.sentAt ?? m.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {visible.length === 0 && (
            <p className="py-4 text-center text-sm text-ink-500">
              No messages with that status.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tap-target rounded-full px-3 py-1.5 text-xs font-medium ${
        active ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
      }`}
    >
      {label}
    </button>
  );
}
