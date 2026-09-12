'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type Student = {
  studentId: string;
  studentCode: string;
  givenName: string;
  fatherName: string;
  givenNameAm: string | null;
  rollNumber: number | null;
  attendancePercent: number | null;
  status: string | null;
  reason: string | null;
  minutesLate: number | null;
};

type Props = {
  sectionId: string;
  sectionLabel: string;
  date: string;
  students: Student[];
  statuses: string[];
  defaultStatus: string;
  requireAbsenceReason: boolean;
  riskThreshold: number;
  alreadyTaken: boolean;
  readOnly: boolean;
  readOnlyReason?: string;
};

const STATUS_META: Record<string, { label: string; short: string; classes: string; active: string }> = {
  present: {
    label: 'Present',
    short: 'P',
    classes: 'border-emerald-300 text-emerald-700',
    active: 'bg-emerald-600 text-white border-emerald-600',
  },
  absent: {
    label: 'Absent',
    short: 'A',
    classes: 'border-red-300 text-red-700',
    active: 'bg-red-600 text-white border-red-600',
  },
  late: {
    label: 'Late',
    short: 'L',
    classes: 'border-amber-300 text-amber-700',
    active: 'bg-amber-500 text-white border-amber-500',
  },
  excused: {
    label: 'Excused',
    short: 'E',
    classes: 'border-sky-300 text-sky-700',
    active: 'bg-sky-600 text-white border-sky-600',
  },
  sick: {
    label: 'Sick',
    short: 'S',
    classes: 'border-violet-300 text-violet-700',
    active: 'bg-violet-600 text-white border-violet-600',
  },
};

const QUEUE_KEY = 'sos.attendance.queue';

type QueuedRegister = {
  sectionId: string;
  date: string;
  marks: { studentId: string; status: string; reason?: string }[];
  idempotencyKey: string;
  queuedAt: number;
};

