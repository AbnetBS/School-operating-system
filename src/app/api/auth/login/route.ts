import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '../../../../db/client.ts';
import {
  login,
  checkLoginAllowed,
  registerLoginFailure,
  isSprayingFailure,
  isFailureFlooding,
  LOGIN_LIMITS,
} from '../../../../lib/auth/login.ts';
import { resolveClientIp, hasTrustedProxy } from '../../../../lib/auth/clientIp.ts';
import { SESSION_COOKIE, sessionCookieOptions } from '../../../../lib/auth/session.ts';
import { route, badRequest, zodFields } from '../../../../lib/api/respond.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  schoolCode: z.string().min(1, 'Select a school').max(32),
  username: z.string().min(1, 'Enter your username').max(64),
  password: z.string().min(1, 'Enter your password').max(1024),
});

/**
 * Identical wording and status for every throttled case.
 *
 * It must not matter whether the caller tripped the per-source, spraying or
 * per-account limit, nor whether the username exists: a difference here would
 * turn the limiter into the account oracle that `login()` is careful not to be.
 */
function tooManyAttempts(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: 'Too many sign-in attempts. Please wait a moment and try again.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export const POST = route(async (request: NextRequest) => {
  // Only trusted when TRUSTED_PROXY_HOPS says a proxy appends it; otherwise
  // every caller shares the `unknown` bucket rather than getting a free pass by
  // forging a header. See src/lib/auth/clientIp.ts.
  const source = resolveClientIp(request.headers);

  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  // Normalised the same way `login()` normalises them, so the limiter cannot be
  // sidestepped with casing or padding variations of the same account.
  const schoolCode = parsed.data.schoolCode.trim().toLowerCase();
  const username = parsed.data.username.trim().toLowerCase();

  // Checked before scrypt runs: one verification costs ~90 ms of CPU, so
  // throttling after it would leave the DoS lever fully intact.
  // Backstop: a source that has already produced a flood of failures is
  // refused before scrypt runs, regardless of which account it names. Built on
  // failure counts only, so ordinary traffic never reaches it.
  if (isFailureFlooding(source)) {
    return tooManyAttempts(Math.ceil(LOGIN_LIMITS.FAILURE_VOLUME.windowMs / 1000));
  }

  const throttled = checkLoginAllowed(source, schoolCode, username, {
    trustedSource: hasTrustedProxy(),
  });
  if (!throttled.allowed) {
    return tooManyAttempts(throttled.retryAfterSeconds);
  }

  const db = await getDb();
  const result = await login(db, {
    ...parsed.data,
    ipAddress: source,
    userAgent: request.headers.get('user-agent'),
  });

  if (!result.ok) {
    // Count the failure only now. Successful sign-ins never consume budget, so
    // a busy school morning cannot throttle itself.
    registerLoginFailure(source, schoolCode, username);

    // Spraying is judged only on attempts that have already failed. Enforcing
    // it earlier would let one attacker on the shared `unknown` bucket lock the
    // whole school out — verified against the running build, not assumed.
    if (isSprayingFailure(source)) {
      return tooManyAttempts(Math.ceil(LOGIN_LIMITS.SPRAY.windowMs / 1000));
    }

    const status = result.reason === 'locked' ? 429 : 401;
    return NextResponse.json({ error: result.message }, { status });
  }

  const response = NextResponse.json({
    ok: true,
    mustChangePassword: result.mustChangePassword,
  });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  return response;
});
