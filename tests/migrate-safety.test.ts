/**
 * Regression tests for audit findings M2 + M1 (paired in the audit's must-fix
 * list, because one causes the other).
 *
 * M1 — the migration runner executed each statement of a file directly, with no
 * transaction. A failure part-way through a multi-statement file left partially
 * applied DDL behind with no `_migrations` row, so every retry then failed on
 * the objects already created. Proven before the fix: of four statements, the
 * first two persisted, the third failed, and no `_migrations` row was written.
 *
 * M2 — `drizzle/0010` uses `NULLS NOT DISTINCT` (PostgreSQL 15+). On PG14 the
 * deploy failed in the middle of that file, i.e. straight into the M1 state.
 *
 * The largest migration here has 116 statements, and none of them is of a kind
 * that cannot run inside a transaction (no CREATE INDEX CONCURRENTLY, VACUUM,
 * or ALTER TYPE ... ADD VALUE), so wrapping each file is safe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { checkServerVersion, MINIMUM_PG_VERSION } from '../scripts/migrate.ts';

// ---------------------------------------------------------------------------
// M2 — server version gate
// ---------------------------------------------------------------------------

test('a PostgreSQL 14 server is rejected', () => {
  const { ok, major } = checkServerVersion('140012');
  assert.equal(ok, false);
  assert.equal(major, 14);
});

test('PostgreSQL 15 and newer are accepted', () => {
  for (const [num, major] of [
    ['150000', 15],
    ['150006', 15],
    ['160002', 16],
    ['170005', 17],
  ] as const) {
    const result = checkServerVersion(num);
    assert.equal(result.ok, true, `${num} must be accepted`);
    assert.equal(result.major, major);
  }
});

test('the boundary is exactly 15.0, not 15.1', () => {
  assert.equal(checkServerVersion('150000').ok, true);
  assert.equal(checkServerVersion('149999').ok, false);
});

test('old majors are all rejected', () => {
  for (const num of ['90623', '100023', '110018', '120016', '130012', '140012']) {
    assert.equal(checkServerVersion(num).ok, false, `${num} must be rejected`);
  }
});

test('a numeric argument works as well as a string', () => {
  assert.equal(checkServerVersion(140012).ok, false);
  assert.equal(checkServerVersion(160002).ok, true);
});

test('an unreadable version does not block the deploy', () => {
  // Some Postgres-compatible engines omit server_version_num. Refusing to
  // migrate on those would be worse than letting the migration fail loudly.
  for (const bad of [null, undefined, '', '   ', 'not-a-number', '0', '-1']) {
    const { ok, major } = checkServerVersion(bad as string);
    assert.equal(ok, true, `${JSON.stringify(bad)} must not block`);
    assert.equal(major, null);
  }
});

test('the declared minimum matches the feature actually used', async () => {
  // If someone raises MINIMUM_PG_VERSION, this keeps the reason honest.
  assert.equal(MINIMUM_PG_VERSION, 15);
  const sql = await readFile(join(process.cwd(), 'drizzle/0010_finance_apply_idempotence.sql'), 'utf8');
  assert.match(sql, /NULLS NOT DISTINCT/i, 'the PG15 feature that sets the floor');
});

// ---------------------------------------------------------------------------
// M1 — atomicity of each migration file
// ---------------------------------------------------------------------------

test('no migration uses a statement that cannot run in a transaction', async () => {
  // Wrapping files in a transaction is only safe while this holds.
  const dir = join(process.cwd(), 'drizzle');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'expected migration files');

  const forbidden = /\b(create|drop)\s+index\s+concurrently\b|\bvacuum\b|\breindex\b|\balter\s+system\b|\balter\s+type\s+\S+\s+add\s+value\b/i;
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    // Strip line comments so prose in a header cannot trip the check.
    const code = sql.replace(/--[^\n]*/g, '');
    assert.ok(!forbidden.test(code), `${file} contains a non-transactional statement`);
  }
});

