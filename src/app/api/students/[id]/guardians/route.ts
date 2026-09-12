import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok, created, badRequest, zodFields } from '../../../../../lib/api/respond.ts';
import {
  linkGuardianToStudent,
  unlinkGuardian,
  updateGuardianLink,
} from '../../../../../lib/guardians/service.ts';
import { linkGuardianSchema, updateLinkSchema } from '../../../../../lib/guardians/schema.ts';
import { getStudentProfile } from '../../../../../lib/students/service.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Link an existing guardian to this student. */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('guardian.manage');
  const { id: studentId } = await params;

  // Relationship-aware: 404 if the caller may not see this student at all.
  await ctx.requireStudentAccess(studentId);

  const body = await request.json().catch(() => null);
  const parsed = linkGuardianSchema.safeParse({ ...(body ?? {}), studentId });
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  await linkGuardianToStudent(ctx, parsed.data);
  const profile = await getStudentProfile(ctx.db, ctx.schoolId, studentId);
  return created({ guardians: profile?.guardians ?? [] });
});

/** Change the properties of an existing link. */
export const PATCH = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('guardian.manage');
  const { id: studentId } = await params;
  await ctx.requireStudentAccess(studentId);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const guardianId = typeof body?.guardianId === 'string' ? body.guardianId : '';
  if (!guardianId) return badRequest('A guardian must be specified.');

  const parsed = updateLinkSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  await updateGuardianLink(ctx, { studentId, guardianId }, parsed.data);
  const profile = await getStudentProfile(ctx.db, ctx.schoolId, studentId);
  return ok({ guardians: profile?.guardians ?? [] });
});

/** Remove a guardian link. The guardian record itself is kept. */
export const DELETE = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('guardian.manage');
  const { id: studentId } = await params;
  await ctx.requireStudentAccess(studentId);

  const guardianId = new URL(request.url).searchParams.get('guardianId');
  if (!guardianId) return badRequest('A guardian must be specified.');

  await unlinkGuardian(ctx, { studentId, guardianId });
  const profile = await getStudentProfile(ctx.db, ctx.schoolId, studentId);
  return ok({ guardians: profile?.guardians ?? [] });
});
