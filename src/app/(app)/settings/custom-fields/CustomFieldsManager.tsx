'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  useSubmit,
  Field,
  TextInput,
  TextArea,
  Select,
  CheckboxRow,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
} from '../../../../components/form.tsx';
import { Card, Badge, EmptyState } from '../../../../components/ui.tsx';

type Definition = {
  id: string;
  entityType: string;
  key: string;
  label: string;
  labelAm: string | null;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
  sortOrder: number;
  isActive: boolean;
};

const ENTITY_LABEL_KEY: Record<string, string> = {
  student: 'customField.entityStudent',
  staff: 'customField.entityStaff',
  guardian: 'customField.entityGuardian',
};

const TYPE_LABEL_KEY: Record<string, string> = {
  text: 'customField.typeText',
  number: 'customField.typeNumber',
  date: 'customField.typeDate',
  select: 'customField.typeSelect',
  boolean: 'customField.typeBoolean',
};

/**
 * Manage which extra fields this school collects.
 *
 * Two rules are visible in the UI because they are surprising otherwise:
 * the key cannot be changed after creation (it is the name the value is
 * already stored under), and retiring keeps the data.
 */
export default function CustomFieldsManager({
  initial,
  usage,
  labels,
}: {
  initial: Definition[];
  usage: Record<string, number>;
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const { saving, error, fieldErrors, submit, reset } = useSubmit();

  // `noUncheckedIndexedAccess` makes a bare lookup possibly-undefined; falling
  // back to the key keeps a missing translation visible rather than blank.
  const label = (key: string) => labels[key] ?? key;

  const [form, setForm] = useState({
    entityType: 'student',
    key: '',
    label: '',
    labelAm: '',
    fieldType: 'text',
    options: '',
    isRequired: false,
    sortOrder: 0,
  });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const options =
      form.fieldType === 'select'
        ? form.options
            .split('\n')
            .map((o) => o.trim())
            .filter(Boolean)
        : undefined;

    const result = await submit('/api/settings/custom-fields', {
      method: 'POST',
      body: {
        entityType: form.entityType,
        key: form.key.trim(),
        label: form.label.trim(),
        labelAm: form.labelAm.trim() || null,
        fieldType: form.fieldType,
        ...(options ? { options } : {}),
        isRequired: form.isRequired,
        sortOrder: Number(form.sortOrder) || 0,
      },
    });

    if (result) {
      setSaved(label('customField.created'));
      setAdding(false);
      setForm({
        entityType: 'student',
        key: '',
        label: '',
        labelAm: '',
        fieldType: 'text',
        options: '',
        isRequired: false,
        sortOrder: 0,
      });
      router.refresh();
    }
  }

  async function toggleActive(def: Definition) {
    const result = await submit(`/api/settings/custom-fields/${def.id}`, {
      method: 'PATCH',
      body: { isActive: !def.isActive },
    });
    if (result) {
      setSaved(label('customField.updated'));
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      {saved ? <SuccessBanner message={saved} /> : null}
      {error ? <ErrorBanner message={error} /> : null}

      {!adding ? (
        <button
          type="button"
          onClick={() => {
            reset();
            setSaved(null);
            setAdding(true);
          }}
          className="tap-target w-full rounded-lg border border-dashed border-ink-300 px-4 py-3 text-sm font-medium text-brand-700 hover:border-brand-400 sm:w-auto"
        >
          + {label('customField.add')}
        </button>
      ) : (
        <Card>
          <form onSubmit={create} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={label('customField.entity')} error={fieldErrors['entityType']}>
                <Select
                  value={form.entityType}
                  onChange={(e) => setForm({ ...form, entityType: e.target.value })}
                >
                  <option value="student">{label('customField.entityStudent')}</option>
                  <option value="staff">{label('customField.entityStaff')}</option>
                  <option value="guardian">{label('customField.entityGuardian')}</option>
                </Select>
              </Field>

              <Field label={label('customField.type')} error={fieldErrors['fieldType']}>
                <Select
                  value={form.fieldType}
                  onChange={(e) => setForm({ ...form, fieldType: e.target.value })}
                >
                  <option value="text">{label('customField.typeText')}</option>
                  <option value="number">{label('customField.typeNumber')}</option>
                  <option value="date">{label('customField.typeDate')}</option>
                  <option value="select">{label('customField.typeSelect')}</option>
                  <option value="boolean">{label('customField.typeBoolean')}</option>
                </Select>
              </Field>

              <Field
                label={label('customField.key')}
                hint={label('customField.keyHint')}
                error={fieldErrors['key']}
              >
                <TextInput
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  invalid={Boolean(fieldErrors['key'])}
                  placeholder="busStop"
                />
              </Field>

              <Field label={label('customField.sortOrder')} error={fieldErrors['sortOrder']}>
                <TextInput
                  type="number"
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                />
              </Field>

              <Field label={label('customField.label')} error={fieldErrors['label']}>
                <TextInput
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  invalid={Boolean(fieldErrors['label'])}
                />
              </Field>

              <Field label={label('customField.labelAm')} error={fieldErrors['labelAm']}>
                <TextInput
                  value={form.labelAm}
                  onChange={(e) => setForm({ ...form, labelAm: e.target.value })}
                  lang="am"
                />
              </Field>
            </div>

            {form.fieldType === 'select' ? (
              <Field
                label={label('customField.options')}
                hint={label('customField.optionsHint')}
                error={fieldErrors['options']}
              >
                <TextArea
                  rows={4}
                  value={form.options}
                  onChange={(e) => setForm({ ...form, options: e.target.value })}
                  invalid={Boolean(fieldErrors['options'])}
                />
              </Field>
            ) : null}

            <CheckboxRow
              id="cf-required"
              label={label('customField.required')}
              hint={label('customField.requiredHint')}
              checked={form.isRequired}
              onChange={(checked) => setForm({ ...form, isRequired: checked })}
            />

            <div className="flex flex-col gap-2 sm:flex-row">
              <SubmitButton saving={saving} savingLabel={label('action.saving')}>
                {label('action.save')}
              </SubmitButton>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="tap-target rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700"
              >
                {label('action.cancel')}
              </button>
            </div>
          </form>
        </Card>
      )}

      {initial.length === 0 ? (
        <Card>
          <EmptyState
            title={label('customField.none')}
            description={label('customField.noneHint')}
          />
        </Card>
      ) : (
        <Card>
          {/* Mobile: one card per field. */}
          <ul className="divide-y divide-ink-100 sm:hidden">
            {initial.map((def) => (
              <li key={def.id} className="space-y-2 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">{def.label}</p>
                    <p className="truncate font-mono text-xs text-ink-500">{def.key}</p>
                  </div>
                  <Badge tone={def.isActive ? 'good' : 'neutral'}>
                    {def.isActive ? label('customField.active') : label('customField.inactive')}
                  </Badge>
                </div>
                <p className="text-xs text-ink-500">
                  {label(ENTITY_LABEL_KEY[def.entityType] ?? def.entityType)} ·{' '}
                  {label(TYPE_LABEL_KEY[def.fieldType] ?? def.fieldType)}
                  {def.isRequired ? ` · ${label('customField.required')}` : ''}
                </p>
                <p className="text-xs text-ink-500">
                  {label('customField.usage').replace('{count}', String(usage[def.id] ?? 0))}
                </p>
                <button
                  type="button"
                  onClick={() => toggleActive(def)}
                  disabled={saving}
                  className="tap-target text-sm font-medium text-brand-700 disabled:opacity-50"
                >
                  {def.isActive ? label('customField.retire') : label('customField.restore')}
                </button>
              </li>
            ))}
          </ul>

          {/* Desktop: table. */}
          <div className="-mx-4 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
                  <th className="px-4 py-2 font-medium">{label('customField.label')}</th>
                  <th className="px-4 py-2 font-medium">{label('customField.key')}</th>
                  <th className="px-4 py-2 font-medium">{label('customField.entity')}</th>
                  <th className="px-4 py-2 font-medium">{label('customField.type')}</th>
                  <th className="px-4 py-2 font-medium">{label('customField.usage').replace(' {count}', '').replace('{count} ', '')}</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {initial.map((def) => (
                  <tr key={def.id}>
                    <td className="px-4 py-2">
                      <span className="font-medium text-ink-900">{def.label}</span>
                      {def.isRequired ? (
                        <span className="ml-2 text-xs text-ink-500">
                          {label('customField.required')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-600">{def.key}</td>
                    <td className="px-4 py-2 text-ink-600">
                      {label(ENTITY_LABEL_KEY[def.entityType] ?? def.entityType)}
                    </td>
                    <td className="px-4 py-2 text-ink-600">
                      {label(TYPE_LABEL_KEY[def.fieldType] ?? def.fieldType)}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-ink-600">{usage[def.id] ?? 0}</td>
                    <td className="px-4 py-2 text-right">
                      <Badge tone={def.isActive ? 'good' : 'neutral'}>
                        {def.isActive
                          ? label('customField.active')
                          : label('customField.inactive')}
                      </Badge>
                      <button
                        type="button"
                        onClick={() => toggleActive(def)}
                        disabled={saving}
                        className="ml-3 text-sm font-medium text-brand-700 disabled:opacity-50"
                      >
                        {def.isActive
                          ? label('customField.retire')
                          : label('customField.restore')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-ink-500">{label('customField.retireWarning')}</p>
        </Card>
      )}
    </div>
  );
}
