/**
 * Settings service.
 *
 * Reads and writes a school's configuration, with an in-process cache because
 * settings are read on nearly every request (to resolve grading rules, module
 * switches, locale and attendance policy) but change rarely.
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { schoolSettings } from '../../db/schema/core.ts';
import {
  SETTINGS_SCHEMAS,
  parseSettings,
  defaultSettings,
  type SettingsKey,
  type SettingsValue,
  type ModuleKey,
} from './schemas.ts';

type CacheEntry = { value: unknown; expiresAt: number };
const CACHE_TTL_MS = 30_000;

const globalForCache = globalThis as unknown as { __sosSettingsCache?: Map<string, CacheEntry> };
const cache: Map<string, CacheEntry> = (globalForCache.__sosSettingsCache ??= new Map());

const cacheKey = (schoolId: string, key: string) => `${schoolId}:${key}`;

/** Read one settings group, applying defaults for anything unset. */
export async function getSetting<K extends SettingsKey>(
  db: Database,
  schoolId: string,
  key: K,
): Promise<SettingsValue<K>> {
  const ck = cacheKey(schoolId, key);
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) return hit.value as SettingsValue<K>;

  const rows = await db
    .select({ value: schoolSettings.value })
    .from(schoolSettings)
    .where(and(eq(schoolSettings.schoolId, schoolId), eq(schoolSettings.key, key)))
    .limit(1);

  const value = parseSettings(key, rows[0]?.value);
  cache.set(ck, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Read several settings groups in one round trip. */
export async function getSettings<K extends SettingsKey>(
  db: Database,
  schoolId: string,
  keys: K[],
): Promise<{ [P in K]: SettingsValue<P> }> {
  const out = {} as { [P in K]: SettingsValue<P> };
  const missing: K[] = [];

  for (const key of keys) {
    const hit = cache.get(cacheKey(schoolId, key));
    if (hit && hit.expiresAt > Date.now()) {
      out[key] = hit.value as SettingsValue<K>;
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const rows = await db
      .select({ key: schoolSettings.key, value: schoolSettings.value })
      .from(schoolSettings)
      .where(eq(schoolSettings.schoolId, schoolId));
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    for (const key of missing) {
      const value = parseSettings(key, byKey.get(key));
      cache.set(cacheKey(schoolId, key), { value, expiresAt: Date.now() + CACHE_TTL_MS });
      out[key] = value as never;
    }
  }

  return out;
}

/**
 * Write a settings group. The value is validated before being stored, so an
 * invalid configuration can never reach the database and break a school.
 */
export async function setSetting<K extends SettingsKey>(
  db: Database,
  schoolId: string,
  key: K,
  value: unknown,
  updatedBy?: string,
): Promise<SettingsValue<K>> {
  const schema = SETTINGS_SCHEMAS[key];
  const parsed = schema.parse(value) as SettingsValue<K>;

  await db
    .insert(schoolSettings)
    .values({ schoolId, key, value: parsed as object, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: [schoolSettings.schoolId, schoolSettings.key],
      set: { value: parsed as object, updatedAt: new Date(), updatedBy: updatedBy ?? null },
    });

  cache.set(cacheKey(schoolId, key), { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS });
  return parsed;
}

/** Merge a partial update into an existing settings group. */
export async function patchSetting<K extends SettingsKey>(
  db: Database,
  schoolId: string,
  key: K,
  patch: Record<string, unknown>,
  updatedBy?: string,
): Promise<SettingsValue<K>> {
  const current = await getSetting(db, schoolId, key);
  return setSetting(db, schoolId, key, { ...(current as object), ...patch }, updatedBy);
}

export function invalidateSettingsCache(schoolId?: string, key?: string): void {
  if (!schoolId) {
    cache.clear();
    return;
  }
  if (key) {
    cache.delete(cacheKey(schoolId, key));
    return;
  }
  for (const k of [...cache.keys()]) {
    if (k.startsWith(`${schoolId}:`)) cache.delete(k);
  }
}

/**
 * Whether a module is switched on for a school.
 * Route handlers call this before serving a module's endpoints, so disabling
 * a module actually disables it server-side rather than merely hiding a menu.
 */
export async function isModuleEnabled(
  db: Database,
  schoolId: string,
  module: ModuleKey,
): Promise<boolean> {
  const modules = await getSetting(db, schoolId, 'modules');
  return Boolean(modules[module]);
}

/** Seed a new school with its initial configuration. */
export async function initialiseSchoolSettings(
  db: Database,
  schoolId: string,
  overrides: Partial<Record<SettingsKey, unknown>> = {},
): Promise<void> {
  for (const key of Object.keys(SETTINGS_SCHEMAS) as SettingsKey[]) {
    const base = defaultSettings(key);
    const override = overrides[key];
    const merged = override ? { ...(base as object), ...(override as object) } : base;
    await setSetting(db, schoolId, key, merged);
  }
}
