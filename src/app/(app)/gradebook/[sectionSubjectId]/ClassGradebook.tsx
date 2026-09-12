'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

type Component = { key: string; name: string; instances: number; maxMark: number };

type AssessmentRow = {
  id: string;
  componentKey: string;
  componentName: string;
  instance: number;
  title: string;
  maxMark: number;
  assessedOn: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'locked';
  markedCount: number;
  studentCount: number;
};

type MarkRow = {
  studentId: string;
  studentCode: string;
  name: string;
  rollNumber: number | null;
  mark: number | null;
  excused: boolean;
  note: string | null;
};

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

/**
 * The teacher's working surface: pick an assessment, type marks, submit.
 *
 * Marks are held locally while typing and sent in one request, because a
 * teacher on a phone should not depend on a round trip per pupil. Server
 * responses are authoritative — per-student errors come back keyed by id and
 * are shown against the right row rather than as one opaque failure.
 */
export default function ClassGradebook({
  sectionSubjectId,
  termId,
  components,
  initialAssessments,
  canEnter,
  canReview,
  canLock,
  canOverride,
  statusTone,
}: {
  sectionSubjectId: string;
  termId: string;
  components: Component[];
  initialAssessments: AssessmentRow[];
  canEnter: boolean;
  canReview: boolean;
  canLock: boolean;
  canOverride: boolean;
  statusTone: Record<string, Tone>;
}) {
  const router = useRouter();
  const [assessments, setAssessments] = useState(initialAssessments);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{
    rows: MarkRow[];
    canEdit: boolean;
    maxMark: number;
    title: string;
    status: string;
    reviewNote: string | null;
  } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const refreshList = useCallback(async () => {
    const res = await fetch(
      `/api/gradebook/assessments?sectionSubjectId=${sectionSubjectId}&termId=${termId}`,
    );
    if (res.ok) {
      const data = await res.json();
      setAssessments(data.assessments);
    }
  }, [sectionSubjectId, termId]);

  async function openSheet(id: string) {
    setBusy(true);
    setMessage(null);
    setRowErrors({});
    const res = await fetch(`/api/gradebook/marks?assessmentId=${id}`);
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setMessage({ tone: 'bad', text: body.error ?? 'That mark sheet could not be opened.' });
      return;
    }
    const data = await res.json();
    setOpenId(id);
    setSheet({
      rows: data.rows,
      canEdit: data.canEdit,
      maxMark: data.assessment.maxMark,
      title: data.assessment.title,
      status: data.assessment.status,
      reviewNote: data.assessment.reviewNote,
    });
  }

  function setMark(studentId: string, raw: string) {
    setSheet((current) => {
      if (!current) return current;
      return {
        ...current,
        rows: current.rows.map((r) =>
          r.studentId === studentId
            ? { ...r, mark: raw === '' ? null : Number(raw), excused: raw === '' ? r.excused : false }
            : r,
        ),
      };
    });
  }

  function toggleExcused(studentId: string) {
    setSheet((current) => {
      if (!current) return current;
      return {
        ...current,
        rows: current.rows.map((r) =>
          // Excused and "scored zero" are different states; setting one clears
          // the other so an excused pupil is never averaged as a nought.
          r.studentId === studentId ? { ...r, excused: !r.excused, mark: null } : r,
        ),
      };
    });
  }

  async function save(submit: boolean) {
    if (!sheet || !openId) return;
    setBusy(true);
    setMessage(null);
    setRowErrors({});

    const res = await fetch('/api/gradebook/marks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assessmentId: openId,
        entries: sheet.rows.map((r) => ({
          studentId: r.studentId,
          mark: r.mark,
          excused: r.excused,
          note: r.note ?? '',
        })),
        submit,
      }),
    });

    const body = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setMessage({ tone: 'bad', text: body.error ?? 'The marks could not be saved.' });
      return;
    }

    if (body.errors && Object.keys(body.errors).length > 0) {
      setRowErrors(body.errors);
      setMessage({
        tone: 'bad',
        text: `${body.saved} saved. ${Object.keys(body.errors).length} could not be saved — see the highlighted rows.`,
      });
    } else {
      setMessage({
        tone: 'ok',
        text: submit ? 'Marks saved and submitted for review.' : `${body.saved} marks saved.`,
      });
      if (submit) {
        setOpenId(null);
        setSheet(null);
      }
    }
    await refreshList();
    router.refresh();
  }

  async function workflow(id: string, action: string) {
    let reason = '';
    if (action === 'reject' || action === 'unlock') {
      reason = window.prompt('A reason is required and will be recorded in the audit log:') ?? '';
      if (!reason.trim()) return;
    }

    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/gradebook/assessments/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, reason }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setMessage({ tone: 'bad', text: body.error ?? 'That action could not be completed.' });
      return;
    }
    setMessage({ tone: 'ok', text: `Marks are now ${body.status}.` });
    if (openId === id) {
      setOpenId(null);
      setSheet(null);
    }
    await refreshList();
    router.refresh();
  }

  const marked = sheet
    ? sheet.rows.filter((r) => r.mark !== null || r.excused).length
    : 0;

  return (
    <div className="space-y-4">
      {message && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${
            message.tone === 'ok'
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </p>
      )}

      {/* ---- assessment list ---- */}
      <section className="card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">Assessments</h2>
          {canEnter && (
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              className="tap-target rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              {creating ? 'Cancel' : 'New assessment'}
            </button>
          )}
        </header>

        {creating && (
          <NewAssessment
            sectionSubjectId={sectionSubjectId}
            termId={termId}
            components={components}
            existing={assessments}
            onDone={async () => {
              setCreating(false);
              await refreshList();
              router.refresh();
            }}
            onError={(text) => setMessage({ tone: 'bad', text })}
          />
        )}

        {assessments.length === 0 ? (
          <p className="p-4 text-sm text-ink-500">
            No assessments yet for this term. Create one to start entering marks.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {assessments.map((a) => (
              <li key={a.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">
                      {a.title}{' '}
                      <span className="text-ink-500">
                        · {a.componentName}
                        {a.instance > 1 ? ` ${a.instance}` : ''} · out of {a.maxMark}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {a.markedCount} of {a.studentCount} marked
                      {a.assessedOn ? ` · ${a.assessedOn}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} tone={statusTone[a.status] ?? 'neutral'} />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => (openId === a.id ? (setOpenId(null), setSheet(null)) : openSheet(a.id))}
                      className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700 disabled:opacity-50"
                    >
                      {openId === a.id ? 'Close' : 'Marks'}
                    </button>
                  </div>
                </div>

                {/* Workflow actions appear only where the permission allows. */}
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.status === 'draft' && canEnter && a.markedCount > 0 && (
                    <WorkflowButton onClick={() => workflow(a.id, 'submit')} busy={busy}>
                      Submit for review
                    </WorkflowButton>
                  )}
                  {a.status === 'submitted' && canReview && (
                    <>
                      <WorkflowButton onClick={() => workflow(a.id, 'approve')} busy={busy}>
                        Approve
                      </WorkflowButton>
                      <WorkflowButton onClick={() => workflow(a.id, 'reject')} busy={busy}>
                        Send back
                      </WorkflowButton>
                    </>
                  )}
                  {a.status === 'approved' && canLock && (
                    <WorkflowButton onClick={() => workflow(a.id, 'lock')} busy={busy}>
                      Lock
                    </WorkflowButton>
                  )}
                  {a.status === 'locked' && canOverride && (
                    <WorkflowButton onClick={() => workflow(a.id, 'unlock')} busy={busy}>
                      Unlock
                    </WorkflowButton>
                  )}
                </div>

                {/* ---- inline mark sheet ---- */}
                {openId === a.id && sheet && (
                  <div className="mt-4 border-t border-ink-200 pt-4">
                    {sheet.reviewNote && (
                      <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        Returned for correction: {sheet.reviewNote}
                      </p>
                    )}
                    {!sheet.canEdit && (
                      <p className="mb-3 rounded-lg bg-ink-100 px-3 py-2 text-sm text-ink-700">
                        These marks are {sheet.status}. They cannot be changed here.
                      </p>
                    )}

                    <p className="mb-2 text-xs text-ink-500">
                      {marked} of {sheet.rows.length} marked · out of {sheet.maxMark}
                    </p>

                    <ul className="divide-y divide-ink-100">
                      {sheet.rows.map((r) => (
                        <li
                          key={r.studentId}
                          className={`flex items-center gap-3 py-2 ${
                            rowErrors[r.studentId] ? 'bg-red-50' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-ink-900">
                              {r.rollNumber ? `${r.rollNumber}. ` : ''}
                              {r.name}
                            </p>
                            <p className="truncate text-xs text-ink-500">{r.studentCode}</p>
                            {rowErrors[r.studentId] && (
                              <p className="text-xs font-medium text-red-700">
                                {rowErrors[r.studentId]}
                              </p>
                            )}
                          </div>

                          <label className="sr-only" htmlFor={`mark-${r.studentId}`}>
                            Mark for {r.name}
                          </label>
                          <input
                            id={`mark-${r.studentId}`}
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={sheet.maxMark}
                            step="any"
                            disabled={!sheet.canEdit || r.excused || busy}
                            value={r.mark ?? ''}
                            onChange={(e) => setMark(r.studentId, e.target.value)}
                            className="w-20 rounded-lg border border-ink-300 px-2 py-2 text-right text-sm disabled:bg-ink-100"
                            placeholder="—"
                          />

                          <button
                            type="button"
                            disabled={!sheet.canEdit || busy}
                            onClick={() => toggleExcused(r.studentId)}
                            aria-pressed={r.excused}
                            className={`tap-target rounded-lg px-2 py-2 text-xs font-medium ${
                              r.excused
                                ? 'bg-amber-100 text-amber-900'
                                : 'border border-ink-300 text-ink-600'
                            } disabled:opacity-50`}
                          >
                            Excused
                          </button>
                        </li>
                      ))}
                    </ul>

                    {sheet.canEdit && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => save(false)}
                          className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                        >
                          {busy ? 'Saving…' : 'Save marks'}
                        </button>
                        {a.status === 'draft' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => save(true)}
                            className="tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 disabled:opacity-50"
                          >
                            Save and submit
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status, tone }: { status: string; tone: Tone }) {
  const classes = {
    neutral: 'bg-ink-100 text-ink-700',
    good: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-800',
    bad: 'bg-red-100 text-red-800',
    info: 'bg-brand-100 text-brand-800',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {status}
    </span>
  );
}

function WorkflowButton({
  children,
  onClick,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Create an assessment, constrained to the school's configured structure. */
function NewAssessment({
  sectionSubjectId,
  termId,
  components,
  existing,
  onDone,
  onError,
}: {
  sectionSubjectId: string;
  termId: string;
  components: Component[];
  existing: AssessmentRow[];
  onDone: () => void;
  onError: (text: string) => void;
}) {
  const [componentKey, setComponentKey] = useState(components[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [maxMark, setMaxMark] = useState(String(components[0]?.maxMark ?? 100));
  const [assessedOn, setAssessedOn] = useState('');
  const [busy, setBusy] = useState(false);

  const component = components.find((c) => c.key === componentKey);
  // Only offer instance numbers the configuration actually allows, and only
  // those not already used — the server enforces both regardless.
  const used = new Set(
    existing.filter((a) => a.componentKey === componentKey).map((a) => a.instance),
  );
  const freeInstances = component
    ? Array.from({ length: component.instances }, (_, i) => i + 1).filter((n) => !used.has(n))
    : [];
  const [instance, setInstance] = useState(freeInstances[0] ?? 1);
  const nextInstance = freeInstances.includes(instance) ? instance : (freeInstances[0] ?? 1);

  async function submit() {
    setBusy(true);
    const res = await fetch('/api/gradebook/assessments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sectionSubjectId,
        termId,
        componentKey,
        instance: nextInstance,
        title: title.trim() || `${component?.name ?? 'Assessment'} ${nextInstance}`,
        maxMark: Number(maxMark),
        assessedOn,
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      onError(body.error ?? 'The assessment could not be created.');
      return;
    }
    setTitle('');
    onDone();
  }

  if (components.length === 0) {
    return (
      <p className="p-4 text-sm text-ink-500">
        This school has no assessment types configured yet.
      </p>
    );
  }

  return (
    <div className="grid gap-3 border-b border-ink-200 bg-ink-50 p-4 sm:grid-cols-5">
      <label className="text-xs font-medium text-ink-700">
        Type
        <select
          value={componentKey}
          onChange={(e) => {
            setComponentKey(e.target.value);
            const next = components.find((c) => c.key === e.target.value);
            if (next) setMaxMark(String(next.maxMark));
          }}
          className="mt-1 w-full rounded-lg border border-ink-300 px-2 py-2 text-sm"
        >
          {components.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-ink-700">
        Number
        <select
          value={nextInstance}
          onChange={(e) => setInstance(Number(e.target.value))}
          disabled={freeInstances.length === 0}
          className="mt-1 w-full rounded-lg border border-ink-300 px-2 py-2 text-sm disabled:bg-ink-100"
        >
          {freeInstances.length === 0 ? (
            <option>All used</option>
          ) : (
            freeInstances.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))
          )}
        </select>
      </label>

      <label className="text-xs font-medium text-ink-700 sm:col-span-2">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`${component?.name ?? ''} ${nextInstance}`}
          className="mt-1 w-full rounded-lg border border-ink-300 px-2 py-2 text-sm"
        />
      </label>

      <label className="text-xs font-medium text-ink-700">
        Out of
        <input
          type="number"
          min={1}
          value={maxMark}
          onChange={(e) => setMaxMark(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink-300 px-2 py-2 text-sm"
        />
      </label>

      <label className="text-xs font-medium text-ink-700 sm:col-span-2">
        Date (optional)
        <input
          type="date"
          value={assessedOn}
          onChange={(e) => setAssessedOn(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink-300 px-2 py-2 text-sm"
        />
      </label>

      <div className="flex items-end sm:col-span-3">
        <button
          type="button"
          onClick={submit}
          disabled={busy || freeInstances.length === 0}
          className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create assessment'}
        </button>
      </div>
    </div>
  );
}
