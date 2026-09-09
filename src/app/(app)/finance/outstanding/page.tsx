import Link from 'next/link';
import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { getOutstandingStudents } from '../../../../lib/finance/reports.ts';
import { money } from '../../../../lib/finance/format.ts';
import { sections } from '../../../../db/schema/core.ts';
import { PageHeader, Card, EmptyState } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function OutstandingPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sectionId?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.fees && !modules.payments) {
    return (
      <Card>
        <EmptyState title={t('finance.disabled')} description={t('finance.disabledHelp')} />
      </Card>
    );
  }

  if (!ctx.hasAny('fee.view', 'finance.report')) {
    return (
      <Card>
        <EmptyState title={t('finance.noAccess')} />
      </Card>
    );
  }

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');
  const currency = finance.currency;

  const [rows, sectionRows] = await Promise.all([
    getOutstandingStudents(
      ctx,
      { sectionId: params.sectionId || undefined },
      { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
    ),
    ctx.db
      .select({ id: sections.id, name: sections.name })
      .from(sections)
      .where(eq(sections.schoolId, ctx.schoolId))
      .orderBy(asc(sections.name)),
  ]);

  const total = rows.reduce((sum, r) => sum + r.outstandingCents, 0);

  const qs = (next: number) => {
    const sp = new URLSearchParams();
    if (params.sectionId) sp.set('sectionId', params.sectionId);
    sp.set('page', String(next));
    return `/finance/outstanding?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={t('finance.outstandingStudents')}
        description={`${t('finance.studentsCount', { count: rows.length })} · ${money(total, { currency })}`}
      />

      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="sectionId" className="block text-xs font-medium text-ink-600">
              Class
            </label>
            <select
              id="sectionId"
              name="sectionId"
              defaultValue={params.sectionId ?? ''}
              className="tap-target mt-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
            >
              <option value="">All</option>
              {sectionRows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Filter
          </button>
        </form>

        {rows.length === 0 ? (
          <EmptyState title={t('finance.nothingOwed')} />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 sm:hidden">
              {rows.map((r) => (
                <li key={r.studentId} className="py-3">
                  <Link href={`/finance/students/${r.studentId}`} className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-brand-700">
                        {r.givenName} {r.fatherName} {r.grandfatherName ?? ''}
                      </span>
                      <span className="block text-xs text-ink-500">
                        {r.studentCode}
                        {r.oldestDue ? ` · ${t('finance.dueDate')} ${r.oldestDue}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-red-700">
                      {money(r.outstandingCents, { currency })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('finance.student')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('finance.charged')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('finance.paid')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('finance.outstanding')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.dueDate')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.map((r) => (
                    <tr key={r.studentId} className="hover:bg-ink-50">
                      <td className="px-4 py-2">
                        <Link
                          href={`/finance/students/${r.studentId}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {r.givenName} {r.fatherName} {r.grandfatherName ?? ''}
                        </Link>
                        <span className="block text-xs text-ink-500">{r.studentCode}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink-700">
                        {money(r.netCents, { currency })}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-emerald-700">
                        {money(r.paidCents, { currency })}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums text-red-700">
                        {money(r.outstandingCents, { currency })}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-ink-600">{r.oldestDue ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {(page > 1 || rows.length === PAGE_SIZE) && (
          <nav className="mt-4 flex items-center justify-between border-t border-ink-200 pt-3 text-sm">
            {page > 1 ? (
              <Link href={qs(page - 1)} className="text-brand-700 hover:underline">
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-ink-500">{page}</span>
            {rows.length === PAGE_SIZE ? (
              <Link href={qs(page + 1)} className="text-brand-700 hover:underline">
                Next →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </Card>
    </>
  );
}
