import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { route, ok, badRequest } from '../../../../lib/api/respond.ts';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { importStudents, buildStudentTemplate } from '../../../../lib/import/students.ts';
import { academicYears } from '../../../../db/schema/core.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A 5 MB ceiling — comfortably more than a whole school, far below a DoS. */
const MAX_BYTES = 5 * 1024 * 1024;

/** GET /api/students/import — download the blank template. */
export const GET = route(async () => {
  const ctx = await requireAuth();
  ctx.require('student.import');

  return new NextResponse(buildStudentTemplate(), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="student-import-template.csv"',
    },
  });
});

/**
 * POST /api/students/import
 *
 * `mode=validate` (default) parses the file and returns a per-row report
 * without writing anything. `mode=commit` re-runs the same validation and
 * then inserts the rows that pass. Nothing is ever written on the strength of
 * a preview alone.
 */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('student.import');

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  if (!year) {
    return badRequest('Set up an academic year before importing students.');
  }

  const contentType = request.headers.get('content-type') ?? '';
  let fileText = '';
  let mode: 'validate' | 'commit' = 'validate';
  let skipRowNumbers: number[] = [];

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return badRequest('Attach a CSV file to import.');
    }
    if (file.size > MAX_BYTES) {
      return badRequest('That file is larger than 5 MB. Split it into smaller files.');
    }
    fileText = await file.text();
    mode = form.get('mode') === 'commit' ? 'commit' : 'validate';
    const skipRaw = form.get('skipRows');
    if (typeof skipRaw === 'string' && skipRaw.trim()) {
      skipRowNumbers = skipRaw
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value));
    }
  } else {
    const body = (await request.json().catch(() => null)) as {
      fileText?: unknown;
      mode?: unknown;
      skipRowNumbers?: unknown;
    } | null;

    if (!body || typeof body.fileText !== 'string' || body.fileText.trim() === '') {
      return badRequest('Provide the file contents to import.');
    }
    if (body.fileText.length > MAX_BYTES) {
      return badRequest('That file is larger than 5 MB. Split it into smaller files.');
    }
    fileText = body.fileText;
    mode = body.mode === 'commit' ? 'commit' : 'validate';
    if (Array.isArray(body.skipRowNumbers)) {
      skipRowNumbers = body.skipRowNumbers.filter(
        (value): value is number => typeof value === 'number' && Number.isInteger(value),
      );
    }
  }

  // Committing writes student records, so it needs create rights too, not
  // just the import permission.
  if (mode === 'commit') {
    ctx.require('student.create');
  }

  const report = await importStudents(ctx, {
    fileText,
    academicYearId: year.id,
    mode,
    skipRowNumbers,
  });

  return ok(report);
});
