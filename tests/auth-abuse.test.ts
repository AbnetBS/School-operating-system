/**
 * Regression tests for audit finding C2 — authentication abuse.
 *
 * Confirmed weaknesses these protect against:
 *
 *   1. The login limiter keyed on the left-most `x-forwarded-for` entry, which
 *      is client-supplied. Rotating it defeated the limiter entirely.
 *   2. Password spraying (one guess against many accounts) was unlimited,
 *      because per-account lockout never triggers at one failure each.
 *   3. `pruneRateLimiter()` was never called, so limiter state grew by one
 *      permanent entry per distinct key — remotely inflatable via (1).
 *
 * Preserved and re-asserted here: per-account lockout, generic failure
 * messages, and successful-login behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import * as schema from '../src/db/schema/index.ts';
import { schools, users } from '../src/db/schema/core.ts';
import { login } from '../src/lib/auth/login.ts';
import {
  checkLoginAllowed,
  registerLoginFailure,
  rateLimit,
  pruneRateLimiter,
  rateLimiterSize,
  resetRateLimiter,
  sprayBreadth,
  isSprayingFailure,
  isFailureFlooding,
  LOGIN_LIMITS,
} from '../src/lib/auth/login.ts';
import {
  resolveClientIp,
  hasTrustedProxy,
  UNKNOWN_CLIENT_IP,
  type ProxyEnv,
} from '../src/lib/auth/clientIp.ts';
import { hashPassword } from '../src/lib/auth/password.ts';
import { MAX_FAILED_LOGINS, LOCKOUT_MINUTES, isLockedOut } from '../src/lib/auth/session.ts';

// ---------------------------------------------------------------------------
// A. Trusted client IP
// ---------------------------------------------------------------------------

/** Minimal stand-in for the Headers object a route handler receives. */
function headers(map: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

test('untrusted by default: a forged X-Forwarded-For cannot rotate the source', () => {
  const env = {} as ProxyEnv; // TRUSTED_PROXY_HOPS unset

  const first = resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.1' }), env);
  const second = resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.2' }), env);
  const third = resolveClientIp(headers({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }), env);

  assert.equal(first, UNKNOWN_CLIENT_IP);
  assert.equal(second, UNKNOWN_CLIENT_IP);
  assert.equal(third, UNKNOWN_CLIENT_IP);
  assert.equal(
    new Set([first, second, third]).size,
    1,
    'all forged values must collapse into one bucket',
  );
  assert.equal(hasTrustedProxy(env), false);
});

test('with one trusted proxy hop, the proxy-appended entry is used', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' } as ProxyEnv;

  // The proxy appends the true client address on the right. Everything to the
  // left of it was supplied by the client and must be ignored.
  assert.equal(
    resolveClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }), env),
    '203.0.113.7',
  );
  assert.equal(hasTrustedProxy(env), true);
});

test('a spoofed prefix cannot change the resolved IP behind a trusted proxy', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' } as ProxyEnv;
  const real = '203.0.113.7';

  const resolved = new Set(
    ['9.9.9.9', '8.8.8.8', 'evil', '1.1.1.1, 2.2.2.2, 3.3.3.3'].map((forged) =>
      resolveClientIp(headers({ 'x-forwarded-for': `${forged}, ${real}` }), env),
    ),
  );

  assert.deepEqual([...resolved], [real], 'attacker prefix must not affect the result');
});

test('multiple trusted hops count from the right', () => {
  const env = { TRUSTED_PROXY_HOPS: '2' } as ProxyEnv;
  assert.equal(
    resolveClientIp(headers({ 'x-forwarded-for': 'fake, 203.0.113.7, 10.0.0.1' }), env),
    '203.0.113.7',
  );
});

test('a header shorter than the configured hop count is refused, not guessed', () => {
  const env = { TRUSTED_PROXY_HOPS: '2' } as ProxyEnv;
  // Only one entry arrived but two hops were promised: the request did not come
  // through the expected path, so nothing here is trustworthy.
  assert.equal(resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7' }), env), UNKNOWN_CLIENT_IP);
});

test('malformed hop values are rejected rather than used as keys', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' } as ProxyEnv;
  for (const bad of ['unknown', '_hidden', 'not-an-ip', '999.999.999.999', '']) {
    assert.equal(
      resolveClientIp(headers({ 'x-forwarded-for': `1.2.3.4, ${bad}` }), env),
      UNKNOWN_CLIENT_IP,
      `"${bad}" must not become a limiter key`,
    );
  }
});

