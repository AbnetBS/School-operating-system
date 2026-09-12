'use client';

/**
 * The fault queue, with the controls a caretaker or manager needs on the row.
 *
 * Closing an issue requires saying what was done — enforced by the schema, not
 * just asked for here, because "resolved" with no explanation is how the same
 * fault gets reported four times.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '../../../components/ui.tsx';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  SecondaryButton,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;

type Issue = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  location: string | null;
  assetName: string | null;
  reportedOn: string;
  reportedByName: string | null;
  assignedToName: string | null;
  assignedStaffId: string | null;
  resolutionNote: string | null;
  costCents: number | null;
  ageDays: number;
};

type StaffOption = { id: string; name: string };

const PRIORITY_TONE = {
  urgent: 'bad',
  high: 'bad',
  normal: 'warn',
  low: 'neutral',
} as const;

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  open: 'warn',
  in_progress: 'info',
  resolved: 'good',
  closed: 'neutral',
  cancelled: 'neutral',
};

function parseCost(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export default function IssueQueue({
  labels,
  issues,
  statuses,
  priorities,
  staff,
  canManage,
}: {
  labels: Labels;
  issues: Issue[];
  statuses: string[];
  priorities: string[];
  staff: StaffOption[];
  canManage: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <ul className="divide-y divide-ink-100">
      {issues.map((issue) => (
        <li key={issue.id} className="py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink-900">{issue.title}</p>
              <p className="text-xs text-ink-600">
                {issue.location ?? issue.assetName ?? '—'}
              </p>
              <p className="mt-0.5 text-xs text-ink-500">
                {t('maintenance.reportedOn')}: {issue.reportedOn} · {issue.ageDays}d
                {issue.reportedByName && ` · ${issue.reportedByName}`}
                {issue.assignedToName && ` · ${t('maintenance.assignedTo')}: ${issue.assignedToName}`}
              </p>
              {issue.resolutionNote && (
                <p className="mt-1 text-xs italic text-ink-600">{issue.resolutionNote}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Badge tone={PRIORITY_TONE[issue.priority as keyof typeof PRIORITY_TONE]}>
                {t(`maintenance.priority.${issue.priority}`)}
              </Badge>
              <Badge tone={STATUS_TONE[issue.status] ?? 'neutral'}>
                {t(`maintenance.status.${issue.status}`)}
              </Badge>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setEditingId(editingId === issue.id ? null : issue.id)}
                  className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                >
                  {t('maintenance.updateIssue')}
                </button>
              )}
            </div>
          </div>

          {canManage && editingId === issue.id && (
            <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
              <IssueForm
                labels={labels}
                t={t}
                issue={issue}
                statuses={statuses}
                priorities={priorities}
                staff={staff}
                onDone={() => setEditingId(null)}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function IssueForm({
  labels,
  t,
  issue,
  statuses,
  priorities,
  staff,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  issue: Issue;
  statuses: string[];
  priorities: string[];
  staff: StaffOption[];
  onDone: () => void;
}) {
  const router = useRouter();
  const { saving, error, fieldErrors, submit } = useSubmit();

  const [status, setStatus] = useState(issue.status);
  const [priority, setPriority] = useState(issue.priority);
  const [assignedStaffId, setAssignedStaffId] = useState(issue.assignedStaffId ?? '');
  const [resolutionNote, setResolutionNote] = useState(issue.resolutionNote ?? '');
  const [cost, setCost] = useState(
    issue.costCents === null ? '' : (issue.costCents / 100).toFixed(2),
  );
  const [success, setSuccess] = useState<string | null>(null);

  // The schema refuses a close without a resolution; mirror it here so the
  // person is told before the round trip rather than after.
  const closing = status === 'resolved' || status === 'closed';
  const needsNote = closing && resolutionNote.trim().length === 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);

    const result = await submit(`/api/maintenance/${issue.id}`, {
      method: 'PATCH',
      body: {
        status,
        priority,
        assignedStaffId: assignedStaffId || null,
        resolutionNote: resolutionNote.trim() || null,
        costCents: parseCost(cost),
      },
    });
    if (!result) return;

    setSuccess(t('maintenance.issueUpdated'));
    router.refresh();
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('finance.status')} error={fieldErrors.status}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {t(`maintenance.status.${s}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('maintenance.priority')} error={fieldErrors.priority}>
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {priorities.map((p) => (
              <option key={p} value={p}>
                {t(`maintenance.priority.${p}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('maintenance.assignTo')} error={fieldErrors.assignedStaffId}>
          <Select
            value={assignedStaffId}
            onChange={(e) => setAssignedStaffId(e.target.value)}
          >
            <option value="">{t('asset.unassigned')}</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('maintenance.cost')} error={fieldErrors.costCents}>
          <TextInput
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            invalid={Boolean(fieldErrors.costCents)}
          />
        </Field>

        <Field
          label={t('maintenance.resolution')}
          error={fieldErrors.resolutionNote}
          required={closing}
          className="sm:col-span-2"
        >
          <TextArea
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
            maxLength={2000}
            invalid={Boolean(fieldErrors.resolutionNote)}
          />
        </Field>
      </div>

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}
      {needsNote && (
        <p className="text-xs text-amber-800">{t('maintenance.resolutionRequired')}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={needsNote}
        >
          {t('action.save')}
        </SubmitButton>
        <SecondaryButton onClick={onDone} disabled={saving}>
          {t('action.cancel')}
        </SecondaryButton>
      </div>
    </form>
  );
}
