import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../lib/api/respond.ts';
import { maintenanceIssueSchema } from '../../../lib/operations/schema.ts';
import { listMaintenanceIssues, reportIssue } from '../../../lib/operations/facilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('maintenance');
  // Reporting a fault and seeing the queue are different jobs; either is
  // enough to read the list, so a teacher can check whether their report was
  // picked up.
  ctx.requireAny('maintenance.manage', 'maintenance.report', 'asset.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);
  const { issues, total } = await listMaintenanceIssues(ctx, {
    status: url.searchParams.get('status'),
    priority: url.searchParams.get('priority'),
    assetId: url.searchParams.get('assetId'),
    openOnly: url.searchParams.get('openOnly') === '1',
    limit: pagination.limit,
    offset: pagination.offset,
  });
  return ok(paged(issues, total, pagination));
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = maintenanceIssueSchema.parse(await request.json().catch(() => ({})));
  return created(await reportIssue(ctx, input));
});