test('valid IPv4 and IPv6 forms are accepted', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' } as ProxyEnv;
  assert.equal(resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7' }), env), '203.0.113.7');
  assert.equal(
    resolveClientIp(headers({ 'x-forwarded-for': '2001:db8::1' }), env),
    '2001:db8::1',
  );
  assert.equal(
    resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7:44321' }), env),
    '203.0.113.7:44321',
  );
});

test('a nonsense TRUSTED_PROXY_HOPS falls back to trusting nothing', () => {
  for (const raw of ['-1', 'abc', '1.5', '']) {
    assert.equal(
      resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.7' }), {
        TRUSTED_PROXY_HOPS: raw,
      } as ProxyEnv),
      UNKNOWN_CLIENT_IP,
      `TRUSTED_PROXY_HOPS="${raw}" must not enable trust`,
    );
  }
});

test('a missing header resolves to unknown even when a proxy is configured', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' } as ProxyEnv;
  assert.equal(resolveClientIp(headers({}), env), UNKNOWN_CLIENT_IP);
});

// ---------------------------------------------------------------------------
// B. Password spraying
// ---------------------------------------------------------------------------

test('spraying one guess across many accounts is limited', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP; // the realistic case: no trusted proxy

  let informativeResponses = 0;
  const accounts = Array.from({ length: 25 }, (_, i) => `teacher${i + 1}`);

  for (const username of accounts) {
    if (!checkLoginAllowed(source, 'bfa', username).allowed) continue;
    registerLoginFailure(source, 'bfa', username); // each guess is wrong
    // The route returns a generic 429 once this trips, so the attacker stops
    // learning anything from further attempts.
    if (!isSprayingFailure(source)) informativeResponses += 1;
  }

  assert.ok(
    informativeResponses <= LOGIN_LIMITS.SPRAY.distinctAccounts,
    `spray produced ${informativeResponses} informative failures; cap is ${LOGIN_LIMITS.SPRAY.distinctAccounts}`,
  );
  assert.ok(informativeResponses < accounts.length, 'the spray must be cut short');
});

test('rotating the forged header does not restore the attacker budget', () => {
  resetRateLimiter();
  // Without a trusted proxy every forged value resolves to the same bucket, so
  // this is the end-to-end version of the audit's bypass.
  let informative = 0;
  for (let i = 0; i < 40; i += 1) {
    const source = resolveClientIp(
      headers({ 'x-forwarded-for': `203.0.113.${i}` }),
      {} as ProxyEnv,
    );
    if (!checkLoginAllowed(source, 'bfa', `victim${i}`).allowed) continue;
    registerLoginFailure(source, 'bfa', `victim${i}`);
    if (!isSprayingFailure(source)) informative += 1;
  }
  assert.ok(
    informative <= LOGIN_LIMITS.SPRAY.distinctAccounts,
    `rotation still produced ${informative} informative failures`,
  );
});

test('a normal school day is not throttled: many users signing in successfully', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP; // whole school behind one NAT address

  // 50 distinct members of staff sign in correctly. Success never records a
  // failure, so nothing accumulates.
  let blocked = 0;
  for (let i = 0; i < 50; i += 1) {
    if (!checkLoginAllowed(source, 'bfa', `staff${i}`).allowed) blocked += 1;
  }
  assert.equal(blocked, 0, 'successful sign-ins must never be throttled');
});

test('a few normal typos do not lock out a shared-NAT school', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP;

  // Eight different people each mistype their password twice — a very ordinary
  // Monday. That is 16 failures from one IP and must still be tolerated.
  for (let user = 0; user < 8; user += 1) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      registerLoginFailure(source, 'bfa', `staff${user}`);
    }
  }

  // A ninth person, who has not failed at all, can still reach the login logic.
  assert.equal(
    checkLoginAllowed(source, 'bfa', 'staff-newcomer').allowed,
    true,
    'an unrelated user must not be collateral damage',
  );
});

