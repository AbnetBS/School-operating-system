/**
 * Sign-in logic.
 *
 * Kept separate from the route handler so it can be tested directly and reused
 * (e.g. by a future mobile API).
 *
 * Security properties enforced here:
 *   - The same generic failure message for unknown user, wrong password and
 *     wrong school, so the form cannot be used to enumerate accounts.
 *   - A password verification is performed even when the user does not exist,
 *     so response timing does not reveal whether a username is valid.
 *   - Failed attempts are counted and the account locks temporarily.
 *   - Both the success and the failure are written to the audit log.
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { schools, users } from '../../db/schema/core.ts';
import { verifyPassword, hashPassword } from './password.ts';
import {
  createSession,
  registerFailedLogin,
  clearFailedLogins,
  isLockedOut,
  SESSION_TTL_HOURS,
} from './session.ts';
import { recordAudit } from '../audit/index.ts';

/**
 * A dummy hash used when the username is unknown. Verifying against it costs
 * the same as a real check, which removes the timing signal that would
 * otherwise let an attacker enumerate valid usernames.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-constant-time-comparison');
  return dummyHashPromise;
}

export type LoginInput = {
  schoolCode: string;
  username: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; userId: string; mustChangePassword: boolean }
  | { ok: false; reason: 'invalid' | 'locked' | 'disabled'; message: string };

const GENERIC_FAILURE = 'The school, username or password is incorrect.';

export async function login(db: Database, input: LoginInput): Promise<LoginResult> {
  const schoolCode = input.schoolCode.trim().toLowerCase();
  const username = input.username.trim().toLowerCase();

  const [school] = await db
    .select({ id: schools.id, isActive: schools.isActive, name: schools.name })
    .from(schools)
    .where(eq(schools.code, schoolCode))
    .limit(1);

  // Unknown school: still spend the time on a hash comparison.
  if (!school) {
    await verifyPassword(input.password, await getDummyHash());
    return { ok: false, reason: 'invalid', message: GENERIC_FAILURE };
  }

  if (!school.isActive) {
    await verifyPassword(input.password, await getDummyHash());
    return {
      ok: false,
      reason: 'disabled',
      message: 'This school account is not active. Please contact support.',
    };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.schoolId, school.id), eq(users.username, username)))
    .limit(1);

  if (!user) {
    await verifyPassword(input.password, await getDummyHash());
    await recordAudit(db, {
      schoolId: school.id,
      actorName: username,
      action: 'auth.loginFailed',
      entityType: 'user',
      summary: `Unknown username "${username}"`,
      ipAddress: input.ipAddress ?? null,
    });
    return { ok: false, reason: 'invalid', message: GENERIC_FAILURE };
  }

  if (isLockedOut(user)) {
    return {
      ok: false,
      reason: 'locked',
      message: 'Too many failed attempts. Please try again in a few minutes.',
    };
  }

  if (!user.isActive) {
    return {
      ok: false,
      reason: 'disabled',
      message: 'This account has been disabled. Contact your administrator.',
    };
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    await registerFailedLogin(db, user.id);
    await recordAudit(db, {
      schoolId: school.id,
      actorUserId: user.id,
      actorName: [user.givenName, user.fatherName].filter(Boolean).join(' '),
      action: 'auth.loginFailed',
      entityType: 'user',
      entityId: user.id,
      summary: 'Incorrect password',
      ipAddress: input.ipAddress ?? null,
    });
    return { ok: false, reason: 'invalid', message: GENERIC_FAILURE };
  }

  await clearFailedLogins(db, user.id);
  const { token, expiresAt } = await createSession(db, {
    userId: user.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    ttlHours: SESSION_TTL_HOURS,
  });

  await recordAudit(db, {
    schoolId: school.id,
    actorUserId: user.id,
    actorName: [user.givenName, user.fatherName].filter(Boolean).join(' '),
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    summary: `Signed in to ${school.name}`,
    ipAddress: input.ipAddress ?? null,
  });

  return {
    ok: true,
    token,
    expiresAt,
    userId: user.id,
    mustChangePassword: user.mustChangePassword,
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * A small in-process rate limiter for the login endpoint.
 *
 * ## Scope
 *
 * This protects a single Node process. The application currently runs as one
 * process (there is no SSE, no cron, and every other cache in the codebase is
 * per-process), so an in-memory limiter is the honest match for the
 * architecture. A multi-instance deployment would need shared state — see
 * `LIMITER_LIMITATIONS` below and the note in the operations runbook. The
 * interface is deliberately narrow so that swap stays easy.
 *
 * ## Memory
 *
 * Bounded two ways: expired buckets are swept opportunistically, and the map is
 * hard-capped. Before this fix `pruneRateLimiter()` existed but was never
 * called from anywhere, so the map grew by one permanent entry per distinct key
 * for the lifetime of the process — and because the key was an
 * attacker-controlled header, it was remotely inflatable.
 */
