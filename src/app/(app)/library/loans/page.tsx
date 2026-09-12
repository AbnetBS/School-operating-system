/**
 * Loans — active, overdue and returned.
 *
 * Three views of one list rather than three screens, because "who has this
 * book?" and "what came back last week?" are the same question asked with a
 * different filter. History is included: a book that keeps coming back damaged
 * is a fact only the history shows.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { listLoans } from '../../../../lib/operations/library.ts';
import { money } from '../../../../lib/finance/format.ts';
import { PageHeader, Card, EmptyState, Badge } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

const VIEWS = ['open', 'overdue', 'returned'] as const;
type View = (typeof VIEWS)[number];

const PAGE_SIZE = 50;

export default async function LibraryLoansPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.library) {
    return (
      <Card>
        <EmptyState title={t('library.disabled')} />
      </Card>
    );
  }
  if (!ctx.has('library.view')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const params = await searchParams;
  const status: View = VIEWS.includes(params.status as View) ? (params.status as View) : 'open';
  const q = params.q?.trim() || null;
  const page = Math.max(1, Number(params.page ?? '1') || 1);

  const { loans, total } = await listLoans(ctx, {
    status,
    q,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const label: Record<View, string> = {
    open: t('library.activeLoans'),
    overdue: t('library.overdue'),
    returned: t('library.loanHistory'),
  };

  const href = (view: View, nextPage = 1) =>
    `/library/loans?status=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}${
      nextPage > 1 ? `&page=${nextPage}` : ''
    }`;

  return (
    <>
      <PageHeader
        title={t('library.loans')}
        description={label[status]}
        action={
          <Link
            href="/library"
            className="tap-target rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {t('action.back')}
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {VIEWS.map((view) => (
          <Link
            key={view}
            href={href(view)}
            className={`tap-target rounded-lg border px-4 py-2 text-sm font-medium transition ${
              status === view
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-50'
            }`}
          >
            {label[view]}
          </Link>
        ))}
      </div>

      <Card>
        {/* Search runs on the server through the URL, so it works without JS
            and survives a page reload. */}
        <form method="get" action="/library/loans" className="mb-4 flex gap-2">
          <input type="hidden" name="status" value={status} />
          <input
            type="search"
            name="q"
            defaultValue={q ?? ''}
            placeholder={t('library.searchPlaceholder')}
            className="tap-target min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('action.search')}
          </button>
        </form>

        {loans.length === 0 ? (
          <EmptyState title={t('library.noLoans')} />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 sm:hidden">
              {loans.map((loan) => (
                <li key={loan.id} className="py-3">
                  <p className="font-medium text-ink-900">{loan.title}</p>
                  <p className="text-sm text-ink-600">{loan.borrowerName}</p>
                  <p className="mt-0.5 font-mono text-xs text-ink-400">{loan.accessionNumber}</p>
                  <p className="mt-1 text-xs">
                    {loan.returnedOn ? (
                      <span className="text-ink-500">
                        {t('library.returnedOn')}: {loan.returnedOn}
                      </span>
                    ) : loan.daysOverdue > 0 ? (
                      <span className="font-medium text-red-700">
                        {t('library.overdueBy', { days: String(loan.daysOverdue) })}
                      </span>
                    ) : (
                      <span className="text-ink-500">
                        {t('library.dueOn')}: {loan.dueOn}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>

            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('library.item')}</th>
                    <th className="px-4 py-2 font-medium">{t('library.borrower')}</th>
                    <th className="px-4 py-2 font-medium">{t('library.accession')}</th>
                    <th className="px-4 py-2 font-medium">{t('library.issuedOn')}</th>
                    <th className="px-4 py-2 font-medium">
                      {status === 'returned' ? t('library.returnedOn') : t('library.dueOn')}
                    </th>
                    <th className="px-4 py-2 font-medium">{t('finance.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {loans.map((loan) => (
                    <tr key={loan.id}>
                      <td className="px-4 py-2 font-medium text-ink-900">{loan.title}</td>
                      <td className="px-4 py-2 text-ink-700">
                        {loan.borrowerName}
                        {loan.borrowerRef && (
                          <span className="block font-mono text-xs text-ink-400">
                            {loan.borrowerRef}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-ink-500">
                        {loan.accessionNumber}
                      </td>
                      <td className="px-4 py-2 text-ink-600">{loan.issuedOn}</td>
                      <td className="px-4 py-2 text-ink-600">
                        {loan.returnedOn ?? loan.dueOn}
                      </td>
                      <td className="px-4 py-2">
                        {loan.returnedOn ? (
                          <Badge tone="good">{t('library.returned')}</Badge>
                        ) : loan.daysOverdue > 0 ? (
                          <Badge tone="bad">
                            {t('library.overdueBy', { days: String(loan.daysOverdue) })}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">{t('library.onLoan')}</Badge>
                        )}
                        {loan.fineCents > 0 && (
                          <span className="ml-2 text-xs text-amber-800">
                            {t('library.fine')}: {money(loan.fineCents)}
                            {loan.fineWaived && ` (${t('library.waiveFine')})`}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-ink-500">
              {t('ops.showing', { count: String(loans.length), total: String(total) })}
            </p>

            {pages > 1 && (
              <nav className="mt-4 flex items-center justify-between gap-2 text-sm">
                {page > 1 ? (
                  <Link
                    href={href(status, page - 1)}
                    className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-ink-700 hover:bg-ink-50"
                  >
                    {t('action.back')}
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-ink-500">
                  {page} / {pages}
                </span>
                {page < pages ? (
                  <Link
                    href={href(status, page + 1)}
                    className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-ink-700 hover:bg-ink-50"
                  >
                    {t('action.next')}
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </>
        )}
      </Card>
    </>
  );
}
