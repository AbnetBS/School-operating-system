/**
 * School-defined custom fields.
 *
 * The `custom_field_defs` table has shipped since migration 0000 but nothing
 * used it, so `students.customFields` and `staff.customFields` accepted any
 * JSON at all. This module is the missing half: definitions become real
 * configuration, and values are validated against them.
 *
 * Definitions change rarely and are read on every student/staff write, so they
 * are cached per school and entity type, following the same pattern (and the
 * same invalidation discipline) as `settings/service.ts`.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { customFieldDefs } from '../../db/schema/people.ts';
import { markDomainError } from '../api/domain-error.ts';
import {
  validateCustomFieldValues,
  type CustomFieldEntity,
  type FieldDefinition,
} from './schema.ts';

export type CustomFieldDef = {
  id: string;
  entityType: string;
  key: string;
  label: string;
  labelAm: string | null;
  fieldType: string;
  options: unknown;
  isRequired: boolean;
  sortOrder: number;
  isActive: boolean;
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = { value: CustomFieldDef[]; expiresAt: number };

/**
 * A TTL bounds staleness when more than one process serves the app: an
 * invalidation only clears the map in the process that performed the write, so
 * without an expiry another instance could keep validating against a
 * definition list the school has already changed.
 *
 * Pinned to `globalThis` for the same reason `settings/service.ts` is — Next.js
 * re-evaluates modules in development, and a module-local map would be
 * silently replaced, making invalidation look like it had worked when it had
 * not.
 */
const CACHE_TTL_MS = 30_000;

const globalForCache = globalThis as unknown as {
  __sosCustomFieldCache?: Map<string, CacheEntry>;
};
const cache: Map<string, CacheEntry> = (globalForCache.__sosCustomFieldCache ??= new Map());

function cacheKey(schoolId: string, entityType: string): string {
  return `${schoolId}:${entityType}`;
}

/**
 * Drop cached definitions. Called after every write here, and exported so
 * tests can clear state between cases — the same contract as
 * `invalidateSettingsCache`.
 */
