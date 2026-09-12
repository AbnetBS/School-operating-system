import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { money } from '../../../lib/finance/format.ts';
import {
  getFinanceSummary,
  getMonthlyCollections,
  getMethodBreakdown,
  getCategoryBreakdown,
  getOutstandingStudents,
} from '../../../lib/finance/reports.ts';
import { PageHeader, Card, StatCard, EmptyState, Badge, BarRow } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export default async function FinancePage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  // The module gate and the permission gate are separate questions: a school
  // may have finance switched off entirely, or on but not for this person.
  if (!modules.fees && !modules.payments) {
    return (
      <Card>
        <EmptyState title={t('finance.disabled')} description={t('finance.disabledHelp')} />
      </Card>
    );
  }

  if (!ctx.hasAny('fee.view', 'payment.view', 'finance.report')) {
    return (
      <Card>
        <EmptyState title={t('finance.noAccess')} />
      </Card>
    );
  }

  const canReport = ctx.has('finance.report');
  const canRecord = ctx.has('payment.record') && modules.payments;
  const canManageFees = ctx.has('fee.manage') && modules.fees;

  const [summary, monthly, methods, categories, outstanding] = await Promise.all([
    getFinanceSummary(ctx),
    canReport ? getMonthlyCollections(ctx) : Promise.resolve([]),
    canReport ? getMethodBreakdown(ctx) : Promise.resolve([]),
    canReport ? getCategoryBreakdown(ctx) : Promise.resolve([]),
    getOutstandingStudents(ctx, {}, { limit: 10 }),
  ]);

  const peakMonth = monthly.reduce((max, m) => Math.max(max, m.amountCents), 0);
  const peakMethod = methods.reduce((max, m) => Math.max(max, m.amountCents), 0);
  const peakCategory = categories.reduce((max, c) => Math.max(max, c.outstandingCents), 0);

  return (
    <>
      <PageHeader
        title={t('finance.dashboard')}
        description={`${t('finance.collectionRate')}: ${summary.collectionRate}%`}
        action={
          <div className="flex flex-wrap gap-2">
            {canManageFees && (
              <Link
                href="/finance/fees"
                className="tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
              >
                {t('finance.fees')}
              </Link>
            )}
            {canRecord && (
              <Link
                href="/finance/payments/new"
                className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
              >
                {t('finance.recordPayment')}
              </Link>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('finance.charged')} value={money(summary.netCents)} sub={`${summary.chargeCount}`} />
        <StatCard label={t('finance.collected')} value={money(summary.collectedCents)} tone="good" />
        <StatCard
          label={t('finance.outstanding')}
          value={money(summary.outstandingCents)}
          tone={summary.outstandingCents > 0 ? 'warn' : 'default'}
        />
        <StatCard
          label={t('finance.overdue')}
          value={money(summary.overdueCents)}
          sub={t('finance.studentsCount', { count: summary.overdueCount })}
          tone={summary.overdueCents > 0 ? 'bad' : 'good'}
          href={summary.overdueCents > 0 ? '/finance/outstanding' : undefined}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t('finance.collectedToday')}
          value={money(summary.todayCents)}
          sub={t('finance.paymentsCount', { count: summary.todayCount })}
          href={ctx.has('payment.view') ? '/finance/payments' : undefined}
        />
        <StatCard label={t('finance.discount')} value={money(summary.discountCents)} />
        <StatCard
          label={t('finance.payments')}
          value={summary.paymentCount}
          sub={money(summary.receivedCents)}
          href={ctx.has('payment.view') ? '/finance/payments' : undefined}
        />
        <StatCard label={t('finance.collectionRate')} value={`${summary.collectionRate}%`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t('finance.outstandingStudents')}>
          {outstanding.length === 0 ? (
            <EmptyState title={t('finance.nothingOwed')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {outstanding.map((s) => (
                <li key={s.studentId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <Link
                      href={`/finance/students/${s.studentId}`}
                      className="truncate text-sm font-medium text-brand-700 hover:underline"
                    >
                      {s.givenName} {s.fatherName} {s.grandfatherName ?? ''}
                    </Link>
                    <p className="text-xs text-ink-500">
                      {s.studentCode}
                      {s.oldestDue ? ` · ${t('finance.dueDate')} ${s.oldestDue}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-red-700">
                    {money(s.outstandingCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {canReport && (
          <Card title={t('finance.monthlyCollections')}>
            {monthly.length === 0 ? (
              <EmptyState title={t('finance.noPayments')} />
            ) : (
              <div className="space-y-1">
                {monthly.map((m) => (
                  <BarRow
                    key={m.month}
                    label={m.month}
                    value={m.amountCents}
                    max={peakMonth}
                    hint={money(m.amountCents)}
                  />
                ))}
              </div>
            )}
          </Card>
        )}

        {canReport && (
          <Card title={t('finance.byMethod')}>
            {methods.length === 0 ? (
              <EmptyState title={t('finance.noPayments')} />
            ) : (
              <div className="space-y-1">
                {methods.map((m) => (
                  <BarRow
                    key={m.method}
                    label={m.method}
                    value={m.amountCents}
                    max={peakMethod}
                    hint={money(m.amountCents)}
                  />
                ))}
              </div>
            )}
          </Card>
        )}

        {canReport && (
          <Card title={t('finance.byCategory')}>
            {categories.length === 0 ? (
              <EmptyState title={t('finance.noFees')} />
            ) : (
              <div className="space-y-1">
                {categories.map((c) => (
                  <BarRow
                    key={c.categoryId ?? 'uncategorised'}
                    label={c.categoryName ?? '—'}
                    value={c.outstandingCents}
                    max={peakCategory}
                    hint={money(c.outstandingCents)}
                  />
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      {!canReport && (
        <p className="mt-4 text-xs text-ink-500">
          <Badge tone="neutral">{t('finance.noAccess')}</Badge>
        </p>
      )}
    </>
  );
}
