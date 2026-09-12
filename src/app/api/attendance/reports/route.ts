import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import {
  getAttendanceSummary,
  getMissingRegisters,
  getConsecutiveAbsences,
} from '../../../../lib/attendance/service.ts';
import { attendanceReportSchema } from '../../../../lib/attendance/schema.ts';
import { academicYears } from '../../../../db/schema/core.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { todayIso } from '../../../../lib/calendar/ethiopian.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('attendance');
  ctx.require('attendance.report');

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') ?? 'summary';

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!year) return badRequest('No academic year is set up yet.');

  const parsed = attendanceReportSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid report filters.', zodFields(parsed.error));
  }

  // A teacher limited to their own classes must not see the whole school by
  // omitting the sectionId filter. Enforced here, server-side, regardless of
  // what the client asked for.
  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  // Nor may they widen the query by naming a section they do not teach.
  if (
    restrictToSectionIds &&
    parsed.data.sectionId &&
    !restrictToSectionIds.includes(parsed.data.sectionId)
  ) {
    return ok({ kind, rows: [], total: 0, threshold: 0 });
  }

  if (kind === 'missing') {
    const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
    const today = todayIso(locale.timezone);
    // Default to the last fortnight, which is the window a principal
    // realistically chases teachers over.
    const from =
      parsed.data.from ??
      new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
    const rows = await getMissingRegisters(ctx.db, ctx.schoolId, year.id, {
      from,
      to: parsed.data.to ?? today,
      sectionId: parsed.data.sectionId,
      restrictToSectionIds,
    });
    return ok({ kind: 'missing', from, to: parsed.data.to ?? today, rows, total: rows.length });
  }

  if (kind === 'consecutive') {
    const settings = await getSetting(ctx.db, ctx.schoolId, 'attendance');
    const rows = await getConsecutiveAbsences(
      ctx.db,
      ctx.schoolId,
      year.id,
      settings.consecutiveAbsenceAlert ?? 3,
      restrictToSectionIds,
    );
    return ok({
      kind: 'consecutive',
      threshold: settings.consecutiveAbsenceAlert ?? 3,
      rows,
      total: rows.length,
    });
  }

  const summary = await getAttendanceSummary(ctx.db, ctx.schoolId, {
    academicYearId: year.id,
    from: parsed.data.from,
    to: parsed.data.to,
    sectionId: parsed.data.sectionId,
    gradeLevelId: parsed.data.gradeLevelId,
    termId: parsed.data.termId,
    atRiskOnly: parsed.data.atRiskOnly,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    restrictToSectionIds,
  });

  return ok({ kind: 'summary', ...summary, page: parsed.data.page, pageSize: parsed.data.pageSize });
});
