import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created, badRequest, zodFields } from '../../../lib/api/respond.ts';
import {
  listGuardians,
  createGuardian,
  getGuardianProfile,
  findGuardianByPhone,
} from '../../../lib/guardians/service.ts';
import { guardianListSchema, createGuardianSchema } from '../../../lib/guardians/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('guardian.view');

  const url = new URL(request.url);

  // Duplicate check used by the registration form: "is this parent already
  // on file?" Returns at most one match and no list access.
  const phoneLookup = url.searchParams.get('phone');
  if (phoneLookup) {
    const match = await findGuardianByPhone(ctx.db, ctx.schoolId, phoneLookup);
    return ok({ match });
  }

  const parsed = guardianListSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid filters', zodFields(parsed.error));
  }

  const result = await listGuardians(ctx.db, ctx.schoolId, parsed.data);
  return ok({
    rows: result.rows,
    total: result.total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('guardian.manage');

  const body = await request.json().catch(() => null);
  const parsed = createGuardianSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  const result = await createGuardian(ctx, parsed.data);
  const profile = await getGuardianProfile(ctx.db, ctx.schoolId, result.id);
  return created({ guardian: profile?.guardian ?? result, id: result.id });
});
