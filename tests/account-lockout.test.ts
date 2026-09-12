/**
 * Audit finding L3 — "Account lockout is a mild self-DoS vector. 8 failed
 * attempts locks any known username. Auto-unlock after 15 minutes bounds the
 * damage; the security tradeoff is correct as-is. No change recommended."
 *
 * The audit's judgement is correct and no code was changed. But the judgement
 * only holds while two specific properties remain true, and neither was covered
 * by a test:
 *
 *   1. **The lock cannot be extended.** A locked account returns early, before
 *      the password is verified and before the failure counter is touched. If
 *      that order were ever reversed, an attacker hammering a headteacher's
 *      username would push the unlock time forward forever — turning a bounded
 *      15-minute annoyance into a permanent denial of service. That would be a
 *      real defect, not a mild one.
 *
 *   2. **The lock actually expires.** `isLockedOut()` is a timestamp
 *      comparison, so the account frees itself with no administrator action.
 *      If it became a boolean flag, every locked-out teacher would need manual
 *      intervention — plausible in a school with no on-site IT staff.
 *
 * Verified live during the audit pass against the seeded database: attempts
 * 1–8 returned `invalid`, attempt 9 returned `locked`, ten further attempts
 * left `locked_until` byte-identical, and after expiry the correct password
 * signed in and reset the counter to zero.
 *
 * These tests exist so that reasoning cannot silently rot. `tests/auth-abuse.ts`
 * already covers "does it lock" and "is the correct password refused while
 * locked"; this file covers the two properties that make the risk acceptable.
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
import { hashPassword } from '../src/lib/auth/password.ts';
import { MAX_FAILED_LOGINS, LOCKOUT_MINUTES, isLockedOut } from '../src/lib/auth/session.ts';

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
// Lower-case: login() lower-cases the submitted code before lookup.
const SCHOOL = `lo3${STAMP}`.slice(0, 16);
const PASSWORD = 'CorrectHorse@2018';
let userId = '';

async function failOnce(username = 'headteacher'): Promise<void> {
  await login(db, { schoolCode: SCHOOL, username, password: 'wrong-password' });
}

async function lockedUntil(): Promise<Date | null> {
  const [row] = await db
    .select({ lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.lockedUntil ?? null;
}

test('setup: one school, one account', async () => {
  await migrate();
  const [school] = await db
    .insert(schools)
    .values({ code: SCHOOL, name: 'Lockout Test School' })
    .returning({ id: schools.id });
  assert.ok(school);

  const [user] = await db
    .insert(users)
    .values({
      schoolId: school.id,
      username: 'headteacher',
      passwordHash: await hashPassword(PASSWORD),
      givenName: 'Almaz',
      fatherName: 'Desta',
    })
    .returning({ id: users.id });
  assert.ok(user);
  userId = user.id;
});

// ---------------------------------------------------------------------------
// The documented behaviour
// ---------------------------------------------------------------------------

test('L3: the threshold is exactly MAX_FAILED_LOGINS, not one earlier', async () => {
  // A school with a shared staff-room computer will hit a few typos a day.
  // Locking early would make the system feel broken.
  for (let i = 0; i < MAX_FAILED_LOGINS - 1; i += 1) await failOnce();

  assert.equal(
    isLockedOut({ lockedUntil: await lockedUntil() }),
    false,
    `must not lock before ${MAX_FAILED_LOGINS} failures`,
  );

  await failOnce();
  assert.equal(isLockedOut({ lockedUntil: await lockedUntil() }), true);
});

test('L3: the lock is ~LOCKOUT_MINUTES away, not indefinite', async () => {
  const until = await lockedUntil();
  assert.ok(until, 'expected the account to be locked from the previous test');

  const minutesAway = (until.getTime() - Date.now()) / 60_000;
  assert.ok(
    minutesAway > LOCKOUT_MINUTES - 2 && minutesAway <= LOCKOUT_MINUTES,
    `expected ~${LOCKOUT_MINUTES} minutes, got ${minutesAway.toFixed(1)}`,
  );
});

// ---------------------------------------------------------------------------
// Property 1: the lock cannot be extended — this is what bounds the damage
// ---------------------------------------------------------------------------

test('CRITICAL: hammering a locked account does not extend the lockout', async () => {
  const before = await lockedUntil();
  assert.ok(before, 'precondition: the account is locked');

  // A persistent attacker. If any of these pushed the deadline out, the
  // "15 minutes" bound would be fiction and this finding would be a real DoS.
  for (let i = 0; i < 15; i += 1) await failOnce();

  const after = await lockedUntil();
  assert.ok(after);
  assert.equal(
    after.getTime(),
    before.getTime(),
    'a locked account must return before the failure counter is touched',
  );
});

test('CRITICAL: the failure counter is not incremented while locked', async () => {
  // The counter is reset to 0 when the lock is applied. If failures kept
  // counting during the lock, the next unlock would relock almost immediately.
  const [row] = await db
    .select({ count: users.failedLoginCount })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  assert.ok(row);
  assert.equal(row.count, 0, 'attempts during a lock must not accumulate');
});

test('L3: a locked account reports "locked", not a generic failure', async () => {
  // The user is told to wait rather than left guessing at their own password.
  // This leaks only that the account exists, which the lock itself implies.
  const result = await login(db, {
    schoolCode: SCHOOL,
    username: 'headteacher',
    password: PASSWORD,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'locked');
});

// ---------------------------------------------------------------------------
// Property 2: it frees itself — no administrator required
// ---------------------------------------------------------------------------

test('CRITICAL: the lock expires on its own and the correct password works', async () => {
  // Simulate the 15 minutes passing rather than waiting for them.
  await db
    .update(users)
    .set({ lockedUntil: new Date(Date.now() - 60_000) })
    .where(eq(users.id, userId));

  const result = await login(db, {
    schoolCode: SCHOOL,
    username: 'headteacher',
    password: PASSWORD,
  });

  assert.equal(result.ok, true, 'auto-unlock must need no administrator action');
});

test('L3: a successful sign-in clears both the counter and the lock', async () => {
  const [row] = await db
    .select({ count: users.failedLoginCount, lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  assert.ok(row);
  assert.equal(row.count, 0);
  assert.equal(row.lockedUntil, null);
});

test('L3: locking one account does not lock another in the same school', async () => {
  // The self-DoS is bounded to the targeted username. If it spread, one
  // attacker could lock an entire staff room out at once.
  const [school] = await db
    .select({ id: schools.id })
    .from(schools)
    .where(eq(schools.code, SCHOOL))
    .limit(1);
  assert.ok(school);

  await db.insert(users).values({
    schoolId: school.id,
    username: 'registrar',
    passwordHash: await hashPassword(PASSWORD),
    givenName: 'Bereket',
    fatherName: 'Worku',
  });

  for (let i = 0; i < MAX_FAILED_LOGINS + 3; i += 1) await failOnce('headteacher');

  const stillWorks = await login(db, {
    schoolCode: SCHOOL,
    username: 'registrar',
    password: PASSWORD,
  });
  assert.equal(stillWorks.ok, true, 'an unrelated account must be unaffected');
});
