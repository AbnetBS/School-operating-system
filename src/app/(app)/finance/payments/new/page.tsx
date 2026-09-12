import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../../lib/auth/context.ts';
import { getSetting } from '../../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../../lib/i18n/index.ts';
import { students } from '../../../../../db/schema/people.ts';
import { PageHeader, Card, EmptyState } from '../../../../../components/ui.tsx';
import RecordPaymentForm from './RecordPaymentForm.tsx';

export const dynamic = 'force-dynamic';

/** The label keys the client component needs, resolved on the server. */
const LABEL_KEYS = [
  'finance.recordPayment',
  'finance.selectStudent',
  'finance.searchStudent',
  'finance.charges',
  'finance.charged',
  'finance.paid',
  'finance.outstanding',
  'finance.balance',
  'finance.nothingOwed',
  'finance.allocateHint',
  'finance.amountReceived',
  'finance.method',
  'finance.paidOn',
  'finance.reference',
  'finance.notes',
  'finance.paymentSaved',
  'finance.duplicateIgnored',
  'finance.receiptNumber',
  'finance.printReceipt',
];

export default async function NewPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ studentId?: string }>;
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

  // The page is a convenience; the API re-checks this on every request.
  if (!ctx.has('payment.record')) {
    return (
      <Card>
        <EmptyState title={t('finance.noAccess')} />
      </Card>
    );
  }

  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');

  // Deep link from a student's account page. Honour it only if this user is
  // actually allowed to see that pupil.
  const { studentId } = await searchParams;
  let initialStudent = null;
  if (studentId && (await ctx.canViewStudent(studentId))) {
    const [row] = await ctx.db
      .select({
        id: students.id,
        givenName: students.givenName,
        fatherName: students.fatherName,
        grandfatherName: students.grandfatherName,
        studentCode: students.studentCode,
      })
      .from(students)
      .where(and(eq(students.schoolId, ctx.schoolId), eq(students.id, studentId)))
      .limit(1);
    initialStudent = row ?? null;
  }

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader title={t('finance.recordPayment')} />
      <RecordPaymentForm
        methods={finance.paymentMethods}
        currency={finance.currency}
        allowPartial={finance.allowPartialPayment}
        allowOverpayment={finance.allowOverpayment}
        labels={labels}
        today={new Date().toISOString().slice(0, 10)}
        initialStudent={initialStudent}
      />
    </>
  );
}
