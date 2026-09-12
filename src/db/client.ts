/**
 * Database client.
 *
 * Two drivers are supported and selected purely by environment:
 *
 *   - PGlite: PostgreSQL compiled to WebAssembly, running in-process with data
 *     persisted to `.data/pgdata`. Used for development and demos. No server,
 *     no Docker, no install step.
 *   - node-postgres: a real PostgreSQL server, used in production.
 *
 * Both speak the same SQL dialect, so application code is identical. Set
 * DATABASE_URL to a postgres:// URL to use a real server; leave it unset to
 * use the embedded database.
 *
 * Driver selection lives in ./config.ts, which makes DATABASE_URL mandatory
 * under NODE_ENV=production so that a missing or mistyped value fails loudly
 * instead of quietly storing real data in the embedded database.
 */

import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.ts';
import { isValidPostgresUrl, resolveDatabaseConfig, resolveSslConfig } from './config.ts';

/**
 * The application's database type.
 *
 * This is deliberately the *shared* Drizzle base class rather than a union of
 * `PgliteDatabase | NodePgDatabase`. A union forces TypeScript to resolve every
 * call signature against both drivers, and builder chains such as
 * `.insert(...).values(...).returning(...)` then fail to resolve at all
 * ("Expected 0 arguments, but got 1"). Both drivers extend `PgDatabase`, which
 * exposes the identical query API, so this type is both accurate and usable.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Cached across hot reloads. Next.js re-evaluates modules in development, and
 * without this each reload would open a new database handle and exhaust
 * connections (or, for PGlite, fail to acquire the data directory lock).
 */
const globalForDb = globalThis as unknown as {
  __sosDb?: Database;
  __sosDbClient?: unknown;
  __sosDbInit?: Promise<Database>;
  __sosDbHooked?: boolean;
};

async function createDatabase(): Promise<Database> {
  // Throws in production when DATABASE_URL is missing or malformed, rather than
  // silently selecting the embedded database. Resolved here — at first use —
  // and not at module load, because `next build` also runs with
  // NODE_ENV=production and must not require a live database to compile.
  const config = resolveDatabaseConfig();

  if (config.driver === 'postgres') {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: config.connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // TLS with certificate verification by default. `undefined` means "let
      // pg honour the sslmode in DATABASE_URL"; see resolveSslConfig.
      ssl: resolveSslConfig(),
    });
    globalForDb.__sosDbClient = pool;
    return drizzleNode(pool, { schema });
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');

  // A hard kill (Ctrl-C on the dev server, container stop) leaves the
  // postmaster lock file behind. PGlite is single-process and always the sole
  // owner of this directory, so any lock file found at startup is by
  // definition stale and would otherwise block the next boot.
  const lockFile = join(config.dataDir, 'postmaster.pid');
  if (existsSync(lockFile)) {
    rmSync(lockFile, { force: true });
  }

  const client = await PGlite.create({ dataDir: config.dataDir });
  globalForDb.__sosDbClient = client;
  return drizzlePglite(client, { schema });
}

/**
 * Close the database cleanly.
 *
 * PGlite keeps recent writes in memory until shutdown; killing the process
 * without this can corrupt the data directory. Registered against process
 * signals below so `npm run dev` can be interrupted safely.
 */
export async function closeDb(): Promise<void> {
  const client = globalForDb.__sosDbClient as
    | { close?: () => Promise<void>; end?: () => Promise<void> }
    | undefined;
  if (!client) return;
  try {
    if (typeof client.close === 'function') await client.close();
    else if (typeof client.end === 'function') await client.end();
  } catch {
    // Shutting down anyway; a failure here must not mask the original exit.
  }
  globalForDb.__sosDb = undefined;
  globalForDb.__sosDbClient = undefined;
  globalForDb.__sosDbInit = undefined;
}

/** Get the shared database handle, initialising it once. */
export function getDb(): Promise<Database> {
  if (globalForDb.__sosDb) return Promise.resolve(globalForDb.__sosDb);
  if (!globalForDb.__sosDbInit) {
    globalForDb.__sosDbInit = createDatabase().then((db) => {
      globalForDb.__sosDb = db;
      registerShutdownHooks();
      return db;
    });
  }
  return globalForDb.__sosDbInit;
}

/** Flush and close the embedded database when the process is asked to stop. */
function registerShutdownHooks(): void {
  if (globalForDb.__sosDbHooked) return;
  globalForDb.__sosDbHooked = true;
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    void closeDb().finally(() => {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('beforeExit', () => {
    void closeDb();
  });
}

/** The underlying driver, for raw SQL (migrations, health checks). */
export function getRawClient(): unknown {
  return globalForDb.__sosDbClient;
}

/**
 * True when running on the embedded PGlite driver.
 *
 * Mirrors the resolver's decision without throwing, so callers can report the
 * active driver even when the environment is misconfigured.
 */
export function isEmbeddedDatabase(): boolean {
  return !isValidPostgresUrl(process.env.DATABASE_URL);
}

export { schema };
