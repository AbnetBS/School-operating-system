import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { listPayments } from '../../../../lib/finance/payments.ts';
import { money } from '../../../../lib/finance/format.ts';
import { PageHeader, Card, EmptyState, Badge } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; method?: string; from?: string; to?: string; voided?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.payments) {
    return (
      <Card>
        <EmptyState title={t('finance.disabled')} description={t('finance.disabledHelp')} />
      </Card>
    );
  }

  if (!ctx.has('payment.view')) {
    return (
      <Card>
        <EmptyState title={t('finance.noAccess')} />
      </Card>
    );
  }

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const includeVoided = params.voided === '1';

  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');
  const currency = finance.currency;

  const { payments: items, total } = await listPayments(ctx, {
    method: params.method || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    includeVoided,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Preserve the active filters when paging.
  const qs = (next: number) => {
    const sp = new URLSearchParams();
    if (params.method) sp.set('method', params.method);
    if (params.from) sp.set('from', params.from);
    if (params.to) sp.set('to', params.to);
    if (includeVoided) sp.set('voided', '1');
    sp.set('page', String(next));
    return `/finance/payments?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={t('finance.payments')}
        description={t('finance.paymentsCount', { count: total })}
        action={
          ctx.has('payment.record') ? (
            <Link
              href="/finance/payments/new"
              className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              {t('finance.recordPayment')}
            </Link>
          ) : undefined
        }
      />

      <Card>
        <form method="get" className="mb-4 grid gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="from" className="block text-xs font-medium text-ink-600">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={params.from ?? ''}
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="to" className="block text-xs font-medium text-ink-600">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={params.to ?? ''}
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="method" className="block text-xs font-medium text-ink-600">
              {t('finance.method')}
            </label>
            <select
              id="method"
              name="method"
              defaultValue={params.method ?? ''}
              className="tap-target mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm"
            >
              <option value="">—</option>
              {finance.paymentMethods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-xs text-ink-600">
              <input type="checkbox" name="voided" value="1" defaultChecked={includeVoided} className="size-4" />
              {t('finance.voided')}
            </label>
            <button
              type="submit"
              className="tap-target ml-auto rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              Filter
            </button>
          </div>
        </form>

        {items.length === 0 ? (
          <EmptyState title={t('finance.noPayments')} />
        ) : (
          <>
            {/* Mobile: one card per payment. */}
            <ul className="divide-y divide-ink-100 sm:hidden">
              {items.map((p) => (
                <li key={p.id} className="py-3">
                  <Link href={`/finance/payments/${p.id}`} className="block">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink-900">
                          {p.studentGivenName} {p.studentFatherName}
                        </p>
                        <p className="font-mono text-xs text-ink-500">{p.receiptNumber}</p>
                        <p className="mt-0.5 text-xs text-ink-500">
                          {p.paidOn} · {p.method}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={`text-sm font-semibold tabular-nums ${
                            p.status === 'voided' ? 'text-ink-400 line-through' : 'text-ink-900'
                          }`}
                        >
                          {money(p.amountCents, { currency })}
                        </p>
                        {p.status === 'voided' && <Badge tone="bad">{t('finance.voided')}</Badge>}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            {/* Desktop: a table. */}
            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase text-ink-500">
                    <th className="px-4 py-2 font-medium">{t('finance.receiptNumber')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.student')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.paidOn')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.method')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('finance.amount')}</th>
                    <th className="px-4 py-2 font-medium">{t('finance.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {items.map((p) => (
                    <tr key={p.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2">
                        <Link href={`/finance/payments/${p.id}`} className="font-mono text-brand-700 hover:underline">
                          {p.receiptNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-ink-800">
                        {p.studentGivenName} {p.studentFatherName}
                        <span className="block text-xs text-ink-500">{p.studentCode}</span>
                      </td>
                      <td className="px-4 py-2 tabular-nums text-ink-700">{p.paidOn}</td>
                      <td className="px-4 py-2 text-ink-700">{p.method}</td>
                      <td
                        className={`px-4 py-2 text-right font-medium tabular-nums ${
                          p.status === 'voided' ? 'text-ink-400 line-through' : 'text-ink-900'
                        }`}
                      >
                        {money(p.amountCents, { currency })}
                      </td>
                      <td className="px-4 py-2">
                        {p.status === 'voided' ? (
                          <Badge tone="bad">{t('finance.voided')}</Badge>
                        ) : (
                          <Badge tone="good">{t('finance.completed')}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {pages > 1 && (
          <nav className="mt-4 flex items-center justify-between border-t border-ink-200 pt-3 text-sm">
            {page > 1 ? (
              <Link href={qs(page - 1)} className="text-brand-700 hover:underline">
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-ink-500">
              {page} / {pages}
            </span>
            {page < pages ? (
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
