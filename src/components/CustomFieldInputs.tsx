'use client';

import { Field, TextInput, Select } from './form.tsx';

export type CustomFieldDefinition = {
  key: string;
  label: string;
  labelAm: string | null;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
};

/** Form input name for a custom field, kept in one place so the reader and
 *  the writer cannot drift apart. */
export const CUSTOM_FIELD_PREFIX = 'cf__';

/**
 * Collect custom-field values out of a FormData.
 *
 * Blank values are omitted rather than sent as empty strings: the server
 * treats a missing optional field as "not recorded", which is the honest
 * representation of an input the user left alone.
 */
export function readCustomFields(
  formData: FormData,
  definitions: CustomFieldDefinition[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const def of definitions) {
    const raw = formData.get(`${CUSTOM_FIELD_PREFIX}${def.key}`);

    if (def.fieldType === 'boolean') {
      // An unchecked box submits nothing at all, which is a real "no" rather
      // than an unanswered question.
      values[def.key] = raw === 'on' || raw === 'true';
      continue;
    }

    const text = String(raw ?? '').trim();
    if (text === '') continue;

    values[def.key] = def.fieldType === 'number' ? Number(text) : text;
  }

  return values;
}

/**
 * Render the fields a school has defined for an entity.
 *
 * These are the same definitions the server validates against, so a field that
 * does not appear here cannot be submitted either — the two sides come from
 * one source rather than a duplicated list.
 */
export default function CustomFieldInputs({
  definitions,
  errors,
  locale,
}: {
  definitions: CustomFieldDefinition[];
  errors?: Record<string, string>;
  locale?: string;
}) {
  if (definitions.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {definitions.map((def) => {
        const name = `${CUSTOM_FIELD_PREFIX}${def.key}`;
        // The API reports failures as `customFields.<key>`.
        const error = errors?.[`customFields.${def.key}`];
        // A school that filled in the Amharic label gets it when reading
        // Amharic; otherwise the English label is better than a blank.
        const label = (locale === 'am' && def.labelAm) || def.label;

        if (def.fieldType === 'select') {
          return (
            <Field key={def.key} label={label} error={error} required={def.isRequired}>
              <Select name={name} defaultValue="" invalid={Boolean(error)}>
                <option value="" />
                {(def.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
          );
        }

        if (def.fieldType === 'boolean') {
          return (
            <Field key={def.key} label={label} error={error}>
              <label className="tap-target flex items-center gap-2">
                <input
                  type="checkbox"
                  name={name}
                  className="h-5 w-5 rounded border-ink-300 text-brand-600"
                />
                <span className="text-sm text-ink-700">{label}</span>
              </label>
            </Field>
          );
        }

        return (
          <Field key={def.key} label={label} error={error} required={def.isRequired}>
            <TextInput
              name={name}
              type={def.fieldType === 'number' ? 'number' : def.fieldType === 'date' ? 'date' : 'text'}
              inputMode={def.fieldType === 'number' ? 'numeric' : undefined}
              invalid={Boolean(error)}
            />
          </Field>
        );
      })}
    </div>
  );
}
