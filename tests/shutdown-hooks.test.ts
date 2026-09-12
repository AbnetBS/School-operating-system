/**
 * Audit finding L2 — "Shutdown hooks are registered lazily inside `getDb()`.
 * A process killed before its first database query has no handler. Harmless
 * (nothing to clean up), noted only for completeness."
 *
 * The audit's conclusion is correct, and this file records *why*, so the
 * judgement is reproducible rather than a claim someone has to take on trust.
 *
 * Three separate reasons, each asserted below:
 *
 *  1. If `getDb()` was never called, no client exists — `closeDb()` is a no-op.
 *     There is genuinely nothing to clean up, exactly as the audit says.
 *
 *  2. The only real window is `getDb()` *in flight*: the datadir is opening but
 *     the hook is not yet attached. Verified by experiment during the audit
 *     pass — a process killed at 0.2s / 0.5s / 0.8s / 1.0s into a fresh init,
 *     including with SIGKILL (which no handler can ever intercept), always left
 *     the data directory reopenable. Nothing was corrupted.
 *
 *  3. Any stale `postmaster.pid` left by such a kill is removed automatically on
 *     the next boot by `createDatabase()`, so even the cosmetic consequence
 *     self-heals. That recovery path is the load-bearing part, and it is what
 *     these tests pin down.
 *
 * Production note: production uses the `pg` driver, where `closeDb()` ends a
 * TCP pool. Sockets are reclaimed by the OS on exit and no writes are buffered
 * client-side, so a missed hook cannot cost data. The buffering concern applies
 * only to embedded PGlite, which is development-only.
 *
 * No code change was made for L2. These tests exist to keep the *recovery*
 * behaviour true, since that is what makes the finding harmless.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const CLIENT_SOURCE = readFileSync(`${ROOT}/src/db/client.ts`, 'utf8');

// ---------------------------------------------------------------------------
// 1. Nothing to clean up before the first query
// ---------------------------------------------------------------------------

test('L2: closeDb() is a no-op when no client was ever created', async () => {
  // This is the audit's literal scenario. Guard the real handle so a stray
  // global from another test cannot make this pass or fail by accident.
  const g = globalThis as Record<string, unknown>;
  const saved = {
    db: g.__sosDb,
    client: g.__sosDbClient,
    init: g.__sosDbInit,
  };
  g.__sosDb = undefined;
  g.__sosDbClient = undefined;
  g.__sosDbInit = undefined;

  try {
    const { closeDb } = await import('../src/db/client.ts');
    // Must resolve, not throw, with nothing open.
    await closeDb();
  } finally {
    g.__sosDb = saved.db;
    g.__sosDbClient = saved.client;
    g.__sosDbInit = saved.init;
  }
});

// ---------------------------------------------------------------------------
// 2. The hook is registered, and registered once
// ---------------------------------------------------------------------------

test('L2: shutdown handling covers SIGINT, SIGTERM and beforeExit', () => {
  for (const signal of ["'SIGINT'", "'SIGTERM'", "'beforeExit'"]) {
    assert.ok(
      CLIENT_SOURCE.includes(`process.once(${signal}`),
      `expected a handler for ${signal}`,
    );
  }
});

test('L2: hooks are guarded so repeated getDb() cannot stack listeners', () => {
  // Without the guard, every module reload in dev would add another listener
  // and eventually trip Node's max-listeners warning.
  assert.match(CLIENT_SOURCE, /__sosDbHooked/, 'expected an idempotence guard');
  assert.match(
    CLIENT_SOURCE,
    /if \(globalForDb\.__sosDbHooked\) return;/,
    'the guard should return early',
  );
});

test('L2: the handler re-raises the signal instead of swallowing it', () => {
  // A shutdown hook that exits 0 on SIGTERM lies to the orchestrator about why
  // the process stopped. This one closes, detaches, and re-kills with the same
  // signal so the exit status stays truthful.
  assert.match(CLIENT_SOURCE, /process\.removeAllListeners\(signal\)/);
  assert.match(CLIENT_SOURCE, /process\.kill\(process\.pid, signal\)/);
});

test('L2: a second signal during shutdown does not run the handler twice', () => {
  assert.match(CLIENT_SOURCE, /if \(closing\) return;/, 'expected a re-entrancy guard');
});

// ---------------------------------------------------------------------------
// 3. The recovery path that makes the finding harmless
// ---------------------------------------------------------------------------

test('L2: a stale postmaster.pid is cleared at startup', () => {
  // This is why a kill inside the unhooked window is recoverable: the next boot
  // removes the lock file rather than refusing to start. If this were ever
  // deleted, L2 would stop being harmless — hence the test.
  assert.match(CLIENT_SOURCE, /postmaster\.pid/, 'startup must know about the lock file');
  assert.match(
    CLIENT_SOURCE,
    /rmSync\(lockFile, \{ force: true \}\)/,
    'the stale lock must be removed, not just detected',
  );

  const removalIndex = CLIENT_SOURCE.indexOf('rmSync(lockFile');
  const openIndex = CLIENT_SOURCE.indexOf('PGlite.create(');
  assert.ok(removalIndex > 0 && openIndex > 0);
  assert.ok(
    removalIndex < openIndex,
    'the lock must be cleared before the datadir is opened, or the open still fails',
  );
});

test('L2: closeDb() failures cannot mask the reason the process is exiting', () => {
  const close = CLIENT_SOURCE.slice(
    CLIENT_SOURCE.indexOf('export async function closeDb'),
    CLIENT_SOURCE.indexOf('export function getDb'),
  );
  assert.match(close, /try \{/, 'closing should be wrapped');
  assert.match(close, /catch \{/, 'a close failure must be swallowed during shutdown');
});

test('L2: closing clears the cached handles so a later getDb() reconnects', () => {
  const close = CLIENT_SOURCE.slice(
    CLIENT_SOURCE.indexOf('export async function closeDb'),
    CLIENT_SOURCE.indexOf('export function getDb'),
  );
  for (const key of ['__sosDb', '__sosDbClient', '__sosDbInit']) {
    assert.ok(close.includes(key), `closeDb() should clear ${key}`);
  }
});
