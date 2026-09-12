import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { route, badRequest } from '../../../../lib/api/respond.ts';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { listStudents } from '../../../../lib/students/service.ts';
import { studentListSchema } from '../../../../lib/students/schema.ts';
import { toCsv } from '../../../../lib/import/csv.ts';
import { getActiveDefinitions } from '../../../../lib/customFields/service.ts';
import { academicYears } from '../../../../db/schema/core.ts';
import { recordAudit } from '../../../../lib/audit/index.ts';
import { throttleByUser } from '../../../../lib/api/throttle.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/students/export
 *
 * Exports the student list as CSV, honouring the same filters and the same
 * visibility rules as the on-screen list. A teacher restricted to their own
 * sections exports only those students — the export is not a way around
 * `restrict.ownSectionsOnly`.
 *
 * Exporting personal data is itself worth recording, so it is audited.
 */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  ctx.require('student.export');

  // Paginates through up to 20,000 rows, so one call is materially expensive on
  // a real tenant. Keyed per user, which a forged header cannot rotate.
  const throttled = throttleByUser(ctx.user.userId, 'export:students');
  if (throttled) return throttled;

  const url = new URL(request.url);
  const parsed = studentListSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid export filters.');
  }

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  // A school's own fields belong in its export — information entered once
  // should leave the system with the record it describes, not be stranded.
  // Only active definitions are included, so a retired field stops appearing
  // in new exports while its values stay in the database.
  const customFields = await getActiveDefinitions(ctx.db, ctx.schoolId, 'student');

  const headers = [
    'Student ID',
    'Given Name',
    'Father Name',
    'Grandfather Name',
    'Gender',
    'Grade Level',
    'Section',
    'Roll Number',
    'Status',
    'Guardian Phone',
    ...customFields.map((def) => def.label),
  ];

  const rows: (string | number | null)[][] = [];
  const pageSize = 500;
  let page = 1;

  // Page through rather than loading an entire school into memory at once.
  for (;;) {
    const { rows: batch, total } = await listStudents(
      ctx.db,
      ctx.schoolId,
      { ...parsed.data, page, pageSize },
      { restrictToSectionIds, academicYearId: year?.id ?? null, withCustomFields: customFields.length > 0 },
    );

    for (const student of batch) {
      rows.push([
        student.studentCode,
        student.givenName,
        student.fatherName,
        student.grandfatherName,
        student.gender,
        student.gradeName,
        student.sectionName,
        student.rollNumber,
        student.status,
        student.guardianPhone,
        ...customFields.map((def) => {
          const value = student.customFields?.[def.key];
          if (value === undefined || value === null) return null;
          // Booleans must not export as "true"/"false", which no spreadsheet
          // user reads as an answer to "Boarder?".
          if (typeof value === 'boolean') return value ? 'Yes' : 'No';
          return typeof value === 'object' ? JSON.stringify(value) : String(value);
        }),
      ]);
    }

    if (batch.length < pageSize || rows.length >= total || rows.length >= 20_000) break;
    page++;
  }

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'export.run',
    entityType: 'student',
    entityId: null,
    summary: `Exported ${rows.length} student record${rows.length === 1 ? '' : 's'}`,
    newValue: { count: rows.length, filters: parsed.data },
    ipAddress: ctx.ipAddress,
  });

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(toCsv(headers, rows), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="students-${stamp}.csv"`,
    },
  });
});