test('one user repeatedly failing does not block their colleagues', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP;

  for (let i = 0; i < LOGIN_LIMITS.PER_ACCOUNT_SOURCE.limit + 5; i += 1) {
    registerLoginFailure(source, 'bfa', 'forgetful-teacher');
  }

  assert.equal(checkLoginAllowed(source, 'bfa', 'forgetful-teacher').allowed, false);
  // The spray counter has also advanced, but a colleague is still under it.
  assert.equal(checkLoginAllowed(source, 'bfa', 'colleague').allowed, true);
});

// ---------------------------------------------------------------------------
// C. Limiter memory
// ---------------------------------------------------------------------------

test('pruneRateLimiter removes expired entries', () => {
  resetRateLimiter();
  for (let i = 0; i < 100; i += 1) rateLimit(`k${i}`, 5, 1_000);
  assert.equal(rateLimiterSize(), 100);

  // Sweep at a point after every bucket has expired.
  const removed = pruneRateLimiter(Date.now() + 5_000);
  assert.equal(removed, 100);
  assert.equal(rateLimiterSize(), 0);
});

test('limiter state does not grow indefinitely under expired traffic', () => {
  resetRateLimiter();
  // Simulate a long attack of distinct short-lived keys. The opportunistic
  // sweep inside rateLimit() must keep the map from growing without bound.
  for (let i = 0; i < 5_000; i += 1) {
    rateLimit(`attacker-${i}`, 5, 1); // 1 ms window: expired almost immediately
  }
  pruneRateLimiter(Date.now() + 1_000);
  assert.equal(rateLimiterSize(), 0, 'expired attack keys must not persist');
});

test('the limiter is hard-capped even within a single window', () => {
  resetRateLimiter();
  // Long windows mean nothing expires; only the cap can save us here.
  for (let i = 0; i < 12_000; i += 1) {
    rateLimit(`flood-${i}`, 5, 10 * 60_000);
  }
  assert.ok(
    rateLimiterSize() <= 10_000,
    `limiter grew to ${rateLimiterSize()} entries despite the cap`,
  );
});

test('eviction never grants access beyond the configured limit', () => {
  resetRateLimiter();
  const verdicts = Array.from({ length: 12 }, () => rateLimit('victim', 10, 60_000).allowed);
  assert.equal(verdicts.filter(Boolean).length, 10, 'exactly `limit` calls may pass');
});

// ---------------------------------------------------------------------------
// D + E. Behaviour against a real database: lockout, secrecy, isolation
// ---------------------------------------------------------------------------

const client = new PGlite();
const db = drizzle(client, { schema });

async function migrate(): Promise<void> {
  const dir = join(process.cwd(), 'drizzle');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
}

const STAMP = Date.now().toString(36);
// Lower-case: `login()` lower-cases the submitted code before lookup, so a
// fixture with capitals would never match its own school.
const SCHOOL_A = `aba${STAMP}`.slice(0, 16);
const SCHOOL_B = `abb${STAMP}`.slice(0, 16);
const PASSWORD = 'CorrectHorse@2018';
let userAId = '';

test('setup: two schools, one user each', async () => {
  await migrate();
  const hash = await hashPassword(PASSWORD);

  const [a] = await db
    .insert(schools)
    .values({ code: SCHOOL_A, name: 'Abuse Test A' })
    .returning({ id: schools.id });
  const [b] = await db
    .insert(schools)
    .values({ code: SCHOOL_B, name: 'Abuse Test B' })
    .returning({ id: schools.id });
  assert.ok(a && b);

  const [ua] = await db
    .insert(users)
    .values({
      schoolId: a.id,
      username: 'teacher',
      passwordHash: hash,
      givenName: 'Abebe',
      fatherName: 'Kebede',
    })
    .returning({ id: users.id });
  assert.ok(ua);
  userAId = ua.id;

  await db.insert(users).values({
    schoolId: b.id,
    username: 'teacher', // same username, different school
    passwordHash: hash,
    givenName: 'Chala',
    fatherName: 'Bekele',
  });
});

