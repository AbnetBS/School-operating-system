import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import {
  getAttendanceSummary,
  getMissingRegisters,
  getConsecutiveAbsences,
} from '../../../../lib/attendance/service.ts';
import { academicYears, sections, gradeLevels } from '../../../../db/schema/core.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { todayIso, formatDate } from '../../../../lib/calendar/ethiopian.ts';
import { PageHeader, Card, Badge, EmptyState, StatCard } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'summary', label: 'By student' },
  { key: 'risk', label: 'At risk' },
  { key: 'consecutive', label: 'Consecutive absences' },
  { key: 'missing', label: 'Missing registers' },
] as const;

export default async function AttendanceReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.attendance || !ctx.has('attendance.report')) {
    return (
      <Card>
        <EmptyState
          title="You do not have permission to view attendance reports"
          description="Contact your administrator if you believe this is a mistake."
        />
      </Card>
    );
  }

  const raw = await searchParams;
  const pick = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const tab = pick('tab') ?? 'summary';
  const sectionId = pick('section') ?? '';

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!year) {
    return (
      <>
        <PageHeader title="Attendance reports" />
        <Card>
          <EmptyState title="No academic year is set up yet" />
        </Card>
      </>
    );
  }

  // Teachers limited to their own classes see only those, here too.
  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  const [localeSettings, attendanceSettings, sectionList] = await Promise.all([
    getSetting(ctx.db, ctx.schoolId, 'locale'),
    getSetting(ctx.db, ctx.schoolId, 'attendance'),
    ctx.db
      .select({ id: sections.id, name: sections.name, gradeName: gradeLevels.name, level: gradeLevels.level })
      .from(sections)
      .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
      .where(
        and(
          eq(sections.schoolId, ctx.schoolId),
          eq(sections.academicYearId, year.id),
          // Only offer classes this user is allowed to report on.
          ...(restrictToSectionIds
            ? [
                restrictToSectionIds.length > 0
                  ? inArray(sections.id, restrictToSectionIds)
                  : sql`false`,
              ]
            : []),
        ),
      )
      .orderBy(gradeLevels.level, sections.name),
  ]);

  const today = todayIso(localeSettings.timezone);
  const cal = localeSettings.calendarDisplay;

  const summary = await getAttendanceSummary(ctx.db, ctx.schoolId, {
    academicYearId: year.id,
    sectionId: sectionId || undefined,
    atRiskOnly: tab === 'risk',
    pageSize: 200,
    restrictToSectionIds,
  });

  const overall =
    summary.rows.length > 0
      ? Math.round(
          (summary.rows.reduce((sum, r) => sum + r.attendancePercent, 0) / summary.rows.length) * 10,
        ) / 10
      : null;

  const atRiskCount = summary.rows.filter((r) => r.atRisk).length;

  const consecutive =
    tab === 'consecutive'
      ? await getConsecutiveAbsences(
          ctx.db,
          ctx.schoolId,
          year.id,
          attendanceSettings.consecutiveAbsenceAlert ?? 3,
          restrictToSectionIds,
        )
      : [];

  const missing =
    tab === 'missing'
      ? await getMissingRegisters(ctx.db, ctx.schoolId, year.id, {
          from: new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 86_400_000)
            .toISOString()
            .slice(0, 10),
          to: today,
          sectionId: sectionId || undefined,
          restrictToSectionIds,
        })
      : [];

  const qs = (next: Record<string, string>) => {
    const sp = new URLSearchParams();
    if (sectionId) sp.set('section', sectionId);
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    return `/attendance/reports?${sp.toString()}`;
  };

  return (
    <>
      <div className="mb-3">
        <Link href="/attendance" className="text-sm text-brand-600 hover:underline">
          ← Attendance
        </Link>
      </div>

      <PageHeader
        title="Attendance reports"
        description={`Academic year to ${formatDate(today, { calendar: cal, locale: ctx.locale })}`}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Students tracked"
          value={summary.total}
          sub={sectionId ? 'in this class' : 'school-wide'}
        />
        <StatCard
          label="Average attendance"
          value={overall === null ? '—' : `${overall}%`}
          tone={overall === null ? 'default' : overall >= summary.threshold ? 'good' : 'warn'}
        />
        <StatCard
          label="At risk"
          value={atRiskCount}
          tone={atRiskCount > 0 ? 'bad' : 'good'}
          sub={`below ${summary.threshold}%`}
        />
        <StatCard
          label="Alert after"
          value={`${attendanceSettings.consecutiveAbsenceAlert} days`}
          sub="consecutive absence"
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((item) => (
          <Link
            key={item.key}
            href={qs({ tab: item.key })}
            className={`tap-target rounded-lg px-3 py-2 text-sm font-medium ${
              tab === item.key
                ? 'bg-brand-600 text-white'
                : 'border border-ink-300 text-ink-700 hover:bg-ink-50'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>

      <form method="get" className="mb-4">
        <input type="hidden" name="tab" value={tab} />
        <select
          name="section"
          defaultValue={sectionId}
          className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm sm:w-auto"
          aria-label="Filter by class"
        >
          <option value="">All classes</option>
          {sectionList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.gradeName} {s.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="tap-target ml-2 rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
        >
          Apply
        </button>
      </form>

      {(tab === 'summary' || tab === 'risk') && (
        <Card>
          {summary.rows.length === 0 ? (
            <EmptyState
              title={tab === 'risk' ? 'No students are below the threshold' : 'No attendance recorded yet'}
              description={
                tab === 'risk'
                  ? `Every student is at or above ${summary.threshold}%.`
                  : 'Take a register to start building attendance data.'
              }
            />
          ) : (
            <>
              <ul className="divide-y divide-ink-100 sm:hidden">
                {summary.rows.map((row) => (
                  <li key={row.studentId} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link
                        href={`/students/${row.studentId}`}
                        className="truncate text-sm font-medium text-ink-900 hover:underline"
                      >
                        {row.givenName} {row.fatherName}
                      </Link>
                      <p className="text-xs text-ink-500">
                        {row.gradeName} {row.sectionName} · {row.absentDays} absent
                      </p>
                    </div>
                    <Badge tone={row.atRisk ? 'bad' : row.attendancePercent >= 95 ? 'good' : 'neutral'}>
                      {row.attendancePercent}%
                    </Badge>
                  </li>
                ))}
              </ul>

              <div className="-mx-4 hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                      <th className="px-4 py-2.5 font-medium">Student</th>
                      <th className="px-4 py-2.5 font-medium">Class</th>
                      <th className="px-4 py-2.5 font-medium text-right">Days</th>
                      <th className="px-4 py-2.5 font-medium text-right">Absent</th>
                      <th className="px-4 py-2.5 font-medium text-right">Late</th>
                      <th className="px-4 py-2.5 font-medium text-right">Attendance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {summary.rows.map((row) => (
                      <tr key={row.studentId} className="hover:bg-ink-50">
                        <td className="px-4 py-2.5">
                          <Link href={`/students/${row.studentId}`} className="font-medium text-ink-900 hover:underline">
                            {row.givenName} {row.fatherName}
                          </Link>
                          <span className="ml-2 font-mono text-xs text-ink-400">{row.studentCode}</span>
                        </td>
                        <td className="px-4 py-2.5 text-ink-600">
                          {row.gradeName} {row.sectionName}
                        </td>
                        <td className="px-4 py-2.5 text-right text-ink-600">{row.totalDays}</td>
                        <td className="px-4 py-2.5 text-right text-ink-600">{row.absentDays}</td>
                        <td className="px-4 py-2.5 text-right text-ink-600">{row.lateDays}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Badge tone={row.atRisk ? 'bad' : row.attendancePercent >= 95 ? 'good' : 'neutral'}>
                            {row.attendancePercent}%
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'consecutive' && (
        <Card
          title={`Absent ${attendanceSettings.consecutiveAbsenceAlert}+ days in a row`}
        >
          {consecutive.length === 0 ? (
            <EmptyState title="No student is currently on a run of absences" />
          ) : (
            <ul className="divide-y divide-ink-100">
              {consecutive.map((row) => (
                <li key={row.studentId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <Link
                      href={`/students/${row.studentId}`}
                      className="truncate text-sm font-medium text-ink-900 hover:underline"
                    >
                      {row.givenName} {row.fatherName}
                    </Link>
                    <p className="text-xs text-ink-500">
                      Last absent {formatDate(row.lastDate, { calendar: cal, locale: ctx.locale })}
                    </p>
                  </div>
                  <Badge tone="bad">{row.days} days</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'missing' && (
        <Card title="Registers not taken (last 14 days)">
          {missing.length === 0 ? (
            <EmptyState
              title="Every register has been taken"
              description="Weekends and school holidays are excluded."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {missing.slice(0, 100).map((row) => (
                <li key={`${row.sectionId}:${row.date}`} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {row.gradeName} {row.sectionName}
                    </p>
                    <p className="text-xs text-ink-500">
                      {formatDate(row.date, { calendar: cal, locale: ctx.locale })}
                    </p>
                  </div>
                  <Link
                    href={`/attendance/${row.sectionId}?date=${row.date}`}
                    className="tap-target shrink-0 rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50"
                  >
                    Take now
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
