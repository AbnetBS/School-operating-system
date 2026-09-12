/**
 * School notification & SMS settings.
 *
 * Two different permissions guard two different things:
 *   - `notification.manageTemplates` — which events generate notifications,
 *     the channels, and quiet hours.
 *   - `sms.configure`               — the provider wiring, which costs money.
 *
 * A school may reasonably let a registrar tune notifications without letting
 * them connect a paid SMS gateway, so the PATCH below checks each block
 * separately rather than gating the whole endpoint on one permission.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, badRequest } from '../../../../lib/api/respond.ts';
import { getSetting, setSetting } from '../../../../lib/settings/service.ts';
import {
  notificationSettingsSchema,
  patchSchemaFor,
} from '../../../../lib/settings/schemas.ts';
import { listSmsProviders, resolveSmsAvailability } from '../../../../lib/sms/provider.ts';
import { getSmsSummary, listSmsMessages } from '../../../../lib/sms/service.ts';
import { recordAudit } from '../../../../lib/audit/index.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('notification.manageTemplates');

  const url = new URL(request.url);
  const settings = await getSetting(ctx.db, ctx.schoolId, 'notifications');

  // The outbox is only meaningful to whoever may configure SMS.
  if (url.searchParams.get('view') === 'outbox') {
    ctx.require('sms.configure');
    const [summary, messages] = await Promise.all([
      getSmsSummary(ctx.db, ctx.schoolId),
      listSmsMessages(ctx.db, ctx.schoolId, {
        limit: 50,
        status: url.searchParams.get('status') ?? undefined,
      }),
    ]);
    return ok({ summary, messages });
  }

  return ok({
    settings,
    providers: listSmsProviders(),
    availability: resolveSmsAvailability(settings.sms),
  });
});

/**
 * Partial update. `sms` is split out so that the expensive half of this
 * setting carries its own permission check.
 *
 * `patchSchemaFor` builds a body schema where an absent key means "leave this
 * alone". A plain `.optional()` would not do: a Zod field carrying a
 * `.default()` still emits that default when the key is missing, so
 * `{ sms: { isEnabled: false } }` would parse into a complete block and wipe
 * the school's provider and credential reference — configuration destroyed by
 * pressing a toggle.
 */
const patchSchema = patchSchemaFor(notificationSettingsSchema);

type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
type NotificationSettingsPatch = {
  [K in keyof NotificationSettings]?: NotificationSettings[K] extends object
    ? Partial<NotificationSettings[K]>
    : NotificationSettings[K];
};

export const PATCH = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('notification.manageTemplates');

  // `patchSchemaFor` returns a dynamically built object schema, so the parsed
  // result is narrowed here to the deep-partial of the settings type.
  const input = patchSchema.parse(
    await request.json().catch(() => ({})),
  ) as NotificationSettingsPatch;

  // The SMS block costs money to use, so it carries its own permission.
  if (input.sms) ctx.require('sms.configure');

  const current = await getSetting(ctx.db, ctx.schoolId, 'notifications');

  // Merge field by field so an omitted key keeps its stored value, and a
  // nested object can be updated one flag at a time.
  const next = notificationSettingsSchema.parse({
    channels: { ...current.channels, ...input.channels },
    events: { ...current.events, ...input.events },
    quietHoursStart: input.quietHoursStart ?? current.quietHoursStart,
    quietHoursEnd: input.quietHoursEnd ?? current.quietHoursEnd,
    sms: { ...current.sms, ...input.sms },
  });

  if (next.quietHoursStart === next.quietHoursEnd) {
    return badRequest('Please check the highlighted fields.', {
      quietHoursEnd: 'Quiet hours cannot start and end at the same time.',
    });
  }

  await setSetting(ctx.db, ctx.schoolId, 'notifications', next);

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    action: 'school.settingsUpdate',
    entityType: 'schoolSettings',
    entityId: 'notifications',
    summary: input.sms
      ? 'Updated notification and SMS settings'
      : 'Updated notification settings',
  });

  return ok({
    settings: next,
    availability: resolveSmsAvailability(next.sms),
  });
});
