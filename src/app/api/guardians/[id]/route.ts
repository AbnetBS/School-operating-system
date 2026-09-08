import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, notFound, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import { getGuardianProfile, updateGuardian } from '../../../../lib/guardians/service.ts';
import { updateGuardianSchema } from '../../../../lib/guardians/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('guardian.view');
  const { id } = await params;

  // Scoped to the caller's school, so another school's guardian is simply
  // not found rather than forbidden.
  const profile = await getGuardianProfile(ctx.db, ctx.schoolId, id);
  if (!profile) return notFound('Guardian not found');

  return ok(profile);
});

export const PATCH = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('guardian.manage');
  const { id } = await params;

  const existing = await getGuardianProfile(ctx.db, ctx.schoolId, id);
  if (!existing) return notFound('Guardian not found');

  const body = await request.json().catch(() => null);
  const parsed = updateGuardianSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  await updateGuardian(ctx, id, parsed.data);
  const profile = await getGuardianProfile(ctx.db, ctx.schoolId, id);
  return ok(profile);
});
