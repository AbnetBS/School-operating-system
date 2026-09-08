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
 * This protects a single instance. A multi-instance deployment should back
 * this with Redis; the interface is deliberately narrow so that swap is easy.
 */
type Bucket = { count: number; resetAt: number };
const globalForLimiter = globalThis as unknown as { __sosRateLimit?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (globalForLimiter.__sosRateLimit ??= new Map());

export function rateLimit(
  key: string,
  limit = 10,
  windowMs = 60_000,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
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

/** Periodically drop expired buckets so the map cannot grow without bound. */
export function pruneRateLimiter(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
