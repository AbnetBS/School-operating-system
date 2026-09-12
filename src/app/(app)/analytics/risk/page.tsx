/**
 * Students needing attention.
 *
 * The screen is built around the rule that a pupil is never reduced to a
 * number: every row shows the reasons before it shows the score, and the
 * thresholds that produced them are printed at the top so a teacher can see
 * what the school has configured without opening settings.
 *
 * Every row links to the student, because a list of problems with nowhere to
 * go is the "dead-end statistic" the specification rules out.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { getRiskReport, type RiskSignal } from '../../../../lib/analytics/risk.ts';
import { getTermContext } from '../../../../lib/analytics/academic.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { todayIso } from '../../../../lib/calendar/ethiopian.ts';
import { academicYears } from '../../../../db/schema/core.ts';
import { PageHeader, Card, EmptyState, Badge, StatCard } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

/** Turns a signal into the school's own words, with its real numbers. */
function explain(t: ReturnType<typeof createTranslator>, signal: RiskSignal): string {
  return t(`risk.reason.${signal.key}`, {
    value: String(signal.value),
    threshold: String(signal.threshold),
  });
}

export default async function RiskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  // Analytics is not a side channel: the same permission that guards the
  // dashboards guards this list.
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
  const page = Math.max(1, Number(pick('page') ?? '1') || 1);

  const [year] = await ctx.db
    .select({ id: academicYears.id, name: academicYears.name })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  if (!year) {
    return (
      <>
        <PageHeader title={t('risk.title')} />
        <Card>
          <EmptyState title={t('academics.noYear')} description={t('academics.noYearHelp')} />
        </Card>
      </>
    );
  }

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);
  const termContext = await getTermContext(ctx.db, ctx.schoolId, year.id, today);

  // A teacher restricted to their own sections sees only their own pupils
  // here, exactly as they do on every other screen.
  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  const report = await getRiskReport(ctx.db, ctx.schoolId, year.id, {
    termId: termContext.currentTermId,
    previousTermId: termContext.previousTermId,
    restrictToSectionIds,
    page,
    pageSize: 50,
  });

  if (report.disabled) {
    return (
      <>
        <PageHeader title={t('risk.title')} />
        <Card>
          <EmptyState title={t('risk.disabled')} description={t('risk.disabledHelp')} />
        </Card>
      </>
    );
  }

  const settings = report.settings;
  const totalPages = Math.max(1, Math.ceil(report.total / 50));

  return (
    <>
      <PageHeader
        title={t('risk.title')}
        description={t('risk.subtitle')}
        action={
          <a
            href="/api/analytics/export?report=risk"
            className="tap-target rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {t('analytics.export')}
          </a>
        }
      />

      {/* The configured rules, stated plainly. Without these the list is
          unaccountable — a teacher cannot tell whether 84% is a problem. */}
      <Card title={t('risk.thresholds')} className="mb-4">
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-600">
          {settings.attendanceEnabled && (
            <li>
              {t('analytics.attendance')}: ≤ {settings.attendanceThresholdPercent}%
            </li>
          )}
          {settings.consecutiveAbsenceEnabled && (
            <li>
              {t('risk.reason.consecutiveAbsence', {
                value: String(settings.consecutiveAbsenceDays),
                threshold: String(settings.consecutiveAbsenceDays),
              })}
            </li>
          )}
          {settings.academicEnabled && (
            <li>
              {t('analytics.average')}: ≤ {settings.academicThresholdPercent}%
            </li>
          )}
          {settings.declineEnabled && (
            <li>
              {t('analytics.change')}: −{settings.declinePoints}
            </li>
          )}
          <li>
            {t('risk.score')}: ≥ {settings.attentionScore}
          </li>
        </ul>
        <p className="mt-2 text-xs text-ink-500">{t('risk.notAScore')}</p>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label={t('risk.title')}
          value={report.total}
          tone={report.total > 0 ? 'warn' : 'good'}
        />
        {termContext.currentTermName && (
          <StatCard label={t('analytics.term')} value={termContext.currentTermName} />
        )}
      </div>

      {report.students.length === 0 ? (
        <Card>
          <EmptyState title={t('risk.none')} description={t('risk.noneHelp')} />
        </Card>
      ) : (
        <Card>
          {/* Mobile: a card per pupil. A table of reasons is unreadable on a
              phone, and this list is meant to be used in a corridor. */}
          <ul className="divide-y divide-ink-100 sm:hidden">
            {report.students.map((student) => (
              <li key={student.studentId} className="py-3">
                <Link
                  href={`/students/${student.studentId}`}
                  className="tap-target block hover:opacity-80"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">
                        {[student.givenName, student.fatherName].filter(Boolean).join(' ')}
                      </p>
                      <p className="text-xs text-ink-500">
                        {student.studentCode}
                        {student.sectionName
                          ? ` · ${student.gradeName ?? ''} ${student.sectionName}`
                          : ''}
                      </p>
                    </div>
                    <Badge tone="warn">{student.score}</Badge>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {student.signals.map((signal) => (
                      <li key={signal.key} className="text-xs text-ink-700">
                        • {explain(t, signal)}
                      </li>
                    ))}
                  </ul>
                </Link>
              </li>
            ))}
          </ul>

          <div className="-mx-4 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 font-medium">{t('student.title')}</th>
                  <th className="px-4 py-2 font-medium">{t('academics.section')}</th>
                  <th className="px-4 py-2 font-medium">{t('risk.reasons')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('risk.score')}</th>
                </tr>
              </thead>
              <tbody>
                {report.students.map((student) => (
                  <tr key={student.studentId} className="border-b border-ink-100 last:border-0">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/students/${student.studentId}`}
                        className="font-medium text-brand-600 hover:underline"
                      >
                        {[student.givenName, student.fatherName].filter(Boolean).join(' ')}
                      </Link>
                      <p className="text-xs text-ink-500">{student.studentCode}</p>
                    </td>
                    <td className="px-4 py-2.5 text-ink-600">
                      {student.sectionName
                        ? `${student.gradeName ?? ''} ${student.sectionName}`.trim()
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <ul className="space-y-0.5">
                        {student.signals.map((signal) => (
                          <li key={signal.key} className="text-xs text-ink-700">
                            {explain(t, signal)}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Badge tone="warn">{student.score}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-ink-500">{t('risk.neverAutomatic')}</p>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link
              href={`/analytics/risk?page=${page - 1}`}
              className="tap-target rounded-lg border border-ink-200 px-3 py-2"
            >
              {t('action.previous')}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-ink-500">
            {page} / {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={`/analytics/risk?page=${page + 1}`}
              className="tap-target rounded-lg border border-ink-200 px-3 py-2"
            >
              {t('action.next')}
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </>
  );
}
