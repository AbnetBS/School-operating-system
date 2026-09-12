/**
 * Early-warning settings.
 *
 * The thresholds that decide which children appear on the pastoral list live
 * here rather than in the code, because no two schools agree on what "poor
 * attendance" means and a hard-coded 85% would be wrong for most of them.
 */

import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { PageHeader, Card, EmptyState } from '../../../../components/ui.tsx';
import RiskSettingsForm from './RiskSettingsForm.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.save',
  'action.saving',
  'analytics.attendance',
  'analytics.academic',
  'settings.saved',
  'risk.settings.enabled',
  'risk.settings.enabledHint',
  'risk.settings.attendanceThreshold',
  'risk.settings.academicThreshold',
  'risk.settings.consecutive',
  'risk.settings.consecutiveDays',
  'risk.settings.decline',
  'risk.settings.declinePoints',
  'risk.settings.finance',
  'risk.settings.financeHint',
  'risk.settings.weight',
  'risk.settings.attentionScore',
  'risk.settings.maxReachable',
];

export default async function RiskSettingsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  if (!ctx.has('school.manage')) {
    return (
      <Card>
        <EmptyState
          title={t('analytics.noPermission')}
          description={t('analytics.noPermissionHelp')}
        />
      </Card>
    );
  }

  const settings = await getSetting(ctx.db, ctx.schoolId, 'risk');
  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader title={t('risk.settings.title')} description={t('risk.settings.subtitle')} />
      <Card>
        <RiskSettingsForm initial={settings} labels={labels} />
      </Card>
    </>
  );
}
