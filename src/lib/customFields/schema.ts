/**
 * Validation for school-defined custom fields.
 *
 * Two different things are validated here and it is worth keeping them apart:
 *
 *   1. The *definition* — "this school collects a text field called
 *      `busStop`". Managed by an administrator, validated by
 *      `createCustomFieldSchema`.
 *   2. The *value* — "this pupil's `busStop` is Megenagna". Supplied with a
 *      student or staff record, validated by a schema that is **generated at
 *      request time from the school's own definitions**
 *      (`buildCustomFieldsSchema`).
 *
 * Generating the value schema is the whole point. Before this existed,
 * `customFields` was `z.record(z.string(), z.unknown())`, so any JSON at all
 * was accepted and stored — including keys no form showed and no export knew
 * about. A field the school never defined is now rejected rather than
 * silently persisted.
 */

import { z } from 'zod';

/** Which record a field is attached to. */
export const CUSTOM_FIELD_ENTITIES = ['student', 'staff', 'guardian'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

/** Supported input types. Deliberately small — each one has a real editor. */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/**
 * Keys a school may not use.
 *
 * Two separate hazards:
 *   - Shadowing a real column (`givenName`, `status`) would produce a form with
 *     two "Status" inputs writing to different places — confusing, and a
 *     reliable source of data-entry error.
 *   - `__proto__`, `constructor` and `prototype` are JavaScript internals.
 *     They are refused on principle rather than relying on every downstream
 *     consumer of the JSON to be prototype-safe.
 */
export const RESERVED_FIELD_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'id',
  'schoolId',
  'studentCode',
  'staffCode',
  'givenName',
  'fatherName',
  'grandfatherName',
  'givenNameAm',
  'fatherNameAm',
  'grandfatherNameAm',
  'gender',
  'dateOfBirth',
  'phone',
  'email',
  'address',
  'status',
  'photoUrl',
  'customFields',
  'createdAt',
  'updatedAt',
]);

/**
 * A key becomes a JSON property name and a CSV column header, so it is held to
 * identifier rules: start with a letter, then letters/digits/underscore.
 */
const fieldKey = z
  .string({ error: 'Enter a field key.' })
  .trim()
  .min(1, 'Enter a field key.')
  .max(64, 'A field key may be at most 64 characters.')
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]*$/,
    'A key must start with a letter and use only letters, numbers and underscores.',
  )
  .refine((key) => !RESERVED_FIELD_KEYS.has(key), {
    error: 'That key is reserved by the system. Choose another.',
  });

const optionsList = z
  .array(z.string().trim().min(1, 'An option cannot be blank.').max(120))
  .max(50, 'A field may have at most 50 options.');

export const createCustomFieldSchema = z
  .object({
    entityType: z.enum(CUSTOM_FIELD_ENTITIES, { error: 'Choose what this field describes.' }),
    key: fieldKey,
    label: z.string({ error: 'Enter a label.' }).trim().min(1, 'Enter a label.').max(120),
    labelAm: z.string().trim().max(120).optional().nullable(),
    fieldType: z.enum(CUSTOM_FIELD_TYPES, { error: 'Choose a field type.' }),
    options: optionsList.optional().nullable(),
    isRequired: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(999).default(0),
  })
  // A select with nothing to select from renders an empty dropdown that can
  // never satisfy `isRequired`, so it is refused at the point of definition.
  .refine((v) => v.fieldType !== 'select' || (v.options?.length ?? 0) > 0, {
    error: 'A choice field needs at least one option.',
    path: ['options'],
  })
  .refine(
    (v) => {
      if (v.fieldType !== 'select' || !v.options) return true;
      const seen = new Set(v.options.map((o) => o.toLowerCase()));
      return seen.size === v.options.length;
    },
    { error: 'Options must be unique.', path: ['options'] },
  );

export type CreateCustomFieldInput = z.input<typeof createCustomFieldSchema>;

/**
 * Updating a definition.
 *
 * `key` and `entityType` are absent on purpose. The key is the JSON property
 * name already written into every existing record; renaming it would orphan
 * every stored value. Labels, ordering, options and required-ness are all safe
 * to change.
 */
