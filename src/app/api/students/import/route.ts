import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { route, ok, badRequest } from '../../../../lib/api/respond.ts';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { importStudents, buildStudentTemplate } from '../../../../lib/import/students.ts';
import { SpreadsheetError, XLSX_LIMITS } from '../../../../lib/import/xlsx.ts';
import { academicYears } from '../../../../db/schema/core.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
 * Accepts a .xlsx or .csv upload as multipart/form-data, or CSV text as JSON.
 *
 * `mode=validate` (the default) parses the file and returns a per-row report
 * without writing anything. `mode=commit` re-runs the identical validation and
 * then inserts only the rows that pass, so a stale preview can never authorise
 * a bad write.
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
  let fileText: string | undefined;
  let fileBytes: Uint8Array | undefined;
  let sheet: string | number | undefined;
  let mode: 'validate' | 'commit' = 'validate';
  let skipRowNumbers: number[] = [];

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return badRequest('Attach an Excel (.xlsx) or CSV file to import.');
    }
    if (file.size === 0) {
      return badRequest('That file is empty.');
    }
    if (file.size > XLSX_LIMITS.maxBytes) {
      return badRequest('That file is larger than 5 MB. Split it into smaller files.');
    }

    // Read as bytes and let the importer sniff the real format. The filename
    // and the browser's Content-Type are both attacker-controlled and are
    // routinely wrong even when they are not.
    fileBytes = new Uint8Array(await file.arrayBuffer());

    mode = form.get('mode') === 'commit' ? 'commit' : 'validate';

    const sheetRaw = form.get('sheet');
    if (typeof sheetRaw === 'string' && sheetRaw.trim()) {
      const asNumber = Number.parseInt(sheetRaw, 10);
      sheet = String(asNumber) === sheetRaw.trim() ? asNumber : sheetRaw;
    }

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
      fileBase64?: unknown;
      sheet?: unknown;
      mode?: unknown;
      skipRowNumbers?: unknown;
    } | null;

    if (!body) return badRequest('Provide a file to import.');

    if (typeof body.fileBase64 === 'string' && body.fileBase64.length > 0) {
      // Base64 inflates by ~4/3, so bound the encoded length accordingly.
      if (body.fileBase64.length > Math.ceil((XLSX_LIMITS.maxBytes * 4) / 3) + 1024) {
        return badRequest('That file is larger than 5 MB.');
      }
      try {
        fileBytes = new Uint8Array(Buffer.from(body.fileBase64, 'base64'));
      } catch {
        return badRequest('The uploaded file could not be decoded.');
      }
    } else if (typeof body.fileText === 'string' && body.fileText.trim() !== '') {
      if (body.fileText.length > XLSX_LIMITS.maxBytes) {
        return badRequest('That file is larger than 5 MB. Split it into smaller files.');
      }
      fileText = body.fileText;
    } else {
      return badRequest('Provide the file contents to import.');
    }

    mode = body.mode === 'commit' ? 'commit' : 'validate';
    if (typeof body.sheet === 'string' || typeof body.sheet === 'number') {
      sheet = body.sheet;
    }
    if (Array.isArray(body.skipRowNumbers)) {
      skipRowNumbers = body.skipRowNumbers.filter(
        (value): value is number => typeof value === 'number' && Number.isInteger(value),
      );
    }
  }

  // Committing writes student records, so it needs create rights as well as
  // the import permission. Validation deliberately does not.
  if (mode === 'commit') {
    ctx.require('student.create');
  }

  try {
    const report = await importStudents(ctx, {
      fileText,
      fileBytes,
      sheet,
      academicYearId: year.id,
      mode,
      skipRowNumbers,
    });
    return ok(report);
  } catch (error) {
    // A malformed workbook is the administrator's problem to fix, not a
    // server fault: report it as a 400 with an actionable message.
    if (error instanceof SpreadsheetError) {
      return badRequest(error.message);
    }
    throw error;
  }
});
