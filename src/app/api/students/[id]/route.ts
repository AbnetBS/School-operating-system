import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, notFound, badRequest, zodFields } from '../../../../lib/api/respond.ts';
import { getStudentProfile, updateStudent } from '../../../../lib/students/service.ts';
import { updateStudentSchema } from '../../../../lib/students/schema.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  const { id } = await params;

  // Relationship-aware: a parent may fetch only their own child, a teacher
  // only a student in their sections. Throws 404 (not 403) so the endpoint
  // cannot be used to discover which ids exist.
  await ctx.requireStudentAccess(id);

  const profile = await getStudentProfile(ctx.db, ctx.schoolId, id);
  if (!profile) return notFound('Student not found');

  // Medical notes are sensitive and gated by a separate permission.
  if (!ctx.has('student.viewSensitive')) {
    profile.student.medicalNotes = null;
    profile.student.bloodGroup = null;
  }

  return ok(profile);
});

export const PATCH = route(async (request: NextRequest, { params }: Params) => {
  const ctx = await requireAuth();
  ctx.require('student.edit');
  const { id } = await params;

  await ctx.requireStudentAccess(id);

  const body = await request.json().catch(() => null);
  const parsed = updateStudentSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  await updateStudent(ctx, id, parsed.data);
  const profile = await getStudentProfile(ctx.db, ctx.schoolId, id);
  return ok(profile);
});
