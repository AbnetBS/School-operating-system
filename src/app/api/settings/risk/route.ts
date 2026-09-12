/**
 * Early-warning settings.
 *
 * These values decide which children appear on a pastoral list, so they are
 * treated as a policy decision rather than a preference: changing them
 * requires `school.manageSettings`, and every change is audited with the old
 * and new values.
 *
 * `financeEnabled` is part of this block but deserves note. It defaults to
 * false, and turning it on means unpaid fees start contributing to a pupil's
 * risk score. That is a school's decision to make, but it should be a
 * deliberate one, so the audit entry records it like any other change.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, badRequest } from '../../../../lib/api/respond.ts';
import { getSetting, setSetting } from '../../../../lib/settings/service.ts';
import { riskSettingsSchema, patchSchemaFor } from '../../../../lib/settings/schemas.ts';
import { recordAudit } from '../../../../lib/audit/index.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const ctx = await requireAuth();
  // Reading the thresholds is what makes the risk list explainable, so anyone
  // who may see the analytics may see the rules behind them.
  ctx.requireAny('analytics.view', 'school.manage');

  const settings = await getSetting(ctx.db, ctx.schoolId, 'risk');
  return ok({ settings });
});

const patchSchema = patchSchemaFor(riskSettingsSchema);

export const PATCH = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('school.manage');

  const input = patchSchema.parse(await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  const current = await getSetting(ctx.db, ctx.schoolId, 'risk');

  // Field-by-field merge: an omitted key keeps its stored value, so a form
  // that posts one toggle cannot silently reset every threshold.
  const next = riskSettingsSchema.parse({ ...current, ...input });

  // A pupil must be able to reach the attention score somehow. If every
  // enabled signal together cannot reach it, the list is permanently empty and
  // the school would believe nobody needs help.
  const reachable =
    (next.attendanceEnabled ? next.attendanceWeight : 0) +
    (next.consecutiveAbsenceEnabled ? next.consecutiveAbsenceWeight : 0) +
    (next.academicEnabled ? next.academicWeight : 0) +
    (next.declineEnabled ? next.declineWeight : 0) +
    (next.financeEnabled ? next.financeWeight : 0);

  if (next.enabled && reachable < next.attentionScore) {
    return badRequest('Please check the highlighted fields.', {
      attentionScore: `No student could ever reach ${next.attentionScore}. The enabled signals add up to at most ${reachable}.`,
    });
  }

  await setSetting(ctx.db, ctx.schoolId, 'risk', next);

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'school.settingsUpdate',
    entityType: 'schoolSettings',
    entityId: 'risk',
    summary: 'Updated early-warning thresholds',
    previousValue: current,
    newValue: next,
    ipAddress: ctx.ipAddress,
  });

  return ok({ settings: next });
});
