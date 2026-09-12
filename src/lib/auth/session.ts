/**
 * Session management.
 *
 * Sessions are server-side records rather than self-contained JWTs, because a
 * school must be able to revoke access immediately — a teacher leaves, a phone
 * is lost, an account is compromised. A stateless token cannot be withdrawn
 * before it expires; a database row can.
 *
 * The cookie holds a 256-bit random token. Only its SHA-256 hash is stored, so
 * a leaked database backup does not yield usable session tokens.
 */

import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { sessions, users } from '../../db/schema/core.ts';

export const SESSION_COOKIE = 'sos_session';
export const SESSION_TTL_HOURS = 12;
/** Sessions idle longer than this are treated as expired. */
export const SESSION_IDLE_HOURS = 8;

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type CreateSessionInput = {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  ttlHours?: number;
};

/** Create a session and return the raw token (shown to the client once). */
export async function createSession(
  db: Database,
  input: CreateSessionInput,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? SESSION_TTL_HOURS) * 3600_000);
  await db.insert(sessions).values({
    userId: input.userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent?.slice(0, 512) ?? null,
  });
  return { token, expiresAt };
}

export type SessionUser = {
  sessionId: string;
  userId: string;
  schoolId: string | null;
  username: string;
  givenName: string;
  fatherName: string | null;
  locale: string | null;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
};

/**
 * Resolve a session token to its user.
 * Returns null for any failure — expired, revoked, unknown, or a deactivated
 * user — without distinguishing between them to the caller.
 */
export async function resolveSession(
  db: Database,
  token: string | undefined | null,
): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const rows = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      schoolId: users.schoolId,
      username: users.username,
      givenName: users.givenName,
      fatherName: users.fatherName,
      locale: users.locale,
      isPlatformAdmin: users.isPlatformAdmin,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) return null;

  // Idle timeout: a session left open on a shared staff computer should not
  // stay valid all day.
  const idleMs = now.getTime() - new Date(row.lastSeenAt).getTime();
  if (idleMs > SESSION_IDLE_HOURS * 3600_000) {
    await revokeSession(db, row.sessionId);
    return null;
  }

  // Throttle write traffic: only touch last_seen_at once a minute.
  if (idleMs > 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  }

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    schoolId: row.schoolId,
    username: row.username,
    givenName: row.givenName,
    fatherName: row.fatherName,
    locale: row.locale,
    isPlatformAdmin: row.isPlatformAdmin,
    mustChangePassword: row.mustChangePassword,
  };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function revokeSessionByToken(db: Database, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, hashSessionToken(token)));
}

/** Revoke every session for a user — used on password change or deactivation. */
export async function revokeAllUserSessions(db: Database, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Delete expired sessions. Safe to run on a schedule. */
export async function purgeExpiredSessions(db: Database): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return (result as { rowCount?: number }).rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_MINUTES = 15;

export async function registerFailedLogin(db: Database, userId: string): Promise<void> {
  const rows = await db
    .update(users)
    .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
    .where(eq(users.id, userId))
    .returning({ count: users.failedLoginCount });

  const count = rows[0]?.count ?? 0;
  if (count >= MAX_FAILED_LOGINS) {
    await db
      .update(users)
      .set({
        lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000),
        failedLoginCount: 0,
      })
      .where(eq(users.id, userId));
  }
}

export async function clearFailedLogins(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, userId));
}

export function isLockedOut(user: { lockedUntil: Date | null }): boolean {
  return user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
}

/** Cookie attributes. `secure` is disabled only for plain-HTTP local dev. */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}