export function invalidateCustomFieldCache(schoolId?: string, entityType?: string): void {
  if (!schoolId) {
    cache.clear();
    return;
  }
  if (entityType) {
    cache.delete(cacheKey(schoolId, entityType));
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${schoolId}:`)) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Active definitions for one entity type, in display order.
 *
 * Only active definitions are returned: deactivating a field must stop it
 * appearing on forms and stop it being accepted on writes, while leaving the
 * values already captured untouched in the record.
 */
export async function getActiveDefinitions(
  db: Database,
  schoolId: string,
  entityType: CustomFieldEntity,
): Promise<CustomFieldDef[]> {
  const key = cacheKey(schoolId, entityType);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const rows = await db
    .select({
      id: customFieldDefs.id,
      entityType: customFieldDefs.entityType,
      key: customFieldDefs.key,
      label: customFieldDefs.label,
      labelAm: customFieldDefs.labelAm,
      fieldType: customFieldDefs.fieldType,
      options: customFieldDefs.options,
      isRequired: customFieldDefs.isRequired,
      sortOrder: customFieldDefs.sortOrder,
      isActive: customFieldDefs.isActive,
    })
    .from(customFieldDefs)
    .where(
      and(
        eq(customFieldDefs.schoolId, schoolId),
        eq(customFieldDefs.entityType, entityType),
        eq(customFieldDefs.isActive, true),
      ),
    )
    .orderBy(asc(customFieldDefs.sortOrder), asc(customFieldDefs.label));

  cache.set(key, { value: rows, expiresAt: Date.now() + CACHE_TTL_MS });
  return rows;
}

/** Every definition including deactivated ones — for the management screen. */
export async function listDefinitions(
  db: Database,
  schoolId: string,
  entityType?: CustomFieldEntity,
): Promise<CustomFieldDef[]> {
  const where = entityType
    ? and(eq(customFieldDefs.schoolId, schoolId), eq(customFieldDefs.entityType, entityType))
    : eq(customFieldDefs.schoolId, schoolId);

  return db
    .select({
      id: customFieldDefs.id,
      entityType: customFieldDefs.entityType,
      key: customFieldDefs.key,
      label: customFieldDefs.label,
      labelAm: customFieldDefs.labelAm,
      fieldType: customFieldDefs.fieldType,
      options: customFieldDefs.options,
      isRequired: customFieldDefs.isRequired,
      sortOrder: customFieldDefs.sortOrder,
      isActive: customFieldDefs.isActive,
    })
    .from(customFieldDefs)
    .where(where)
    .orderBy(
      asc(customFieldDefs.entityType),
      asc(customFieldDefs.sortOrder),
      asc(customFieldDefs.label),
    );
}

/**
 * Validate a `customFields` payload for one entity type against this school's
 * definitions.
 *
 * This is the function the student and staff services call. It throws a 400
 * carrying per-field messages, so the caller does not need to know how custom
 * fields are stored.
 */
export async function resolveCustomFieldValues(
  db: Database,
  schoolId: string,
  entityType: CustomFieldEntity,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const defs = await getActiveDefinitions(db, schoolId, entityType);
  const result = validateCustomFieldValues(defs as FieldDefinition[], raw);

  if (!result.ok) {
    const error = markDomainError(
      Object.assign(new Error('Please check the highlighted fields.'), { status: 400 }),
    ) as Error & { status: number; fields?: Record<string, string> };
    error.fields = result.fields;
    throw error;
  }
  return result.values;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type CreateDefinitionInput = {
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  labelAm?: string | null;
  fieldType: string;
  options?: string[] | null;
  isRequired: boolean;
  sortOrder: number;
};

/**
 * Define a new field.
 *
 * Uniqueness of `(school, entity, key)` is enforced by the index in migration
 * 0000; the pre-check below exists to return a field-level message rather than
 * a generic conflict, and the index remains the authority under concurrency.
 */
export async function createDefinition(
  db: Database,
  schoolId: string,
  input: CreateDefinitionInput,
): Promise<CustomFieldDef> {
  const [existing] = await db
    .select({ id: customFieldDefs.id, isActive: customFieldDefs.isActive })
    .from(customFieldDefs)
    .where(
      and(
        eq(customFieldDefs.schoolId, schoolId),
        eq(customFieldDefs.entityType, input.entityType),
        eq(customFieldDefs.key, input.key),
      ),
    )
    .limit(1);

  if (existing) {
    const error = markDomainError(
      Object.assign(
        new Error(
          existing.isActive
            ? 'A field with that key already exists.'
            : 'A deactivated field already uses that key. Re-enable it instead of creating a duplicate.',
        ),
        { status: 409 },
      ),
    ) as Error & { status: number; fields?: Record<string, string> };
    error.fields = { key: error.message };
    throw error;
  }

  const [row] = await db
    .insert(customFieldDefs)
    .values({
      schoolId,
      entityType: input.entityType,
      key: input.key,
      label: input.label,
      labelAm: input.labelAm ?? null,
      fieldType: input.fieldType,
      options: input.fieldType === 'select' ? (input.options ?? []) : null,
      isRequired: input.isRequired,
      sortOrder: input.sortOrder,
    })
    .returning();

  invalidateCustomFieldCache(schoolId, input.entityType);
  return row as CustomFieldDef;
}

export type UpdateDefinitionInput = {
  label?: string;
  labelAm?: string | null;
  options?: string[] | null;
  isRequired?: boolean;
  sortOrder?: number;
  isActive?: boolean;
};

/**
 * Amend a definition.
 *
 * The row is located with the school id in the WHERE clause, so a definition
 * belonging to another school is simply not found — a forged id cannot reach
 * across tenants.
 */
export async function updateDefinition(
  db: Database,
  schoolId: string,
  id: string,
  input: UpdateDefinitionInput,
): Promise<{ before: CustomFieldDef; after: CustomFieldDef }> {
  const [before] = await db
    .select()
    .from(customFieldDefs)
    .where(and(eq(customFieldDefs.id, id), eq(customFieldDefs.schoolId, schoolId)))
    .limit(1);

  if (!before) {
    throw markDomainError(Object.assign(new Error('Field not found.'), { status: 404 }));
  }

  // A select field must never end up active with zero options: the form would
  // render an unanswerable required question.
  const nextType = before.fieldType;
  const nextOptions = input.options === undefined ? before.options : input.options;
  const nextActive = input.isActive ?? before.isActive;
  if (
    nextType === 'select' &&
    nextActive &&
    (!Array.isArray(nextOptions) || nextOptions.length === 0)
  ) {
    const error = markDomainError(
      Object.assign(new Error('A choice field needs at least one option.'), { status: 400 }),
    ) as Error & { status: number; fields?: Record<string, string> };
    error.fields = { options: 'A choice field needs at least one option.' };
    throw error;
  }

  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) patch['label'] = input.label;
  if (input.labelAm !== undefined) patch['labelAm'] = input.labelAm;
  if (input.options !== undefined) {
    patch['options'] = nextType === 'select' ? input.options : null;
  }
  if (input.isRequired !== undefined) patch['isRequired'] = input.isRequired;
  if (input.sortOrder !== undefined) patch['sortOrder'] = input.sortOrder;
  if (input.isActive !== undefined) patch['isActive'] = input.isActive;

  const [after] = await db
    .update(customFieldDefs)
    .set(patch)
    .where(and(eq(customFieldDefs.id, id), eq(customFieldDefs.schoolId, schoolId)))
    .returning();

  invalidateCustomFieldCache(schoolId, before.entityType);
  return { before: before as CustomFieldDef, after: after as CustomFieldDef };
}

/**
 * How many records already hold a value for this field.
 *
 * Shown before deactivation so an administrator understands what they are
 * hiding. The `?` operator asks whether the JSONB object has the key.
 */
export async function countRecordsUsing(
  db: Database,
  schoolId: string,
  entityType: string,
  key: string,
): Promise<number> {
  const table = entityType === 'staff' ? 'staff' : entityType === 'guardian' ? 'guardians' : 'students';
  const rows = await db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)}
        where school_id = ${schoolId} and custom_fields ? ${key}`,
  );
  const first = (rows as unknown as { rows?: { n?: number }[] }).rows?.[0];
  return first?.n ?? 0;
}

