/**
 * Finance dashboard data.
 *
 * Gated on `finance.report`, which a class teacher does not hold — seeing a
 * pupil's name must never imply seeing the school's income.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok } from '../../../../lib/api/respond.ts';
import {
  getFinanceSummary,
  getMonthlyCollections,
  getMethodBreakdown,
  getCategoryBreakdown,
  getOutstandingStudents,
  type FinanceFilters,
} from '../../../../lib/finance/reports.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('fees');
  ctx.require('finance.report');

  const url = new URL(request.url);
  const filters: FinanceFilters = {
    academicYearId: url.searchParams.get('academicYearId') ?? undefined,
    termId: url.searchParams.get('termId') ?? undefined,
    gradeLevelId: url.searchParams.get('gradeLevelId') ?? undefined,
    sectionId: url.searchParams.get('sectionId') ?? undefined,
    categoryId: url.searchParams.get('categoryId') ?? undefined,
    method: url.searchParams.get('method') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  };

  const [summary, monthly, methods, categories, outstanding] = await Promise.all([
    getFinanceSummary(ctx, filters),
    getMonthlyCollections(ctx, filters),
    getMethodBreakdown(ctx, filters),
    getCategoryBreakdown(ctx, filters),
    getOutstandingStudents(ctx, filters, { limit: 25 }),
  ]);

  return ok({ summary, monthly, methods, categories, outstanding });
});
