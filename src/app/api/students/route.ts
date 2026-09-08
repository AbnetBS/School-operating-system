import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, created, badRequest, zodFields } from '../../../lib/api/respond.ts';
import {
  listStudents,
  createStudent,
  generateStudentCode,
  getStudentProfile,
} from '../../../lib/students/service.ts';
import { studentListSchema, createStudentSchema } from '../../../lib/students/schema.ts';
import { academicYears } from '../../../db/schema/core.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function currentYear(ctx: Awaited<ReturnType<typeof requireAuth>>) {
  const [year] = await ctx.db
    .select({ id: academicYears.id, ethiopianYear: academicYears.ethiopianYear })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  return year ?? null;
}

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('student.view');

  const url = new URL(request.url);
  const parsed = studentListSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid filter values.', zodFields(parsed.error));
  }

  const year = await currentYear(ctx);

  // A teacher limited to their own sections must not be able to widen the
  // query by passing a different sectionId — the restriction is applied
  // server-side regardless of what the client asked for.
  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  const { rows, total } = await listStudents(ctx.db, ctx.schoolId, parsed.data, {
    restrictToSectionIds,
    academicYearId: year?.id ?? null,
  });

  return ok({
    data: rows,
    total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
  });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('student.create');

  const year = await currentYear(ctx);
  if (!year) {
    return badRequest('Create an academic year before registering students.');
  }

  const body = await request.json().catch(() => null);

  // Generate a student code when the form left it blank.
  if (body && typeof body === 'object' && !(body as Record<string, unknown>).studentCode) {
    (body as Record<string, unknown>).studentCode = await generateStudentCode(
      ctx.db,
      ctx.schoolId,
      year.ethiopianYear,
    );
  }

  const parsed = createStudentSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Please check the highlighted fields.', zodFields(parsed.error));
  }

  const result = await createStudent(ctx, parsed.data, year.id);

  // Return the saved record under `student`, matching the shape of GET
  // /api/students/[id], so callers can read `student.id` consistently.
  const profile = await getStudentProfile(ctx.db, ctx.schoolId, result.id);
  return created({ student: profile?.student ?? result, id: result.id });
});
