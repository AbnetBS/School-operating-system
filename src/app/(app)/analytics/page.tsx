/**
 * School analytics.
 *
 * Four views over data other modules own: enrolment, academic performance,
 * teacher completion and the attendance picture. Nothing here is stored; every
 * figure is a query, so the analytics can never drift from the record.
 *
 * Each view exports to CSV through the same service it renders, so an export
 * can never contain more than the screen.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { todayIso } from '../../../lib/calendar/ethiopian.ts';
import { academicYears } from '../../../db/schema/core.ts';
import {
  getSchoolOverview,
  getEnrollmentByGrade,
  getSectionSummaries,
} from '../../../lib/dashboard/queries.ts';
import {
  getTermContext,
  getSubjectPerformance,
  getStudentTrends,
  getMarksPipeline,
  getSubjectRanking,
} from '../../../lib/analytics/academic.ts';
import { getTeacherCompletion } from '../../../lib/analytics/teachers.ts';
import {
  PageHeader,
  Card,
  EmptyState,
  StatCard,
  Badge,
  BarRow,
} from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

const TABS = ['enrollment', 'academic', 'teachers'] as const;
type Tab = (typeof TABS)[number];

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  if (!ctx.has('analytics.view')) {
    return (
      <Card>
        <EmptyState
          title={t('analytics.noPermission')}
          description={t('analytics.noPermissionHelp')}
        />
      </Card>
    );
  }

  const raw = await searchParams;
  const pick = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const requested = pick('tab');
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as Tab)
    : 'enrollment';

  const [year] = await ctx.db
    .select({ id: academicYears.id, name: academicYears.name })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  if (!year) {
    return (
      <>
        <PageHeader title={t('analytics.title')} />
        <Card>
          <EmptyState title={t('academics.noYear')} description={t('academics.noYearHelp')} />
        </Card>
      </>
    );
  }

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);
  const termContext = await getTermContext(ctx.db, ctx.schoolId, year.id, today);
  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  const tabLabel: Record<Tab, string> = {
    enrollment: t('analytics.enrollment'),
    academic: t('analytics.academic'),
    teachers: t('analytics.teachers'),
  };

  return (
    <>
      <PageHeader
        title={t('analytics.title')}
        description={`${year.name}${termContext.currentTermName ? ` · ${termContext.currentTermName}` : ''}`}
        action={
          <a
            href={`/api/analytics/export?report=${tab}`}
            className="tap-target rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {t('analytics.export')}
          </a>
        }
      />

      <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 pb-1">
        {TABS.map((key) => (
          <Link
            key={key}
            href={`/analytics?tab=${key}`}
            className={`tap-target shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition ${
              tab === key
                ? 'bg-brand-600 text-white'
                : 'border border-ink-200 text-ink-700 hover:bg-ink-50'
            }`}
          >
            {tabLabel[key]}
          </Link>
        ))}
      </nav>

      {tab === 'enrollment' && (
        <EnrollmentView ctx={ctx} t={t} yearId={year.id} />
      )}
      {tab === 'academic' && (
        <AcademicView
          ctx={ctx}
          t={t}
          termId={termContext.currentTermId}
          previousTermId={termContext.previousTermId}
          previousTermName={termContext.previousTermName}
          restrictToSectionIds={restrictToSectionIds}
        />
      )}
      {tab === 'teachers' && (
        <TeachersView
          ctx={ctx}
          t={t}
          yearId={year.id}
          termId={termContext.currentTermId}
          restrictToSectionIds={restrictToSectionIds}
        />
      )}
    </>
  );
}

type Ctx = NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;
type T = ReturnType<typeof createTranslator>;

// ---------------------------------------------------------------------------

async function EnrollmentView({ ctx, t, yearId }: { ctx: Ctx; t: T; yearId: string }) {
  const [overview, byGrade, sections] = await Promise.all([
    getSchoolOverview(ctx.db, ctx.schoolId),
    getEnrollmentByGrade(ctx.db, ctx.schoolId, yearId),
    getSectionSummaries(ctx.db, ctx.schoolId, yearId, { limit: 60 }),
  ]);

  const maxGrade = Math.max(1, ...byGrade.map((g) => g.studentCount));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('student.plural')} value={overview.activeStudents} href="/students" />
        <StatCard label={t('analytics.girls')} value={overview.femaleStudents} />
        <StatCard label={t('analytics.boys')} value={overview.maleStudents} />
        <StatCard label={t('academics.sections')} value={overview.sections} />
      </div>

      <Card title={t('analytics.byGrade')}>
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

      <Card title={t('analytics.bySection')}>
        {sections.length === 0 ? (
          <EmptyState title={t('academics.noSections')} />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 sm:hidden">
              {sections.map((section) => (
                <li key={section.sectionId} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {section.gradeName} {section.sectionName}
                    </p>
                    <p className="text-xs text-ink-500">
                      {section.classTeacherName ?? t('academics.noClassTeacher')}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-ink-700">
                    {section.studentCount}
                    {section.capacity ? (
                      <span className="text-ink-400"> / {section.capacity}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>

            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('academics.section')}</th>
                    <th className="px-4 py-2 font-medium">{t('academics.classTeacher')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('student.plural')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('analytics.capacity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((section) => (
                    <tr key={section.sectionId} className="border-b border-ink-100 last:border-0">
                      <td className="px-4 py-2.5 font-medium text-ink-900">
                        {section.gradeName} {section.sectionName}
                      </td>
                      <td className="px-4 py-2.5 text-ink-600">
                        {section.classTeacherName ?? (
                          <Badge tone="warn">{t('academics.noClassTeacher')}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {section.studentCount}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-500">
                        {section.capacity ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function AcademicView({
  ctx,
  t,
  termId,
  previousTermId,
  previousTermName,
  restrictToSectionIds,
}: {
  ctx: Ctx;
  t: T;
  termId: string | null;
  previousTermId: string | null;
  previousTermName: string | null;
  restrictToSectionIds: string[] | undefined;
}) {
  if (!termId) {
    return (
      <Card>
        <EmptyState title={t('analytics.noTerm')} description={t('analytics.noDataHelp')} />
      </Card>
    );
  }

  const [performance, pipeline, ranking, declining] = await Promise.all([
    getSubjectPerformance(ctx.db, ctx.schoolId, termId, { restrictToSectionIds }),
    getMarksPipeline(ctx.db, ctx.schoolId, termId, { restrictToSectionIds }),
    getSubjectRanking(ctx.db, ctx.schoolId, termId, { restrictToSectionIds }),
    getStudentTrends(ctx.db, ctx.schoolId, termId, previousTermId, {
      restrictToSectionIds,
      minDeclinePoints: 10,
      limit: 20,
    }),
  ]);

  const graded = performance.rows.filter((r) => r.averagePercent !== null);

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-500">{t('analytics.basisNote')}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t('analytics.pendingApproval')}
          value={pipeline.pendingApproval}
          tone={pipeline.pendingApproval > 0 ? 'warn' : 'default'}
          href="/gradebook"
        />
        <StatCard
          label={t('analytics.missingMarks')}
          value={pipeline.missingMarks}
          tone={pipeline.missingMarks > 0 ? 'warn' : 'good'}
          href="/gradebook"
        />
        <StatCard label={t('analytics.approved')} value={pipeline.approved} />
        <StatCard label={t('analytics.draft')} value={pipeline.draft} />
      </div>

      {ranking.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('analytics.strongest')}>
            <div className="space-y-0.5">
              {ranking.slice(0, 5).map((subject) => (
                <BarRow
                  key={subject.subjectId}
                  label={subject.subjectName}
                  value={subject.averagePercent}
                  max={100}
                  hint={`${subject.averagePercent}%`}
                />
              ))}
            </div>
          </Card>
          <Card title={t('analytics.weakest')}>
            <div className="space-y-0.5">
              {[...ranking]
                .reverse()
                .slice(0, 5)
                .map((subject) => (
                  <BarRow
                    key={subject.subjectId}
                    label={subject.subjectName}
                    value={subject.averagePercent}
                    max={100}
                    hint={`${subject.averagePercent}%`}
                  />
                ))}
            </div>
          </Card>
        </div>
      )}

      <Card title={t('analytics.declining')}>
        {!previousTermId ? (
          <EmptyState title={t('analytics.noComparison')} description={t('analytics.noHistory')} />
        ) : declining.length === 0 ? (
          <EmptyState title={t('analytics.noDecline')} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {declining.map((student) => (
              <li key={student.studentId}>
                <Link
                  href={`/students/${student.studentId}`}
                  className="tap-target -mx-4 flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {[student.givenName, student.fatherName].filter(Boolean).join(' ')}
                    </p>
                    <p className="text-xs text-ink-500">
                      {student.sectionName
                        ? `${student.gradeName ?? ''} ${student.sectionName}`.trim()
                        : student.studentCode}
                      {previousTermName
                        ? ` · ${t('analytics.comparedTo', { term: previousTermName })}`
                        : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-red-700">
                    {student.changePoints}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('analytics.academic')}>
        {graded.length === 0 && performance.rows.length === 0 ? (
          <EmptyState title={t('analytics.noData')} description={t('analytics.noDataHelp')} />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 sm:hidden">
              {performance.rows.map((row) => (
                <li key={row.sectionSubjectId} className="py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">
                        {row.gradeName} {row.sectionName} · {row.subjectName}
                      </p>
                      <p className="text-xs text-ink-500">
                        {row.teacherName ?? t('academics.noClassTeacher')}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {row.averagePercent === null ? '—' : `${row.averagePercent}%`}
                    </span>
                  </div>
                  {row.missingResults > 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      {t('analytics.missingResults')}: {row.missingResults}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('academics.section')}</th>
                    <th className="px-4 py-2 font-medium">{t('academics.subjects')}</th>
                    <th className="px-4 py-2 font-medium">{t('staff.title')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('analytics.average')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('analytics.passRate')}</th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t('analytics.missingResults')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {performance.rows.map((row) => (
                    <tr key={row.sectionSubjectId} className="border-b border-ink-100 last:border-0">
                      <td className="px-4 py-2.5 font-medium text-ink-900">
                        {row.gradeName} {row.sectionName}
                      </td>
                      <td className="px-4 py-2.5 text-ink-700">{row.subjectName}</td>
                      <td className="px-4 py-2.5 text-ink-600">
                        {row.teacherName ?? <Badge tone="warn">{t('academics.noClassTeacher')}</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {row.averagePercent === null ? '—' : `${row.averagePercent}%`}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {row.passRate === null ? '—' : `${row.passRate}%`}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {row.missingResults > 0 ? (
                          <span className="text-amber-700">{row.missingResults}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function TeachersView({
  ctx,
  t,
  yearId,
  termId,
  restrictToSectionIds,
}: {
  ctx: Ctx;
  t: T;
  yearId: string;
  termId: string | null;
  restrictToSectionIds: string[] | undefined;
}) {
  const rows = await getTeacherCompletion(ctx.db, ctx.schoolId, yearId, {
    termId,
    restrictToSectionIds,
  });

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-500">{t('teachers.notScoring')}</p>

      <Card title={t('teachers.title')}>
        {rows.length === 0 ? (
          <EmptyState title={t('teachers.none')} description={t('analytics.noDataHelp')} />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 sm:hidden">
              {rows.map((teacher) => (
                <li key={teacher.teacherId} className="py-2.5">
                  <p className="text-sm font-medium text-ink-900">{teacher.teacherName}</p>
                  <p className="text-xs text-ink-500">
                    {teacher.sectionCount} {t('teachers.classes')} · {teacher.studentCount}{' '}
                    {t('student.plural')}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {teacher.registersMissing > 0 ? (
                      <span className="text-amber-700">
                        {t('teachers.registersMissing')}: {teacher.registersMissing}
                      </span>
                    ) : (
                      <span className="text-emerald-700">{t('teachers.upToDate')}</span>
                    )}
                    {teacher.missingMarks > 0 && (
                      <span className="text-amber-700">
                        {t('analytics.missingMarks')}: {teacher.missingMarks}
                      </span>
                    )}
                    {teacher.pendingApproval > 0 && (
                      <span className="text-ink-600">
                        {t('analytics.pendingApproval')}: {teacher.pendingApproval}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('staff.title')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('teachers.classes')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('student.plural')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('teachers.registers')}</th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t('teachers.registersMissing')}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t('analytics.missingMarks')}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t('analytics.pendingApproval')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((teacher) => (
                    <tr key={teacher.teacherId} className="border-b border-ink-100 last:border-0">
                      <td className="px-4 py-2.5 font-medium text-ink-900">
                        {teacher.teacherName}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {teacher.sectionCount}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {teacher.studentCount}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">
                        {teacher.registersTaken}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {teacher.registersMissing > 0 ? (
                          <span className="text-amber-700">{teacher.registersMissing}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {teacher.missingMarks > 0 ? (
                          <span className="text-amber-700">{teacher.missingMarks}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">
                        {teacher.pendingApproval}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
