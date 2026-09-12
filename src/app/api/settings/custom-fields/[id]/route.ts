/**
 * Amend or deactivate one custom field definition.
 *
 * There is no DELETE. A definition whose values are already captured in
 * hundreds of student records cannot be removed without either orphaning that
 * data or destroying it; deactivating hides the field from forms and rejects
 * new values while leaving what was collected intact. `PATCH { isActive:
 * false }` is the supported "remove".
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok, badRequest, zodFields } from '../../../../../lib/api/respond.ts';
import { updateCustomFieldSchema } from '../../../../../lib/customFields/schema.ts';
import { updateDefinition } from '../../../../../lib/customFields/service.ts';
import { recordAudit } from '../../../../../lib/audit/index.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    ctx.require('school.manage');

    const { id } = await params;
    const parsed = updateCustomFieldSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
    }

    // The school id is part of the lookup inside the service, so a definition
    // belonging to another school is a 404 rather than an edit.
    const { before, after } = await updateDefinition(ctx.db, ctx.schoolId, id, {
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      ...(parsed.data.labelAm !== undefined ? { labelAm: parsed.data.labelAm } : {}),
      ...(parsed.data.options !== undefined ? { options: parsed.data.options } : {}),
      ...(parsed.data.isRequired !== undefined ? { isRequired: parsed.data.isRequired } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    });

    const deactivated = before.isActive && after.isActive === false;

    await recordAudit(ctx.db, {
      schoolId: ctx.schoolId,
      actorUserId: ctx.user.userId,
      actorName: ctx.displayName(),
      action: deactivated ? 'customField.deactivated' : 'customField.updated',
      entityType: 'custom_field_def',
      entityId: id,
      summary: deactivated
        ? `Deactivated ${before.entityType} field "${before.label}"`
        : `Updated ${before.entityType} field "${before.label}"`,
      previousValue: before as unknown as Record<string, unknown>,
      newValue: after as unknown as Record<string, unknown>,
      ipAddress: ctx.ipAddress,
    });

    return ok({ definition: after });
  },
);
