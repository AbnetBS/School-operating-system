import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../../lib/auth/context.ts';
import { getSetting } from '../../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../../lib/i18n/index.ts';
import { getReceipt } from '../../../../../lib/finance/payments.ts';
import { money } from '../../../../../lib/finance/format.ts';
import { schools } from '../../../../../db/schema/core.ts';
import { Card, EmptyState, Badge } from '../../../../../components/ui.tsx';
import VoidPaymentButton from './VoidPaymentButton.tsx';
import PrintButton from './PrintButton.tsx';

export const dynamic = 'force-dynamic';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;

  // getReceipt is scoped to this school and throws a 404 for anything else, so
  // a guessed id from another school is indistinguishable from a typo.
  const { payment, lines, balance } = await getReceipt(ctx, id);

  const [school] = await ctx.db
    .select({ name: schools.name, nameAm: schools.nameAm, address: schools.address, phone: schools.phone })
    .from(schools)
    .where(eq(schools.id, ctx.schoolId))
    .limit(1);

  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');
  const currency = finance.currency;
  const voided = payment.status === 'voided';
  const allocated = lines.reduce((sum, l) => sum + l.amountCents, 0);

  return (
    <>
      {/* Controls, deliberately excluded from the printed sheet. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <a href="/finance/payments" className="text-sm text-brand-700 hover:underline">
          ← {t('finance.payments')}
        </a>
        <div className="flex flex-wrap gap-2">
          {!voided && ctx.has('payment.void') && (
            <VoidPaymentButton
              paymentId={payment.id}
              label={t('finance.voidPayment')}
              reasonLabel={t('finance.voidReason')}
              confirmText={t('finance.confirmVoid')}
            />
          )}
        </div>
      </div>

      {voided && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>{t('finance.voided')}.</strong> {payment.voidReason}
        </div>
      )}

      <article className="card mx-auto max-w-2xl p-6 print:max-w-none print:p-0">
        <header className="border-b border-ink-200 pb-4 text-center">
          <h1 className="text-lg font-bold text-ink-900">{school?.name}</h1>
          {school?.nameAm && <p className="text-sm text-ink-600">{school.nameAm}</p>}
          {school?.address && <p className="mt-0.5 text-xs text-ink-500">{school.address}</p>}
          {school?.phone && <p className="text-xs text-ink-500">{school.phone}</p>}
          <p className="mt-3 text-sm font-semibold uppercase tracking-wide text-ink-700">
            {t('finance.receipt')}
          </p>
        </header>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-500">{t('finance.receiptNumber')}</dt>
          <dd className="text-right font-mono font-semibold text-ink-900">{payment.receiptNumber}</dd>

          <dt className="text-ink-500">{t('finance.paidOn')}</dt>
          <dd className="text-right text-ink-900">{payment.paidOn}</dd>

          <dt className="text-ink-500">{t('finance.student')}</dt>
          <dd className="text-right text-ink-900">
            {payment.studentGivenName} {payment.studentFatherName} {payment.studentGrandfatherName ?? ''}
          </dd>

          <dt className="text-ink-500">{t('finance.student')} ID</dt>
          <dd className="text-right font-mono text-ink-900">{payment.studentCode}</dd>

          <dt className="text-ink-500">{t('finance.method')}</dt>
          <dd className="text-right text-ink-900">{payment.method}</dd>

          {payment.referenceNumber && (
            <>
              <dt className="text-ink-500">{t('finance.reference')}</dt>
              <dd className="text-right font-mono text-ink-900">{payment.referenceNumber}</dd>
            </>
          )}
        </dl>

        {lines.length > 0 && (
          <table className="mt-5 w-full text-sm">
            <thead>
              <tr className="border-y border-ink-200 text-left text-xs uppercase text-ink-500">
                <th className="py-2 font-medium">{t('finance.description')}</th>
                <th className="py-2 text-right font-medium">{t('finance.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {lines.map((line) => (
                <tr key={line.chargeId}>
                  <td className="py-2 text-ink-800">
                    {line.description}
                    {line.termName || line.categoryName ? (
                      <span className="block text-xs text-ink-500">
                        {[line.categoryName, line.termName].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink-900">
                    {money(line.amountCents, { currency })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-4 border-t border-ink-300 pt-3">
          <div className="flex items-center justify-between text-base font-bold">
            <span>{t('finance.amount')}</span>
            <span className="tabular-nums">{money(payment.amountCents, { currency })}</span>
          </div>
          {payment.unallocatedCents > 0 && (
            <p className="mt-1 flex items-center justify-between text-xs text-ink-500">
              <span>Credit held</span>
              <span className="tabular-nums">{money(payment.unallocatedCents, { currency })}</span>
            </p>
          )}
          {allocated !== payment.amountCents && payment.unallocatedCents === 0 && (
            <p className="mt-1 text-xs text-amber-700">
              Allocation {money(allocated, { currency })} differs from the amount received.
            </p>
          )}
          <p className="mt-2 flex items-center justify-between text-sm">
            <span className="text-ink-600">{t('finance.balance')}</span>
            <span className="font-semibold tabular-nums text-ink-900">
              {money(balance.outstandingCents, { currency })}
            </span>
          </p>
        </div>

        <footer className="mt-6 flex items-end justify-between border-t border-ink-200 pt-4 text-xs text-ink-500">
          <span>
            {t('finance.recordedBy')}: {payment.recordedByGiven ?? '—'} {payment.recordedByFather ?? ''}
          </span>
          {voided ? <Badge tone="bad">{t('finance.voided')}</Badge> : <span>____________________</span>}
        </footer>
      </article>

      <div className="mt-4 text-center print:hidden">
        <PrintButton label={t('finance.printReceipt')} />
      </div>
    </>
  );
}
