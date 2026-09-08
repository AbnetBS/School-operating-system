import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getReportCard } from '../../../../lib/gradebook/reportCards.ts';
import { schools } from '../../../../db/schema/core.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import PrintButton from './PrintButton.tsx';

export const dynamic = 'force-dynamic';

/**
 * A single report card, laid out for paper.
 *
 * Printing goes through the browser rather than a PDF library: schools already
 * print from a browser, and a print stylesheet avoids a heavyweight dependency
 * that would need its own fonts to render Amharic correctly.
 */
export default async function ReportCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.reportCards) notFound();
  if (!ctx.hasAny('reportCard.view', 'reportCard.generate')) notFound();

  const { id } = await params;
  const card = await getReportCard(ctx.db, ctx.schoolId, id);
  if (!card) notFound();

  const [school] = await ctx.db
    .select({ name: schools.name, nameAm: schools.nameAm })
    .from(schools)
    .where(eq(schools.id, ctx.schoolId))
    .limit(1);

  const data = card.data;
  const s = card.settings;

  return (
    <div className="space-y-4">
      {/* Screen-only controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/report-cards" className="text-sm font-medium text-brand-700 hover:underline">
          ← All report cards
        </Link>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-700">
            {card.status.replace('_', ' ')}
          </span>
          <PrintButton />
        </div>
      </div>

      <article className="card mx-auto max-w-[820px] p-6 print:border-0 print:shadow-none">
        <header className="border-b border-ink-300 pb-4 text-center">
          {s.headerText ? (
            <p className="text-sm text-ink-600">{s.headerText}</p>
          ) : null}
          <h1 className="text-xl font-bold text-ink-900">{school?.name}</h1>
          {school?.nameAm && <p className="text-sm text-ink-600">{school.nameAm}</p>}
          <p className="mt-1 text-sm font-medium text-ink-700">
            Report card — {data?.term.name}
          </p>
        </header>

        {!data ? (
          <p className="py-8 text-center text-sm text-ink-500">
            This report card has no content yet.
          </p>
        ) : (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-ink-500">Student</dt>
                <dd className="font-medium text-ink-900">{data.student.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">ID</dt>
                <dd className="font-medium text-ink-900">{data.student.studentCode}</dd>
              </div>
              {s.showAttendance && data.attendancePercent !== null && (
                <div>
                  <dt className="text-xs text-ink-500">Attendance</dt>
                  <dd className="font-medium text-ink-900">{data.attendancePercent}%</dd>
                </div>
              )}
              {s.showRank && data.rankInSection !== null && (
                <div>
                  <dt className="text-xs text-ink-500">Rank</dt>
                  <dd className="font-medium text-ink-900">
                    {data.rankInSection}
                    {data.classSize ? ` of ${data.classSize}` : ''}
                  </dd>
                </div>
              )}
            </dl>

            <table className="mt-5 w-full text-sm">
              <thead>
                <tr className="border-y border-ink-300 text-left">
                  <th className="py-2 font-medium">Subject</th>
                  <th className="py-2 text-right font-medium">Mark</th>
                  <th className="py-2 text-right font-medium">Grade</th>
                  {s.showRank && <th className="py-2 text-right font-medium">Rank</th>}
                </tr>
              </thead>
              <tbody>
                {data.subjects.map((row) => (
                  <tr key={row.subjectName} className="border-b border-ink-200">
                    <td className="py-2 text-ink-900">
                      {row.subjectName}
                      {row.subjectNameAm ? (
                        <span className="text-ink-500"> · {row.subjectNameAm}</span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right text-ink-900">
                      {row.percentage === null ? '—' : `${row.percentage}%`}
                    </td>
                    <td className="py-2 text-right text-ink-900">{row.letter ?? '—'}</td>
                    {s.showRank && (
                      <td className="py-2 text-right text-ink-700">{row.rank ?? '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-400 font-semibold">
                  <td className="py-2 text-ink-900">Average</td>
                  <td className="py-2 text-right text-ink-900">
                    {data.average === null ? '—' : `${data.average}%`}
                  </td>
                  <td className="py-2 text-right text-ink-900">
                    {data.gpa !== null ? `GPA ${data.gpa}` : ''}
                  </td>
                  {s.showRank && <td />}
                </tr>
              </tfoot>
            </table>

            {s.showConduct && card.conduct && (
              <p className="mt-4 text-sm">
                <span className="font-medium text-ink-900">Conduct: </span>
                <span className="text-ink-700">{card.conduct}</span>
              </p>
            )}

            {s.showTeacherComment && card.classTeacherComment && (
              <p className="mt-3 text-sm">
                <span className="font-medium text-ink-900">Class teacher: </span>
                <span className="text-ink-700">{card.classTeacherComment}</span>
              </p>
            )}

            {s.showPrincipalComment && card.principalComment && (
              <p className="mt-2 text-sm">
                <span className="font-medium text-ink-900">Principal: </span>
                <span className="text-ink-700">{card.principalComment}</span>
              </p>
            )}

            {s.showSignatures && (
              <div className="mt-10 grid grid-cols-2 gap-8 text-xs text-ink-600">
                <div className="border-t border-ink-400 pt-1">Class teacher</div>
                <div className="border-t border-ink-400 pt-1">Principal</div>
              </div>
            )}

            {s.footerText && (
              <p className="mt-6 border-t border-ink-200 pt-3 text-center text-xs text-ink-500">
                {s.footerText}
              </p>
            )}
          </>
        )}
      </article>
    </div>
  );
}
