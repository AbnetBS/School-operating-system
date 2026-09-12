/**
 * Student charges.
 *
 * GET is the balance view for one student. It requires `fee.view` AND that the
 * caller may see that particular student — a permission on its own is never an
 * authorisation.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, badRequest } from '../../../../lib/api/respond.ts';
import { adHocChargeSchema } from '../../../../lib/finance/schema.ts';
import {
  listStudentCharges,
  getStudentBalance,
  createAdHocCharge,
} from '../../../../lib/finance/service.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('fees');
  ctx.require('fee.view');

  const url = new URL(request.url);
  const studentId = url.searchParams.get('studentId');
  if (!studentId) return badRequest('A student must be specified.');

  // Relationship check. Throws 404 for a pupil this user may not see, so a
  // forged id is indistinguishable from one that does not exist.
  await ctx.requireStudentAccess(studentId);

  const academicYearId = url.searchParams.get('academicYearId') ?? undefined;
  const [charges, balance] = await Promise.all([
    listStudentCharges(ctx, studentId, {
      academicYearId,
      includeCancelled: url.searchParams.get('includeCancelled') === '1',
    }),
    getStudentBalance(ctx, studentId, { academicYearId }),
  ]);

  return ok({ charges, balance });
});

/** A one-off charge for a single pupil. */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('fees');
  ctx.require('fee.manage');

  const input = adHocChargeSchema.parse(await request.json().catch(() => ({})));
  return created(await createAdHocCharge(ctx, input));
});
