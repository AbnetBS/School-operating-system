'use client';

/**
 * Leave: requesting, and deciding.
 *
 * Both halves live in one component because the same person often does both —
 * a head of department requests their own leave and approves a teacher's. What
 * they may do is decided by permissions passed from the server.
 *
 * Self-approval is refused by `decideLeaveRequest` with a 403 whatever the UI
 * does. Hiding the button here is a courtesy so nobody is invited to try.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  SecondaryButton,
  ConfirmButton,
  Disclosure,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;

type LeaveType = { id: string; name: string; requiresApproval: boolean };

type Request = {
  id: string;
  staffId: string;
  staffName: string;
  staffCode: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  reason: string | null;
  decisionNote: string | null;
  decidedByName: string | null;
};

type Option = { id: string; name: string };

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  pending: 'warn',
  approved: 'good',
  rejected: 'bad',
  cancelled: 'neutral',
};

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

export default function LeaveWorkflow({
  labels,
  leaveTypes,
  pending,
  mine,
  staff,
  ownStaffId,
  today,
  canRequest,
  canApprove,
  canViewAll,
}: {
  labels: Labels;
  leaveTypes: LeaveType[];
  pending: Request[];
  mine: Request[];
  staff: Option[];
  ownStaffId: string | null;
  today: string;
  canRequest: boolean;
  canApprove: boolean;
  canViewAll: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);

  return (
    <>
      {canRequest && ownStaffId && (
        <Card title={t('leave.newRequest')} className="mb-6">
          {leaveTypes.length === 0 ? (
            <EmptyState title={t('leave.noTypes')} description={t('leave.noTypesHelp')} />
          ) : (
            <RequestForm
              labels={labels}
              t={t}
              leaveTypes={leaveTypes}
              staff={staff}
              ownStaffId={ownStaffId}
              today={today}
              canRequestForOthers={canApprove}
            />
          )}
        </Card>
      )}

      {canViewAll && pending.length > 0 && (
        <Card title={`${t('leave.pending')} — ${t('ops.workQueue')}`} className="mb-6">
          <ul className="divide-y divide-ink-100">
            {pending.map((request) => (
              <li key={request.id} className="py-3">
                <RequestRow
                  labels={labels}
                  t={t}
                  request={request}
                  canApprove={canApprove}
                  // The server refuses this anyway; not offering it avoids
                  // inviting a failure.
                  isOwn={ownStaffId === request.staffId}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {mine.length > 0 && (
        <Card title={t('leave.myRequests')} className="mb-6">
          <ul className="divide-y divide-ink-100">
            {mine.map((request) => (
              <li key={request.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">{request.leaveTypeName}</p>
                    <p className="text-xs text-ink-600">
                      {request.startDate} → {request.endDate} ·{' '}
                      {fill(labels['leave.workingDays'] ?? '', { count: String(request.days) })}
                    </p>
                    {request.decisionNote && (
                      <p className="mt-1 text-xs italic text-ink-600">
                        “{request.decisionNote}”
                        {request.decidedByName && ` — ${request.decidedByName}`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={STATUS_TONE[request.status] ?? 'neutral'}>
                      {t(`leave.status.${request.status}`)}
                    </Badge>
                    {request.status === 'pending' && (
                      <WithdrawButton labels={labels} t={t} requestId={request.id} />
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function RequestForm({
  labels,
  t,
  leaveTypes,
  staff,
  ownStaffId,
  today,
  canRequestForOthers,
}: {
  labels: Labels;
  t: (k: string) => string;
  leaveTypes: LeaveType[];
  staff: Option[];
  ownStaffId: string;
  today: string;
  canRequestForOthers: boolean;
}) {
  const router = useRouter();
  const { saving, error, fieldErrors, submit } = useSubmit();

  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState(ownStaffId);
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? '');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState('');
  const [success, setSuccess] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);

    const result = await submit('/api/hr/leave', {
      method: 'POST',
      body: {
        staffId,
        leaveTypeId,
        startDate,
        endDate,
        reason: reason.trim() || null,
      },
    });
    if (!result) return;

    setSuccess(t('leave.submitted'));
    setReason('');
    router.refresh();
  }

  return (
    <Disclosure
      open={open}
      onToggle={setOpen}
      openLabel={t('leave.request')}
      closeLabel={t('action.cancel')}
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {canRequestForOthers && staff.length > 0 && (
            <Field
              label={t('leave.forStaff')}
              error={fieldErrors.staffId}
              className="sm:col-span-2"
            >
              <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value={ownStaffId}>{t('leave.forSelf')}</option>
                {staff
                  .filter((s) => s.id !== ownStaffId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}

          <Field
            label={t('leave.type')}
            error={fieldErrors.leaveTypeId}
            required
            className="sm:col-span-2"
          >
            <Select
              value={leaveTypeId}
              onChange={(e) => setLeaveTypeId(e.target.value)}
              required
              invalid={Boolean(fieldErrors.leaveTypeId)}
            >
              {leaveTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('leave.from')} error={fieldErrors.startDate} required>
            <TextInput
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                // Keep the range coherent rather than letting the server
                // reject an end date before the start.
                if (e.target.value > endDate) setEndDate(e.target.value);
              }}
              required
              invalid={Boolean(fieldErrors.startDate)}
            />
          </Field>

          <Field label={t('leave.to')} error={fieldErrors.endDate} required>
            <TextInput
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
              invalid={Boolean(fieldErrors.endDate)}
            />
          </Field>

          <Field
            label={t('leave.reason')}
            hint={t('leave.reasonHelp')}
            error={fieldErrors.reason}
            className="sm:col-span-2"
          >
            <TextArea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
            />
          </Field>
        </div>

        <ErrorBanner message={error} />
        {!error && <SuccessBanner message={success} />}

        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={!leaveTypeId}
        >
          {t('action.submit')}
        </SubmitButton>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function RequestRow({
  labels,
  t,
  request,
  canApprove,
  isOwn,
}: {
  labels: Labels;
  t: (k: string) => string;
  request: Request;
  canApprove: boolean;
  isOwn: boolean;
}) {
  const router = useRouter();
  const { saving, error, fieldErrors, submit } = useSubmit();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [success, setSuccess] = useState<string | null>(null);

  async function decide(decision: 'approved' | 'rejected') {
    setSuccess(null);
    const result = await submit(`/api/hr/leave/${request.id}`, {
      method: 'PATCH',
      body: { decision, note: note.trim() || null },
    });
    if (!result) return;
    setSuccess(decision === 'approved' ? t('leave.approved') : t('leave.rejected'));
    setRejecting(false);
    router.refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">{request.staffName}</p>
          <p className="text-xs text-ink-600">
            {request.leaveTypeName} · {request.startDate} → {request.endDate}
          </p>
          {request.reason && <p className="mt-1 text-xs text-ink-500">{request.reason}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone="warn">
            {fill(labels['leave.workingDays'] ?? '', { count: String(request.days) })}
          </Badge>

          {canApprove && !isOwn && !rejecting && (
            <>
              <ConfirmButton
                label={t('leave.approve')}
                confirmLabel={t('leave.approve')}
                question={t('leave.confirmApprove')}
                cancelLabel={t('action.cancel')}
                onConfirm={() => void decide('approved')}
                saving={saving}
                savingLabel={labels['ops.saving'] ?? '…'}
                tone="primary"
              />
              <button
                type="button"
                onClick={() => setRejecting(true)}
                className="tap-target rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                {t('leave.reject')}
              </button>
            </>
          )}

          {canApprove && isOwn && (
            <span className="text-xs text-ink-500">{t('leave.cannotApproveOwn')}</span>
          )}
        </div>
      </div>

      {rejecting && (
        <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3">
          <Field label={t('leave.rejectReason')} error={fieldErrors.note} required>
            <TextArea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              autoFocus
              invalid={Boolean(fieldErrors.note)}
            />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            <SubmitButton
              type="button"
              tone="danger"
              saving={saving}
              savingLabel={labels['ops.saving'] ?? '…'}
              disabled={note.trim().length === 0}
              onClick={() => void decide('rejected')}
            >
              {t('leave.reject')}
            </SubmitButton>
            <SecondaryButton onClick={() => setRejecting(false)} disabled={saving}>
              {t('action.cancel')}
            </SecondaryButton>
          </div>
          {note.trim().length === 0 && (
            <p className="mt-1 text-xs text-red-800">{t('leave.rejectReasonRequired')}</p>
          )}
        </div>
      )}

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}
    </div>
  );
}

function WithdrawButton({
  labels,
  t,
  requestId,
}: {
  labels: Labels;
  t: (k: string) => string;
  requestId: string;
}) {
  const router = useRouter();
  const { saving, error, submit } = useSubmit();

  async function withdraw() {
    const result = await submit(`/api/hr/leave/${requestId}`, { method: 'DELETE' });
    if (!result) return;
    router.refresh();
  }

  return (
    <div>
      <ConfirmButton
        label={t('leave.withdraw')}
        confirmLabel={t('leave.withdraw')}
        question={t('leave.confirmWithdraw')}
        cancelLabel={t('action.cancel')}
        onConfirm={() => void withdraw()}
        saving={saving}
        savingLabel={labels['ops.saving'] ?? '…'}
      />
      <ErrorBanner message={error} />
    </div>
  );
}
