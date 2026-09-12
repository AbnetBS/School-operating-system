'use client';

/**
 * The asset register.
 *
 * An asset's location is either a room in the school (a section) or free text,
 * because a laptop lives with a person and a projector lives in a classroom,
 * and forcing one model onto both produces bad data. Both are optional.
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
  Disclosure,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;

type Asset = {
  id: string;
  name: string;
  assetTag: string | null;
  category: string | null;
  serialNumber: string | null;
  sectionId: string | null;
  sectionName: string | null;
  location: string | null;
  assignedStaffId: string | null;
  assignedTo: string | null;
  status: string;
  condition: string;
  openIssues: number;
};

type Option = { id: string; name: string };

type Draft = {
  name: string;
  assetTag: string;
  category: string;
  serialNumber: string;
  sectionId: string;
  location: string;
  assignedStaffId: string;
  status: string;
  condition: string;
  purchasedOn: string;
  purchaseCost: string;
  warrantyUntil: string;
  note: string;
};

const EMPTY: Draft = {
  name: '',
  assetTag: '',
  category: '',
  serialNumber: '',
  sectionId: '',
  location: '',
  assignedStaffId: '',
  status: 'in_use',
  condition: 'good',
  purchasedOn: '',
  purchaseCost: '',
  warrantyUntil: '',
  note: '',
};

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCost(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export default function AssetManager({
  labels,
  assets,
  statuses,
  conditions,
  sections,
  staff,
  canManage,
}: {
  labels: Labels;
  assets: Asset[];
  statuses: string[];
  conditions: string[];
  sections: Option[];
  staff: Option[];
  canManage: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Card title={t('asset.title')}>
      {canManage && (
        <Disclosure
          open={creating}
          onToggle={(next) => {
            setCreating(next);
            setEditingId(null);
          }}
          openLabel={t('asset.newAsset')}
          closeLabel={t('action.cancel')}
        >
          <AssetForm
            labels={labels}
            t={t}
            initial={EMPTY}
            statuses={statuses}
            conditions={conditions}
            sections={sections}
            staff={staff}
            onDone={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        </Disclosure>
      )}

      {assets.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={t('asset.noAssets')} />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {assets.map((asset) => (
            <li key={asset.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">
                    {asset.name}
                    {asset.openIssues > 0 && (
                      <span className="ml-2">
                        <Badge tone="warn">
                          {t('maintenance.openCount').replace(
                            '{count}',
                            String(asset.openIssues),
                          )}
                        </Badge>
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {[
                      asset.assetTag,
                      asset.sectionName ?? asset.location,
                      asset.assignedTo,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge
                    tone={
                      asset.status === 'in_use'
                        ? 'good'
                        : asset.status === 'under_repair'
                          ? 'warn'
                          : asset.status === 'lost'
                            ? 'bad'
                            : 'neutral'
                    }
                  >
                    {t(`asset.status.${asset.status}`)}
                  </Badge>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setEditingId(editingId === asset.id ? null : asset.id)}
                      className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                    >
                      {t('action.edit')}
                    </button>
                  )}
                </div>
              </div>

              {canManage && editingId === asset.id && (
                <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                  <AssetForm
                    labels={labels}
                    t={t}
                    assetId={asset.id}
                    initial={{
                      name: asset.name,
                      assetTag: asset.assetTag ?? '',
                      category: asset.category ?? '',
                      serialNumber: asset.serialNumber ?? '',
                      sectionId: asset.sectionId ?? '',
                      location: asset.location ?? '',
                      assignedStaffId: asset.assignedStaffId ?? '',
                      status: asset.status,
                      condition: asset.condition,
                      purchasedOn: '',
                      purchaseCost: '',
                      warrantyUntil: '',
                      note: '',
                    }}
                    statuses={statuses}
                    conditions={conditions}
                    sections={sections}
                    staff={staff}
                    onDone={() => {
                      setEditingId(null);
                      router.refresh();
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AssetForm({
  labels,
  t,
  initial,
  assetId,
  statuses,
  conditions,
  sections,
  staff,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  initial: Draft;
  assetId?: string;
  statuses: string[];
  conditions: string[];
  sections: Option[];
  staff: Option[];
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
      assetTag: orNull(draft.assetTag),
      category: orNull(draft.category),
      serialNumber: orNull(draft.serialNumber),
      sectionId: draft.sectionId || null,
      location: orNull(draft.location),
      assignedStaffId: draft.assignedStaffId || null,
      status: draft.status,
      condition: draft.condition,
      purchasedOn: draft.purchasedOn || null,
      purchaseCostCents: parseCost(draft.purchaseCost),
      warrantyUntil: draft.warrantyUntil || null,
      note: orNull(draft.note),
    };

    const result = assetId
      ? await submit(`/api/assets/${assetId}`, { method: 'PATCH', body })
      : await submit('/api/assets', { method: 'POST', body });

    if (!result) return;
    setSuccess(t('asset.assetSaved'));
    if (!assetId) setDraft(EMPTY);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('asset.title')}
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

        <Field label={t('asset.tag')} error={fieldErrors.assetTag}>
          <TextInput
            value={draft.assetTag}
            onChange={(e) => set('assetTag', e.target.value)}
            maxLength={64}
            invalid={Boolean(fieldErrors.assetTag)}
          />
        </Field>

        <Field label={t('asset.serialNumber')} error={fieldErrors.serialNumber}>
          <TextInput
            value={draft.serialNumber}
            onChange={(e) => set('serialNumber', e.target.value)}
            maxLength={96}
          />
        </Field>

        <Field label={t('library.category')} error={fieldErrors.category}>
          <TextInput
            value={draft.category}
            onChange={(e) => set('category', e.target.value)}
            maxLength={120}
          />
        </Field>

        <Field label={t('asset.status')} error={fieldErrors.status}>
          <Select value={draft.status} onChange={(e) => set('status', e.target.value)}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {t(`asset.status.${s}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('asset.condition')} error={fieldErrors.condition}>
          <Select value={draft.condition} onChange={(e) => set('condition', e.target.value)}>
            {conditions.map((c) => (
              <option key={c} value={c}>
                {t(`asset.condition.${c}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('asset.section')} error={fieldErrors.sectionId}>
          <Select value={draft.sectionId} onChange={(e) => set('sectionId', e.target.value)}>
            <option value="">{t('ops.none')}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('asset.location')} error={fieldErrors.location}>
          <TextInput
            value={draft.location}
            onChange={(e) => set('location', e.target.value)}
            maxLength={200}
          />
        </Field>

        <Field label={t('asset.assignedTo')} error={fieldErrors.assignedStaffId}>
          <Select
            value={draft.assignedStaffId}
            onChange={(e) => set('assignedStaffId', e.target.value)}
          >
            <option value="">{t('asset.unassigned')}</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('asset.purchasedOn')} error={fieldErrors.purchasedOn}>
          <TextInput
            type="date"
            value={draft.purchasedOn}
            onChange={(e) => set('purchasedOn', e.target.value)}
          />
        </Field>

        <Field label={t('asset.purchaseCost')} error={fieldErrors.purchaseCostCents}>
          <TextInput
            value={draft.purchaseCost}
            onChange={(e) => set('purchaseCost', e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            invalid={Boolean(fieldErrors.purchaseCostCents)}
          />
        </Field>

        <Field label={t('asset.warrantyUntil')} error={fieldErrors.warrantyUntil}>
          <TextInput
            type="date"
            value={draft.warrantyUntil}
            onChange={(e) => set('warrantyUntil', e.target.value)}
          />
        </Field>

        <Field label={t('asset.note')} error={fieldErrors.note} className="sm:col-span-2">
          <TextArea
            value={draft.note}
            onChange={(e) => set('note', e.target.value)}
            maxLength={1000}
          />
        </Field>
      </div>

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}

      <div className="flex flex-wrap gap-2">
        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={draft.name.trim().length === 0}
        >
          {t('action.save')}
        </SubmitButton>
        {assetId && (
          <SecondaryButton onClick={onDone} disabled={saving}>
            {t('action.cancel')}
          </SecondaryButton>
        )}
      </div>
    </form>
  );
}
