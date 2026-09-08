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

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

type Executor = {
  exec: (sql: string) => Promise<void>;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
  label: string;
};

async function createExecutor(): Promise<Executor> {
  const url = process.env.DATABASE_URL;

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { Client } = await import('pg');
    const client = new Client({
      connectionString: url,
      ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
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
  const { dirname } = await import('node:path');
  const dataDir = process.env.PGLITE_DATA_DIR ?? '.data/pgdata';
  // PGlite does not create intermediate directories.
  await mkdir(dirname(dataDir), { recursive: true });
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
      for (const statement of splitStatements(sql)) {
        await exec.exec(statement);
      }
      await exec.query('insert into _migrations (name, checksum) values ($1, $2)', [
        file,
        checksum,
      ]);
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
