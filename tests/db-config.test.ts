/**
 * Regression tests for audit finding C1.
 *
 * Before the fix, a missing or mistyped DATABASE_URL in production silently
 * selected the embedded PGlite database. The application booted, looked
 * healthy, and wrote real school data to a local file that no backup covers
 * and that is destroyed on redeploy.
 *
 * The rule these tests protect:
 *
 *   production  -> DATABASE_URL must be present and valid, or startup fails
 *   development -> PGlite remains the zero-configuration default
 *
 * `resolveDatabaseConfig` takes its environment as an argument so these run as
 * pure functions, with no process-wide mutation and no database connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDatabaseConfig,
  isValidPostgresUrl,
  DatabaseConfigError,
  DEFAULT_PGLITE_DATA_DIR,
  type EnvLike,
} from '../src/db/config.ts';

const PROD: EnvLike = { NODE_ENV: 'production' };
const DEV: EnvLike = { NODE_ENV: 'development' };

/** Assert the call fails as a config error and return the message. */
function expectConfigFailure(env: EnvLike): string {
  let caught: unknown;
  try {
    resolveDatabaseConfig(env);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof DatabaseConfigError,
    `expected DatabaseConfigError, got ${caught === undefined ? 'no error' : String(caught)}`,
  );
  return (caught as DatabaseConfigError).message;
}

// ---------------------------------------------------------------------------
// Production: DATABASE_URL is mandatory
// ---------------------------------------------------------------------------

test('production + DATABASE_URL missing -> startup failure', () => {
  const message = expectConfigFailure(PROD);
  assert.match(message, /DATABASE_URL is required/i);
});

test('production + DATABASE_URL empty -> startup failure', () => {
  expectConfigFailure({ ...PROD, DATABASE_URL: '' });
});

test('production + DATABASE_URL whitespace-only -> startup failure', () => {
  expectConfigFailure({ ...PROD, DATABASE_URL: '   ' });
});

test('production + malformed DATABASE_URL -> startup failure', () => {
  expectConfigFailure({ ...PROD, DATABASE_URL: 'not a url at all' });
});

test('production + wrong scheme -> startup failure, no silent fallback', () => {
  for (const url of [
    'mysql://user:pw@host:3306/db',
    'http://host/db',
    'sqlite:///tmp/db.sqlite',
    'file:./local.db',
  ]) {
    const message = expectConfigFailure({ ...PROD, DATABASE_URL: url });
    assert.match(message, /postgres/i);
  }
});

test('production + "postgre://" typo -> startup failure (the exact audit case)', () => {
  // One missing "s". The original code fell through to PGlite here, which is
  // the realistic copy-paste error that motivated this whole fix.
  const message = expectConfigFailure({
    ...PROD,
    DATABASE_URL: 'postgre://user:pw@host:5432/db',
  });
  assert.match(message, /not a valid PostgreSQL connection string/i);
});

test('production + URL with stray whitespace -> startup failure, never trimmed', () => {
  // Requirement: do not silently repair. A trailing newline from a secrets file
  // is reported, not fixed, because the operator needs to know it is there.
  const message = expectConfigFailure({
    ...PROD,
    DATABASE_URL: ' postgresql://user:pw@host:5432/db\n',
  });
  assert.match(message, /whitespace/i);
});

test('production + valid URL -> PostgreSQL selected, string passed through verbatim', () => {
  const url = 'postgresql://user:pw@db.example.com:5432/school';
  const config = resolveDatabaseConfig({ ...PROD, DATABASE_URL: url });
  assert.equal(config.driver, 'postgres');
  assert.equal(
    config.driver === 'postgres' && config.connectionString,
    url,
    'the connection string must reach the driver unmodified',
  );
});

test('production + postgres:// scheme is accepted (pg supports both spellings)', () => {
  // The pre-existing driver check accepted `postgres://` and `postgresql://`.
  // That behaviour is preserved deliberately: this is not a guess or a
  // normalisation, it is the scheme set `pg` itself documents.
  for (const url of [
    'postgres://user:pw@host:5432/db',
    'postgresql://user:pw@host:5432/db',
  ]) {
    assert.equal(resolveDatabaseConfig({ ...PROD, DATABASE_URL: url }).driver, 'postgres');
  }
});

test('production + Unix-socket connection string is accepted', () => {
  // `postgres:///db?host=/var/run/postgresql` has no hostname but is a real,
  // valid deployment style. Rejecting it would be an over-strict regression.
  const url = 'postgresql:///school?host=/var/run/postgresql';
  assert.equal(resolveDatabaseConfig({ ...PROD, DATABASE_URL: url }).driver, 'postgres');
});

// ---------------------------------------------------------------------------
// The failure must never leak credentials
// ---------------------------------------------------------------------------

