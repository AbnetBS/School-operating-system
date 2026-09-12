import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import {
  getTeachableSections,
  getTodayProgress,
} from '../../../lib/attendance/service.ts';
import { academicYears } from '../../../db/schema/core.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { todayIso, formatDate } from '../../../lib/calendar/ethiopian.ts';
import {
  PageHeader,
  Card,
  Badge,
  EmptyState,
  StatCard,
  ActionAlert,
} from '../../../components/ui.tsx';
import DatePicker from './DatePicker.tsx';

export const dynamic = 'force-dynamic';

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.attendance) {
    return (
      <Card>
        <EmptyState
          title="Attendance is switched off for this school"
          description="An administrator can enable it in Settings."
        />
      </Card>
    );
  }

  if (!ctx.hasAny('attendance.take', 'attendance.view')) {
    return (
      <Card>
        <EmptyState
          title="You do not have permission to view attendance"
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

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  if (!year) {
    return (
      <>
        <PageHeader title="Attendance" />
        <ActionAlert
          tone="warn"
          title="No academic year is set up yet"
          detail="Attendance is recorded against an academic year. Create one to begin."
          href="/settings/academic"
          linkLabel="Set up academic year"
        />
      </>
    );
  }

  const [localeSettings, attendanceSettings] = await Promise.all([
    getSetting(ctx.db, ctx.schoolId, 'locale'),
    getSetting(ctx.db, ctx.schoolId, 'attendance'),
  ]);

  const today = todayIso(localeSettings.timezone);
  const date = pick('date') ?? today;

  const [sections, progress] = await Promise.all([
    getTeachableSections(ctx, year.id, date),
    ctx.has('attendance.report')
      ? getTodayProgress(ctx.db, ctx.schoolId, year.id, date)
      : Promise.resolve(null),
  ]);

  const isPast = date < today;
  const isFuture = date > today;

  return (
    <>
      <PageHeader
        title="Attendance"
        description={formatDate(date, {
          calendar: localeSettings.calendarDisplay,
          locale: ctx.locale,
        })}
      />

      <DatePicker current={date} today={today} />

      {isFuture && (
        <div className="mt-4">
          <ActionAlert
            tone="warn"
            title="This date is in the future"
            detail="Attendance can only be recorded for today or a past date."
          />
        </div>
      )}

      {progress && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Registers taken"
            value={`${progress.sectionsTaken}/${progress.sectionsTotal}`}
            tone={progress.sectionsPending === 0 ? 'good' : 'warn'}
            sub={progress.sectionsPending > 0 ? `${progress.sectionsPending} outstanding` : 'All classes done'}
          />
          <StatCard
            label="Present"
            value={progress.presentPercent === null ? '—' : `${progress.presentPercent}%`}
            tone={
              progress.presentPercent === null
                ? 'default'
                : progress.presentPercent >= (attendanceSettings.riskThresholdPercent ?? 85)
                  ? 'good'
                  : 'warn'
            }
            sub={`${progress.present} of ${progress.studentsMarked} marked`}
          />
          <StatCard label="Absent" value={progress.absent} tone={progress.absent > 0 ? 'bad' : 'good'} />
          <StatCard label="Late" value={progress.late} tone={progress.late > 0 ? 'warn' : 'good'} />
        </div>
      )}

      <Card className="mt-4" title={ctx.has('attendance.editAny') ? 'All classes' : 'My classes'}>
        {sections.length === 0 ? (
          <EmptyState
            title="No classes assigned to you"
            description="Ask an administrator to assign you to a class before taking attendance."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {sections.map((section) => {
              const taken = section.sessionId !== null;
              return (
                <li key={section.id}>
                  <Link
                    href={`/attendance/${section.id}?date=${date}`}
                    className="tap-target -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-3 hover:bg-ink-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">
                        {section.gradeName} {section.name}
                      </p>
                      <p className="text-xs text-ink-500">
                        {section.studentCount} student{section.studentCount === 1 ? '' : 's'}
                        {taken && section.absentToday !== null
                          ? ` · ${section.absentToday} absent`
                          : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {taken ? (
                        <Badge tone="good">Taken</Badge>
                      ) : isFuture ? (
                        <Badge tone="neutral">—</Badge>
                      ) : (
                        <Badge tone={isPast ? 'bad' : 'warn'}>{isPast ? 'Missed' : 'Pending'}</Badge>
                      )}
                      <span aria-hidden className="text-ink-300">
                        ›
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {ctx.has('attendance.report') && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/attendance/reports"
            className="tap-target inline-flex items-center rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
          >
            Reports &amp; at-risk students
          </Link>
        </div>
      )}
    </>
  );
}
