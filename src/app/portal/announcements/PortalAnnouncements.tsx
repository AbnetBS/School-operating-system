'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';

type Item = {
  id: string;
  title: string;
  titleAm: string | null;
  body: string;
  bodyAm: string | null;
  isPinned: boolean;
  isRead: boolean;
  authorName: string | null;
  publishedAt: string;
};

export default function PortalAnnouncements({
  items,
  locale,
}: {
  items: Item[];
  locale: string;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No notices yet"
          description="Announcements from the school will appear here."
        />
      </Card>
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id}>
          <Notice item={item} locale={locale} />
        </li>
      ))}
    </ul>
  );
}

function Notice({ item, locale }: { item: Item; locale: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  // Amharic where the school wrote it, English otherwise — a missing
  // translation should never leave a parent with a blank notice.
  const title = locale === 'am' && item.titleAm ? item.titleAm : item.title;
  const body = locale === 'am' && item.bodyAm ? item.bodyAm : item.body;

  function toggle() {
    setOpen((o) => !o);
    if (!item.isRead && !open) {
      startTransition(async () => {
        await fetch(`/api/announcements/${item.id}`, { method: 'POST' });
        router.refresh();
      });
    }
  }

  return (
    <Card>
      <button type="button" onClick={toggle} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {item.isPinned && <Badge tone="info">Pinned</Badge>}
              {!item.isRead && <Badge tone="warn">New</Badge>}
            </div>
            <h2
              className={`mt-1.5 text-base ${
                item.isRead ? 'font-medium text-ink-800' : 'font-semibold text-ink-900'
              }`}
            >
              {title}
            </h2>
            <p className="mt-1 text-xs text-ink-500">
              {item.authorName ? `${item.authorName} · ` : ''}
              {new Date(item.publishedAt).toLocaleDateString()}
            </p>
          </div>
          <span aria-hidden className="text-ink-400">
            {open ? '−' : '+'}
          </span>
        </div>
      </button>

      {open && (
        <p className="mt-3 whitespace-pre-wrap border-t border-ink-100 pt-3 text-sm leading-relaxed text-ink-700">
          {body}
        </p>
      )}
    </Card>
  );
}