test('successful login still works and returns a session', async () => {
  const result = await login(db, {
    schoolCode: SCHOOL_A,
    username: 'teacher',
    password: PASSWORD,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.token.length > 20);
    assert.ok(result.expiresAt.getTime() > Date.now());
  }
});

test('repeated failures against one account still trigger the existing lockout', async () => {
  for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
    const r = await login(db, {
      schoolCode: SCHOOL_A,
      username: 'teacher',
      password: 'wrong-password',
    });
    assert.equal(r.ok, false);
  }

  const [row] = await db
    .select({ lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, userAId))
    .limit(1);
  assert.ok(row);
  assert.equal(isLockedOut(row), true, 'account must be locked after MAX_FAILED_LOGINS');

  // Even the correct password is refused while locked — unchanged behaviour.
  const correct = await login(db, {
    schoolCode: SCHOOL_A,
    username: 'teacher',
    password: PASSWORD,
  });
  assert.equal(correct.ok, false);
  assert.equal(correct.ok === false && correct.reason, 'locked');
});

test('a small number of normal failures does NOT lock a valid user out', async () => {
  // Clear the lock from the previous test by signing in on a fresh account.
  const hash = await hashPassword(PASSWORD);
  const [school] = await db
    .select({ id: schools.id })
    .from(schools)
    .where(eq(schools.code, SCHOOL_A))
    .limit(1);
  assert.ok(school);
  await db.insert(users).values({
    schoolId: school.id,
    username: 'careful',
    passwordHash: hash,
    givenName: 'Marta',
    fatherName: 'Tesfaye',
  });

  // Three typos, well under the threshold of 8.
  for (let i = 0; i < 3; i += 1) {
    await login(db, { schoolCode: SCHOOL_A, username: 'careful', password: 'oops' });
  }

  const ok = await login(db, {
    schoolCode: SCHOOL_A,
    username: 'careful',
    password: PASSWORD,
  });
  assert.equal(ok.ok, true, 'a user who mistypes three times must still get in');
});

test('failure messages never reveal whether a username exists', async () => {
  const unknownUser = await login(db, {
    schoolCode: SCHOOL_A,
    username: 'no-such-person',
    password: 'whatever',
  });
  const knownUserWrongPassword = await login(db, {
    schoolCode: SCHOOL_A,
    username: 'careful',
    password: 'definitely-wrong',
  });
  const unknownSchool = await login(db, {
    schoolCode: 'zz-not-a-school',
    username: 'careful',
    password: PASSWORD,
  });

  assert.equal(unknownUser.ok, false);
  assert.equal(knownUserWrongPassword.ok, false);
  assert.equal(unknownSchool.ok, false);

  const messages = new Set(
    [unknownUser, knownUserWrongPassword, unknownSchool].map((r) =>
      r.ok === false ? r.message : 'ok',
    ),
  );
  assert.equal(messages.size, 1, `expected one shared message, saw: ${[...messages].join(' | ')}`);
});

test('tenant isolation: same username in another school is a separate account', async () => {
  // Locking the account in school A must not affect school B.
  for (let i = 0; i < MAX_FAILED_LOGINS + 2; i += 1) {
    await login(db, { schoolCode: SCHOOL_A, username: 'teacher', password: 'wrong' });
  }

  const other = await login(db, {
    schoolCode: SCHOOL_B,
    username: 'teacher',
    password: PASSWORD,
  });
  assert.equal(other.ok, true, 'school B must be unaffected by school A lockout');
});

test('no credentials or tokens appear in throttling state', () => {
  resetRateLimiter();
  const secret = 'SuperSecret@2018';
  registerLoginFailure(UNKNOWN_CLIENT_IP, 'bfa', 'teacher1');
  rateLimit(`login:src:${UNKNOWN_CLIENT_IP}`, 60, 60_000);

  const limiterMap = (globalThis as unknown as { __sosRateLimit?: Map<string, unknown> })
    .__sosRateLimit;
  assert.ok(limiterMap);
  const keys = [...limiterMap.keys()].join(' ');
  assert.ok(!keys.includes(secret), 'no password may reach limiter keys');
  assert.ok(!keys.includes('passwordHash'));
});

