/**
 * Fee structures.
 *
 * Reading needs `fee.view`; writing needs `fee.manage`. Both are checked
 * server-side on every request — the navigation hiding a link is convenience,
 * not access control.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created } from '../../../../lib/api/respond.ts';
import { feeStructureSchema } from '../../../../lib/finance/schema.ts';
import {
  listFeeStructures,
  createFeeStructure,
  listFeeCategories,
} from '../../../../lib/finance/service.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('fees');
  ctx.require('fee.view');

  const url = new URL(request.url);
  const [fees, categories] = await Promise.all([
    listFeeStructures(ctx, {
      academicYearId: url.searchParams.get('academicYearId') ?? undefined,
      includeInactive: url.searchParams.get('includeInactive') === '1',
    }),
    listFeeCategories(ctx, true),
  ]);

  return ok({ fees, categories });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('fees');
  ctx.require('fee.manage');

  const input = feeStructureSchema.parse(await request.json().catch(() => ({})));
  const result = await createFeeStructure(ctx, input);
  return created(result);
});
