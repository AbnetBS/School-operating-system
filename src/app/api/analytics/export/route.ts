import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { route, badRequest } from '../../../../lib/api/respond.ts';
import { requireAuth, type AuthContext } from '../../../../lib/auth/context.ts';
import { toCsv } from '../../../../lib/import/csv.ts';
import { recordAudit } from '../../../../lib/audit/index.ts';
import { academicYears } from '../../../../db/schema/core.ts';
import { getRiskReport } from '../../../../lib/analytics/risk.ts';
import {
  getSubjectPerformance,
  getStudentTrends,
  getTermContext,
} from '../../../../lib/analytics/academic.ts';
import { getAttendanceSummary } from '../../../../lib/attendance/service.ts';
import { getEnrollmentByGrade } from '../../../../lib/dashboard/queries.ts';
import { getTeacherCompletion } from '../../../../lib/analytics/teachers.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { todayIso } from '../../../../lib/calendar/ethiopian.ts';
import type { Permission } from '../../../../lib/auth/permissions.ts';
import { throttleByUser } from '../../../../lib/api/throttle.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPORTS = [
  'attendance',
  'academic',
  'risk',
  'enrollment',
  'teachers',
] as const;
type ReportKey = (typeof REPORTS)[number];

/**
 * Which permission each report requires.
 *
 * An export must never be an easier way to get data than the screen. These are
 * the same permissions the corresponding pages check, listed here so the
 * mapping is auditable in one place rather than scattered through the handler.
 */
const REPORT_PERMISSION: Record<ReportKey, Permission> = {
  attendance: 'attendance.report',
  academic: 'analytics.view',
  risk: 'analytics.view',
  enrollment: 'analytics.view',
  teachers: 'analytics.view',
};

const querySchema = z.object({
  report: z.enum(REPORTS),
  section: z.string().trim().max(64).optional(),
});

/**
 * GET /api/analytics/export?report=…
 *
 * CSV export of the intelligence screens. Every report re-runs the same
 * service the page uses, with the same restrictions applied — in particular
 * `restrict.ownSectionsOnly`, which is the rule an export is most likely to
 * quietly bypass.
 */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest('Unknown report.');

  const { report } = parsed.data;
  ctx.require(REPORT_PERMISSION[report]);

  // Aggregates across the whole school. Throttled after the permission check so
  // an unauthorised caller still gets the usual denial, not a rate-limit hint.
  const throttled = throttleByUser(ctx.user.userId, `export:analytics:${report}`);
  if (throttled) return throttled;

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  if (!year) return badRequest('No academic year is set up yet.');

  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);
  const termContext = await getTermContext(ctx.db, ctx.schoolId, year.id, today);

  const built = await buildReport(ctx, report, {
    academicYearId: year.id,
    termId: termContext.currentTermId,
    previousTermId: termContext.previousTermId,
    restrictToSectionIds,
    sectionId: parsed.data.section || undefined,
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'export.run',
    entityType: 'analytics',
    entityId: null,
    summary: `Exported the ${report} report (${built.rows.length} row${built.rows.length === 1 ? '' : 's'})`,
    newValue: { report, count: built.rows.length },
    ipAddress: ctx.ipAddress,
  });

  const stamp = today;
  return new NextResponse(toCsv(built.headers, built.rows), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${report}-${stamp}.csv"`,
      // An export of pupil data should not sit in a shared cache.
      'Cache-Control': 'private, no-store',
    },
  });
});

type BuildOptions = {
  academicYearId: string;
  termId: string | null;
  previousTermId: string | null;
  restrictToSectionIds: string[] | undefined;
  sectionId: string | undefined;
};

async function buildReport(
  ctx: AuthContext,
  report: ReportKey,
  options: BuildOptions,
): Promise<{ headers: string[]; rows: (string | number | null)[][] }> {
  switch (report) {
    case 'attendance': {
      const summary = await getAttendanceSummary(ctx.db, ctx.schoolId, {
        academicYearId: options.academicYearId,
        sectionId: options.sectionId,
        restrictToSectionIds: options.restrictToSectionIds,
        pageSize: 5000,
      });
      return {
        headers: [
          'Student ID',
          'Given Name',
          'Father Name',
          'Grade',
          'Section',
          'Days Recorded',
          'Present',
          'Absent',
          'Late',
          'Excused',
          'Attendance %',
        ],
        rows: summary.rows.map((r) => [
          r.studentCode,
          r.givenName,
          r.fatherName,
          r.gradeName,
          r.sectionName,
          r.totalDays,
          r.presentDays,
          r.absentDays,
          r.lateDays,
          r.excusedDays,
          r.attendancePercent,
        ]),
      };
    }

    case 'academic': {
      if (!options.termId) return { headers: ['Term'], rows: [] };
      const { rows } = await getSubjectPerformance(ctx.db, ctx.schoolId, options.termId, {
        restrictToSectionIds: options.restrictToSectionIds,
        sectionId: options.sectionId,
      });
      return {
        headers: [
          'Grade',
          'Section',
          'Subject',
          'Teacher',
          'Students',
          'Average %',
          'Passed',
          'Failed',
          'Pass Rate %',
          'Missing Results',
        ],
        rows: rows.map((r) => [
          r.gradeName,
          r.sectionName,
          r.subjectName,
          r.teacherName,
          r.studentCount,
          r.averagePercent,
          r.passCount,
          r.failCount,
          r.passRate,
          r.missingResults,
        ]),
      };
    }

    case 'risk': {
      const report = await getRiskReport(ctx.db, ctx.schoolId, options.academicYearId, {
        termId: options.termId,
        previousTermId: options.previousTermId,
        restrictToSectionIds: options.restrictToSectionIds,
        sectionId: options.sectionId,
        pageSize: 5000,
      });
      return {
        headers: [
          'Student ID',
          'Given Name',
          'Father Name',
          'Grade',
          'Section',
          'Score',
          'Attendance %',
          'Average %',
          // The reasons travel with the export. A spreadsheet of scores with
          // no explanation is precisely the black box the spec rules out.
          'Reasons',
        ],
        rows: report.students.map((s) => [
          s.studentCode,
          s.givenName,
          s.fatherName,
          s.gradeName,
          s.sectionName,
          s.score,
          s.attendancePercent,
          s.averagePercent,
          s.signals
            .map((sig) => `${sig.key}(${sig.value} vs ${sig.threshold})`)
            .join('; '),
        ]),
      };
    }

    case 'enrollment': {
      const byGrade = await getEnrollmentByGrade(ctx.db, ctx.schoolId, options.academicYearId);
      return {
        headers: ['Grade', 'Level', 'Students', 'Sections', 'Capacity'],
        rows: byGrade.map((g) => [
          g.gradeName,
          g.level,
          g.studentCount,
          g.sectionCount,
          g.capacity,
        ]),
      };
    }

    case 'teachers': {
      const rows = await getTeacherCompletion(ctx.db, ctx.schoolId, options.academicYearId, {
        termId: options.termId,
        restrictToSectionIds: options.restrictToSectionIds,
      });
      return {
        headers: [
          'Teacher',
          'Classes',
          'Subjects',
          'Registers Expected',
          'Registers Taken',
          'Registers Missing',
          'Assessments',
          'Awaiting Approval',
          'Missing Marks',
        ],
        rows: rows.map((t) => [
          t.teacherName,
          t.sectionCount,
          t.subjectCount,
          t.registersExpected,
          t.registersTaken,
          t.registersMissing,
          t.assessmentCount,
          t.pendingApproval,
          t.missingMarks,
        ]),
      };
    }
  }
}