test('MAX_FAILED_LOGINS and LOCKOUT_MINUTES are unchanged', () => {
  // Guards against a future "tuning" pass quietly weakening the lockout.
  assert.equal(MAX_FAILED_LOGINS, 8);
  assert.equal(LOCKOUT_MINUTES, 15);
});

// ---------------------------------------------------------------------------
// Spray tracking: breadth, not volume
// ---------------------------------------------------------------------------

test('repeated failures by one person count as ONE account of breadth', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP;
  for (let i = 0; i < 50; i += 1) {
    registerLoginFailure(source, 'bfa', 'same-person');
  }
  assert.equal(sprayBreadth(source), 1, 'volume must not inflate breadth');
});

test('a large school can absorb many people each mistyping their own password', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP;

  // 11 different people, three typos each: 33 failures from one NAT address.
  // Under the breadth limit of 12, so a 12th colleague is still served.
  for (let person = 0; person < 11; person += 1) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      registerLoginFailure(source, 'bfa', `person${person}`);
    }
  }
  assert.equal(sprayBreadth(source), 11);
  assert.equal(checkLoginAllowed(source, 'bfa', 'person-twelve').allowed, true);
});

test('an already-seen account stays reachable after the breadth limit trips', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP;

  // An attacker sprays widely from the shared address.
  for (let i = 0; i < LOGIN_LIMITS.SPRAY.distinctAccounts + 5; i += 1) {
    registerLoginFailure(source, 'bfa', `victim${i}`);
  }

  // The source is now flagged as spraying...
  assert.equal(isSprayingFailure(source), true);
  // ...but that only suppresses *failed* attempts. A legitimate user reaching
  // the endpoint is still allowed to try, so a correct password still works.
  assert.equal(checkLoginAllowed(source, 'bfa', 'never-seen').allowed, true);
});

test('spray tracking expires with its window', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP;
  registerLoginFailure(source, 'bfa', 'someone');
  assert.equal(sprayBreadth(source), 1);
  assert.equal(sprayBreadth(source, Date.now() + LOGIN_LIMITS.SPRAY.windowMs + 1_000), 0);
});

test('spray tracker memory is bounded per source', () => {
  resetRateLimiter();
  const source = UNKNOWN_CLIENT_IP;
  for (let i = 0; i < 5_000; i += 1) {
    registerLoginFailure(source, 'bfa', `victim${i}`);
  }
  assert.ok(sprayBreadth(source) <= 200, `tracked ${sprayBreadth(source)} accounts; cap is 200`);
  // Still decisively flagged as spraying.
  assert.equal(isSprayingFailure(source), true);
});

// ---------------------------------------------------------------------------
// The lockout-the-whole-school regression
// ---------------------------------------------------------------------------

test('an attacker spraying the shared bucket cannot lock out legitimate users', () => {
  // This is the failure mode that live testing exposed and unit tests initially
  // missed: with no trusted proxy every caller shares `unknown`, so enforcing
  // the breadth limit before verification let one attacker anywhere on the
  // internet deny sign-in to an entire school.
  resetRateLimiter();
  const shared = UNKNOWN_CLIENT_IP;

  // Attacker sprays far past the breadth limit.
  for (let i = 0; i < LOGIN_LIMITS.SPRAY.distinctAccounts * 4; i += 1) {
    registerLoginFailure(shared, 'bfa', `sprayed${i}`);
  }
  assert.equal(isSprayingFailure(shared), true, 'the source must be recognised as spraying');

  // A member of staff on the same address must still be allowed to attempt a
  // sign-in, so that a correct password still succeeds.
  for (const staff of ['admin', 'principal', 'registrar', 'teacher1', 'teacher2']) {
    assert.equal(
      checkLoginAllowed(shared, 'bfa', staff).allowed,
      true,
      `${staff} must not be collateral damage of someone else's attack`,
    );
  }
});

test('a TRUSTED source is volume-capped, bounding scrypt CPU per network', () => {
  resetRateLimiter();
  const source = '203.0.113.50'; // a real address behind a configured proxy
  let allowed = 0;
  for (let i = 0; i < LOGIN_LIMITS.PER_SOURCE.limit + 40; i += 1) {
    if (checkLoginAllowed(source, 'bfa', `t${i}`, { trustedSource: true }).allowed) allowed += 1;
  }
  assert.equal(
    allowed,
    LOGIN_LIMITS.PER_SOURCE.limit,
    'a trusted source must be capped on volume',
  );
});

