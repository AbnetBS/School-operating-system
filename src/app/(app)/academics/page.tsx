/**
 * Academic structure — years, terms, grades, sections and subjects.
 *
 * The dashboard has linked here since Group 1 with nothing behind it: six
 * links and the "no academic year" call to action all led to a 404. The data
 * and the query functions already existed, so this page surfaces them.
 *
 * The gaps it highlights — a section with no class teacher, a subject nobody
 * teaches — are the things that break attendance and the gradebook later, so
 * they are shown first.
 *
 * It also routes INTO the existing Group 3/4 screens rather than duplicating
 * them: a section row links to that section's register and its gradebook,
 * which is the journey someone on this page is actually making. It does not
 * become an analytics page; the numbers here are structural facts, not
 * performance measures.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { formatDate } from '../../../lib/calendar/ethiopian.ts';
import { academicYears, terms } from '../../../db/schema/core.ts';
import {
  getSchoolOverview,
  getSectionSummaries,
  getEnrollmentByGrade,
  getSectionsWithoutTeacher,
  getUnassignedSubjects,
} from '../../../lib/dashboard/queries.ts';
import {
  PageHeader,
  Card,
  StatCard,
  EmptyState,
  Badge,
  ActionAlert,
} from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export default async function AcademicsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  if (!ctx.has('academic.view')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  const overview = await getSchoolOverview(ctx.db, ctx.schoolId);

  // Deep links into the existing Group 3/4 screens. Gated on the module AND
  // the permission, exactly as `buildNav` gates the sidebar — offering a link
  // to a screen that will refuse the person is worse than offering nothing.
  const canTakeAttendance =
    Boolean(modules.attendance) && ctx.hasAny('attendance.take', 'attendance.view');
  const canSeeGrades = Boolean(modules.gradebook) && ctx.hasAny('grade.enter', 'grade.view');

  if (!overview.currentYearId) {
    return (
      <>
        <PageHeader title={t('academics.title')} />
        <ActionAlert
          tone="warn"
          title={t('academics.noYear')}
          detail={t('academics.noYearHelp')}
          href="/settings"
          linkLabel={t('action.next')}
        />
      </>
    );
  }

  const yearId = overview.currentYearId;

  const [years, termRows, sections, byGrade, noTeacher, noSubjectTeacher] = await Promise.all([
    ctx.db
      .select()
      .from(academicYears)
      .where(eq(academicYears.schoolId, ctx.schoolId))
      .orderBy(asc(academicYears.startDate)),
    ctx.db
      .select()
      .from(terms)
      .where(and(eq(terms.schoolId, ctx.schoolId), eq(terms.academicYearId, yearId)))
      .orderBy(asc(terms.sequence)),
    getSectionSummaries(ctx.db, ctx.schoolId, yearId),
    getEnrollmentByGrade(ctx.db, ctx.schoolId, yearId),
    getSectionsWithoutTeacher(ctx.db, ctx.schoolId, yearId),
    getUnassignedSubjects(ctx.db, ctx.schoolId, yearId),
  ]);

  const currentYear = years.find((y) => y.id === yearId);

  return (
    <>
      <PageHeader
        title={t('academics.title')}
        description={currentYear?.name ?? undefined}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('academics.terms')} value={termRows.length} />
        <StatCard label={t('academics.grades')} value={byGrade.length} />
        <StatCard label={t('academics.sections')} value={sections.length} />
        <StatCard label={t('academics.students')} value={overview.activeStudents} />
      </div>

      {/* The gaps that break other modules, shown before the reference data. */}
      {(noTeacher.length > 0 || noSubjectTeacher.count > 0) && (
        <div className="mb-6 space-y-3">
          {noTeacher.length > 0 && (
            <ActionAlert
              tone="warn"
              title={t('academics.sectionsWithoutTeacher', { count: String(noTeacher.length) })}
              detail={noTeacher.map((s) => `${s.gradeName} ${s.name}`).join(', ')}
              href="/staff"
              linkLabel={t('staff.title')}
            />
          )}
          {noSubjectTeacher.count > 0 && (
            <ActionAlert
              tone="warn"
              title={t('academics.subjectsWithoutTeacher', {
                count: String(noSubjectTeacher.count),
              })}
              detail={t('academics.subjectsWithoutTeacherHelp')}
              href="/staff"
              linkLabel={t('staff.title')}
            />
          )}
        </div>
      )}

      <Card title={t('academics.terms')} className="mb-6">
        {termRows.length === 0 ? (
          <EmptyState title={t('academics.noTerms')} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {termRows.map((term) => (
              <li key={term.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink-900">{term.name}</p>
                  <p className="text-xs text-ink-500">
                    {formatDate(term.startDate, {
                      calendar: locale.calendarDisplay,
                      locale: ctx.locale,
                    })}
                    {' — '}
                    {formatDate(term.endDate, {
                      calendar: locale.calendarDisplay,
                      locale: ctx.locale,
                    })}
                  </p>
                </div>
                {term.isCurrent && <Badge tone="good">{t('academics.current')}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('academics.sections')} className="mb-6">
        {sections.length === 0 ? (
          <EmptyState title={t('academics.noSections')} />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 sm:hidden">
              {sections.map((section) => (
                <li key={section.sectionId} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-ink-900">
                      {section.gradeName} {section.sectionName}
                    </p>
                    <Badge tone={section.classTeacherName ? 'neutral' : 'warn'}>
                      {section.studentCount}
                      {section.capacity ? ` / ${section.capacity}` : ''}
                    </Badge>
                  </div>
                  <p className="text-xs text-ink-500">
                    {section.classTeacherName ?? t('academics.noClassTeacher')}
                  </p>
                  {(canTakeAttendance || canSeeGrades) && (
                    <p className="mt-1.5 flex flex-wrap gap-3">
                      {canTakeAttendance && (
                        <Link
                          href={`/attendance/${section.sectionId}`}
                          className="text-xs font-medium text-brand-700 underline"
                        >
                          {t('nav.attendance')}
                        </Link>
                      )}
                      {canSeeGrades && (
                        <Link
                          href="/gradebook"
                          className="text-xs font-medium text-brand-700 underline"
                        >
                          {t('nav.gradebook')}
                        </Link>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('academics.section')}</th>
                    <th className="px-4 py-2 font-medium">{t('academics.classTeacher')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('academics.students')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('academics.subjects')}</th>
                    {(canTakeAttendance || canSeeGrades) && (
                      <th className="px-4 py-2 text-right font-medium">{t('ops.manage')}</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {sections.map((section) => (
                    <tr key={section.sectionId}>
                      <td className="px-4 py-2 font-medium text-ink-900">
                        {section.gradeName} {section.sectionName}
                      </td>
                      <td className="px-4 py-2 text-ink-700">
                        {section.classTeacherName ?? (
                          <span className="text-amber-700">{t('academics.noClassTeacher')}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink-700">
                        {section.studentCount}
                        {section.capacity ? (
                          <span className="text-ink-400"> / {section.capacity}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink-600">
                        {section.subjectCount}
                      </td>
                      {(canTakeAttendance || canSeeGrades) && (
                        <td className="px-4 py-2 text-right">
                          <span className="flex justify-end gap-3">
                            {canTakeAttendance && (
                              <Link
                                href={`/attendance/${section.sectionId}`}
                                className="text-xs font-medium text-brand-700 underline"
                              >
                                {t('nav.attendance')}
                              </Link>
                            )}
                            {canSeeGrades && (
                              <Link
                                href="/gradebook"
                                className="text-xs font-medium text-brand-700 underline"
                              >
                                {t('nav.gradebook')}
                              </Link>
                            )}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card
        title={t('academics.years')}
        action={
          <Link href="/settings" className="text-xs font-medium text-brand-600 hover:underline">
            {t('nav.settings')}
          </Link>
        }
      >
        <ul className="divide-y divide-ink-100">
          {years.map((year) => (
            <li key={year.id} className="flex items-center justify-between gap-2 py-3">
              <div>
                <p className="font-medium text-ink-900">{year.name}</p>
                <p className="text-xs text-ink-500">
                  {year.startDate} — {year.endDate}
                </p>
              </div>
              {year.isCurrent && <Badge tone="good">{t('academics.current')}</Badge>}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
