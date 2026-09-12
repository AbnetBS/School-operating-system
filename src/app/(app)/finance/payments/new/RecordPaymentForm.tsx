'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, Badge, EmptyState } from '../../../../../components/ui.tsx';

type Student = {
  id: string;
  givenName: string;
  fatherName: string;
  grandfatherName: string | null;
  studentCode: string;
};

type Charge = {
  id: string;
  description: string;
  descriptionAm: string | null;
  categoryName: string | null;
  termName: string | null;
  amountCents: number;
  discountCents: number;
  netAmountCents: number;
  paidCents: number;
  outstandingCents: number;
  dueDate: string | null;
  status: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
};

type Balance = {
  netCents: number;
  paidCents: number;
  outstandingCents: number;
  chargeCount: number;
};

type Receipt = {
  id: string;
  receiptNumber: string;
  amountCents: number;
  duplicate: boolean;
  balanceAfterCents: number;
  unallocatedCents: number;
};

type Labels = Record<string, string>;

/** Format cents for display without importing the server-side money helpers. */
function money(valueCents: number, currency: string): string {
  const sign = valueCents < 0 ? '-' : '';
  const abs = Math.abs(valueCents);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  return `${sign}${currency} ${major.toLocaleString('en-US')}.${minor}`;
}

/**
 * Parse a typed amount into whole cents.
 *
 * Deliberately strict and never floating point: `12.5` is 1250 cents, `12.567`
 * is refused rather than silently rounded, because a clerk who mistypes an
 * amount should be told, not corrected.
 */
