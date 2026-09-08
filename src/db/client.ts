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
 */

import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.ts';

export type Database = PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

const DATA_DIR = process.env.PGLITE_DATA_DIR ?? '.data/pgdata';

/**
 * Cached across hot reloads. Next.js re-evaluates modules in development, and
 * without this each reload would open a new database handle and exhaust
 * connections (or, for PGlite, fail to acquire the data directory lock).
 */
const globalForDb = globalThis as unknown as {
  __sosDb?: Database;
  __sosDbClient?: unknown;
  __sosDbInit?: Promise<Database>;
};

async function createDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL;

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Managed Postgres providers generally require TLS.
      ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
    globalForDb.__sosDbClient = pool;
    return drizzleNode(pool, { schema });
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const client = await PGlite.create({ dataDir: DATA_DIR });
  globalForDb.__sosDbClient = client;
  return drizzlePglite(client, { schema });
}

/** Get the shared database handle, initialising it once. */
export function getDb(): Promise<Database> {
  if (globalForDb.__sosDb) return Promise.resolve(globalForDb.__sosDb);
  if (!globalForDb.__sosDbInit) {
    globalForDb.__sosDbInit = createDatabase().then((db) => {
      globalForDb.__sosDb = db;
      return db;
    });
  }
  return globalForDb.__sosDbInit;
}

/** The underlying driver, for raw SQL (migrations, health checks). */
export function getRawClient(): unknown {
  return globalForDb.__sosDbClient;
}

/** True when running on the embedded PGlite driver. */
export function isEmbeddedDatabase(): boolean {
  const url = process.env.DATABASE_URL;
  return !(url && /^postgres(ql)?:\/\//.test(url));
}

export { schema };