export const updateCustomFieldSchema = z
  .object({
    label: z.string().trim().min(1, 'Enter a label.').max(120).optional(),
    labelAm: z.string().trim().max(120).optional().nullable(),
    options: optionsList.optional().nullable(),
    isRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: 'Nothing to change.' });

export type UpdateCustomFieldInput = z.input<typeof updateCustomFieldSchema>;

/** A definition as the value-validator needs to see it. */
export type FieldDefinition = {
  key: string;
  label: string;
  fieldType: string;
  options: unknown;
  isRequired: boolean;
};

function optionValues(def: FieldDefinition): string[] {
  return Array.isArray(def.options) ? def.options.filter((o): o is string => typeof o === 'string') : [];
}

/**
 * Build a validator for a `customFields` payload from the school's own active
 * definitions.
 *
 * `.strict()` is the important part: a key the school has not defined is an
 * error, not something to quietly keep. That is what stops an integration typo
 * becoming permanent per-record data.
 *
 * A school with no definitions gets a schema that accepts only `{}`.
 */
export function buildCustomFieldsSchema(defs: FieldDefinition[]) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const def of defs) {
    let field: z.ZodTypeAny;

    switch (def.fieldType) {
      case 'number':
        field = z.coerce.number({ error: `${def.label} must be a number.` }).finite();
        break;
      case 'date':
        field = z
          .string({ error: `${def.label} must be a date.` })
          .regex(/^\d{4}-\d{2}-\d{2}$/, `${def.label} must use the date format YYYY-MM-DD.`);
        break;
      case 'boolean':
        field = z.boolean({ error: `${def.label} must be yes or no.` });
        break;
      case 'select': {
        const values = optionValues(def);
        // An active select whose options were emptied would otherwise throw
        // when constructing the enum; refuse the value instead of crashing.
        field =
          values.length > 0
            ? z.enum(values as [string, ...string[]], {
                error: `Choose one of the available options for ${def.label}.`,
              })
            : z.never({ error: `${def.label} has no options configured.` });
        break;
      }
      default:
        field = z.string({ error: `${def.label} must be text.` }).trim().max(2000);
    }

    if (def.isRequired) {
      // A required text field must not be satisfiable by an empty string.
      if (def.fieldType === 'text') {
        field = z.string({ error: `${def.label} is required.` }).trim().min(1, `${def.label} is required.`).max(2000);
      }
    } else {
      // Optional fields accept omission, and treat '' / null as "cleared"
      // because that is what an HTML form submits for an untouched input.
      //
      // This is a preprocessor rather than `.or(z.literal(''))` on purpose: a
      // union reports its own generic "Invalid input" when every branch fails,
      // which would discard the per-field message built above. Normalising the
      // empty cases to `undefined` first keeps one schema, and one message.
      field = z.preprocess(
        (value) => (value === '' || value === null ? undefined : value),
        field.optional(),
      );
    }

    shape[def.key] = field;
  }

  return z.object(shape).strict();
}

/**
 * Validate a `customFields` payload against a school's definitions.
 *
 * Returns either the cleaned values or field-keyed messages ready to merge
 * into the API's `fields` error object. Blank optional values are dropped
 * rather than stored as empty strings, so a cleared field disappears instead
 * of lingering as `""`.
 */
export function validateCustomFieldValues(
  defs: FieldDefinition[],
  raw: unknown,
): { ok: true; values: Record<string, unknown> } | { ok: false; fields: Record<string, string> } {
  const parsed = buildCustomFieldsSchema(defs).safeParse(raw ?? {});

  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      // An unrecognised-key issue does not carry the offending key in `path`
      // — it reports the parent object with the names in `keys`. Naming each
      // one individually is what lets the form point at the real problem, and
      // Zod's own wording for it is opaque to a school administrator.
      if (issue.code === 'unrecognized_keys') {
        for (const key of (issue as { keys?: string[] }).keys ?? []) {
          fields[`customFields.${key}`] ??= 'That field is not defined for this school.';
        }
        continue;
      }
      const key = issue.path.length > 0 ? issue.path.join('.') : 'customFields';
      fields[`customFields.${key}`] ??= issue.message;
    }
    return { ok: false, fields };
  }

  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === '' || value === null || value === undefined) continue;
    values[key] = value;
  }
  return { ok: true, values };
}