/**
 * Usage counts for every definition, keyed by definition id.
 *
 * The obvious implementation calls `countRecordsUsing` per definition, which
 * is a query per row — small for three fields, but it is exactly the N+1
 * shape this codebase avoids elsewhere, and a school with twenty fields would
 * pay twenty round trips to render one settings page. Instead each table is
 * visited once and every key counted in that single pass.
 */
export async function countUsageForDefinitions(
  db: Database,
  schoolId: string,
  definitions: { id: string; entityType: string; key: string }[],
): Promise<Record<string, number>> {
  const usage: Record<string, number> = {};
  for (const def of definitions) usage[def.id] = 0;
  if (definitions.length === 0) return usage;

  // Group by the table each definition lives in: at most three queries total,
  // regardless of how many fields the school has defined.
  const byEntity = new Map<string, { id: string; key: string }[]>();
  for (const def of definitions) {
    const list = byEntity.get(def.entityType) ?? [];
    list.push({ id: def.id, key: def.key });
    byEntity.set(def.entityType, list);
  }

  for (const [entityType, defs] of byEntity) {
    const table =
      entityType === 'staff' ? 'staff' : entityType === 'guardian' ? 'guardians' : 'students';

    // One row per key, counted in a single scan of the table.
    const counts = sql.join(
      defs.map(
        (def) =>
          sql`count(*) filter (where custom_fields ? ${def.key})::int as ${sql.identifier(`k_${def.id.replace(/-/g, '')}`)}`,
      ),
      sql`, `,
    );

    const result = await db.execute(
      sql`select ${counts} from ${sql.identifier(table)} where school_id = ${schoolId}`,
    );
    const row = (result as unknown as { rows?: Record<string, number>[] }).rows?.[0];
    if (!row) continue;

    for (const def of defs) {
      usage[def.id] = row[`k_${def.id.replace(/-/g, '')}`] ?? 0;
    }
  }

  return usage;
}
