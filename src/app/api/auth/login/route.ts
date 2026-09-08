import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '../../../../db/client.ts';
import { login, rateLimit } from '../../../../lib/auth/login.ts';
import { SESSION_COOKIE, sessionCookieOptions } from '../../../../lib/auth/session.ts';
import { route, badRequest, zodFields } from '../../../../lib/api/respond.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  schoolCode: z.string().min(1, 'Select a school').max(32),
  username: z.string().min(1, 'Enter your username').max(64),
  password: z.string().min(1, 'Enter your password').max(1024),
});

export const POST = route(async (request: NextRequest) => {
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  // Two limits: a per-IP limit stops a broad attack, and a per-account limit
  // (in registerFailedLogin) stops a targeted one.
  const limited = rateLimit(`login:${ipAddress}`, 20, 60_000);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  const db = await getDb();
  const result = await login(db, {
    ...parsed.data,
    ipAddress,
    userAgent: request.headers.get('user-agent'),
  });

  if (!result.ok) {
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
