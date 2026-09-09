import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';

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

  // Only sections this user may actually open are listed. Each destination
  // re-checks its own permission — this list is convenience, not a gate.
  const sections: Section[] = [
    {
      href: '/settings/notifications',
      title: 'Notifications & SMS',
      description:
        'Choose which events tell parents and staff, set quiet hours, and connect an SMS provider.',
      icon: '✉',
      visible: ctx.has('notification.manageTemplates'),
    },
  ];

  const visible = sections.filter((s) => s.visible);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Configure how this school works. Nothing here is fixed in the software."
      />

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing to configure"
            description="You do not have permission to change any school settings."
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