type Bucket = { count: number; resetAt: number };

const globalForLimiter = globalThis as unknown as { __sosRateLimit?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (globalForLimiter.__sosRateLimit ??= new Map());

/**
 * Hard ceiling on tracked keys.
 *
 * Reached only under attack: legitimate traffic for one school is a handful of
 * keys. If it is ever hit, the sweep below runs and — if that does not free
 * space — the oldest entries are evicted. Eviction can only ever *forget* an
 * attacker's counter, never bypass the per-account lockout, which lives in the
 * database.
 */
const MAX_TRACKED_KEYS = 10_000;

/** Sweep at most this often, so a burst does not trigger a scan per request. */
const SWEEP_INTERVAL_MS = 30_000;
let lastSweepAt = 0;

/**
 * Drop expired buckets.
 *
 * Called opportunistically from `rateLimit()` (see `maybeSweep`) and exported
 * so tests and any future scheduled task can invoke it directly.
 */
export function pruneRateLimiter(now = Date.now()): number {
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
      removed += 1;
    }
  }
  lastSweepAt = now;
  return removed;
}

/**
 * Time-boxed sweep plus a hard cap.
 *
 * The cap matters because a sweep only removes *expired* buckets; a flood of
 * distinct keys inside a single window would otherwise still grow unbounded.
 * Map preserves insertion order, so deleting from the front evicts the oldest.
 */
function maybeSweep(now: number): void {
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    pruneRateLimiter(now);
  }

  // `maybeSweep` runs before the caller inserts its key, so leave room for
  // that one entry. Without the -1 the map settles at MAX_TRACKED_KEYS + 1.
  if (buckets.size < MAX_TRACKED_KEYS) return;

  pruneRateLimiter(now);

  let overflow = buckets.size - (MAX_TRACKED_KEYS - 1);
  if (overflow <= 0) return;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    overflow -= 1;
    if (overflow <= 0) break;
  }
}