function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export default function RecordPaymentForm({
  methods,
  currency,
  allowPartial,
  allowOverpayment,
  labels,
  today,
  initialStudent,
}: {
  methods: string[];
  currency: string;
  allowPartial: boolean;
  allowOverpayment: boolean;
  labels: Labels;
  today: string;
  initialStudent: Student | null;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Student[]>([]);
  const [searching, setSearching] = useState(false);
  const [student, setStudent] = useState<Student | null>(initialStudent);

  const [charges, setCharges] = useState<Charge[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [loadingCharges, setLoadingCharges] = useState(false);

  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(methods[0] ?? 'cash');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  /**
   * One key per attempt at a distinct payment.
   *
   * Held in a ref so a re-render cannot change it: if the button is
   * double-tapped, or the network retries, the second request carries the same
   * key and the server returns the original receipt instead of taking the
   * money twice. It is regenerated only once a payment has succeeded.
   */
  const clientKey = useRef<string>(crypto.randomUUID());

  // --- student search -------------------------------------------------------
  useEffect(() => {
    if (student) return;
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/students?search=${encodeURIComponent(term)}&pageSize=10&status=active`,
          { signal: controller.signal },
        );
        if (res.ok) {
          const data = await res.json();
          setResults(data.items ?? data.students ?? []);
        }
      } catch {
        // An aborted keystroke is not an error worth showing.
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, student]);

  // --- charges for the chosen student --------------------------------------
  const loadCharges = useCallback(async (studentId: string) => {
    setLoadingCharges(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/charges?studentId=${encodeURIComponent(studentId)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Could not load this account.');
        setCharges([]);
        setBalance(null);
        return;
      }
      const data = await res.json();
      setCharges(data.charges ?? []);
      setBalance(data.balance ?? null);
    } finally {
      setLoadingCharges(false);
    }
  }, []);

  useEffect(() => {
    if (student) void loadCharges(student.id);
  }, [student, loadCharges]);

  const unpaid = useMemo(
    () => charges.filter((c) => c.status === 'active' && c.outstandingCents > 0),
    [charges],
  );

  // What the selection implies, so the clerk can see the sum before saving.
  const selectedTotal = useMemo(
    () =>
      unpaid
        .filter((c) => selected.includes(c.id))
        .reduce((sum, c) => sum + c.outstandingCents, 0),
    [unpaid, selected],
  );

  const enteredCents = parseAmount(amount);
  const outstanding = balance?.outstandingCents ?? 0;
  const targetTotal = selected.length > 0 ? selectedTotal : outstanding;

  const overpaying = enteredCents !== null && enteredCents > targetTotal;
  const underpaying = enteredCents !== null && enteredCents < targetTotal;

  function reset() {
    setStudent(null);
    setQuery('');
    setResults([]);
    setCharges([]);
    setBalance(null);
    setSelected([]);
    setAmount('');
    setReference('');
    setNotes('');
    setFieldErrors({});
    setError(null);
    clientKey.current = crypto.randomUUID();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !student) return;

    const cents = parseAmount(amount);
    if (cents === null || cents <= 0) {
      setFieldErrors({ amountCents: 'Enter an amount such as 250 or 250.50.' });
      return;
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const res = await fetch('/api/finance/payments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          studentId: student.id,
          amountCents: cents,
          method,
          referenceNumber: reference.trim() || null,
          paidOn,
          notes: notes.trim() || null,
          chargeIds: selected.length > 0 ? selected : undefined,
          clientKey: clientKey.current,
        }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body.error ?? 'The payment was not recorded.');
        if (body.fields) setFieldErrors(body.fields);
        return;
      }

      setReceipt(body as Receipt);
      // A new key, so the next payment for this family is not mistaken for a
      // replay of this one.
      clientKey.current = crypto.randomUUID();
    } catch {
      setError('The payment could not be sent. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  // --- confirmation ---------------------------------------------------------
  if (receipt) {
    return (
      <Card>
        <div className="text-center">
          <p className="text-sm font-medium text-emerald-700">
            {receipt.duplicate ? t('finance.duplicateIgnored') : t('finance.paymentSaved')}
          </p>
          <p className="mt-2 text-3xl font-bold tabular-nums text-ink-900">
            {money(receipt.amountCents, currency)}
          </p>
          <p className="mt-1 text-sm text-ink-500">
            {t('finance.receiptNumber')}: <span className="font-mono">{receipt.receiptNumber}</span>
          </p>
          <p className="mt-1 text-sm text-ink-600">
            {t('finance.balance')}: {money(receipt.balanceAfterCents, currency)}
          </p>
          {receipt.unallocatedCents > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              {money(receipt.unallocatedCents, currency)} held as credit.
            </p>
          )}

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Link
              href={`/finance/payments/${receipt.id}`}
              className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              {t('finance.printReceipt')}
            </Link>
            <button
              type="button"
              onClick={() => {
                setReceipt(null);
                reset();
              }}
              className="tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              {t('finance.recordPayment')}
            </button>
          </div>
        </div>
      </Card>
    );
  }

  // --- student picker -------------------------------------------------------
  if (!student) {
    return (
      <Card title={t('finance.selectStudent')}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('finance.searchStudent')}
          autoFocus
          className="tap-target w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
        />
        {searching && <p className="mt-3 text-xs text-ink-500">…</p>}
        {!searching && query.trim().length >= 2 && results.length === 0 && (
          <p className="mt-3 text-sm text-ink-500">No match.</p>
        )}
        <ul className="mt-3 divide-y divide-ink-100">
          {results.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setStudent(s)}
                className="tap-target flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-ink-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink-900">
                    {s.givenName} {s.fatherName} {s.grandfatherName ?? ''}
                  </span>
                  <span className="block text-xs text-ink-500">{s.studentCode}</span>
                </span>
                <span aria-hidden className="text-ink-400">
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  // --- the form -------------------------------------------------------------
  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-900">
              {student.givenName} {student.fatherName} {student.grandfatherName ?? ''}
            </p>
            <p className="text-xs text-ink-500">{student.studentCode}</p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="text-xs font-medium text-brand-700 underline"
          >
            {t('finance.selectStudent')}
          </button>
        </div>

        {balance && (
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-ink-50 p-2">
              <dt className="text-xs text-ink-500">{t('finance.charged')}</dt>
              <dd className="text-sm font-semibold tabular-nums">{money(balance.netCents, currency)}</dd>
            </div>
            <div className="rounded-lg bg-emerald-50 p-2">
              <dt className="text-xs text-ink-500">{t('finance.paid')}</dt>
              <dd className="text-sm font-semibold tabular-nums text-emerald-700">
                {money(balance.paidCents, currency)}
              </dd>
            </div>
            <div className="rounded-lg bg-amber-50 p-2">
              <dt className="text-xs text-ink-500">{t('finance.outstanding')}</dt>
              <dd className="text-sm font-semibold tabular-nums text-amber-800">
                {money(balance.outstandingCents, currency)}
              </dd>
            </div>
          </dl>
        )}
      </Card>

      <Card title={t('finance.charges')}>
        {loadingCharges ? (
          <p className="text-sm text-ink-500">…</p>
        ) : unpaid.length === 0 ? (
          <EmptyState title={t('finance.nothingOwed')} />
        ) : (
          <>
            <p className="mb-3 text-xs text-ink-500">{t('finance.allocateHint')}</p>
            <ul className="divide-y divide-ink-100">
              {unpaid.map((c) => {
                const checked = selected.includes(c.id);
                return (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                          )
                        }
                        className="size-5 shrink-0 rounded border-ink-300"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink-900">
                          {c.description}
                          {c.installmentTotal && c.installmentTotal > 1
                            ? ` (${c.installmentNumber}/${c.installmentTotal})`
                            : ''}
                        </span>
                        <span className="block text-xs text-ink-500">
                          {[c.categoryName, c.termName, c.dueDate].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-medium tabular-nums text-ink-800">
                        {money(c.outstandingCents, currency)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {selected.length > 0 && (
              <p className="mt-3 flex items-center justify-between border-t border-ink-200 pt-3 text-sm">
                <span className="text-ink-600">{selected.length} selected</span>
                <span className="font-semibold tabular-nums">{money(selectedTotal, currency)}</span>
              </p>
            )}
          </>
        )}
      </Card>

      <Card title={t('finance.recordPayment')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="amount" className="block text-sm font-medium text-ink-700">
              {t('finance.amountReceived')}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-sm text-ink-500">{currency}</span>
              <input
                id="amount"
                name="amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                className="tap-target w-full rounded-lg border border-ink-300 px-3 py-2.5 text-lg font-semibold tabular-nums"
              />
              {targetTotal > 0 && (
                <button
                  type="button"
                  onClick={() => setAmount((targetTotal / 100).toFixed(2))}
                  className="shrink-0 rounded-lg border border-ink-300 px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
                >
                  {money(targetTotal, currency)}
                </button>
              )}
            </div>
            {fieldErrors.amountCents && (
              <p className="mt-1 text-xs text-red-700">{fieldErrors.amountCents}</p>
            )}
            {overpaying && !allowOverpayment && (
              <p className="mt-1 text-xs text-red-700">
                That is more than is owed, and this school does not accept overpayment.
              </p>
            )}
            {overpaying && allowOverpayment && (
              <p className="mt-1 text-xs text-amber-700">
                {money(enteredCents - targetTotal, currency)} will be held as credit.
              </p>
            )}
            {underpaying && !allowPartial && (
              <p className="mt-1 text-xs text-red-700">
                This school does not accept part payment.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="method" className="block text-sm font-medium text-ink-700">
              {t('finance.method')}
            </label>
            <select
              id="method"
              name="method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
            >
              {methods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {fieldErrors.method && <p className="mt-1 text-xs text-red-700">{fieldErrors.method}</p>}
          </div>

          <div>
            <label htmlFor="paidOn" className="block text-sm font-medium text-ink-700">
              {t('finance.paidOn')}
            </label>
            <input
              id="paidOn"
              name="paidOn"
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
              required
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
            />
            {fieldErrors.paidOn && <p className="mt-1 text-xs text-red-700">{fieldErrors.paidOn}</p>}
          </div>

          <div>
            <label htmlFor="reference" className="block text-sm font-medium text-ink-700">
              {t('finance.reference')}
            </label>
            <input
              id="reference"
              name="reference"
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Transaction or slip number"
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
            />
          </div>

          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-ink-700">
              {t('finance.notes')}
            </label>
            <input
              id="notes"
              name="notes"
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <Badge tone="neutral">{outstanding > 0 ? money(outstanding, currency) : t('finance.nothingOwed')}</Badge>
          <button
            type="submit"
            disabled={saving || !amount}
            className="tap-target rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? '…' : t('finance.recordPayment')}
          </button>
        </div>
      </Card>
    </form>
  );
}
