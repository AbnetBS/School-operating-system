/**
 * Library — catalogue and lending desk in one screen.
 *
 * The overdue list comes first because it is the only part of a librarian's
 * day that is time-critical. The lending desk sits next to it, then the
 * catalogue, which answers "have we got it, and is a copy on the shelf?".
 *
 * Everything a person cannot do is absent rather than disabled, and every
 * absence is decided from the permission set on the server. The API repeats
 * every one of these checks — see `src/lib/operations/library.ts`.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { todayIso } from '../../../lib/calendar/ethiopian.ts';
import { listLibraryItems, listLoans } from '../../../lib/operations/library.ts';
import {
  LIBRARY_ITEM_TYPES,
  CONDITIONS,
  COPY_STATUSES,
} from '../../../lib/operations/schema.ts';
import { PageHeader, Card, StatCard, EmptyState, Badge } from '../../../components/ui.tsx';
import { LibrarySearch } from './search.tsx';
import LendingDesk from './LendingDesk.tsx';
import CatalogueManager from './CatalogueManager.tsx';

export const dynamic = 'force-dynamic';

/** Keys the client islands need, resolved here because they cannot translate. */
const LABEL_KEYS = [
  'action.save',
  'action.cancel',
  'action.edit',
  'ops.saving',
  'ops.saved',
  'ops.loading',
  'ops.change',
  'ops.done',
  'ops.noResults',
  'ops.searchStudent',
  'ops.searchStaff',
  'ops.manage',
  'ops.readOnly',
  'library.item',
  'library.newItem',
  'library.newItemHelp',
  'library.itemSaved',
  'library.author',
  'library.isbn',
  'library.callNumber',
  'library.publisher',
  'library.publishedYear',
  'library.language',
  'library.description',
  'library.category',
  'library.active',
  'library.inactive',
  'library.itemType',
  'library.copies',
  'library.addCopies',
  'library.copiesAdded',
  'library.copyCount',
  'library.copyPrefix',
  'library.copyPrefixHelp',
  'library.acquiredOn',
  'library.condition',
  'library.copyStatus',
  'library.copySaved',
  'library.noCopies',
  'library.noAvailableCopies',
  'library.desk',
  'library.issue',
  'library.issueTo',
  'library.issued',
  'library.borrowerStudent',
  'library.borrowerStaff',
  'library.searchPlaceholder',
  'library.dueDate',
  'library.dueDateHelp',
  'library.dueOn',
  'library.return',
  'library.returned',
  'library.returnCondition',
  'library.renew',
  'library.renewed',
  'library.onLoan',
  'library.onLoanTo',
  'library.overdueBy',
  'library.noLoans',
  'library.noItems',
  'library.accession',
  'library.cannotIssue',
];

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
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
  const q = params.q?.trim() || null;

  const canManage = ctx.has('library.manage');
  const canIssue = ctx.has('library.issue');

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);

  const [catalogue, overdue, openLoans] = await Promise.all([
    listLibraryItems(ctx, { q, limit: 25 }),
    listLoans(ctx, { status: 'overdue', limit: 10 }),
    listLoans(ctx, { status: 'open', limit: 1 }),
  ]);

  const totalCopies = catalogue.items.reduce((sum, i) => sum + i.totalCopies, 0);
  const availableCopies = catalogue.items.reduce((sum, i) => sum + i.availableCopies, 0);

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader
        title={t('library.title')}
        description={t('library.catalogue')}
        action={
          <Link
            href="/library/loans"
            className="tap-target rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {t('library.loans')}
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('library.item')} value={catalogue.total} />
        <StatCard label={t('library.copies')} value={totalCopies} />
        <StatCard
          label={t('library.onLoan')}
          value={openLoans.total}
          href={openLoans.total > 0 ? '/library/loans?status=open' : undefined}
        />
        <StatCard
          label={t('library.overdue')}
          value={overdue.total}
          tone={overdue.total > 0 ? 'bad' : 'good'}
          href={overdue.total > 0 ? '/library/loans?status=overdue' : undefined}
        />
      </div>

      {canIssue && (
        <div className="mb-6">
          <LendingDesk
            labels={labels}
            today={today}
            conditions={[...CONDITIONS]}
            canIssue={canIssue}
          />
        </div>
      )}

      {overdue.total > 0 && (
        <Card title={`${t('library.overdue')} — ${t('ops.workQueue')}`} className="mb-6">
          {/* Mobile: cards. Desktop: a table. Never a shrunken table. */}
          <ul className="divide-y divide-ink-100 sm:hidden">
            {overdue.loans.map((loan) => (
              <li key={loan.id} className="py-3">
                <p className="font-medium text-ink-900">{loan.title}</p>
                <p className="text-sm text-ink-600">{loan.borrowerName}</p>
                <p className="mt-1 text-xs text-red-700">
                  {t('library.overdueBy', { days: String(loan.daysOverdue) })}
                </p>
              </li>
            ))}
          </ul>
          <div className="-mx-4 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 font-medium">{t('library.item')}</th>
                  <th className="px-4 py-2 font-medium">{t('library.borrower')}</th>
                  <th className="px-4 py-2 font-medium">{t('library.accession')}</th>
                  <th className="px-4 py-2 font-medium">{t('library.dueOn')}</th>
                  <th className="px-4 py-2 font-medium">{t('library.overdue')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {overdue.loans.map((loan) => (
                  <tr key={loan.id}>
                    <td className="px-4 py-2 font-medium text-ink-900">{loan.title}</td>
                    <td className="px-4 py-2 text-ink-700">{loan.borrowerName}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-500">
                      {loan.accessionNumber}
                    </td>
                    <td className="px-4 py-2 text-ink-600">{loan.dueOn}</td>
                    <td className="px-4 py-2">
                      <Badge tone="bad">
                        {t('library.overdueBy', { days: String(loan.daysOverdue) })}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {canManage && (
        <div className="mb-6">
          <CatalogueManager
            labels={labels}
            itemTypes={[...LIBRARY_ITEM_TYPES]}
            conditions={[...CONDITIONS]}
            copyStatuses={[...COPY_STATUSES]}
            items={catalogue.items}
            today={today}
          />
        </div>
      )}

      <Card title={t('library.catalogue')}>
        <LibrarySearch placeholder={t('library.searchPlaceholder')} initial={q ?? ''} />

        {catalogue.items.length === 0 ? (
          <EmptyState
            title={t('library.noItems')}
            description={canManage ? t('library.noItemsHelp') : undefined}
          />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 sm:hidden">
              {catalogue.items.map((item) => (
                <li key={item.id} className="py-3">
                  <p className="font-medium text-ink-900">{item.title}</p>
                  {item.author && <p className="text-sm text-ink-600">{item.author}</p>}
                  <p className="mt-1 text-xs text-ink-500">
                    {item.availableCopies} / {item.totalCopies} {t('library.available')}
                  </p>
                </li>
              ))}
            </ul>
            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('library.item')}</th>
                    <th className="px-4 py-2 font-medium">{t('library.author')}</th>
                    <th className="px-4 py-2 font-medium">{t('library.itemType')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('library.copies')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('library.available')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {catalogue.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-2 font-medium text-ink-900">{item.title}</td>
                      <td className="px-4 py-2 text-ink-700">{item.author ?? '—'}</td>
                      <td className="px-4 py-2 text-ink-600">
                        {t(`library.itemType.${item.itemType}`)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink-700">
                        {item.totalCopies}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Badge tone={item.availableCopies > 0 ? 'good' : 'warn'}>
                          {item.availableCopies}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-500">
              {availableCopies} / {totalCopies} {t('library.available')}
            </p>
          </>
        )}
      </Card>
    </>
  );
}
