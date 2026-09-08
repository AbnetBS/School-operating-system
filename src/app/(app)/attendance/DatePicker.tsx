'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition } from 'react';

/**
 * Day stepper.
 *
 * Teachers overwhelmingly take attendance for today, occasionally for
 * yesterday. Arrows are faster than a date field on a phone, so the picker
 * leads with them and keeps the full input as a fallback.
 */
export default function DatePicker({ current, today }: { current: string; today: string }) {
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
    goTo(next);
  }

  const isToday = current === today;
  const atFuture = current >= today;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => shift(-1)}
        className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
        aria-label="Previous day"
      >
        ‹
      </button>

      <input
        type="date"
        value={current}
        max={today}
        onChange={(e) => e.target.value && goTo(e.target.value)}
        className="tap-target min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm sm:flex-none"
        aria-label="Attendance date"
      />

      <button
        type="button"
        onClick={() => shift(1)}
        disabled={atFuture}
        className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-40"
        aria-label="Next day"
      >
        ›
      </button>

      {!isToday && (
        <button
          type="button"
          onClick={() => goTo(today)}
          className="tap-target rounded-lg bg-ink-100 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-200"
        >
          Today
        </button>
      )}

      {pending && <span className="text-xs text-ink-400">…</span>}
    </div>
  );
}
