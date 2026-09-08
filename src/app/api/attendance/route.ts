import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created, badRequest, forbidden, zodFields } from '../../../lib/api/respond.ts';
import {
  getRoster,
  submitAttendance,
  checkAttendancePermission,
} from '../../../lib/attendance/service.ts';
import { submitAttendanceSchema } from '../../../lib/attendance/schema.ts';
import { academicYears } from '../../../db/schema/core.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { todayIso } from '../../../lib/calendar/ethiopian.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function currentYear(ctx: Awaited<ReturnType<typeof requireAuth>>) {
  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  return year ?? null;
}

/** The class list for a register, with any marks already recorded. */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('attendance');
  ctx.requireAny('attendance.view', 'attendance.take');

  const url = new URL(request.url);
  const sectionId = url.searchParams.get('sectionId');
  const sectionSubjectId = url.searchParams.get('sectionSubjectId');
  if (!sectionId) return badRequest('A class must be specified.');

  const year = await currentYear(ctx);
  if (!year) return badRequest('No academic year is set up yet.');

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const date = url.searchParams.get('date') ?? todayIso(locale.timezone);

  // Reading a register still requires a relationship to the class unless the
  // caller has school-wide attendance rights.
  if (!ctx.has('attendance.editAny') && !ctx.has('attendance.report')) {
    if (!ctx.relationships.sectionIds.includes(sectionId)) {
      return forbidden('You are not assigned to this class.');
    }
  }

  const roster = await getRoster(ctx.db, ctx.schoolId, {
    sectionId,
    sectionSubjectId,
    date,
    academicYearId: year.id,
  });

  return ok({ ...roster, date });
});

/** Save a register. Idempotent: re-submitting updates rather than duplicates. */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('attendance');

  const body = await request.json().catch(() => null);
  const parsed = submitAttendanceSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  const year = await currentYear(ctx);
  if (!year) return badRequest('No academic year is set up yet.');

  // Relationship and backdating policy, enforced server-side.
  const permission = await checkAttendancePermission(ctx, {
    sectionId: parsed.data.sectionId,
    sectionSubjectId: parsed.data.sectionSubjectId,
    date: parsed.data.date,
  });
  if (!permission.allowed) {
    return permission.status === 400
      ? badRequest(permission.reason)
      : forbidden(permission.reason);
  }

  const result = await submitAttendance(ctx, parsed.data, year.id);
  return result.created ? created(result) : ok(result);
});
