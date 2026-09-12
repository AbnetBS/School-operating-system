'use client';

/**
 * One route: its stops, and the children who ride it.
 *
 * Assignment is the operation with a real consequence — a bus that is full
 * means a child waiting at a kerb — so the seat count is shown next to the
 * button and the server re-checks capacity under a row lock before it accepts
 * (`assignTransport`). The count here is advisory; the server's is binding.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../../components/ui.tsx';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  ConfirmButton,
  Disclosure,
  useSubmit,
} from '../../../../components/form.tsx';

type Labels = Record<string, string>;

type Stop = {
  id: string;
  name: string;
  sortOrder: number;
  pickupTime: string | null;
  dropoffTime: string | null;
  landmark: string | null;
};

type Rider = {
  id: string;
  studentId: string;
  studentName: string;
  studentCode: string;
  sectionName: string | null;
  pickupStop: string | null;
  dropoffStop: string | null;
  startDate: string;
  status: string;
};

type Student = {
  id: string;
  givenName: string;
  fatherName: string;
  grandfatherName: string | null;
  studentCode: string;
};

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

export default function RouteDetail({
  labels,
  routeId,
  routeName,
  stops,
  riders,
  seatsLeft,
  today,
  canManage,
}: {
  labels: Labels;
  routeId: string;
  routeName: string;
  stops: Stop[];
  riders: Rider[];
  seatsLeft: number | null;
  today: string;
  canManage: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);

  return (
    <>
      <Card title={t('transport.stops')} className="mb-6">
        {canManage && <StopForm labels={labels} t={t} routeId={routeId} />}

        {stops.length === 0 ? (
          <div className="mt-4">
            <EmptyState title={t('transport.noStops')} />
          </div>
        ) : (
          <ol className="mt-4 divide-y divide-ink-100">
            {stops.map((stop) => (
              <li key={stop.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink-900">
                    {stop.sortOrder}. {stop.name}
                  </span>
                  {stop.landmark && (
                    <span className="block text-xs text-ink-500">{stop.landmark}</span>
                  )}
                </span>
                <span className="shrink-0 text-right text-xs text-ink-600">
                  {stop.pickupTime && (
                    <span className="block">
                      {t('transport.pickupTime')}: {stop.pickupTime}
                    </span>
                  )}
                  {stop.dropoffTime && (
                    <span className="block">
                      {t('transport.dropoffTime')}: {stop.dropoffTime}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={t('transport.riderList')}>
        {canManage && (
          <AssignForm
            labels={labels}
            t={t}
            routeId={routeId}
            routeName={routeName}
            stops={stops}
            seatsLeft={seatsLeft}
            today={today}
          />
        )}

        {riders.length === 0 ? (
          <div className="mt-4">
            <EmptyState title={t('transport.noRiders')} />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-ink-100">
            {riders.map((rider) => (
              <li key={rider.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">{rider.studentName}</p>
                    <p className="text-xs text-ink-500">
                      {[rider.studentCode, rider.sectionName].filter(Boolean).join(' · ')}
                    </p>
                    <p className="text-xs text-ink-500">
                      {[rider.pickupStop, rider.dropoffStop].filter(Boolean).join(' → ') || '—'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={rider.status === 'active' ? 'good' : 'neutral'}>
                      {rider.startDate}
                    </Badge>
                    {canManage && rider.status === 'active' && (
                      <EndAssignment
                        labels={labels}
                        t={t}
                        assignmentId={rider.id}
                        today={today}
                      />
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

function StopForm({
  labels,
  t,
  routeId,
}: {
  labels: Labels;
  t: (k: string) => string;
  routeId: string;
}) {
  const router = useRouter();
  const { saving, error, fieldErrors, submit } = useSubmit();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [pickupTime, setPickupTime] = useState('');
  const [dropoffTime, setDropoffTime] = useState('');
  const [landmark, setLandmark] = useState('');
  const [success, setSuccess] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const result = await submit(`/api/transport/routes/${routeId}/stops`, {
      method: 'POST',
      body: {
        name: name.trim(),
        sortOrder: Number(sortOrder) || 0,
        pickupTime: pickupTime || null,
        dropoffTime: dropoffTime || null,
        landmark: landmark.trim() || null,
      },
    });
    if (!result) return;
    setSuccess(t('transport.stopSaved'));
    setName('');
    setLandmark('');
    router.refresh();
  }

  return (
    <Disclosure
      open={open}
      onToggle={setOpen}
      openLabel={t('transport.addStop')}
      closeLabel={t('action.cancel')}
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('transport.stopName')} error={fieldErrors.name} required>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              invalid={Boolean(fieldErrors.name)}
            />
          </Field>
          <Field label={t('transport.sortOrder')} error={fieldErrors.sortOrder}>
            <TextInput
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
            />
          </Field>
          <Field label={t('transport.pickupTime')} error={fieldErrors.pickupTime}>
            <TextInput
              type="time"
              value={pickupTime}
              onChange={(e) => setPickupTime(e.target.value)}
              invalid={Boolean(fieldErrors.pickupTime)}
            />
          </Field>
          <Field label={t('transport.dropoffTime')} error={fieldErrors.dropoffTime}>
            <TextInput
              type="time"
              value={dropoffTime}
              onChange={(e) => setDropoffTime(e.target.value)}
              invalid={Boolean(fieldErrors.dropoffTime)}
            />
          </Field>
          <Field
            label={t('transport.landmark')}
            error={fieldErrors.landmark}
            className="sm:col-span-2"
          >
            <TextInput
              value={landmark}
              onChange={(e) => setLandmark(e.target.value)}
              maxLength={200}
            />
          </Field>
        </div>

        <ErrorBanner message={error} />
        {!error && <SuccessBanner message={success} />}

        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={name.trim().length === 0}
        >
          {t('transport.addStop')}
        </SubmitButton>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

function AssignForm({
  labels,
  t,
  routeId,
  routeName,
  stops,
  seatsLeft,
  today,
}: {
  labels: Labels;
  t: (k: string) => string;
  routeId: string;
  routeName: string;
  stops: Stop[];
  seatsLeft: number | null;
  today: string;
}) {
  const router = useRouter();
  const { saving, error, fieldErrors, submit } = useSubmit();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Student[]>([]);
  const [student, setStudent] = useState<Student | null>(null);
  const [pickupStopId, setPickupStopId] = useState('');
  const [dropoffStopId, setDropoffStopId] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [note, setNote] = useState('');
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (student) return;
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/students?search=${encodeURIComponent(term)}&pageSize=8&status=active`,
          { signal: controller.signal },
        );
        if (res.ok) {
          const body = await res.json();
          setResults(body.data ?? []);
        }
      } catch {
        /* aborted */
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, student]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!student) return;
    setSuccess(null);

    const result = await submit('/api/transport/assignments', {
      method: 'POST',
      body: {
        studentId: student.id,
        routeId,
        pickupStopId: pickupStopId || null,
        dropoffStopId: dropoffStopId || null,
        startDate,
        note: note.trim() || null,
      },
    });
    if (!result) return;

    const name = [student.givenName, student.fatherName].filter(Boolean).join(' ');
    setSuccess(fill(labels['transport.assigned'] ?? '', { name, route: routeName }));
    setStudent(null);
    setQuery('');
    setNote('');
    router.refresh();
  }

  const full = seatsLeft !== null && seatsLeft <= 0;

  return (
    <Disclosure
      open={open}
      onToggle={setOpen}
      openLabel={t('transport.assignStudent')}
      closeLabel={t('action.cancel')}
    >
      <form onSubmit={save} className="space-y-4">
        {full && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
            {t('transport.full')}
          </p>
        )}

        {student ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink-900">
                {[student.givenName, student.fatherName, student.grandfatherName]
                  .filter(Boolean)
                  .join(' ')}
              </span>
              <span className="block font-mono text-xs text-ink-500">{student.studentCode}</span>
            </span>
            <button
              type="button"
              onClick={() => setStudent(null)}
              className="shrink-0 text-xs font-semibold text-brand-700 underline"
            >
              {t('ops.change')}
            </button>
          </div>
        ) : (
          <Field label={t('academics.students')} error={fieldErrors.studentId}>
            <TextInput
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('ops.searchStudent')}
              invalid={Boolean(fieldErrors.studentId)}
            />
            {results.length > 0 && (
              <ul className="mt-2 max-h-56 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
                {results.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setStudent(row)}
                      className="tap-target flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-ink-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink-900">
                          {[row.givenName, row.fatherName, row.grandfatherName]
                            .filter(Boolean)
                            .join(' ')}
                        </span>
                        <span className="block font-mono text-xs text-ink-500">
                          {row.studentCode}
                        </span>
                      </span>
                      <span aria-hidden className="text-ink-400">
                        →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('transport.pickupStop')} error={fieldErrors.pickupStopId}>
            <Select value={pickupStopId} onChange={(e) => setPickupStopId(e.target.value)}>
              <option value="">{t('ops.none')}</option>
              {stops.map((stop) => (
                <option key={stop.id} value={stop.id}>
                  {stop.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('transport.dropoffStop')} error={fieldErrors.dropoffStopId}>
            <Select value={dropoffStopId} onChange={(e) => setDropoffStopId(e.target.value)}>
              <option value="">{t('ops.none')}</option>
              {stops.map((stop) => (
                <option key={stop.id} value={stop.id}>
                  {stop.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('transport.startDate')} error={fieldErrors.startDate} required>
            <TextInput
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
              invalid={Boolean(fieldErrors.startDate)}
            />
          </Field>

          <Field label={t('asset.note')} error={fieldErrors.note}>
            <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
        </div>

        <ErrorBanner message={error} />
        {!error && <SuccessBanner message={success} />}

        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={!student}
        >
          {t('transport.assignStudent')}
        </SubmitButton>
      </form>
    </Disclosure>
  );
}

function EndAssignment({
  labels,
  t,
  assignmentId,
  today,
}: {
  labels: Labels;
  t: (k: string) => string;
  assignmentId: string;
  today: string;
}) {
  const router = useRouter();
  const { saving, error, submit } = useSubmit();

  async function end() {
    const result = await submit(`/api/transport/assignments/${assignmentId}`, {
      method: 'DELETE',
      body: { endDate: today },
    });
    if (!result) return;
    router.refresh();
  }

  return (
    <div>
      <ConfirmButton
        label={t('transport.endAssignment')}
        confirmLabel={t('transport.endAssignment')}
        question={t('transport.confirmEnd')}
        cancelLabel={t('action.cancel')}
        onConfirm={() => void end()}
        saving={saving}
        savingLabel={labels['ops.saving'] ?? '…'}
      />
      <ErrorBanner message={error} />
    </div>
  );
}
