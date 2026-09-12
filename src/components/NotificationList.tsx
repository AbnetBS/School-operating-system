'use client';

/**
 * Notification list, shared by the staff application and the portals.
 *
 * Parents read this on a phone, so rows are full-width tap targets rather than
 * a table.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from './ui.tsx';

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
};

const TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  'attendance.absent': 'bad',
  'attendance.late': 'warn',
  'attendance.risk': 'bad',
  'grade.published': 'info',
  'reportCard.published': 'good',
  'homework.assigned': 'info',
  'fee.due': 'warn',
  'payment.recorded': 'good',
  announcement: 'info',
  message: 'info',
};

const LABEL: Record<string, string> = {
  'attendance.absent': 'Absence',
  'attendance.late': 'Late',
  'attendance.risk': 'Attendance',
  'grade.published': 'Results',
  'reportCard.published': 'Report card',
  'homework.assigned': 'Homework',
  'fee.due': 'Fees',
  'payment.recorded': 'Payment',
  announcement: 'Announcement',
  message: 'Message',
};

export default function NotificationList({
  initial,
  initialUnread,
}: {
  initial: NotificationItem[];
  initialUnread: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [unread, setUnread] = useState(initialUnread);
  const [busy, setBusy] = useState(false);

  async function markRead(ids?: string[]) {
    setBusy(true);
    const response = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ids ? { notificationIds: ids } : {}),
    });
    setBusy(false);

    if (!response.ok) return;

    const result = (await response.json()) as { unread: number };
    const now = new Date().toISOString();
    setItems((current) =>
      current.map((n) =>
        !ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n,
      ),
    );
    setUnread(result.unread);
    router.refresh();
  }

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nothing new"
          description="Absences, results and announcements will appear here."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {unread > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => markRead()}
            disabled={busy}
            className="tap-target rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          >
            Mark all as read
          </button>
        </div>
      )}

      <Card>
        <ul className="divide-y divide-ink-100">
          {items.map((item) => {
            const isUnread = item.readAt === null;
            const inner = (
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[item.type] ?? 'neutral'}>
                      {LABEL[item.type] ?? item.type}
                    </Badge>
                    {isUnread && <span className="h-2 w-2 rounded-full bg-brand-500" />}
                  </div>
                  <p
                    className={`mt-1 text-sm ${
                      isUnread ? 'font-semibold text-ink-900' : 'font-medium text-ink-700'
                    }`}
                  >
                    {item.title}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-600">{item.body}</p>
                  <p className="mt-1 text-xs text-ink-400">
                    {new Date(item.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            );

            return (
              <li key={item.id} className="py-3">
                {item.linkPath ? (
                  <Link
                    href={item.linkPath}
                    onClick={() => {
                      if (isUnread) void markRead([item.id]);
                    }}
                    className="tap-target -mx-4 block px-4 hover:bg-ink-50"
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => isUnread && markRead([item.id])}
                    className="tap-target -mx-4 block w-full px-4 text-left hover:bg-ink-50"
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
