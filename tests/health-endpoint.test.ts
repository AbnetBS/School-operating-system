/**
 * Regression tests for audit finding M5 — no health/readiness endpoint.
 *
 * Without one, a process that is alive but cannot reach the database is
 * indistinguishable from a healthy one, so a load balancer keeps sending it
 * traffic and a rolling deploy promotes a broken release.
 *
 * The valuable property is not "returns 200" — that is trivial and worthless.
 * It is that the endpoint returns **503 when the database is genuinely
 * unreachable**, so these tests exercise that path rather than only the happy
 * one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROUTE = 'src/app/api/health/route.ts';

async function callHealth(url: string) {
  const { GET } = await import('../src/app/api/health/route.ts');
  const response = await GET(new Request(url));
  return { response, body: (await response.clone().json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Readiness against a working database
// ---------------------------------------------------------------------------

test('readiness returns 200 when the database answers', async () => {
  const { response, body } = await callHealth('http://localhost/api/health');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.checks, { database: 'ok' });
});

test('readiness reports how long the check took', async () => {
  const { body } = await callHealth('http://localhost/api/health');
  assert.equal(typeof body.durationMs, 'number');
  assert.ok((body.durationMs as number) >= 0);
});

test('the response is never cached', async () => {
  // A cached health check reports stale state, which is worse than none.
  const { response } = await callHealth('http://localhost/api/health');
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
});

// ---------------------------------------------------------------------------
// Liveness is separate from readiness
// ---------------------------------------------------------------------------

test('liveness answers without touching the database', async () => {
  const { response, body } = await callHealth('http://localhost/api/health?live=1');
  assert.equal(response.status, 200);
  assert.equal(body.check, 'liveness');
  // No dependency results: a database outage must not restart the process.
  assert.equal(body.checks, undefined);
});

test('readiness and liveness are distinguishable by the caller', async () => {
  const ready = await callHealth('http://localhost/api/health');
  const live = await callHealth('http://localhost/api/health?live=1');
  assert.equal(ready.body.check, 'readiness');
  assert.equal(live.body.check, 'liveness');
});

// ---------------------------------------------------------------------------
// The part that actually matters: a broken database must fail the probe
// ---------------------------------------------------------------------------

/**
 * The database handle is pinned on `globalThis` by `getDb()`, so pointing the
 * environment at a dead server is not enough — the cached healthy handle would
 * be reused and the probe would wrongly report success. (That is exactly what
 * happened the first time this test was written.) Clearing the pin forces a
 * genuine reconnect attempt.
 */
function withClearedDbHandle<T>(run: () => Promise<T>): Promise<T> {
  const holder = globalThis as unknown as {
    __sosDb?: unknown;
    __sosDbClient?: unknown;
    __sosDbInit?: unknown;
  };
  const saved = {
    db: holder.__sosDb,
    client: holder.__sosDbClient,
    init: holder.__sosDbInit,
  };
  holder.__sosDb = undefined;
  holder.__sosDbClient = undefined;
  holder.__sosDbInit = undefined;

  return run().finally(() => {
    holder.__sosDb = saved.db;
    holder.__sosDbClient = saved.client;
    holder.__sosDbInit = saved.init;
  });
}

test('readiness returns 503 when the database cannot be reached', async () => {
  // Point the app at an unreachable PostgreSQL server, with no cached handle to
  // fall back on, so this exercises the real failure path rather than a stub.
  const previousEnv = { ...process.env };
  // NODE_ENV is typed read-only; this test genuinely needs the real
  // process.env, because getDb() reads it directly.
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = 'production';
  mutableEnv.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:59999/absent';

  try {
    await withClearedDbHandle(async () => {
      const suffix = `m5-${Date.now()}`;
      const { GET } = (await import(
        `../src/app/api/health/route.ts?${suffix}`
      )) as typeof import('../src/app/api/health/route.ts');

      const response = await GET(new Request('http://localhost/api/health'));
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 503, 'a load balancer must be told to drain this instance');
      assert.equal(body.status, 'unavailable');
      assert.deepEqual(body.checks, { database: 'unavailable' });
    });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});

test('a failing readiness check leaks no diagnostic detail', async () => {
  const previousEnv = { ...process.env };
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = 'production';
  mutableEnv.DATABASE_URL = 'postgresql://secretuser:hunter2@db.internal:5432/school';

  try {
    await withClearedDbHandle(async () => {
      const suffix = `m5leak-${Date.now()}`;
      const { GET } = (await import(
        `../src/app/api/health/route.ts?${suffix}`
      )) as typeof import('../src/app/api/health/route.ts');

      const response = await GET(new Request('http://localhost/api/health'));
      const text = await response.text();

      // The endpoint is public, so the body must not become a recon tool.
      for (const secret of ['hunter2', 'secretuser', 'db.internal', 'postgres', 'ECONNREFUSED']) {
        assert.ok(!text.includes(secret), `health body must not disclose "${secret}"`);
      }
    });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});

// ---------------------------------------------------------------------------
// Shape of the implementation
// ---------------------------------------------------------------------------

test('the probe is bounded by a timeout', async () => {
  // A hung connection must fail the check, not hang the orchestrator.
  const source = await readFile(ROUTE, 'utf8');
  assert.match(source, /DATABASE_TIMEOUT_MS/);
  assert.match(source, /Promise\.race/);
});

test('the readiness query is the cheapest possible', async () => {
  // A probe that runs real work becomes a denial-of-service amplifier, since
  // it is unauthenticated and called every few seconds.
  const source = await readFile(ROUTE, 'utf8');
  assert.match(source, /select 1/i);
  assert.ok(!/from\s+students|from\s+users|count\(/i.test(source), 'must not query real tables');
});

test('the endpoint requires no authentication', async () => {
  // A probe cannot hold a session; requiring auth would make it useless.
  const source = await readFile(ROUTE, 'utf8');
  assert.ok(!source.includes('requireAuth'), 'a health probe must not require a session');
});

test('the health route exposes only GET', async () => {
  const module = await import('../src/app/api/health/route.ts');
  assert.equal(typeof (module as Record<string, unknown>).GET, 'function');
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    assert.equal(
      (module as Record<string, unknown>)[method],
      undefined,
      `a probe endpoint must not expose ${method}`,
    );
  }
});
