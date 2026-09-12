import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created, badRequest, zodFields } from '../../../lib/api/respond.ts';
import { listStaff, createStaff, getStaffProfile } from '../../../lib/staff/service.ts';
import { staffListSchema, createStaffSchema } from '../../../lib/staff/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('staff.view');

  const url = new URL(request.url);
  const parsed = staffListSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid filters', zodFields(parsed.error));
  }

  const result = await listStaff(ctx.db, ctx.schoolId, parsed.data);
  return ok({
    rows: result.rows,
    total: result.total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('staff.manage');

  // Creating a staff member also creates a login, so the caller must be
  // allowed to manage user accounts too. Without this, anyone who could add a
  // teacher could mint an account and attach the principal's role to it.
  ctx.require('user.manage');

  const body = await request.json().catch(() => null);
  const parsed = createStaffSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  const result = await createStaff(ctx, parsed.data);
  const profile = await getStaffProfile(ctx.db, ctx.schoolId, result.id);

  // The temporary password is returned exactly once, here.
  return created({
    staff: profile?.staff ?? null,
    user: profile?.user ?? null,
    id: result.id,
    username: result.username,
    temporaryPassword: result.temporaryPassword,
  });
});
