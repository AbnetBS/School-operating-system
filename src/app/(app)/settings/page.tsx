import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';
import { createTranslator } from '../../../lib/i18n/index.ts';

export const dynamic = 'force-dynamic';

type Section = {
  href: string;
  title: string;
  description: string;
  icon: string;
  visible: boolean;
};

export default async function SettingsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  // Only sections this user may actually open are listed. Each destination
  // re-checks its own permission — this list is convenience, not a gate.
  const sections: Section[] = [
    {
      href: '/settings/notifications',
      title: t('settings.notifications'),
      description: t('settings.notificationsHint'),
      icon: '✉',
      visible: ctx.has('notification.manageTemplates'),
    },
    {
      href: '/settings/risk',
      title: t('settings.risk'),
      description: t('settings.riskHint'),
      icon: '!',
      visible: ctx.has('school.manage'),
    },
    {
      href: '/settings/custom-fields',
      title: t('customField.settingsCard'),
      description: t('customField.settingsCardHint'),
      icon: '▤',
      visible: ctx.has('school.manage'),
    },
  ];

  const visible = sections.filter((s) => s.visible);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('settings.title')}
        description={t('settings.subtitle')}
      />

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            title={t('settings.none')}
            description={t('settings.noneHint')}
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((section) => (
            <Link key={section.href} href={section.href} className="block">
              <Card className="h-full transition hover:border-brand-300">
                <div className="flex items-start gap-3">
                  <span aria-hidden className="text-xl text-brand-600">
                    {section.icon}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-ink-900">{section.title}</h2>
                    <p className="mt-1 text-sm text-ink-500">{section.description}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
