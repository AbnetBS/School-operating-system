import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, notFound, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import { getStaffProfile, updateStaff, resetStaffPassword } from '../../../../lib/staff/service.ts';
import { updateStaffSchema } from '../../../../lib/staff/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('staff.view');
  const { id } = await params;

  const profile = await getStaffProfile(ctx.db, ctx.schoolId, id);
  if (!profile) return notFound('Staff member not found');
  return ok(profile);
});

export const PATCH = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('staff.manage');
  const { id } = await params;

  const existing = await getStaffProfile(ctx.db, ctx.schoolId, id);
  if (!existing) return notFound('Staff member not found');

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  // Changing roles is an escalation vector, so it needs role management rights
  // on top of plain staff editing.
  if (body && 'roleIds' in body) ctx.require('role.manage');
  if (body && 'isActive' in body) ctx.require('user.manage');

  const parsed = updateStaffSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  await updateStaff(ctx, id, parsed.data);
  const profile = await getStaffProfile(ctx.db, ctx.schoolId, id);
  return ok(profile);
});

/** Password reset. Returns a new temporary password exactly once. */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('user.manage');
  const { id } = await params;

  const url = new URL(request.url);
  if (url.searchParams.get('action') !== 'resetPassword') {
    return badRequest('Unknown action.');
  }

  const existing = await getStaffProfile(ctx.db, ctx.schoolId, id);
  if (!existing) return notFound('Staff member not found');

  const result = await resetStaffPassword(ctx, id);
  return ok(result);
});
