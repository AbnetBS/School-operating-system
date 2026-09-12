/**
 * Executive dashboard.
 *
 * Organised around three questions, in this order:
 *
 *   1. What needs attention now?
 *   2. What is getting worse?
 *   3. What is the school's current state?
 *
 * Everything in the first block links to the screen that resolves it. A
 * statistic a user cannot act on has been left out rather than added for
 * completeness — the specification is explicit that meaningless charts are a
 * failure, not a feature.
 *
 * Every panel is permission-gated independently. A user who may not see fees
 * does not get a fees card, and the query behind it is never run.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import {
  getSchoolOverview,
  getEnrollmentByGrade,
  getSectionsWithoutTeacher,
  getUnassignedSubjects,
  getTeacherAssignments,
} from '../../../lib/dashboard/queries.ts';
import { getTodayProgress } from '../../../lib/attendance/service.ts';
import { getRiskReport } from '../../../lib/analytics/risk.ts';
import { getMarksPipeline, getTermContext } from '../../../lib/analytics/academic.ts';
import { getFinanceSummary } from '../../../lib/finance/reports.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { money } from '../../../lib/finance/format.ts';
import { formatDate, todayIso } from '../../../lib/calendar/ethiopian.ts';
import {
  PageHeader,
  StatCard,
  Card,
  ActionAlert,
  EmptyState,
  BarRow,
} from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const overview = await getSchoolOverview(ctx.db, ctx.schoolId);
  const localeSettings = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(localeSettings.timezone);

  const isTeacherView =
    ctx.has('attendance.take') && !ctx.hasAny('academic.manage', 'student.create');

  if (!overview.currentYearId) {
    return (
      <>
        <PageHeader title={t('dashboard.title')} />
        <ActionAlert
          tone="warn"
          title={t('academics.noYear')}
          detail={t('academics.noYearHelp')}
          href="/academics"
          linkLabel={t('action.create')}
        />
      </>
    );
  }

  if (isTeacherView) {
    return (
      <TeacherDashboard ctx={ctx} t={t} yearId={overview.currentYearId} today={today} />
    );
  }

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  const termContext = await getTermContext(
    ctx.db,
    ctx.schoolId,
    overview.currentYearId,
    today,
  );

  // Each of these is gated: an unauthorised viewer never triggers the query.
  const canSeeAttendance = modules.attendance && ctx.hasAny('attendance.view', 'attendance.report');
  const canSeeAnalytics = ctx.has('analytics.view');
  const canSeeFinance = (modules.fees || modules.payments) && ctx.has('finance.report');
  const canSeeGradebook = modules.gradebook && ctx.hasAny('grade.view', 'grade.review');

  const [byGrade, missingTeachers, unassigned, attendanceToday, risk, pipeline, finance] =
    await Promise.all([
      getEnrollmentByGrade(ctx.db, ctx.schoolId, overview.currentYearId),
      getSectionsWithoutTeacher(ctx.db, ctx.schoolId, overview.currentYearId),
      getUnassignedSubjects(ctx.db, ctx.schoolId, overview.currentYearId),
      canSeeAttendance
        ? getTodayProgress(ctx.db, ctx.schoolId, overview.currentYearId, today)
        : null,
      canSeeAnalytics
        ? getRiskReport(ctx.db, ctx.schoolId, overview.currentYearId, {
            termId: termContext.currentTermId,
            previousTermId: termContext.previousTermId,
            pageSize: 5,
          })
        : null,
      canSeeGradebook && termContext.currentTermId
        ? getMarksPipeline(ctx.db, ctx.schoolId, termContext.currentTermId)
        : null,
      canSeeFinance ? getFinanceSummary(ctx) : null,
    ]);

  const maxGrade = Math.max(1, ...byGrade.map((g) => g.studentCount));

  // Assembled first, rendered as one block, so "needs attention" is genuinely
  // the top of the page rather than scattered among the statistics.
  const alerts: {
    key: string;
    tone: 'warn' | 'bad' | 'info';
    title: string;
    detail?: string;
    href: string;
    linkLabel: string;
  }[] = [];

  if (attendanceToday && attendanceToday.sectionsPending > 0) {
    alerts.push({
      key: 'registers',
      tone: 'warn',
      title: t('dashboard.pendingRegisters', {
        count: String(attendanceToday.sectionsPending),
      }),
      detail: t('dashboard.pendingRegistersHelp'),
      href: '/attendance',
      linkLabel: t('action.view'),
    });
  }

  if (risk && !risk.disabled && risk.total > 0) {
    alerts.push({
      key: 'risk',
      tone: 'bad',
      title: t('dashboard.riskAlert', { count: String(risk.total) }),
      detail: risk.students
        .slice(0, 3)
        .map((s) => [s.givenName, s.fatherName].filter(Boolean).join(' '))
        .join(', '),
      href: '/analytics/risk',
      linkLabel: t('risk.review'),
    });
  }

  if (pipeline && pipeline.pendingApproval > 0) {
    alerts.push({
      key: 'approval',
      tone: 'warn',
      title: t('dashboard.pendingApprovalAlert', {
        count: String(pipeline.pendingApproval),
      }),
      href: '/gradebook',
      linkLabel: t('action.approve'),
    });
  }

  if (pipeline && pipeline.missingMarks > 0) {
    alerts.push({
      key: 'marks',
      tone: 'warn',
      title: t('dashboard.missingMarksAlert', { count: String(pipeline.missingMarks) }),
      href: '/gradebook',
      linkLabel: t('action.view'),
    });
  }

  if (missingTeachers.length > 0) {
    alerts.push({
      key: 'teachers',
      tone: 'warn',
      title: t('academics.sectionsWithoutTeacher', { count: String(missingTeachers.length) }),
      detail: missingTeachers
        .slice(0, 4)
        .map((s) => `${s.gradeName} ${s.name}`)
        .join(', '),
      href: '/academics',
      linkLabel: t('action.edit'),
    });
  }

  if (unassigned.count > 0) {
    alerts.push({
      key: 'subjects',
      tone: 'warn',
      title: t('academics.subjectsWithoutTeacher', { count: String(unassigned.count) }),
      detail: t('academics.subjectsWithoutTeacherHelp'),
      href: '/academics',
      linkLabel: t('action.edit'),
    });
  }

  return (
    <>
      <PageHeader
        title={t('dashboard.greeting', { name: ctx.user.givenName })}
        description={`${formatDate(today, { calendar: 'both', locale: ctx.locale })} · ${overview.currentYearName}`}
      />

      <section className="mb-6 space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          {t('dashboard.needsAttention')}
        </h2>
        {alerts.length === 0 ? (
          <ActionAlert
            tone="info"
            title={t('dashboard.allClear')}
            detail={t('dashboard.allClearHelp')}
          />
        ) : (
          alerts.map((alert) => (
            <ActionAlert
              key={alert.key}
              tone={alert.tone}
              title={alert.title}
              detail={alert.detail}
              href={alert.href}
              linkLabel={alert.linkLabel}
            />
          ))
        )}
      </section>

      {attendanceToday && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {t('dashboard.today')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label={t('attendance.status.present')}
              value={
                attendanceToday.presentPercent === null
                  ? '—'
                  : `${attendanceToday.presentPercent}%`
              }
              sub={`${attendanceToday.studentsMarked}`}
              href="/attendance"
            />
            <StatCard
              label={t('attendance.status.absent')}
              value={attendanceToday.absent}
              tone={attendanceToday.absent > 0 ? 'warn' : 'good'}
              href="/attendance/reports"
            />
            <StatCard label={t('attendance.status.late')} value={attendanceToday.late} />
            <StatCard
              label={t('dashboard.registers')}
              value={`${attendanceToday.sectionsTaken}/${attendanceToday.sectionsTotal}`}
              tone={attendanceToday.sectionsPending > 0 ? 'warn' : 'good'}
              href="/attendance"
            />
          </div>
        </section>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          {t('analytics.overview')}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label={t('student.plural')}
            value={overview.activeStudents}
            href="/students"
          />
          <StatCard
            label={`${t('analytics.girls')} / ${t('analytics.boys')}`}
            value={`${overview.femaleStudents}/${overview.maleStudents}`}
          />
          <StatCard label={t('dashboard.teachers')} value={overview.teachers} href="/staff" />
          <StatCard label={t('academics.sections')} value={overview.sections} href="/academics" />
          <StatCard label={t('academics.subjects')} value={overview.subjects} href="/academics" />
          {finance ? (
            <StatCard
              label={t('finance.collected')}
              value={money(finance.collectedCents ?? 0, { locale: ctx.locale })}
              sub={
                finance.collectionRate === null || finance.collectionRate === undefined
                  ? undefined
                  : `${finance.collectionRate}%`
              }
              href="/finance"
            />
          ) : (
            <StatCard label={t('guardian.plural')} value={overview.guardianCount} />
          )}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={t('analytics.byGrade')}
          action={
            ctx.has('analytics.view') ? (
              <Link
                href="/analytics?tab=enrollment"
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                {t('dashboard.viewAll')}
              </Link>
            ) : undefined
          }
        >
          {byGrade.length === 0 ? (
            <EmptyState title={t('analytics.noData')} description={t('analytics.noDataHelp')} />
          ) : (
            <div className="space-y-0.5">
              {byGrade.map((grade) => (
                <BarRow
                  key={grade.gradeLevelId}
                  label={grade.gradeName}
                  value={grade.studentCount}
                  max={maxGrade}
                  hint={`${grade.studentCount}`}
                />
              ))}
            </div>
          )}
        </Card>

        {risk && !risk.disabled && (
          <Card
            title={t('risk.title')}
            action={
              <Link
                href="/analytics/risk"
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                {t('dashboard.viewAll')}
              </Link>
            }
          >
            {risk.students.length === 0 ? (
              <EmptyState title={t('risk.none')} description={t('risk.noneHelp')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {risk.students.map((student) => (
                  <li key={student.studentId}>
                    <Link
                      href={`/students/${student.studentId}`}
                      className="tap-target -mx-4 block px-4 py-2.5 hover:bg-ink-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-ink-900">
                          {[student.givenName, student.fatherName].filter(Boolean).join(' ')}
                        </p>
                        <span className="shrink-0 text-xs text-ink-500">
                          {student.sectionName ?? ''}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-600">
                        {student.signals
                          .map((signal) =>
                            t(`risk.reason.${signal.key}`, {
                              value: String(signal.value),
                              threshold: String(signal.threshold),
                            }),
                          )
                          .join(' · ')}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

/** A teacher's home screen: their classes, ready to act on. */
async function TeacherDashboard({
  ctx,
  t,
  yearId,
  today,
}: {
  ctx: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;
  t: ReturnType<typeof createTranslator>;
  yearId: string;
  today: string;
}) {
  const assignments = await getTeacherAssignments(ctx.db, ctx.schoolId, ctx.user.userId, yearId);

  const totalStudents = assignments.reduce((sum, a) => sum + a.studentCount, 0);
  const uniqueSections = new Set(assignments.map((a) => a.sectionId)).size;

  return (
    <>
      <PageHeader
        title={t('dashboard.greeting', { name: ctx.user.givenName })}
        description={formatDate(today, { calendar: 'both', locale: ctx.locale })}
      />

      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatCard label={t('dashboard.myClasses')} value={uniqueSections} />
        <StatCard label={t('academics.subjects')} value={assignments.length} />
        <StatCard label={t('student.plural')} value={totalStudents} />
      </div>

      <Card title={t('dashboard.myClasses')}>
        {assignments.length === 0 ? (
          <EmptyState
            title={t('dashboard.noClasses')}
            description={t('dashboard.noClassesHelp')}
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {assignments.map((assignment) => (
              <li key={assignment.sectionSubjectId}>
                <Link
                  href={`/attendance?section=${assignment.sectionId}&subject=${assignment.subjectId}`}
                  className="tap-target -mx-4 flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {assignment.gradeName} {assignment.sectionName} · {assignment.subjectName}
                    </p>
                    <p className="text-xs text-ink-500">
                      {t('dashboard.studentsLabel', { count: String(assignment.studentCount) })}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white">
                    {t('dashboard.takeAttendance')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
