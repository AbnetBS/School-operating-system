'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

type Row = {
  staffId: string;
  staffCode: string;
  name: string;
  jobTitle: string | null;
  status: string | null;
};

type Props = {
  date: string;
  rows: Row[];
  statuses: string[];
  labels: Record<string, string>;
  markAllLabel: string;
  saveLabel: string;
  savedLabel: string;
  /** Shown against a person whose status is already on the record. */
  recordedLabel: string;
};

const TONE: Record<string, { idle: string; active: string }> = {
  present: { idle: 'border-emerald-300 text-emerald-700', active: 'bg-emerald-600 text-white border-emerald-600' },
  absent: { idle: 'border-red-300 text-red-700', active: 'bg-red-600 text-white border-red-600' },
  late: { idle: 'border-amber-300 text-amber-700', active: 'bg-amber-500 text-white border-amber-500' },
  on_leave: { idle: 'border-sky-300 text-sky-700', active: 'bg-sky-600 text-white border-sky-600' },
  half_day: { idle: 'border-violet-300 text-violet-700', active: 'bg-violet-600 text-white border-violet-600' },
};

/**
 * Staff register.
 *
 * Thumb-sized status buttons in a row per person, exactly like the pupil
 * register: on a phone an administrator marks a whole staff list by tapping
 * down one column, and never has to open a dropdown.
 *
 * Everything is sent in ONE request. Marking thirty people must not be thirty
 * round trips on a school's connection.
 */
export function StaffRegister({
  date,
  rows,
  statuses,
  labels,
  markAllLabel,
  saveLabel,
  savedLabel,
  recordedLabel,
}: Props) {
  const router = useRouter();
  const [marks, setMarks] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.filter((r) => r.status).map((r) => [r.staffId, r.status!])),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markedCount = useMemo(() => Object.keys(marks).length, [marks]);

  async function save() {
    if (saving) return; // Double-tap guard, in addition to the disabled button.
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch('/api/hr/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          entries: Object.entries(marks).map(([staffId, status]) => ({ staffId, status })),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        // Never claim success on a rejection — the server knows about the
        // module switch and the permission, and this screen does not.
        setError(body.error ?? 'Could not save.');
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError('The request could not be sent. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-600">
          {markedCount} / {rows.length}
        </p>
        <button
          type="button"
          onClick={() =>
            setMarks(Object.fromEntries(rows.map((r) => [r.staffId, statuses[0] ?? 'present'])))
          }
          className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
        >
          {markAllLabel}
        </button>
      </div>

      <ul className="divide-y divide-ink-100">
        {rows.map((row) => (
          <li key={row.staffId} className="py-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <p className="min-w-0 truncate font-medium text-ink-900">
                {row.name}
                {row.status && (
                  <span className="ml-2 text-xs font-normal text-ink-400">{recordedLabel}</span>
                )}
              </p>
              <span className="shrink-0 font-mono text-xs text-ink-400">{row.staffCode}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {statuses.map((status) => {
                const active = marks[row.staffId] === status;
                const tone = TONE[status] ?? TONE.present!;
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setMarks((prev) => {
                        const next = { ...prev };
                        if (next[row.staffId] === status) delete next[row.staffId];
                        else next[row.staffId] = status;
                        return next;
                      })
                    }
                    className={`tap-target min-w-[4.5rem] rounded-lg border px-3 py-2 text-sm font-medium transition ${
                      active ? tone.active : `bg-white ${tone.idle}`
                    }`}
                  >
                    {labels[status] ?? status}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {saved && !error && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {savedLabel}
        </p>
      )}

      <div className="sticky bottom-16 mt-4 lg:bottom-0">
        <button
          type="button"
          onClick={save}
          disabled={saving || markedCount === 0}
          className="tap-target w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? '…' : saveLabel}
        </button>
      </div>
    </div>
  );
}