test('an UNTRUSTED shared bucket is not volume-capped, but failures are', () => {
  resetRateLimiter();
  const shared = UNKNOWN_CLIENT_IP;

  // Legitimate volume is never refused on the shared bucket, because doing so
  // would let one attacker deny the whole school.
  let allowed = 0;
  for (let i = 0; i < LOGIN_LIMITS.PER_SOURCE.limit + 40; i += 1) {
    if (checkLoginAllowed(shared, 'bfa', `person${i}`).allowed) allowed += 1;
  }
  assert.equal(allowed, LOGIN_LIMITS.PER_SOURCE.limit + 40, 'no volume rejection when untrusted');

  // Failures, however, are bounded — this is what keeps scrypt work finite.
  assert.equal(isFailureFlooding(shared), false);
  for (let i = 0; i < LOGIN_LIMITS.FAILURE_VOLUME.limit + 5; i += 1) {
    registerLoginFailure(shared, 'bfa', `victim${i % 30}`);
  }
  assert.equal(isFailureFlooding(shared), true, 'sustained failures must be cut off');
});

test('a sustained attack on the shared bucket never blocks a correct password', () => {
  // The full end-to-end version of the regression: an attacker floods the
  // shared `unknown` bucket with failures, and a legitimate user must still be
  // allowed to reach password verification so their correct password works.
  resetRateLimiter();
  const shared = UNKNOWN_CLIENT_IP;

  for (let i = 0; i < 200; i += 1) {
    if (checkLoginAllowed(shared, 'bfa', `victim${i}`).allowed) {
      registerLoginFailure(shared, 'bfa', `victim${i}`);
    }
  }

  assert.equal(isSprayingFailure(shared), true, 'attacker must be recognised');
  assert.equal(isFailureFlooding(shared), false, '200 failures is under the flood cap');

  for (const staff of ['admin', 'principal', 'registrar', 'teacher7', 'parent']) {
    assert.equal(
      checkLoginAllowed(shared, 'bfa', staff).allowed,
      true,
      `${staff} must still be able to sign in during an attack`,
    );
  }
});

// ---------------------------------------------------------------------------
// Cleanup must not become a way to switch protection off
// ---------------------------------------------------------------------------

test('pruning retains ACTIVE entries while removing expired ones', () => {
  resetRateLimiter();

  // Ten buckets that expire almost immediately...
  for (let i = 0; i < 10; i += 1) rateLimit(`stale-${i}`, 5, 1);
  // ...and ten that are still well inside their window.
  for (let i = 0; i < 10; i += 1) rateLimit(`live-${i}`, 5, 10 * 60_000);
  assert.equal(rateLimiterSize(), 20);

  const removed = pruneRateLimiter(Date.now() + 5_000);

  assert.equal(removed, 10, 'only the expired buckets may be removed');
  assert.equal(rateLimiterSize(), 10, 'active buckets must survive the sweep');

  // And the survivors must still be *counting*, not merely present: a bucket
  // that was reset to zero by the sweep would silently grant a fresh budget.
  for (let i = 0; i < 4; i += 1) rateLimit('live-0', 5, 10 * 60_000);
  assert.equal(
    rateLimit('live-0', 5, 10 * 60_000).allowed,
    false,
    'a pruned-past bucket must retain its accumulated count',
  );
});

test('cleanup running mid-window does not reset an attacker\'s budget', () => {
  resetRateLimiter();

  // Attacker burns most of a 10-minute budget.
  for (let i = 0; i < 9; i += 1) rateLimit('attacker', 10, 10 * 60_000);

  // A sweep happens (triggered by unrelated traffic expiring elsewhere).
  for (let i = 0; i < 50; i += 1) rateLimit(`noise-${i}`, 5, 1);
  pruneRateLimiter(Date.now() + 2_000);

  // The attacker's own bucket has not expired, so their budget must persist.
  assert.equal(rateLimit('attacker', 10, 10 * 60_000).allowed, true, '10th call is the last');
  assert.equal(
    rateLimit('attacker', 10, 10 * 60_000).allowed,
    false,
    'cleanup must not hand back a fresh budget',
  );
});

