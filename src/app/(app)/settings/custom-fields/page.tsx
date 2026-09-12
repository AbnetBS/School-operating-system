/**
 * School-defined custom fields.
 *
 * Every school records something the standard form does not cover — a bus
 * stop, a sponsor, a boarding house. Before this screen those went nowhere:
 * the `custom_field_defs` table existed but nothing wrote to it, and the
 * student API accepted any JSON at all under `customFields`.
 */

import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { PageHeader, Card, EmptyState } from '../../../../components/ui.tsx';
import {
  listDefinitions,
  countUsageForDefinitions,
} from '../../../../lib/customFields/service.ts';
import CustomFieldsManager from './CustomFieldsManager.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.save',
  'action.saving',
  'action.cancel',
  'customField.add',
  'customField.entity',
  'customField.entityStudent',
  'customField.entityStaff',
  'customField.entityGuardian',
  'customField.key',
  'customField.keyHint',
  'customField.label',
  'customField.labelAm',
  'customField.type',
  'customField.typeText',
  'customField.typeNumber',
  'customField.typeDate',
  'customField.typeSelect',
  'customField.typeBoolean',
  'customField.options',
  'customField.optionsHint',
  'customField.required',
  'customField.requiredHint',
  'customField.sortOrder',
  'customField.active',
  'customField.inactive',
  'customField.usage',
  'customField.retire',
  'customField.restore',
  'customField.retireWarning',
  'customField.created',
  'customField.updated',
  'customField.none',
  'customField.noneHint',
];

export default async function CustomFieldsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  // The API enforces this independently; the page repeats it so a user who
  // reaches the URL directly gets an explanation rather than an empty screen.
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

  const definitions = await listDefinitions(ctx.db, ctx.schoolId);

  // Usage counts tell an administrator what retiring a field would hide.
  // Counted in one pass per table rather than one query per definition.
  const usage = await countUsageForDefinitions(ctx.db, ctx.schoolId, definitions);

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <div className="space-y-6">
      <PageHeader title={t('customField.title')} description={t('customField.subtitle')} />
      <CustomFieldsManager
        initial={definitions.map((d) => ({
          id: d.id,
          entityType: d.entityType,
          key: d.key,
          label: d.label,
          labelAm: d.labelAm,
          fieldType: d.fieldType,
          options: Array.isArray(d.options) ? (d.options as string[]) : null,
          isRequired: d.isRequired,
          sortOrder: d.sortOrder,
          isActive: d.isActive,
        }))}
        usage={usage}
        labels={labels}
      />
    </div>
  );
}
