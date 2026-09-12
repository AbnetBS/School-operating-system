import { getDb } from '../../../db/client.ts';
import { schools } from '../../../db/schema/core.ts';
import { eq } from 'drizzle-orm';
import { route, ok } from '../../../lib/api/respond.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The list of schools available at sign-in.
 *
 * This endpoint is intentionally public and intentionally minimal: it returns
 * only the code and display name needed to populate the sign-in selector.
 * No counts, no contact details, no settings — nothing that would help someone
 * profile a school before authenticating.
 */
export const GET = route(async () => {
  const db = await getDb();
  const rows = await db
    .select({ code: schools.code, name: schools.name, nameAm: schools.nameAm })
    .from(schools)
    .where(eq(schools.isActive, true))
    .orderBy(schools.name);

  return ok({ schools: rows });
});
