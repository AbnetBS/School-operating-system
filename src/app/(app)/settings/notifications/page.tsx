import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { listSmsProviders, resolveSmsAvailability } from '../../../../lib/sms/provider.ts';
import { getSmsSummary, listSmsMessages } from '../../../../lib/sms/service.ts';
import { PageHeader, Card, EmptyState } from '../../../../components/ui.tsx';
import NotificationSettingsForm from './NotificationSettingsForm.tsx';
import SmsOutbox from './SmsOutbox.tsx';

export const dynamic = 'force-dynamic';

export default async function NotificationSettingsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  // Server-side gate. The nav hides this page, but hiding is not access control.
  if (!ctx.has('notification.manageTemplates')) {
    return (
      <Card>
        <EmptyState
          title="Not available"
          description="You do not have permission to change notification settings."
        />
      </Card>
    );
  }

  const canConfigureSms = ctx.has('sms.configure');
  const settings = await getSetting(ctx.db, ctx.schoolId, 'notifications');

  // The full availability object holds the provider implementation, which
  // cannot cross to a client component — send only the serialisable facts.
  const resolved = resolveSmsAvailability(settings.sms);
  const availability = resolved.available
    ? { available: true as const, providerLabel: resolved.provider.label }
    : { available: false as const, reason: resolved.reason, detail: resolved.detail };

  const [summary, messages] = canConfigureSms
    ? await Promise.all([
        getSmsSummary(ctx.db, ctx.schoolId),
        listSmsMessages(ctx.db, ctx.schoolId, { limit: 50 }),
      ])
    : [[], []];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications & SMS"
        description="Choose which events tell parents and staff, and how they are delivered."
      />

      <NotificationSettingsForm
        initial={settings}
        canConfigureSms={canConfigureSms}
        providers={listSmsProviders()}
        availability={availability}
      />

      {canConfigureSms && (
        <SmsOutbox
          summary={summary}
          messages={messages.map((m) => ({
            id: m.id,
            toPhone: m.toPhone,
            body: m.body,
            status: m.status,
            provider: m.provider,
            error: m.error,
            createdAt: m.createdAt.toISOString(),
            sentAt: m.sentAt ? m.sentAt.toISOString() : null,
          }))}
        />
      )}
    </div>
  );
}