function readQueue(): QueuedRegister[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as QueuedRegister[];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedRegister[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

/**
 * The register.
 *
 * Designed for a teacher standing in front of a class on a phone:
 *  - everyone starts at the school's default status, so only exceptions need
 *    tapping;
 *  - one tap per student, with large touch targets;
 *  - the whole register saves in a single request;
 *  - if the network is down the register is queued locally and flushed when
 *    connectivity returns, rather than being lost.
 */
export default function RegisterForm({
  sectionId,
  sectionLabel,
  date,
  students,
  statuses,
  defaultStatus,
  requireAbsenceReason,
  riskThreshold,
  alreadyTaken,
  readOnly,
  readOnlyReason,
}: Props) {
  const router = useRouter();

  const initial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const student of students) {
      map[student.studentId] =
        student.status ?? (defaultStatus === 'unmarked' ? '' : defaultStatus);
    }
    return map;
  }, [students, defaultStatus]);

  const [marks, setMarks] = useState<Record<string, string>>(initial);
  const [reasons, setReasons] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const student of students) if (student.reason) map[student.studentId] = student.reason;
    return map;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(
    null,
  );
  const [online, setOnline] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    setQueuedCount(readQueue().length);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // Flush anything saved while offline as soon as the network is back.
  useEffect(() => {
    if (!online) return;
    const queue = readQueue();
    if (queue.length === 0) return;

    (async () => {
      try {
        const response = await fetch('/api/attendance/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            registers: queue.map((q) => ({
              sectionId: q.sectionId,
              date: q.date,
              marks: q.marks,
              idempotencyKey: q.idempotencyKey,
              syncedOffline: true,
            })),
          }),
        });
        if (!response.ok) return;
        const data = await response.json();
        // Keep only the ones the server refused, so nothing is silently lost.
        const failedKeys = new Set(
          (data.results ?? [])
            .filter((r: { ok: boolean }) => !r.ok)
            .map((r: { sectionId: string; date: string }) => `${r.sectionId}:${r.date}`),
        );
        const remaining = queue.filter((q) => failedKeys.has(`${q.sectionId}:${q.date}`));
        writeQueue(remaining);
        setQueuedCount(remaining.length);
        if (data.synced > 0) {
          setMessage({
            tone: 'good',
            text: `${data.synced} offline register${data.synced === 1 ? '' : 's'} synced.`,
          });
          router.refresh();
        }
      } catch {
        // Still offline in practice; the queue stays put.
      }
    })();
  }, [online, router]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const value of Object.values(marks)) {
      if (!value) continue;
      tally[value] = (tally[value] ?? 0) + 1;
    }
    return tally;
  }, [marks]);

  const unmarked = students.filter((s) => !marks[s.studentId]).length;

  const visible = useMemo(() => {
    if (!search.trim()) return students;
    const term = search.trim().toLowerCase();
    return students.filter(
      (s) =>
        s.givenName.toLowerCase().includes(term) ||
        s.fatherName.toLowerCase().includes(term) ||
        s.studentCode.toLowerCase().includes(term) ||
        (s.givenNameAm ?? '').includes(term),
    );
  }, [students, search]);

  function setStatus(studentId: string, status: string) {
    if (readOnly) return;
    setMarks((prev) => ({ ...prev, [studentId]: status }));
  }

  function markAll(status: string) {
    if (readOnly) return;
    const next: Record<string, string> = {};
    for (const student of students) next[student.studentId] = status;
    setMarks(next);
  }

  async function save() {
    if (readOnly) return;

    const payloadMarks = students
      .filter((s) => marks[s.studentId])
      .map((s) => ({
        studentId: s.studentId,
        status: marks[s.studentId]!,
        reason: reasons[s.studentId] || undefined,
      }));

    if (payloadMarks.length === 0) {
      setMessage({ tone: 'warn', text: 'Mark at least one student before saving.' });
      return;
    }

    if (requireAbsenceReason) {
      const missing = payloadMarks.filter((m) => m.status === 'absent' && !m.reason?.trim());
      if (missing.length > 0) {
        setMessage({
          tone: 'warn',
          text: `This school requires a reason for every absence — ${missing.length} still missing.`,
        });
        return;
      }
    }

    const idempotencyKey = `${sectionId}:daily:${date}`;
    setSaving(true);
    setMessage(null);

    // Offline: queue and tell the truth about what happened.
    if (!navigator.onLine) {
      const queue = readQueue().filter((q) => q.idempotencyKey !== idempotencyKey);
      queue.push({ sectionId, date, marks: payloadMarks, idempotencyKey, queuedAt: Date.now() });
      writeQueue(queue);
      setQueuedCount(queue.length);
      setSaving(false);
      setMessage({
        tone: 'warn',
        text: 'Saved on this device. It will sync automatically when you are back online.',
      });
      return;
    }

    try {
      const response = await fetch('/api/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionId,
          date,
          marks: payloadMarks,
          idempotencyKey,
          syncedOffline: false,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setMessage({ tone: 'bad', text: data.error ?? 'Could not save attendance.' });
        setSaving(false);
        return;
      }

      setMessage({
        tone: 'good',
        text: data.created ? 'Attendance saved.' : 'Attendance updated.',
      });
      setSaving(false);
      router.refresh();
    } catch {
      // The request failed mid-flight; keep the data rather than losing it.
      const queue = readQueue().filter((q) => q.idempotencyKey !== idempotencyKey);
      queue.push({ sectionId, date, marks: payloadMarks, idempotencyKey, queuedAt: Date.now() });
      writeQueue(queue);
      setQueuedCount(queue.length);
      setSaving(false);
      setMessage({
        tone: 'warn',
        text: 'No connection. Saved on this device and will sync automatically.',
      });
    }
  }

  return (
    <div className="pb-28">
      {!online && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You are offline. Registers are saved on this device and sync automatically.
        </div>
      )}
      {queuedCount > 0 && online && (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          {queuedCount} register{queuedCount === 1 ? '' : 's'} waiting to sync…
        </div>
      )}
      {readOnly && (
        <div className="mb-3 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-700">
          {readOnlyReason ?? 'This register is read-only.'}
        </div>
      )}
      {message && (
        <div
          role="status"
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
            message.tone === 'good'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : message.tone === 'bad'
                ? 'border-red-200 bg-red-50 text-red-800'
                : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          {message.text}
        </div>
      )}

      {!readOnly && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-500">Mark all:</span>
          {statuses.slice(0, 3).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => markAll(status)}
              className={`tap-target rounded-lg border px-3 py-1.5 text-xs font-semibold ${STATUS_META[status]?.classes ?? 'border-ink-300 text-ink-700'}`}
            >
              {STATUS_META[status]?.label ?? status}
            </button>
          ))}
        </div>
      )}

      {students.length > 12 && (
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a student…"
          className="tap-target mb-3 w-full rounded-lg border border-ink-300 px-3 py-2 text-base sm:text-sm"
          aria-label="Find a student in this class"
        />
      )}

      <ul className="space-y-1.5">
        {visible.map((student) => {
          const value = marks[student.studentId] ?? '';
          const atRisk =
            student.attendancePercent !== null && student.attendancePercent < riskThreshold;
          return (
            <li
              key={student.studentId}
              className="rounded-xl border border-ink-200 bg-white p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">
                    {student.rollNumber ? `${student.rollNumber}. ` : ''}
                    {student.givenName} {student.fatherName}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {student.studentCode}
                    {atRisk && (
                      <span className="ml-2 font-medium text-red-600">
                        {student.attendancePercent}% attendance
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-4 gap-1.5" role="group" aria-label={`Attendance for ${student.givenName}`}>
                {statuses.map((status) => {
                  const meta = STATUS_META[status] ?? {
                    label: status,
                    short: status.charAt(0).toUpperCase(),
                    classes: 'border-ink-300 text-ink-700',
                    active: 'bg-ink-700 text-white border-ink-700',
                  };
                  const selected = value === status;
                  return (
                    <button
                      key={status}
                      type="button"
                      disabled={readOnly}
                      aria-pressed={selected}
                      onClick={() => setStatus(student.studentId, status)}
                      className={`tap-target rounded-lg border py-2 text-xs font-semibold transition disabled:opacity-50 ${
                        selected ? meta.active : `bg-white ${meta.classes}`
                      }`}
                    >
                      <span className="sm:hidden">{meta.short}</span>
                      <span className="hidden sm:inline">{meta.label}</span>
                    </button>
                  );
                })}
              </div>

              {(value === 'absent' || value === 'excused' || value === 'sick') && !readOnly && (
                <input
                  type="text"
                  value={reasons[student.studentId] ?? ''}
                  onChange={(e) =>
                    setReasons((prev) => ({ ...prev, [student.studentId]: e.target.value }))
                  }
                  placeholder={
                    requireAbsenceReason && value === 'absent'
                      ? 'Reason (required)'
                      : 'Reason (optional)'
                  }
                  className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm ${
                    requireAbsenceReason && value === 'absent' && !reasons[student.studentId]
                      ? 'border-amber-400 bg-amber-50'
                      : 'border-ink-300'
                  }`}
                  aria-label={`Reason for ${student.givenName}`}
                />
              )}
            </li>
          );
        })}
      </ul>

      {visible.length === 0 && (
        <p className="py-6 text-center text-sm text-ink-500">No student matches “{search}”.</p>
      )}

      {/* Sticky action bar: the summary and Save stay reachable with a thumb. */}
      <div className="fixed inset-x-0 bottom-14 z-20 border-t border-ink-200 bg-white/95 px-4 py-2.5 backdrop-blur lg:bottom-0 lg:left-64">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-ink-600">
            <span className="font-semibold text-ink-900">{sectionLabel}</span>
            <span className="mx-1.5 text-ink-300">·</span>
            {statuses.map((status) => (
              <span key={status} className="mr-2 whitespace-nowrap">
                {STATUS_META[status]?.short ?? status.charAt(0).toUpperCase()} {counts[status] ?? 0}
              </span>
            ))}
            {unmarked > 0 && <span className="text-amber-700">· {unmarked} unmarked</span>}
          </div>
          {readOnly ? (
            <Link
              href="/attendance"
              className="tap-target shrink-0 rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700"
            >
              Back
            </Link>
          ) : (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="tap-target shrink-0 rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {saving ? 'Saving…' : alreadyTaken ? 'Update' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
