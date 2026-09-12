'use client';

/**
 * Day stepper for the staff register.
 *
 * Same shape as the pupil attendance picker: arrows first, because correcting
 * yesterday is the common case and a date field is slow on a phone. Future
 * dates are blocked — a register for a day that has not happened is not a
 * correction, it is a guess.
 */

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition } from 'react';

export default function HrDatePicker({
  current,
  today,
}: {
  current: string;
  today: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function goTo(date: string) {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('date', date);
    startTransition(() => router.push(`${pathname}?${sp.toString()}`));
  }

  function shift(days: number) {
    const next = new Date(Date.parse(`${current}T00:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (next > today) return;
    goTo(next);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => shift(-1)}
        className="tap-target rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
        aria-label="Previous day"
      >
        ‹
      </button>

      <input
        type="date"
        value={current}
        max={today}
        onChange={(e) => e.target.value && goTo(e.target.value)}
        className="tap-target min-w-0 rounded-lg border border-ink-300 px-3 py-2 text-sm"
        aria-label="Attendance date"
      />

      <button
        type="button"
        onClick={() => shift(1)}
        disabled={current >= today}
        className="tap-target rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-40"
        aria-label="Next day"
      >
        ›
      </button>

      {pending && <span className="text-xs text-ink-400">…</span>}
    </div>
  );
}
