import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { listPortalStudents } from '../../../lib/portal/service.ts';
import { resolvePortalStudentPage } from '../resolve-student.ts';
import { listStudentCharges, getStudentBalance } from '../../../lib/finance/service.ts';
import { listPayments } from '../../../lib/finance/payments.ts';
import { money } from '../../../lib/finance/format.ts';
import { Card, StatCard, EmptyState, Badge } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

/**
 * A family's view of what is owed.
 *
 * Read-only by design. A parent has no finance permission at all — the scoping
 * here comes from the relationship, via `resolvePortalStudent`, which refuses
 * any pupil that is not theirs with a 404. The finance service functions are
 * then called for that resolved id and never for one taken from the URL.
 */
export default async function PortalFeesPage({
  searchParams,
}: {
  searchParams: Promise<{ studentId?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  // A school that does not use the fees module simply has no such page.
  if (!modules.fees && !modules.payments) {
    return (
      <Card>
        <EmptyState title={t('finance.disabled')} />
      </Card>
    );
  }

  const isParent = ctx.has('portal.parent');
  const { studentId } = await searchParams;

  // Throws 404 for any pupil this account is not linked to.
  const student = await resolvePortalStudentPage(ctx, studentId);
  const siblings = isParent ? await listPortalStudents(ctx) : [];

  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');
  const currency = finance.currency;

  const [charges, balance, history] = await Promise.all([
    listStudentCharges(ctx, student.id),
    getStudentBalance(ctx, student.id),
    modules.payments
      ? listPayments(ctx, { studentId: student.id, limit: 25 })
      : Promise.resolve({ payments: [], total: 0 }),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-ink-900">
          {isParent ? t('finance.childFees') : t('finance.myFees')}
        </h1>
        <p className="text-sm text-ink-500">{student.name}</p>
      </div>

      {siblings.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {siblings.map((s) => (
            <Link
              key={s.id}
              href={`/portal/fees?studentId=${s.id}`}
              className={`tap-target rounded-lg border px-3 py-2 text-sm font-medium ${
                s.id === student.id
                  ? 'border-brand-600 bg-brand-50 text-brand-800'
                  : 'border-ink-300 text-ink-700'
              }`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <StatCard label={t('finance.charged')} value={money(balance.netCents, { currency })} />
        <StatCard label={t('finance.paid')} value={money(balance.paidCents, { currency })} tone="good" />
        <StatCard
          label={t('finance.outstanding')}
          value={money(balance.outstandingCents, { currency })}
          tone={balance.outstandingCents > 0 ? 'warn' : 'good'}
        />
      </div>

      <Card title={t('finance.charges')}>
        {charges.length === 0 ? (
          <EmptyState title={t('finance.noCharges')} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {charges.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink-900">
                    {ctx.locale === 'am' && c.descriptionAm ? c.descriptionAm : c.description}
                    {c.installmentTotal > 1 ? ` (${c.installmentNumber}/${c.installmentTotal})` : ''}
                  </p>
                  <p className="text-xs text-ink-500">
                    {[c.categoryName, c.termName, c.dueDate].filter(Boolean).join(' · ')}
                  </p>
                  {c.discountCents > 0 && (
                    <p className="text-xs text-emerald-700">
                      {t('finance.discount')} {money(c.discountCents, { currency })}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium tabular-nums text-ink-900">
                    {money(c.netAmountCents, { currency })}
                  </p>
                  {c.outstandingCents === 0 ? (
                    <Badge tone="good">{t('finance.paid')}</Badge>
                  ) : (
                    <span className="text-xs text-amber-700">
                      {money(c.outstandingCents, { currency })}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {modules.payments && (
        <Card title={t('finance.paymentHistory')}>
          {history.payments.length === 0 ? (
            <EmptyState title={t('finance.noPayments')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {history.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-ink-700">{p.receiptNumber}</p>
                    <p className="text-xs text-ink-500">
                      {p.paidOn} · {p.method}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-emerald-700">
                    {money(p.amountCents, { currency })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-500">
            Payments are recorded at the school office. This page is a record, not a payment page.
          </p>
        </Card>
      )}
    </div>
  );
}
