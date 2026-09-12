import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import { submitAttendance, checkAttendancePermission } from '../../../../lib/attendance/service.ts';
import { syncAttendanceSchema } from '../../../../lib/attendance/schema.ts';
import { academicYears } from '../../../../db/schema/core.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Flush an offline queue.
 *
 * Several registers arrive in one request, which matters when a teacher
 * reconnects after a day without signal. Each is processed independently: one
 * rejected register (say, a backdating limit) must not discard the rest, so the
 * response reports per-register outcomes instead of failing the whole batch.
 */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('attendance');

  const body = await request.json().catch(() => null);
  const parsed = syncAttendanceSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Invalid sync payload.', zodFields(parsed.error));
  }

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!year) return badRequest('No academic year is set up yet.');

  const results: {
    sectionId: string;
    date: string;
    ok: boolean;
    sessionId?: string;
    created?: boolean;
    error?: string;
  }[] = [];

  for (const register of parsed.data.registers) {
    const permission = await checkAttendancePermission(ctx, {
      sectionId: register.sectionId,
      sectionSubjectId: register.sectionSubjectId,
      date: register.date,
    });

    if (!permission.allowed) {
      results.push({
        sectionId: register.sectionId,
        date: register.date,
        ok: false,
        error: permission.reason,
      });
      continue;
    }

    try {
      const result = await submitAttendance(
        ctx,
        { ...register, syncedOffline: true },
        year.id,
      );
      results.push({
        sectionId: register.sectionId,
        date: register.date,
        ok: true,
        sessionId: result.sessionId,
        created: result.created,
      });
    } catch (error) {
      results.push({
        sectionId: register.sectionId,
        date: register.date,
        ok: false,
        error: error instanceof Error ? error.message : 'Could not save this register.',
      });
    }
  }

  return ok({
    synced: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});