test('error message never contains credentials or the connection string', () => {
  const secret = 'sup3rS3cretP@ssw0rd';
  const url = `postgre://admin:${secret}@db.internal.example.com:5432/school`;
  const message = expectConfigFailure({ ...PROD, DATABASE_URL: url });

  assert.ok(!message.includes(secret), 'password must not appear in the error');
  assert.ok(!message.includes(url), 'full connection string must not appear');
  assert.ok(!message.includes('admin'), 'username must not appear in the error');
  assert.ok(!message.includes('db.internal.example.com'), 'host must not appear');
});

test('error message for a wrong scheme reveals only the scheme itself', () => {
  const message = expectConfigFailure({
    ...PROD,
    DATABASE_URL: 'mysql://root:hunter2@10.0.0.5:3306/prod',
  });
  assert.ok(!message.includes('hunter2'));
  assert.ok(!message.includes('10.0.0.5'));
  assert.ok(!message.includes('root'));
  assert.match(message, /mysql:/);
});

// ---------------------------------------------------------------------------
// Development and test: PGlite stays the zero-config default
// ---------------------------------------------------------------------------

test('development + no DATABASE_URL -> PGlite, as before', () => {
  const config = resolveDatabaseConfig(DEV);
  assert.equal(config.driver, 'pglite');
  assert.equal(config.driver === 'pglite' && config.dataDir, DEFAULT_PGLITE_DATA_DIR);
});

test('test environment + no DATABASE_URL -> PGlite', () => {
  assert.equal(resolveDatabaseConfig({ NODE_ENV: 'test' }).driver, 'pglite');
});

test('undefined NODE_ENV -> PGlite (plain `tsx script.ts` still works)', () => {
  assert.equal(resolveDatabaseConfig({}).driver, 'pglite');
});

test('development honours PGLITE_DATA_DIR', () => {
  const config = resolveDatabaseConfig({ ...DEV, PGLITE_DATA_DIR: '/tmp/custom-pgdata' });
  assert.equal(config.driver === 'pglite' && config.dataDir, '/tmp/custom-pgdata');
});

test('development + valid DATABASE_URL still selects PostgreSQL', () => {
  const config = resolveDatabaseConfig({
    ...DEV,
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/dev',
  });
  assert.equal(config.driver, 'postgres');
});

test('development + malformed DATABASE_URL warns but falls back', () => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '));
  };
  try {
    const config = resolveDatabaseConfig({ ...DEV, DATABASE_URL: 'postgre://typo@host/db' });
    assert.equal(config.driver, 'pglite', 'development keeps working');
    assert.equal(warnings.length, 1, 'but the developer is told');
    assert.match(warnings[0] ?? '', /production/i);
  } finally {
    console.warn = original;
  }
});

// ---------------------------------------------------------------------------
// isValidPostgresUrl — used by isEmbeddedDatabase(), must never throw
// ---------------------------------------------------------------------------

test('isValidPostgresUrl classifies without throwing', () => {
  const valid = [
    'postgres://u:p@h:5432/d',
    'postgresql://u:p@h:5432/d',
    'postgresql:///d?host=/var/run/postgresql',
  ];
  const invalid = [undefined, '', '   ', 'postgre://u@h/d', 'mysql://u@h/d', 'garbage', 'postgres://h:99999/d'];

  for (const url of valid) assert.equal(isValidPostgresUrl(url), true, `expected valid: ${url}`);
  for (const url of invalid) {
    assert.equal(isValidPostgresUrl(url), false, `expected invalid: ${String(url)}`);
  }
});

// ---------------------------------------------------------------------------
// No production code path may reach PGlite
// ---------------------------------------------------------------------------

test('no production environment can ever resolve to PGlite', () => {
  const candidates: (string | undefined)[] = [
    undefined,
    '',
    '   ',
    '\n',
    'postgre://u:p@h/d',
    'postgresq://u:p@h/d',
    'mysql://u:p@h/d',
    'sqlite://./db',
    'not a url',
    '${DATABASE_URL}',
    'localhost:5432',
    'user:pw@host:5432/db',
    'POSTGRES://u@h/d',
  ];

  for (const candidate of candidates) {
    const env: EnvLike = { NODE_ENV: 'production' };
    if (candidate !== undefined) env.DATABASE_URL = candidate;

    let config: ReturnType<typeof resolveDatabaseConfig> | undefined;
    try {
      config = resolveDatabaseConfig(env);
    } catch (error) {
      assert.ok(error instanceof DatabaseConfigError);
      continue;
    }
    assert.notEqual(
      config?.driver,
      'pglite',
      `production silently fell back to PGlite for ${JSON.stringify(candidate)}`,
    );
  }
});
