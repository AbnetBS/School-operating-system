/**
 * School-defined custom fields — list and create.
 *
 * Defining a field is school configuration, so it is gated on `school.manage`
 * exactly like the other settings surfaces. Reading the definitions is allowed
 * for anyone who may see the records the fields hang off, because the student
 * and staff forms need the labels in order to render.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import {
  createCustomFieldSchema,
  CUSTOM_FIELD_ENTITIES,
  type CustomFieldEntity,
} from '../../../../lib/customFields/schema.ts';
import {
  listDefinitions,
  createDefinition,
  countUsageForDefinitions,
} from '../../../../lib/customFields/service.ts';
import { recordAudit } from '../../../../lib/audit/index.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseEntity(value: string | null): CustomFieldEntity | undefined {
  return CUSTOM_FIELD_ENTITIES.includes(value as CustomFieldEntity)
    ? (value as CustomFieldEntity)
    : undefined;
}

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  // Whoever may see students or staff may see the field labels; only
  // `school.manage` may change them (enforced on POST/PATCH below).
  ctx.requireAny('student.view', 'staff.view', 'school.manage');

  const url = new URL(request.url);
  const entityType = parseEntity(url.searchParams.get('entityType'));
  const definitions = await listDefinitions(ctx.db, ctx.schoolId, entityType);

  // The management screen needs to know what deactivating a field would hide.
  // Only computed for a manager, and only when asked.
  let usage: Record<string, number> | undefined;
  if (url.searchParams.get('usage') === '1' && ctx.has('school.manage')) {
    usage = await countUsageForDefinitions(ctx.db, ctx.schoolId, definitions);
  }

  return ok({ definitions, entities: CUSTOM_FIELD_ENTITIES, ...(usage ? { usage } : {}) });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('school.manage');

  const parsed = createCustomFieldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  const definition = await createDefinition(ctx.db, ctx.schoolId, {
    entityType: parsed.data.entityType,
    key: parsed.data.key,
    label: parsed.data.label,
    labelAm: parsed.data.labelAm ?? null,
    fieldType: parsed.data.fieldType,
    options: parsed.data.options ?? null,
    isRequired: parsed.data.isRequired,
    sortOrder: parsed.data.sortOrder,
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'customField.created',
    entityType: 'custom_field_def',
    entityId: definition.id,
    summary: `Defined ${parsed.data.entityType} field "${parsed.data.label}"`,
    newValue: definition as unknown as Record<string, unknown>,
    ipAddress: ctx.ipAddress,
  });

  return created({ definition });
});
