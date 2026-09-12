/**
 * Health and readiness probe (audit finding M5).
 *
 * Load balancers, uptime monitors and rolling deploys need to distinguish a
 * process that is merely alive from one that can actually serve requests.
 * Without this, a container whose database connection is broken looks exactly
 * like a healthy one, and a bad release is promoted over a good one.
 *
 *   GET /api/health        readiness — checks the database, 200 or 503
 *   GET /api/health?live=1 liveness  — process is running, always 200
 *
 * The distinction matters to an orchestrator. A failing *readiness* check
 * should remove an instance from the load balancer; a failing *liveness* check
 * should restart it. Restarting a process because the database is down turns a
 * database outage into a crash loop, so the two are kept separate.
 *
 * ## Deliberately unauthenticated, and deliberately terse
 *
 * A probe cannot hold a session, so this endpoint is public. That makes it an
 * information-disclosure surface, so it returns only what a monitor needs:
 * `status`, `checks.database`, and a duration. No version, no hostname, no
 * driver, no schema details, no error text from the database — an attacker
 * learns nothing beyond "this service is up", which they can infer anyway.
 *
 * The failure reason is logged server-side, where operators can see it.
 */

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '../../../db/client.ts';
import { route } from '../../../lib/api/respond.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cap on the readiness query. A probe that hangs is worse than one that fails:
 * an orchestrator waiting on a stuck connection keeps a broken instance in
 * rotation. Comfortably above a healthy `select 1`, which is sub-millisecond.
 */
const DATABASE_TIMEOUT_MS = 3_000;

/** Run the cheapest possible query, bounded so a hung connection still answers. */
async function checkDatabase(): Promise<{ ok: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`database did not respond within ${DATABASE_TIMEOUT_MS}ms`)),
        DATABASE_TIMEOUT_MS,
      );
    });

    const query = (async () => {
      const db = await getDb();
      await db.execute(sql`select 1`);
    })();

    await Promise.race([query, timeout]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const GET = route(async (request: Request): Promise<NextResponse> => {
  const startedAt = Date.now();
  const url = new URL(request.url);

  // Liveness: is this process running at all? No dependency checks, so a
  // database outage cannot trigger a restart loop.
  if (url.searchParams.get('live') === '1') {
    return NextResponse.json(
      { status: 'ok', check: 'liveness' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const database = await checkDatabase();

  if (!database.ok) {
    // Visible to operators in the logs; never in the response body.
    console.error('[health] readiness check failed:', database.error);
  }

  return NextResponse.json(
    {
      status: database.ok ? 'ok' : 'unavailable',
      check: 'readiness',
      checks: { database: database.ok ? 'ok' : 'unavailable' },
      durationMs: Date.now() - startedAt,
    },
    {
      // 503 so a load balancer drains this instance instead of sending it work.
      status: database.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
});
