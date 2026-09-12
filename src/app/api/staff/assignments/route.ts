import type { NextRequest } from 'next/server';
import { route, ok, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { assignTeacher } from '../../../../lib/staff/service.ts';
import { assignTeacherSchema } from '../../../../lib/staff/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/staff/assignments
 *
 * Assigns a teacher to a subject class, or makes them the class teacher of a
 * section. This is the switch that grants a teacher visibility of a class —
 * `ctx.relationships.sectionIds` is derived from exactly these two columns —
 * so it is permission-gated and audited.
 */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('academic.assignTeacher');

  const parsed = assignTeacherSchema.safeParse(await request.json());
  if (!parsed.success) {
    return badRequest('Check the highlighted fields', zodFields(parsed.error));
  }

  await assignTeacher(ctx, parsed.data);
  return ok({ ok: true });
});