export function rateLimit(
  key: string,
  limit = 10,
  windowMs = 60_000,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  maybeSweep(now);

  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Current number of tracked keys. Exposed for tests and diagnostics. */
export function rateLimiterSize(): number {
  return buckets.size;
}

/** Reset all limiter state. Test-only helper; not called by application code. */
export function resetRateLimiter(): void {
  buckets.clear();
  sprayTracker.clear();
  lastSweepAt = 0;
}

// ---------------------------------------------------------------------------
// Login throttling policy
// ---------------------------------------------------------------------------

/**
 * Thresholds for the login endpoint.
 *
 * These are tuned for a *school*, where hundreds of staff and parents share one
 * public IP over NAT and a Monday-morning rush is normal traffic, not an
 * attack. The per-IP number is therefore generous; the protection that actually
 * stops spraying is `SPRAY` below, which counts only *failures*.
 */
export const LOGIN_LIMITS = {
  /**
   * All login traffic from one resolved source. Deliberately high: a school
   * behind a single NAT address genuinely produces this much.
   */
  PER_SOURCE: { limit: 60, windowMs: 60_000 },

  /**
   * The number of *distinct accounts* one source may fail against in a window.
   *
   * This is the anti-spraying control, and it counts **breadth, not volume**.
   * That distinction is the whole design:
   *
   *   - A school of 400 people behind one NAT address produces a lot of typos.
   *     Counting raw failures would throttle them — testing showed 8 staff
   *     mistyping twice was already enough to lock out an innocent colleague.
   *   - But those failures concentrate on a handful of accounts: people get
   *     *their own* password wrong, repeatedly. Failing against 25 different
   *     usernames is not something legitimate traffic does.
   *
   * So repeated failures by the same person cost one unit, not ten, and the
   * limit is on how many distinct usernames a source may fail against.
   */
  SPRAY: { distinctAccounts: 12, windowMs: 15 * 60_000 },

  /**
   * Failed attempts against one specific account from one source, before the
   * database-backed lockout at 8 would engage. Slightly above the lockout
   * threshold so the existing behaviour remains the one users encounter.
   */
  PER_ACCOUNT_SOURCE: { limit: 10, windowMs: 15 * 60_000 },

  /**
   * Sustained *failure* volume from one source.
   *
   * The CPU bound for the untrusted shared bucket. Counting only failures is
   * what makes it safe there: a school signing in normally never touches it,
   * so it cannot become a denial-of-service switch, while an attacker — whose
   * every attempt fails by definition — is stopped after this many.
   *
   * 300 failures still costs ~27 s of scrypt across a 5-minute window, which a
   * VPS absorbs comfortably, and it is far beyond anything legitimate.
   */
  FAILURE_VOLUME: { limit: 300, windowMs: 5 * 60_000 },
} as const;

/**
 * Known limitations of an in-process limiter, documented so the tradeoff is
 * explicit rather than discovered later.
 */
export const LIMITER_LIMITATIONS = [
  'State is per-process. Running N instances multiplies every effective limit by N.',
  'State is lost on restart or redeploy, which resets counters.',
  'The database-backed per-account lockout is unaffected by both of the above.',
] as const;

/**
 * Distinct usernames each source has failed against, with an expiry.
 *
 * Separate from the count-based buckets because spraying is measured by how
 * many *different* accounts are touched, not by how many attempts are made.
 */
type SprayEntry = { accounts: Set<string>; resetAt: number };
const globalForSpray = globalThis as unknown as { __sosSprayTrack?: Map<string, SprayEntry> };
const sprayTracker: Map<string, SprayEntry> = (globalForSpray.__sosSprayTrack ??= new Map());

/**
 * Cap on distinct usernames remembered per source.
 *
 * Bounds the memory a single attacker can cause. Once reached the source is
 * already far past the spray threshold, so forgetting further names changes no
 * decision — the verdict is `blocked` either way.
 */
const MAX_TRACKED_ACCOUNTS_PER_SOURCE = 200;

/** Drop expired spray entries. Shares the sweep budget with the bucket map. */
function pruneSprayTracker(now: number): number {
  let removed = 0;
  for (const [key, entry] of sprayTracker) {
    if (entry.resetAt <= now) {
      sprayTracker.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Record a failed login.
 *
 * Called only on failure, so successful sign-ins never consume budget. A person
 * repeatedly failing their own password adds their username once, which is what
 * keeps a busy school from throttling itself.
 */
export function registerLoginFailure(source: string, schoolCode: string, username: string): void {
  const now = Date.now();

  // Sustained failure volume — the CPU bound that applies even on the shared
  // untrusted bucket, because only failures reach it.
  rateLimit(
    `login:fail:${source}`,
    LOGIN_LIMITS.FAILURE_VOLUME.limit,
    LOGIN_LIMITS.FAILURE_VOLUME.windowMs,
  );

  const key = `${source}`;
  const existing = sprayTracker.get(key);

  if (!existing || existing.resetAt <= now) {
    sprayTracker.set(key, {
      accounts: new Set([`${schoolCode}:${username}`]),
      resetAt: now + LOGIN_LIMITS.SPRAY.windowMs,
    });
  } else if (existing.accounts.size < MAX_TRACKED_ACCOUNTS_PER_SOURCE) {
    existing.accounts.add(`${schoolCode}:${username}`);
  }

  if (sprayTracker.size > MAX_TRACKED_KEYS) {
    pruneSprayTracker(now);
    let overflow = sprayTracker.size - MAX_TRACKED_KEYS;
    for (const k of sprayTracker.keys()) {
      if (overflow-- <= 0) break;
      sprayTracker.delete(k);
    }
  }

  // Per-account-per-source failures, so one hammered account is throttled
  // without affecting anyone else at the same school.
  rateLimit(
    `login:acct:${source}:${schoolCode}:${username}`,
    LOGIN_LIMITS.PER_ACCOUNT_SOURCE.limit,
    LOGIN_LIMITS.PER_ACCOUNT_SOURCE.windowMs,
  );
}

/** How many distinct accounts a source has failed against in the window. */
export function sprayBreadth(source: string, now = Date.now()): number {
  const entry = sprayTracker.get(source);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.accounts.size;
}

export type LoginThrottleVerdict = { allowed: boolean; retryAfterSeconds: number };

/**
 * Decide whether a login attempt may proceed to password verification.
 *
 * Checked *before* scrypt runs. That ordering is the point: one verification
 * costs ~90 ms of CPU, so an unthrottled attacker can saturate a small VPS with
 * failed logins alone, independent of whether any account is ever compromised.
 */
export function checkLoginAllowed(
  source: string,
  schoolCode: string,
  username: string,
  options: { trustedSource?: boolean } = {},
): LoginThrottleVerdict {
  // Whether this bucket identifies a real network or is the shared fallback
  // that every untrusted caller lands in.
  const trusted = options.trustedSource ?? false;

  if (trusted) {
    // A trusted source maps to one real network, so a volume cap is meaningful:
    // it bounds password-verification CPU without touching anyone else.
    const overall = rateLimit(
      `login:src:${source}`,
      LOGIN_LIMITS.PER_SOURCE.limit,
      LOGIN_LIMITS.PER_SOURCE.windowMs,
    );
    if (!overall.allowed) return overall;
  } else {
    // Untrusted: every caller in the world shares this bucket, so rejecting on
    // volume would let one attacker deny sign-in to the entire school. Verified
    // against the running build — 60 attacker requests locked out all ten staff
    // accounts tested. Track the volume for observability, ignore the verdict,
    // and rely on the failure-only controls below to bound abuse.
    rateLimit(
      `login:src:${source}`,
      LOGIN_LIMITS.PER_SOURCE.limit,
      LOGIN_LIMITS.PER_SOURCE.windowMs,
    );
  }

  // Per-account-per-source. Safe to enforce even on the shared bucket: it is
  // scoped to one username, so it throttles the account under attack rather
  // than everyone. The database-backed lockout is the real control here; this
  // simply stops the CPU being spent before that lockout is consulted.
  return peek(
    `login:acct:${source}:${schoolCode}:${username}`,
    LOGIN_LIMITS.PER_ACCOUNT_SOURCE.limit,
  );
}

/**
 * Should this *failed* attempt be reported as throttled?
 *
 * Consulted only after verification has already failed, which is what makes it
 * safe to share one bucket across everyone behind a NAT address — and, when no
 * trusted proxy is configured, across the whole internet.
 *
 * The subtlety this encodes, found by testing rather than reasoning: if the
 * breadth limit is enforced *before* verification, a single attacker spraying
 * the shared `unknown` bucket locks every legitimate user out of the school.
 * A correct password must therefore always be honoured. Suppressing only
 * failures still denies the attacker what they want — they learn nothing and
 * make no progress — while a member of staff who types their password
 * correctly is never affected by someone else's attack.
 */
export function isSprayingFailure(source: string, now = Date.now()): boolean {
  const entry = sprayTracker.get(source);
  if (!entry || entry.resetAt <= now) return false;
  return entry.accounts.size >= LOGIN_LIMITS.SPRAY.distinctAccounts;
}

/**
 * True when a source has produced so many failures that further attempts
 * should be refused outright, whatever account they name.
 *
 * Only failures count towards this, so it cannot be triggered by legitimate
 * use. It is the backstop that keeps scrypt work finite when no trusted proxy
 * is configured and every caller shares one bucket.
 */
export function isFailureFlooding(source: string): boolean {
  return !peek(`login:fail:${source}`, LOGIN_LIMITS.FAILURE_VOLUME.limit).allowed;
}

/** Read a bucket's state without recording a new hit against it. */
function peek(key: string, limit: number): LoginThrottleVerdict {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) return { allowed: true, retryAfterSeconds: 0 };
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