test('a failure part-way through a file leaves nothing behind', async () => {
  // The core of M1, exercised against a real Postgres engine.
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = `/tmp/m1-test-${randomUUID()}`;
  const db = await PGlite.create({ dataDir: dir });

  try {
    const statements = [
      'create table alpha (id int primary key)',
      'create table beta (id int primary key)',
      'create table alpha (id int primary key)', // fails: already exists
      'create table gamma (id int primary key)',
    ];

    await db.exec('begin');
    let failed = false;
    try {
      for (const s of statements) await db.exec(s);
      await db.exec('commit');
    } catch {
      failed = true;
      await db.exec('rollback');
    }

    assert.ok(failed, 'the duplicate table must fail');

    const tables = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    assert.deepEqual(
      tables.rows.map((r) => r.tablename),
      [],
      'a rolled-back file must leave no tables behind',
    );
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rolled-back migration can simply be retried once fixed', async () => {
  // The practical consequence: no manual repair on a live system.
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = `/tmp/m1-retry-${randomUUID()}`;
  const db = await PGlite.create({ dataDir: dir });

  try {
    // First attempt: a broken file.
    await db.exec('begin');
    try {
      await db.exec('create table students_x (id int primary key)');
      await db.exec('create table students_x (id int primary key)');
      await db.exec('commit');
    } catch {
      await db.exec('rollback');
    }

    // Second attempt: the corrected file. It must not trip over leftovers.
    await db.exec('begin');
    await db.exec('create table students_x (id int primary key)');
    await db.exec('create table staff_x (id int primary key)');
    await db.exec('commit');

    const tables = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    assert.deepEqual(tables.rows.map((r) => r.tablename), ['staff_x', 'students_x']);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the DDL and its _migrations row commit together', async () => {
  // If the row could be written without the DDL, the migration would be
  // skipped forever afterwards and the schema would be silently wrong.
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = `/tmp/m1-row-${randomUUID()}`;
  const db = await PGlite.create({ dataDir: dir });

  try {
    await db.exec(
      'create table _migrations (name text primary key, checksum text not null)',
    );

    await db.exec('begin');
    try {
      await db.exec('create table thing (id int primary key)');
      await db.query('insert into _migrations (name, checksum) values ($1, $2)', [
        '0001_thing.sql',
        'abc123',
      ]);
      await db.exec('this is not valid sql'); // fails after the row is inserted
      await db.exec('commit');
    } catch {
      await db.exec('rollback');
    }

    const rows = await db.query<{ n: number }>('select count(*)::int as n from _migrations');
    assert.equal(rows.rows[0]?.n, 0, 'the _migrations row must roll back with the DDL');

    const tables = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname='public' and tablename='thing'",
    );
    assert.equal(tables.rows[0]?.n, 0, 'the table must roll back too');
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner wraps each file and records it inside the transaction', async () => {
  // Guards the shape of the fix against a well-meaning refactor.
  const source = await readFile(join(process.cwd(), 'scripts/migrate.ts'), 'utf8');
  assert.match(source, /await exec\.exec\('begin'\)/, 'each file must open a transaction');
  assert.match(source, /await exec\.exec\('commit'\)/);
  assert.match(source, /await exec\.exec\('rollback'\)/);

  const begin = source.indexOf("exec.exec('begin')");
  const insert = source.indexOf('insert into _migrations');
  const commit = source.indexOf("exec.exec('commit')");
  assert.ok(begin < insert && insert < commit, 'the _migrations insert must sit inside the transaction');
});

test('the version gate runs before any migration is applied', async () => {
  const source = await readFile(join(process.cwd(), 'scripts/migrate.ts'), 'utf8');
  const check = source.indexOf('assertServerVersion(exec)');
  const create = source.indexOf('create table if not exists _migrations');
  assert.ok(check > -1, 'the version gate must be called');
  assert.ok(check < create, 'it must run before the first write');
});
