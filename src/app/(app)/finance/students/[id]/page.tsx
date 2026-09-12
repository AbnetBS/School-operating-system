import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../../lib/auth/context.ts';
import { getSetting } from '../../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../../lib/i18n/index.ts';
import { listStudentCharges, getStudentBalance } from '../../../../../lib/finance/service.ts';
import { listPayments } from '../../../../../lib/finance/payments.ts';
import { money } from '../../../../../lib/finance/format.ts';
import { students } from '../../../../../db/schema/people.ts';
import { PageHeader, Card, StatCard, EmptyState, Badge } from '../../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export default async function StudentAccountPage({ params }: { params: Promise<{ id: string }> }) {
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

  if (!ctx.hasAny('fee.view', 'payment.view')) {
    return (
      <Card>
        <EmptyState title={t('finance.noAccess')} />
      </Card>
    );
  }

  const { id } = await params;

  // Seeing a pupil's money requires the right to see the pupil. A denial is a
  // 404 so an id cannot be probed for existence.
  await ctx.requireStudentAccess(id);

  const [student] = await ctx.db
    .select({
      id: students.id,
      givenName: students.givenName,
      fatherName: students.fatherName,
      grandfatherName: students.grandfatherName,
      studentCode: students.studentCode,
    })
    .from(students)
    .where(and(eq(students.schoolId, ctx.schoolId), eq(students.id, id)))
    .limit(1);

  if (!student) redirect('/finance');

  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');
  const currency = finance.currency;

  const [charges, balance, paymentHistory] = await Promise.all([
    listStudentCharges(ctx, id, { includeCancelled: true }),
    getStudentBalance(ctx, id),
    ctx.has('payment.view')
      ? listPayments(ctx, { studentId: id, includeVoided: true, limit: 50 })
      : Promise.resolve({ payments: [], total: 0 }),
  ]);

  return (
    <>
      <PageHeader
        title={`${student.givenName} ${student.fatherName} ${student.grandfatherName ?? ''}`.trim()}
        description={student.studentCode}
        action={
          ctx.has('payment.record') && modules.payments ? (
            <Link
              href={`/finance/payments/new?studentId=${student.id}`}
              className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              {t('finance.recordPayment')}
            </Link>
          ) : undefined
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <StatCard label={t('finance.charged')} value={money(balance.netCents, { currency })} />
        <StatCard label={t('finance.paid')} value={money(balance.paidCents, { currency })} tone="good" />
        <StatCard
          label={t('finance.outstanding')}
          value={money(balance.outstandingCents, { currency })}
          tone={balance.outstandingCents > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t('finance.charges')}>
          {charges.length === 0 ? (
            <EmptyState title={t('finance.noCharges')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {charges.map((c) => (
                <li key={c.id} className="py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className={`truncate text-sm ${
                          c.status === 'cancelled' ? 'text-ink-400 line-through' : 'text-ink-900'
                        }`}
                      >
                        {c.description}
                        {c.installmentTotal > 1 ? ` (${c.installmentNumber}/${c.installmentTotal})` : ''}
                      </p>
                      <p className="text-xs text-ink-500">
                        {[c.categoryName, c.termName, c.academicYearName, c.dueDate]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {c.discountCents > 0 && (
                        <p className="mt-0.5 text-xs text-emerald-700">
                          {t('finance.discount')} {money(c.discountCents, { currency })}
                          {c.discountReason ? ` — ${c.discountReason}` : ''}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-medium tabular-nums text-ink-900">
                        {money(c.netAmountCents, { currency })}
                      </p>
                      {c.status === 'cancelled' ? (
                        <Badge tone="neutral">{t('finance.cancelled')}</Badge>
                      ) : c.outstandingCents === 0 ? (
                        <Badge tone="good">{t('finance.paid')}</Badge>
                      ) : (
                        <span className="text-xs text-amber-700">
                          {money(c.outstandingCents, { currency })} {t('finance.outstanding').toLowerCase()}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {ctx.has('payment.view') && (
          <Card title={t('finance.paymentHistory')}>
            {paymentHistory.payments.length === 0 ? (
              <EmptyState title={t('finance.noPayments')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {paymentHistory.payments.map((p) => (
                  <li key={p.id} className="py-2.5">
                    <Link href={`/finance/payments/${p.id}`} className="flex items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block font-mono text-xs text-brand-700">{p.receiptNumber}</span>
                        <span className="block text-xs text-ink-500">
                          {p.paidOn} · {p.method}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className={`block text-sm font-semibold tabular-nums ${
                            p.status === 'voided' ? 'text-ink-400 line-through' : 'text-emerald-700'
                          }`}
                        >
                          {money(p.amountCents, { currency })}
                        </span>
                        {p.status === 'voided' && <Badge tone="bad">{t('finance.voided')}</Badge>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
