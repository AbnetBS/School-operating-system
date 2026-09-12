import type { NextRequest } from 'next/server';
import { route, ok } from '../../../lib/api/respond.ts';
import { requireAuth } from '../../../lib/auth/context.ts';
import { listRoles } from '../../../lib/staff/service.ts';
import { PERMISSIONS, RESTRICTIONS } from '../../../lib/auth/permissions.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/roles
 *
 * Lists the roles configured for the caller's school. With `?catalogue=true`
 * it also returns the full permission catalogue, so a role editor can be built
 * without hard-coding the list of permissions in the frontend.
 */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('role.view');

  const rows = await listRoles(ctx.db, ctx.schoolId);
  const url = new URL(request.url);

  if (url.searchParams.get('catalogue') === 'true') {
    return ok({
      roles: rows,
      catalogue: { permissions: PERMISSIONS, restrictions: RESTRICTIONS },
    });
  }

  return ok({ roles: rows });
});
