import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { listFeeStructures, listFeeCategories } from '../../../../lib/finance/service.ts';
import { academicYears, terms, gradeLevels, sections } from '../../../../db/schema/core.ts';
import { PageHeader, Card, EmptyState } from '../../../../components/ui.tsx';
import FeeManager from './FeeManager.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'finance.fees',
  'finance.newFee',
  'finance.editFee',
  'finance.categories',
  'finance.category',
  'finance.newCategory',
  'finance.amount',
  'finance.appliesTo',
  'finance.appliesTo.all',
  'finance.appliesTo.grade',
  'finance.appliesTo.section',
  'finance.appliesTo.individual',
  'finance.billingPeriod',
  'finance.billingPeriod.once',
  'finance.billingPeriod.term',
  'finance.billingPeriod.month',
  'finance.billingPeriod.custom',
  'finance.installments',
  'finance.optional',
  'finance.dueDate',
  'finance.applyFee',
  'finance.applied',
  'finance.noFees',
  'finance.noFeesHelp',
  'finance.active',
  'finance.description',
  'finance.studentsCount',
];

export default async function FeeStructuresPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.fees) {
    return (
      <Card>
        <EmptyState title={t('finance.disabled')} description={t('finance.disabledHelp')} />
      </Card>
    );
  }

  if (!ctx.has('fee.view')) {
    return (
      <Card>
        <EmptyState title={t('finance.noAccess')} />
      </Card>
    );
  }

  const canManage = ctx.has('fee.manage');
  const finance = await getSetting(ctx.db, ctx.schoolId, 'finance');

  const [fees, categories, years, termRows, grades, sectionRows] = await Promise.all([
    listFeeStructures(ctx, { includeInactive: true }),
    listFeeCategories(ctx, true),
    ctx.db
      .select({ id: academicYears.id, name: academicYears.name, isCurrent: academicYears.isCurrent })
      .from(academicYears)
      .where(eq(academicYears.schoolId, ctx.schoolId))
      .orderBy(asc(academicYears.name)),
    ctx.db
      .select({ id: terms.id, name: terms.name, academicYearId: terms.academicYearId })
      .from(terms)
      .where(eq(terms.schoolId, ctx.schoolId))
      .orderBy(asc(terms.sequence)),
    ctx.db
      .select({ id: gradeLevels.id, name: gradeLevels.name })
      .from(gradeLevels)
      .where(eq(gradeLevels.schoolId, ctx.schoolId))
      .orderBy(asc(gradeLevels.level)),
    ctx.db
      .select({ id: sections.id, name: sections.name, gradeLevelId: sections.gradeLevelId })
      .from(sections)
      .where(and(eq(sections.schoolId, ctx.schoolId)))
      .orderBy(asc(sections.name)),
  ]);

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader title={t('finance.fees')} description={t('finance.noFeesHelp')} />
      <FeeManager
        fees={fees}
        categories={categories}
        years={years}
        terms={termRows}
        grades={grades}
        sections={sectionRows}
        canManage={canManage}
        currency={finance.currency}
        labels={labels}
      />
    </>
  );
}
