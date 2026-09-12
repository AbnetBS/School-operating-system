import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '../../../../db/client.ts';
import { SESSION_COOKIE, revokeSessionByToken, resolveSession } from '../../../../lib/auth/session.ts';
import { recordAudit } from '../../../../lib/audit/index.ts';
import { route } from '../../../../lib/api/respond.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (request: NextRequest) => {
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (token) {
    const db = await getDb();
    const session = await resolveSession(db, token);
    // Revoke server-side, so clearing the cookie is not the only protection.
    await revokeSessionByToken(db, token);
    if (session?.schoolId) {
      await recordAudit(db, {
        schoolId: session.schoolId,
        actorUserId: session.userId,
        actorName: [session.givenName, session.fatherName].filter(Boolean).join(' '),
        action: 'auth.logout',
        entityType: 'user',
        entityId: session.userId,
      });
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0, httpOnly: true });
  return response;
});
