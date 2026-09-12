import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, badRequest } from '../../../../lib/api/respond.ts';
import { recordStaffAttendanceSchema } from '../../../../lib/operations/schema.ts';
import {
  getStaffAttendanceSheet,
  getStaffAttendanceSummary,
  recordStaffAttendance,
} from '../../../../lib/operations/hr.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('hr');
  ctx.require('staffAttendance.view');

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  // A range asks for the summary; a single date asks for the marking sheet.
  if (from && to) {
    if (!ISO.test(from) || !ISO.test(to)) return badRequest('Use the date format YYYY-MM-DD.');
    return ok({ summary: await getStaffAttendanceSummary(ctx, from, to) });
  }

  const date = url.searchParams.get('date');
  if (!date || !ISO.test(date)) return badRequest('Give a date as YYYY-MM-DD.');
  return ok({ date, sheet: await getStaffAttendanceSheet(ctx, date) });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = recordStaffAttendanceSchema.parse(await request.json().catch(() => ({})));
  return ok(await recordStaffAttendance(ctx, input));
});