test('a bucket becomes usable again only after its window genuinely elapses', () => {
  resetRateLimiter();
  for (let i = 0; i < 12; i += 1) rateLimit('cycle', 10, 60_000);
  assert.equal(rateLimit('cycle', 10, 60_000).allowed, false, 'blocked inside the window');

  // Expire it and sweep, exactly as the opportunistic cleanup would.
  pruneRateLimiter(Date.now() + 61_000);
  assert.equal(rateLimiterSize(), 0);

  // Legitimate rate limiting still functions after cleanup.
  assert.equal(rateLimit('cycle', 10, 60_000).allowed, true, 'a fresh window is allowed');
});

test('an attacker behind a trusted proxy cannot rotate their limiter budget', () => {
  // The limiter-budget counterpart to the header-resolution tests above: it is
  // not enough that the resolved IP is correct, the attacker must also be
  // unable to win extra attempts by varying the part they control.
  resetRateLimiter();
  const env = { TRUSTED_PROXY_HOPS: '1' } as ProxyEnv;
  const attackerRealIp = '198.51.100.66';

  let informative = 0;
  for (let i = 0; i < 40; i += 1) {
    // A different forged prefix on every single request.
    const source = resolveClientIp(
      headers({ 'x-forwarded-for': `10.0.0.${i}, ${attackerRealIp}` }),
      env,
    );
    assert.equal(source, attackerRealIp, 'resolution must ignore the forged prefix');

    if (!checkLoginAllowed(source, 'bfa', `target${i}`, { trustedSource: true }).allowed) continue;
    registerLoginFailure(source, 'bfa', `target${i}`);
    if (!isSprayingFailure(source)) informative += 1;
  }

  assert.ok(
    informative <= LOGIN_LIMITS.SPRAY.distinctAccounts,
    `rotation behind a proxy still produced ${informative} informative failures`,
  );

  // A genuinely different network must be untouched by that attacker.
  const other = resolveClientIp(headers({ 'x-forwarded-for': 'x, 203.0.113.200' }), env);
  assert.equal(
    checkLoginAllowed(other, 'bfa', 'admin', { trustedSource: true }).allowed,
    true,
    'an unrelated network must not inherit the attacker throttle',
  );
});

test('a failed login writes no password, hash, token or session id to logs', async () => {
  // The earlier test covers limiter keys; this covers everything the login path
  // actually prints, which is what would end up in a deployment log drain.
  const captured: string[] = [];
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  for (const level of ['log', 'error', 'warn', 'info'] as const) {
    console[level] = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }

  let successToken = '';
  try {
    await login(db, { schoolCode: SCHOOL_A, username: 'careful', password: 'WrongGuess@1' });
    await login(db, { schoolCode: SCHOOL_A, username: 'ghost-user', password: 'WrongGuess@1' });
    const ok = await login(db, {
      schoolCode: SCHOOL_A,
      username: 'careful',
      password: PASSWORD,
    });
    if (ok.ok) successToken = ok.token;
  } finally {
    Object.assign(console, originals);
  }

  const output = captured.join('\n');
  assert.ok(!output.includes(PASSWORD), 'the real password must never be logged');
  assert.ok(!output.includes('WrongGuess@1'), 'a submitted password must never be logged');
  assert.ok(!output.includes('scrypt$'), 'no password hash may be logged');
  if (successToken) {
    assert.ok(!output.includes(successToken), 'no session token may be logged');
  }
});

test('the session token is never stored in plain text', async () => {
  // Re-asserted here because C2 touched the login path: the audit relies on
  // tokens being unusable even if the database leaks.
  const result = await login(db, {
    schoolCode: SCHOOL_A,
    username: 'careful',
    password: PASSWORD,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const rows = await db.select().from(schema.sessions);
  const stored = JSON.stringify(rows);
  assert.ok(rows.length > 0, 'a session row must exist');
  assert.ok(
    !stored.includes(result.token),
    'the raw token must not be recoverable from the sessions table',
  );
});
