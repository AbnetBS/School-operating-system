'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../../components/ui.tsx';

type Fee = {
  id: string;
  name: string;
  nameAm: string | null;
  description: string | null;
  amountCents: number;
  billingPeriod: string;
  appliesTo: string;
  gradeLevelIds: unknown;
  sectionIds: unknown;
  isOptional: boolean;
  installmentCount: number;
  dueDate: string | null;
  isActive: boolean;
  academicYearId: string;
  categoryId: string | null;
  categoryName: string | null;
  chargeCount: number;
};

type Category = { id: string; key: string; name: string; nameAm: string | null; isActive: boolean };
type Year = { id: string; name: string; isCurrent: boolean };
type Term = { id: string; name: string; academicYearId: string };
type Grade = { id: string; name: string };
type Section = { id: string; name: string; gradeLevelId: string };

function money(valueCents: number, currency: string): string {
  const abs = Math.abs(valueCents);
  return `${currency} ${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** Strict decimal → cents. Refuses anything it cannot represent exactly. */
function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

export default function FeeManager({
  fees,
  categories,
  years,
  terms,
  grades,
  sections,
  canManage,
  currency,
  labels,
}: {
  fees: Fee[];
  categories: Category[];
  years: Year[];
  terms: Term[];
  grades: Grade[];
  sections: Section[];
  canManage: boolean;
  currency: string;
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const t = useCallback((k: string) => labels[k] ?? k, [labels]);

  const currentYear = years.find((y) => y.isCurrent) ?? years[0];
  const [editing, setEditing] = useState<Fee | null>(null);
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState<Fee | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const activeCategories = useMemo(() => categories.filter((c) => c.isActive), [categories]);

  return (
    <div className="space-y-4">
      {banner && (
        <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{banner}</p>
      )}

      {canManage && !creating && !editing && !applying && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('finance.newFee')}
        </button>
      )}

      {(creating || editing) && (
        <FeeForm
          fee={editing}
          categories={activeCategories}
          years={years}
          grades={grades}
          sections={sections}
          currency={currency}
          labels={labels}
          defaultYearId={currentYear?.id ?? ''}
          onDone={(message) => {
            setCreating(false);
            setEditing(null);
            setBanner(message);
            router.refresh();
          }}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {applying && (
        <ApplyForm
          fee={applying}
          terms={terms.filter((term) => term.academicYearId === applying.academicYearId)}
          labels={labels}
          onDone={(message) => {
            setApplying(null);
            setBanner(message);
            router.refresh();
          }}
          onCancel={() => setApplying(null)}
        />
      )}

      <Card title={t('finance.fees')}>
        {fees.length === 0 ? (
          <EmptyState title={t('finance.noFees')} description={t('finance.noFeesHelp')} />
        ) : (
          <>
            {/* Mobile list */}
            <ul className="divide-y divide-ink-100 sm:hidden">
              {fees.map((fee) => (
                <li key={fee.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">{fee.name}</p>
                      <p className="text-xs text-ink-500">
                        {[fee.categoryName, t(`finance.billingPeriod.${fee.billingPeriod}`)]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {t(`finance.appliesTo.${fee.appliesTo}`)} ·{' '}
                        {t('finance.studentsCount').replace('{count}', String(fee.chargeCount))}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums">{money(fee.amountCents, currency)}</p>
                      {!fee.isActive && <Badge tone="neutral">—</Badge>}
                    </div>
                  </div>
                  {canManage && (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(fee)}
                        className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium"
                      >
                        {t('finance.editFee')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setApplying(fee)}
                        className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        {t('finance.applyFee')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {/* Desktop table */}
            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('finance.fees')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.category')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.appliesTo')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.billingPeriod')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('finance.amount')}</th>
                    <th className="px-4 py-2 text-right font-medium">#</th>
                    {canManage && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {fees.map((fee) => (
                    <tr key={fee.id} className={fee.isActive ? '' : 'opacity-60'}>
                      <td className="px-4 py-2">
                        <span className="font-medium text-ink-900">{fee.name}</span>
                        {fee.isOptional && (
                          <span className="ml-2">
                            <Badge tone="info">{t('finance.optional')}</Badge>
                          </span>
                        )}
                        {fee.installmentCount > 1 && (
                          <span className="block text-xs text-ink-500">
                            {fee.installmentCount} × {money(Math.floor(fee.amountCents / fee.installmentCount), currency)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-ink-700">{fee.categoryName ?? '—'}</td>
                      <td className="px-4 py-2 text-ink-700">{t(`finance.appliesTo.${fee.appliesTo}`)}</td>
                      <td className="px-4 py-2 text-ink-700">{t(`finance.billingPeriod.${fee.billingPeriod}`)}</td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {money(fee.amountCents, currency)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink-600">{fee.chargeCount}</td>
                      {canManage && (
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setEditing(fee)}
                            className="text-xs font-medium text-brand-700 hover:underline"
                          >
                            {t('finance.editFee')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setApplying(fee)}
                            className="ml-3 text-xs font-medium text-brand-700 hover:underline"
                          >
                            {t('finance.applyFee')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card title={t('finance.categories')}>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <Badge key={c.id} tone={c.isActive ? 'info' : 'neutral'}>
              {c.name}
            </Badge>
          ))}
          {categories.length === 0 && <p className="text-sm text-ink-500">—</p>}
        </div>
        {canManage && (
          <CategoryForm
            labels={labels}
            onDone={(message) => {
              setBanner(message);
              router.refresh();
            }}
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FeeForm({
  fee,
  categories,
  years,
  grades,
  sections,
  currency,
  labels,
  defaultYearId,
  onDone,
  onCancel,
}: {
  fee: Fee | null;
  categories: Category[];
  years: Year[];
  grades: Grade[];
  sections: Section[];
  currency: string;
  labels: Record<string, string>;
  defaultYearId: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const t = useCallback((k: string) => labels[k] ?? k, [labels]);

  const [name, setName] = useState(fee?.name ?? '');
  const [nameAm, setNameAm] = useState(fee?.nameAm ?? '');
  const [categoryId, setCategoryId] = useState(fee?.categoryId ?? '');
  const [academicYearId, setAcademicYearId] = useState(fee?.academicYearId ?? defaultYearId);
  const [amount, setAmount] = useState(fee ? (fee.amountCents / 100).toFixed(2) : '');
  const [billingPeriod, setBillingPeriod] = useState(fee?.billingPeriod ?? 'term');
  const [appliesTo, setAppliesTo] = useState(fee?.appliesTo ?? 'all');
  const [gradeLevelIds, setGradeLevelIds] = useState<string[]>(idList(fee?.gradeLevelIds));
  const [sectionIds, setSectionIds] = useState<string[]>(idList(fee?.sectionIds));
  const [isOptional, setIsOptional] = useState(fee?.isOptional ?? false);
  const [installmentCount, setInstallmentCount] = useState(String(fee?.installmentCount ?? 1));
  const [dueDate, setDueDate] = useState(fee?.dueDate ?? '');
  const [isActive, setIsActive] = useState(fee?.isActive ?? true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const cents = parseAmount(amount);
    if (cents === null) {
      setFieldErrors({ amountCents: 'Enter an amount such as 1500 or 1500.50.' });
      return;
    }

    setBusy(true);
    setError(null);
    setFieldErrors({});

    const body = {
      academicYearId,
      categoryId: categoryId || null,
      name,
      nameAm: nameAm.trim() || null,
      amountCents: cents,
      billingPeriod,
      appliesTo,
      gradeLevelIds: appliesTo === 'grade' ? gradeLevelIds : [],
      sectionIds: appliesTo === 'section' ? sectionIds : [],
      isOptional,
      installmentCount: Number(installmentCount) || 1,
      dueDate: dueDate || null,
      isActive,
    };

    try {
      const res = await fetch(fee ? `/api/finance/fees/${fee.id}` : '/api/finance/fees', {
        method: fee ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'The fee could not be saved.');
        if (data.fields) setFieldErrors(data.fields);
        return;
      }
      onDone(fee ? 'Saved.' : 'Created.');
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={fee ? t('finance.editFee') : t('finance.newFee')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="feeName" className="block text-sm font-medium text-ink-700">
            {t('finance.fee')}
          </label>
          <input
            id="feeName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          />
          {fieldErrors.name && <p className="mt-1 text-xs text-red-700">{fieldErrors.name}</p>}
        </div>

        <div>
          <label htmlFor="feeNameAm" className="block text-sm font-medium text-ink-700">
            አማርኛ
          </label>
          <input
            id="feeNameAm"
            value={nameAm}
            onChange={(e) => setNameAm(e.target.value)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          />
        </div>

        <div>
          <label htmlFor="feeCategory" className="block text-sm font-medium text-ink-700">
            {t('finance.category')}
          </label>
          <select
            id="feeCategory"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="feeYear" className="block text-sm font-medium text-ink-700">
            Academic year
          </label>
          <select
            id="feeYear"
            value={academicYearId}
            onChange={(e) => setAcademicYearId(e.target.value)}
            required
            disabled={Boolean(fee)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base disabled:bg-ink-50"
          >
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="feeAmount" className="block text-sm font-medium text-ink-700">
            {t('finance.amount')} ({currency})
          </label>
          <input
            id="feeAmount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base tabular-nums"
          />
          {fieldErrors.amountCents && (
            <p className="mt-1 text-xs text-red-700">{fieldErrors.amountCents}</p>
          )}
        </div>

        <div>
          <label htmlFor="feePeriod" className="block text-sm font-medium text-ink-700">
            {t('finance.billingPeriod')}
          </label>
          <select
            id="feePeriod"
            value={billingPeriod}
            onChange={(e) => setBillingPeriod(e.target.value)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          >
            {['once', 'term', 'month', 'custom'].map((p) => (
              <option key={p} value={p}>
                {t(`finance.billingPeriod.${p}`)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="feeApplies" className="block text-sm font-medium text-ink-700">
            {t('finance.appliesTo')}
          </label>
          <select
            id="feeApplies"
            value={appliesTo}
            onChange={(e) => setAppliesTo(e.target.value)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          >
            {['all', 'grade', 'section', 'individual'].map((a) => (
              <option key={a} value={a}>
                {t(`finance.appliesTo.${a}`)}
              </option>
            ))}
          </select>
        </div>

        {appliesTo === 'grade' && (
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-medium text-ink-700">{t('finance.appliesTo.grade')}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {grades.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5 rounded-lg border border-ink-300 px-3 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={gradeLevelIds.includes(g.id)}
                    onChange={(e) =>
                      setGradeLevelIds((prev) =>
                        e.target.checked ? [...prev, g.id] : prev.filter((x) => x !== g.id),
                      )
                    }
                    className="size-4"
                  />
                  {g.name}
                </label>
              ))}
            </div>
            {fieldErrors.gradeLevelIds && (
              <p className="mt-1 text-xs text-red-700">{fieldErrors.gradeLevelIds}</p>
            )}
          </fieldset>
        )}

        {appliesTo === 'section' && (
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-medium text-ink-700">{t('finance.appliesTo.section')}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {sections.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 rounded-lg border border-ink-300 px-3 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={sectionIds.includes(s.id)}
                    onChange={(e) =>
                      setSectionIds((prev) =>
                        e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                      )
                    }
                    className="size-4"
                  />
                  {s.name}
                </label>
              ))}
            </div>
            {fieldErrors.sectionIds && (
              <p className="mt-1 text-xs text-red-700">{fieldErrors.sectionIds}</p>
            )}
          </fieldset>
        )}

        <div>
          <label htmlFor="feeInstallments" className="block text-sm font-medium text-ink-700">
            {t('finance.installments')}
          </label>
          <input
            id="feeInstallments"
            type="number"
            min={1}
            max={12}
            value={installmentCount}
            onChange={(e) => setInstallmentCount(e.target.value)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          />
        </div>

        <div>
          <label htmlFor="feeDue" className="block text-sm font-medium text-ink-700">
            {t('finance.dueDate')}
          </label>
          <input
            id="feeDue"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          />
        </div>

        <div className="flex items-center gap-4 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isOptional}
              onChange={(e) => setIsOptional(e.target.checked)}
              className="size-4"
            />
            {t('finance.optional')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="size-4"
            />
            {t('finance.active')}
          </label>
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 sm:col-span-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="tap-target rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? '…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="tap-target rounded-lg border border-ink-300 px-4 py-2.5 text-sm font-medium text-ink-700"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ApplyForm({
  fee,
  terms,
  labels,
  onDone,
  onCancel,
}: {
  fee: Fee;
  terms: Term[];
  labels: Record<string, string>;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const t = useCallback((k: string) => labels[k] ?? k, [labels]);
  const [termId, setTermId] = useState(terms[0]?.id ?? '');
  const [dueDate, setDueDate] = useState(fee.dueDate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsTerm = fee.billingPeriod === 'term';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/fees/${fee.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          feeStructureId: fee.id,
          termId: needsTerm ? termId || null : null,
          dueDate: dueDate || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'The fee could not be applied.');
        return;
      }
      onDone(
        `${t('finance.applied')}: ${data.created} created, ${data.skipped} already charged.`,
      );
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`${t('finance.applyFee')} — ${fee.name}`}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <p className="text-xs text-ink-500 sm:col-span-2">
          Charges already raised for this fee are skipped, so applying twice is safe.
        </p>

        {needsTerm && (
          <div>
            <label htmlFor="applyTerm" className="block text-sm font-medium text-ink-700">
              Term
            </label>
            <select
              id="applyTerm"
              value={termId}
              onChange={(e) => setTermId(e.target.value)}
              required
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
            >
              {terms.map((term) => (
                <option key={term.id} value={term.id}>
                  {term.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="applyDue" className="block text-sm font-medium text-ink-700">
            {t('finance.dueDate')}
          </label>
          <input
            id="applyDue"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base"
          />
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 sm:col-span-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="tap-target rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? '…' : t('finance.applyFee')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="tap-target rounded-lg border border-ink-300 px-4 py-2.5 text-sm font-medium text-ink-700"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CategoryForm({
  labels,
  onDone,
}: {
  labels: Record<string, string>;
  onDone: (message: string) => void;
}) {
  const t = useCallback((k: string) => labels[k] ?? k, [labels]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameAm, setNameAm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/finance/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, nameAm: nameAm.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'The category could not be created.');
        return;
      }
      setName('');
      setNameAm('');
      setOpen(false);
      onDone('Category created.');
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-xs font-medium text-brand-700 hover:underline"
      >
        + {t('finance.newCategory')}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="catName" className="block text-xs font-medium text-ink-600">
          {t('finance.newCategory')}
        </label>
        <input
          id="catName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
          className="tap-target mt-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label htmlFor="catNameAm" className="block text-xs font-medium text-ink-600">
          አማርኛ
        </label>
        <input
          id="catNameAm"
          value={nameAm}
          onChange={(e) => setNameAm(e.target.value)}
          className="tap-target mt-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? '…' : 'Add'}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-sm"
      >
        Cancel
      </button>
      {error && <p className="w-full text-xs text-red-700">{error}</p>}
    </form>
  );
}
