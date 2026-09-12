'use client';

/**
 * Stock operations.
 *
 * The three things a storekeeper does all day are stock in, stock out, and
 * correcting a count after a stock take — so those are three buttons on each
 * row, not a form hidden behind a menu.
 *
 * The browser NEVER computes a new quantity. It sends a movement type and a
 * positive magnitude; the server decides the sign, applies it under a row
 * lock, and returns the resulting balance, which is what gets displayed. That
 * is the whole reason the quantity shown after a save is trustworthy — see
 * `recordMovement` in `src/lib/operations/inventory.ts`.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  CheckboxRow,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  Disclosure,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;

type Item = {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit: string;
  quantity: number;
  reorderLevel: number;
  location: string | null;
  unitCostCents: number | null;
  active: boolean;
  isLow: boolean;
};

type Movement = {
  id: string;
  movementType: string;
  delta: number;
  balanceAfter: number;
  reference: string | null;
  note: string | null;
  movedOn: string;
  recordedByName: string | null;
};

type Draft = {
  name: string;
  sku: string;
  category: string;
  unit: string;
  reorderLevel: string;
  location: string;
  unitCost: string;
  active: boolean;
};

const EMPTY: Draft = {
  name: '',
  sku: '',
  category: '',
  unit: 'piece',
  reorderLevel: '0',
  location: '',
  unitCost: '',
  active: true,
};

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Parse a typed major-unit price into whole cents, strictly. */
function parseCost(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export default function StockManager({
  labels,
  items,
  today,
  canManage,
}: {
  labels: Labels;
  items: Item[];
  today: string;
  canManage: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);

  return (
    <Card title={t('inventory.title')}>
      {canManage && (
        <Disclosure
          open={creating}
          onToggle={(next) => {
            setCreating(next);
            setEditingId(null);
          }}
          openLabel={t('inventory.newItem')}
          closeLabel={t('action.cancel')}
        >
          <ItemForm
            labels={labels}
            t={t}
            initial={EMPTY}
            onDone={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        </Disclosure>
      )}

      {items.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={t('inventory.noItems')} />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {items.map((item) => (
            <li key={item.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">
                    {item.name}
                    {!item.active && (
                      <span className="ml-2">
                        <Badge tone="neutral">{t('library.inactive')}</Badge>
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {[item.sku, item.location].filter(Boolean).join(' · ') || '—'}
                    {item.reorderLevel > 0 &&
                      ` · ${t('inventory.reorderLevel')} ${item.reorderLevel}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={item.isLow ? 'warn' : 'neutral'}>
                    {item.quantity} {item.unit}
                  </Badge>
                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setMovingId(movingId === item.id ? null : item.id);
                          setEditingId(null);
                          setHistoryId(null);
                        }}
                        className="tap-target rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
                      >
                        {t('inventory.recordMovement')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(editingId === item.id ? null : item.id);
                          setMovingId(null);
                          setHistoryId(null);
                        }}
                        className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                      >
                        {t('action.edit')}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setHistoryId(historyId === item.id ? null : item.id);
                      setMovingId(null);
                      setEditingId(null);
                    }}
                    className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                  >
                    {t('inventory.viewMovements')}
                  </button>
                </div>
              </div>

              {movingId === item.id && (
                <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                  <MovementForm
                    labels={labels}
                    t={t}
                    item={item}
                    today={today}
                    onDone={() => router.refresh()}
                  />
                </div>
              )}

              {editingId === item.id && (
                <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                  <ItemForm
                    labels={labels}
                    t={t}
                    itemId={item.id}
                    initial={{
                      name: item.name,
                      sku: item.sku ?? '',
                      category: item.category ?? '',
                      unit: item.unit,
                      reorderLevel: String(item.reorderLevel),
                      location: item.location ?? '',
                      unitCost:
                        item.unitCostCents === null
                          ? ''
                          : (item.unitCostCents / 100).toFixed(2),
                      active: item.active,
                    }}
                    onDone={() => {
                      setEditingId(null);
                      router.refresh();
                    }}
                  />
                </div>
              )}

              {historyId === item.id && (
                <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                  <MovementHistory labels={labels} t={t} itemId={item.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

function MovementForm({
  labels,
  t,
  item,
  today,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  item: Item;
  today: string;
  onDone: () => void;
}) {
  const { saving, error, fieldErrors, submit } = useSubmit();

  const [movementType, setMovementType] = useState<'receipt' | 'issue' | 'adjustment' | 'loss'>(
    'receipt',
  );
  const [quantity, setQuantity] = useState('');
  const [movedOn, setMovedOn] = useState(today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  // A correction is an assertion about reality; the server refuses it without
  // a reason, so the form says so before the round trip.
  const needsReason = movementType === 'adjustment' || movementType === 'loss';
  const hasReason = Boolean(reference.trim() || note.trim());

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);

    const result = await submit<{ balanceAfter: number; delta: number }>(
      `/api/inventory/items/${item.id}/movements`,
      {
        method: 'POST',
        body: {
          movementType,
          // A positive magnitude only. For an adjustment this is the corrected
          // count; the server works out the signed difference itself.
          quantity: Number(quantity) || 0,
          movedOn,
          reference: orNull(reference),
          note: orNull(note),
        },
      },
    );
    if (!result) return;

    setBalance(result.balanceAfter);
    setSuccess(
      fill(labels['inventory.movementSaved'] ?? '', {
        name: item.name,
        quantity: String(result.balanceAfter),
        unit: item.unit,
      }),
    );
    setQuantity('');
    setReference('');
    setNote('');
    onDone();
  }

  const TYPE_LABEL: Record<string, string> = {
    receipt: t('inventory.stockIn'),
    issue: t('inventory.stockOut'),
    adjustment: t('inventory.adjust'),
    loss: t('inventory.movementType.loss'),
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(['receipt', 'issue', 'adjustment', 'loss'] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setMovementType(type)}
            aria-pressed={movementType === type}
            className={`tap-target rounded-lg border px-3 py-2 text-sm font-medium transition ${
              movementType === type
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-50'
            }`}
          >
            {TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={movementType === 'adjustment' ? t('inventory.adjustTo') : t('inventory.quantity')}
          hint={
            movementType === 'adjustment'
              ? t('inventory.adjustToHelp')
              : `${t('inventory.currentQuantity')}: ${item.quantity} ${item.unit}`
          }
          error={fieldErrors.quantity}
          required
        >
          <TextInput
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            required
            autoFocus
            invalid={Boolean(fieldErrors.quantity)}
          />
        </Field>

        <Field label={t('inventory.movedOn')} error={fieldErrors.movedOn} required>
          <TextInput
            type="date"
            value={movedOn}
            onChange={(e) => setMovedOn(e.target.value)}
            required
            invalid={Boolean(fieldErrors.movedOn)}
          />
        </Field>

        <Field
          label={needsReason ? t('inventory.reason') : t('inventory.reference')}
          error={fieldErrors.reference}
          required={needsReason}
          className="sm:col-span-2"
        >
          <TextInput
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={200}
            required={needsReason}
            invalid={Boolean(fieldErrors.reference)}
          />
        </Field>

        <Field label={t('asset.note')} error={fieldErrors.note} className="sm:col-span-2">
          <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}
      {!error && balance !== null && (
        <p className="text-sm font-semibold text-ink-800">
          {t('inventory.currentQuantity')}: {balance} {item.unit}
        </p>
      )}

      <SubmitButton
        saving={saving}
        savingLabel={labels['ops.saving'] ?? '…'}
        disabled={!quantity || (needsReason && !hasReason)}
      >
        {t('inventory.recordMovement')}
      </SubmitButton>
      {needsReason && !hasReason && (
        <p className="text-xs text-amber-800">{t('inventory.reasonRequired')}</p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Item form
// ---------------------------------------------------------------------------

function ItemForm({
  labels,
  t,
  initial,
  itemId,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  initial: Draft;
  itemId?: string;
  onDone: () => void;
}) {
  const { saving, error, fieldErrors, submit } = useSubmit();
  const [draft, setDraft] = useState<Draft>(initial);
  const [success, setSuccess] = useState<string | null>(null);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);

    const body = {
      name: draft.name.trim(),
      sku: orNull(draft.sku),
      category: orNull(draft.category),
      unit: draft.unit.trim() || 'piece',
      reorderLevel: Number(draft.reorderLevel) || 0,
      location: orNull(draft.location),
      unitCostCents: parseCost(draft.unitCost),
      active: draft.active,
    };

    const result = itemId
      ? await submit(`/api/inventory/items/${itemId}`, { method: 'PATCH', body })
      : await submit('/api/inventory/items', { method: 'POST', body });

    if (!result) return;
    setSuccess(t('inventory.itemSaved'));
    if (!itemId) setDraft(EMPTY);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('inventory.item')}
          error={fieldErrors.name}
          required
          className="sm:col-span-2"
        >
          <TextInput
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            required
            maxLength={200}
            invalid={Boolean(fieldErrors.name)}
          />
        </Field>

        <Field label={t('inventory.sku')} error={fieldErrors.sku}>
          <TextInput value={draft.sku} onChange={(e) => set('sku', e.target.value)} maxLength={64} />
        </Field>

        <Field label={t('inventory.unit')} error={fieldErrors.unit} required>
          <TextInput
            value={draft.unit}
            onChange={(e) => set('unit', e.target.value)}
            required
            maxLength={32}
            invalid={Boolean(fieldErrors.unit)}
          />
        </Field>

        <Field label={t('library.category')} error={fieldErrors.category}>
          <TextInput
            value={draft.category}
            onChange={(e) => set('category', e.target.value)}
            maxLength={120}
          />
        </Field>

        <Field label={t('inventory.location')} error={fieldErrors.location}>
          <TextInput
            value={draft.location}
            onChange={(e) => set('location', e.target.value)}
            maxLength={200}
          />
        </Field>

        <Field label={t('inventory.reorderLevel')} error={fieldErrors.reorderLevel}>
          <TextInput
            value={draft.reorderLevel}
            onChange={(e) => set('reorderLevel', e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            invalid={Boolean(fieldErrors.reorderLevel)}
          />
        </Field>

        <Field label={t('inventory.unitCost')} error={fieldErrors.unitCostCents}>
          <TextInput
            value={draft.unitCost}
            onChange={(e) => set('unitCost', e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            invalid={Boolean(fieldErrors.unitCostCents)}
          />
        </Field>
      </div>

      <CheckboxRow
        id={`inv-active-${itemId ?? 'new'}`}
        label={t('inventory.active')}
        checked={draft.active}
        onChange={(next) => set('active', next)}
      />

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}

      <SubmitButton
        saving={saving}
        savingLabel={labels['ops.saving'] ?? '…'}
        disabled={draft.name.trim().length === 0}
      >
        {t('action.save')}
      </SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function MovementHistory({
  labels,
  t,
  itemId,
}: {
  labels: Labels;
  t: (k: string) => string;
  itemId: string;
}) {
  const [movements, setMovements] = useState<Movement[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/inventory/items/${itemId}/movements?pageSize=25`);
      const body = res.ok ? await res.json().catch(() => ({})) : {};
      if (!cancelled) setMovements(body.data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (movements === null) return <p className="text-xs text-ink-500">{labels['ops.loading']}</p>;
  if (movements.length === 0)
    return <p className="text-xs text-ink-500">{t('inventory.noMovements')}</p>;

  return (
    <ul className="divide-y divide-ink-100">
      {movements.map((m) => (
        <li key={m.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-ink-800">
              {t(`inventory.movementType.${m.movementType}`)}
            </span>
            <span className="block text-xs text-ink-500">
              {m.movedOn}
              {m.reference && ` · ${m.reference}`}
              {m.recordedByName && ` · ${m.recordedByName}`}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span
              className={`block text-sm font-semibold tabular-nums ${
                m.delta > 0 ? 'text-emerald-700' : 'text-red-700'
              }`}
            >
              {m.delta > 0 ? '+' : ''}
              {m.delta}
            </span>
            <span className="block text-xs text-ink-500">{m.balanceAfter}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
