/**
 * Migration runner.
 *
 * Applies the SQL files in ./drizzle in order, tracking what has been applied
 * in a `_migrations` table. Works against both the embedded PGlite database
 * and a real PostgreSQL server, so development and production run identical
 * migrations.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDatabaseConfig, resolveSslConfig } from '../src/db/config.ts';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

type Executor = {
  exec: (sql: string) => Promise<void>;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
  label: string;
};

/**
 * Lowest PostgreSQL version the migrations can run on.
 *
 * `drizzle/0010_finance_apply_idempotence.sql` uses `NULLS NOT DISTINCT`,
 * added in PostgreSQL 15. Without the check below, an older server fails
 * part-way through that file rather than before starting any of it.
 */
export const MINIMUM_PG_VERSION = 15;

/**
 * Decide whether a server is new enough, from `server_version_num`
 * (e.g. `140012` for 14.12, `150006` for 15.6).
 *
 * Exported for testing: this must be right for the check to be worth having.
 */
export function checkServerVersion(versionNum: string | number | null | undefined): {
  ok: boolean;
  major: number | null;
} {
  const parsed = typeof versionNum === 'number' ? versionNum : Number.parseInt(String(versionNum ?? ''), 10);
  // An unreadable value must not block a deploy: some Postgres-compatible
  // engines omit the setting. The migration itself will still fail loudly if
  // the feature is genuinely missing.
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: true, major: null };

  const major = Math.floor(parsed / 10000);
  return { ok: major >= MINIMUM_PG_VERSION, major };
}

/**
 * Refuse to start against a server too old for the migrations.
 *
 * Checked before any file runs, so an unsupported server leaves the database
 * completely untouched instead of half-migrated.
 */
async function assertServerVersion(exec: Executor): Promise<void> {
  let rows: { server_version_num?: string }[];
  try {
    rows = await exec.query<{ server_version_num?: string }>(
      "select current_setting('server_version_num') as server_version_num",
    );
  } catch {
    // Setting unavailable — see checkServerVersion.
    return;
  }

  const { ok, major } = checkServerVersion(rows[0]?.server_version_num);
  if (ok) return;

  throw new Error(
    `PostgreSQL ${MINIMUM_PG_VERSION} or newer is required, but this server reports ` +
      `version ${major}.\n` +
      `Migration 0010 uses NULLS NOT DISTINCT, which ${major} does not support.\n` +
      'No migrations have been applied; the database is unchanged. ' +
      'Upgrade the server and run this again.',
  );
}

async function createExecutor(): Promise<Executor> {
  // Same guard as the application: under NODE_ENV=production a missing or
  // malformed DATABASE_URL is a hard failure. Without this, a deploy could
  // migrate the embedded database, report success, and leave the real server
  // untouched — the most confusing possible version of the C1 bug.
  const config = resolveDatabaseConfig();

  if (config.driver === 'postgres') {
    const { Client } = await import('pg');
    const client = new Client({
      connectionString: config.connectionString,
      // Same TLS policy as the application; see resolveSslConfig.
      ssl: resolveSslConfig(),
    });
    await client.connect();
    return {
      label: 'PostgreSQL server',
      exec: async (sql) => {
        await client.query(sql);
      },
      query: async <T>(sql: string, params?: unknown[]) =>
        (await client.query(sql, params)).rows as T[],
      close: async () => {
        await client.end();
      },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { mkdir } = await import('node:fs/promises');
  const { existsSync, rmSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const dataDir = config.dataDir;
  // PGlite does not create intermediate directories.
  await mkdir(dirname(dataDir), { recursive: true });

  // Clear a stale lock, exactly as `src/db/client.ts` does.
  //
  // Any process that exits without `close()` — a killed dev server, a test run
  // ending on a signal — leaves `postmaster.pid` behind. PGlite is
  // single-process and always the sole owner of this directory, so a lock file
  // found here is by definition stale. Without this the migration runner
  // aborts with an opaque "Aborted()" while the application starts fine, which
  // makes it look as though the migrations themselves are broken.
  const lockFile = join(dataDir, 'postmaster.pid');
  if (existsSync(lockFile)) rmSync(lockFile, { force: true });

  const db = await PGlite.create({ dataDir });
  return {
    label: `PGlite (${dataDir})`,
    exec: async (sql) => {
      await db.exec(sql);
    },
    query: async <T>(sql: string, params?: unknown[]) =>
      (await db.query(sql, params as never[])).rows as T[],
    close: async () => {
      await db.close();
    },
  };
}

/**
 * Split a migration file on Drizzle's statement separator.
 * Falls back to running the file whole when no separator is present.
 */
function splitStatements(sql: string): string[] {
  const parts = sql.split('--> statement-breakpoint');
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const exec = await createExecutor();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Before anything is written: an unsupported server must fail here, not
    // half-way through migration 0010.
    await assertServerVersion(exec);

    await exec.exec(`
      create table if not exists _migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
    `);

    const done = await exec.query<{ name: string; checksum: string }>(
      'select name, checksum from _migrations',
    );
    const doneMap = new Map(done.map((r) => [r.name, r.checksum]));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);

      const existing = doneMap.get(file);
      if (existing) {
        if (existing !== checksum) {
          // A migration that has already run must never be edited: the
          // database and the file would silently diverge.
          throw new Error(
            `Migration "${file}" has changed since it was applied ` +
              `(recorded ${existing}, now ${checksum}). Create a new migration instead.`,
          );
        }
        skipped.push(file);
        continue;
      }

      process.stdout.write(`Applying ${file} … `);
      // One transaction per file, covering both the DDL and the _migrations
      // row. PostgreSQL has transactional DDL, so a failure part-way through
      // rolls the whole file back and the database is left exactly as it was.
      // Without this, a partially applied file persists with no _migrations
      // row, and every retry then fails on the objects already created —
      // requiring manual repair on a live system.
      await exec.exec('begin');
      try {
        for (const statement of splitStatements(sql)) {
          await exec.exec(statement);
        }
        await exec.query('insert into _migrations (name, checksum) values ($1, $2)', [
          file,
          checksum,
        ]);
        await exec.exec('commit');
      } catch (error) {
        // Best-effort rollback: if this throws too, the original error is the
        // useful one, so it must not be masked.
        try {
          await exec.exec('rollback');
        } catch {
          /* the connection is already unusable; report the real failure */
        }
        process.stdout.write('failed\n');
        throw new Error(
          `Migration "${file}" failed and was rolled back; the database is unchanged.\n` +
            `Cause: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      applied.push(file);
      process.stdout.write('done\n');
    }

    return { applied, skipped };
  } finally {
    await exec.close();
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  runMigrations()
    .then(({ applied, skipped }) => {
      console.log(
        `\nMigrations complete: ${applied.length} applied, ${skipped.length} already up to date.`,
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error('\nMigration failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
