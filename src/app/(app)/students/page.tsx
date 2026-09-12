import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listStudents, getStudentFilters } from '../../../lib/students/service.ts';
import { studentListSchema } from '../../../lib/students/schema.ts';
import { academicYears } from '../../../db/schema/core.ts';
import { PageHeader, Card, Badge, EmptyState } from '../../../components/ui.tsx';
import StudentFilters from './StudentFilters.tsx';
import { personName, initials } from '../../../lib/format.ts';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  active: 'good',
  transferred: 'neutral',
  withdrawn: 'bad',
  graduated: 'info',
  suspended: 'warn',
  inactive: 'neutral',
};

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.has('student.view')) {
    return (
      <Card>
        <EmptyState
          title="You do not have permission to view students"
          description="Contact your administrator if you believe this is a mistake."
        />
      </Card>
    );
  }

  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = studentListSchema.safeParse(flat);
  const query = parsed.success ? parsed.data : studentListSchema.parse({});

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  const restrictToSectionIds = ctx.has('restrict.ownSectionsOnly')
    ? ctx.relationships.sectionIds
    : undefined;

  const [{ rows, total }, filters] = await Promise.all([
    listStudents(ctx.db, ctx.schoolId, query, {
      restrictToSectionIds,
      academicYearId: year?.id ?? null,
    }),
    getStudentFilters(ctx.db, ctx.schoolId, year?.id ?? null),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));

  return (
    <>
      <PageHeader
        title="Students"
        description={
          restrictToSectionIds
            ? `${total} students in your classes`
            : `${total} students`
        }
        action={
          <div className="flex flex-wrap gap-2">
            {ctx.has('student.export') && (
              <a
                href={`/api/students/export?${new URLSearchParams(
                  Object.entries(query).reduce<Record<string, string>>((acc, [key, value]) => {
                    if (value !== undefined && value !== null && value !== '') {
                      acc[key] = String(value);
                    }
                    return acc;
                  }, {}),
                ).toString()}`}
                className="tap-target inline-flex items-center rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
              >
                Export
              </a>
            )}
            {ctx.has('student.import') && (
              <Link
                href="/students/import"
                className="tap-target inline-flex items-center rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
              >
                Import
              </Link>
            )}
            {ctx.has('student.create') && (
              <Link
                href="/students/new"
                className="tap-target inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Add student
              </Link>
            )}
          </div>
        }
      />

      <StudentFilters
        grades={filters.grades}
        sections={filters.sections}
        current={{
          search: query.search ?? '',
          status: query.status ?? '',
          gradeLevelId: query.gradeLevelId ?? '',
          sectionId: query.sectionId ?? '',
        }}
      />

      <Card className="mt-4">
        {rows.length === 0 ? (
          <EmptyState
            title="No students found"
            description={
              query.search
                ? `Nothing matched “${query.search}”. Try a different name or ID.`
                : 'Add a student, or import your existing list from Excel.'
            }
          />
        ) : (
          <>
            {/* Mobile: cards. Desktop: table. Same data, appropriate density. */}
            <ul className="divide-y divide-ink-100 sm:hidden">
              {rows.map((student) => (
                <li key={student.id}>
                  <Link
                    href={`/students/${student.id}`}
                    className="-mx-4 flex items-center gap-3 px-4 py-3 active:bg-ink-50"
                  >
                    <Avatar student={student} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-900">
                        {personName(student)}
                      </p>
                      <p className="truncate text-xs text-ink-500">
                        {student.studentCode}
                        {student.gradeName ? ` · ${student.gradeName} ${student.sectionName ?? ''}` : ''}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[student.status] ?? 'neutral'}>{student.status}</Badge>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2.5 font-medium">Student</th>
                    <th className="px-4 py-2.5 font-medium">ID</th>
                    <th className="px-4 py-2.5 font-medium">Class</th>
                    <th className="px-4 py-2.5 font-medium">Guardian phone</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((student) => (
                    <tr
                      key={student.id}
                      className="border-b border-ink-100 last:border-0 hover:bg-ink-50"
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/students/${student.id}`}
                          className="flex items-center gap-2.5 font-medium text-ink-900 hover:text-brand-700"
                        >
                          <Avatar student={student} />
                          <span className="truncate">{personName(student, { full: true })}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-600">
                        {student.studentCode}
                      </td>
                      <td className="px-4 py-2.5 text-ink-600">
                        {student.gradeName
                          ? `${student.gradeName}${student.sectionName ? ` ${student.sectionName}` : ''}`
                          : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-ink-600">{student.guardianPhone ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[student.status] ?? 'neutral'}>
                          {student.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <Pagination page={query.page} totalPages={totalPages} params={flat} />
            )}
          </>
        )}
      </Card>
    </>
  );
}

function Avatar({ student }: { student: { givenName: string; fatherName: string } }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
      {initials(student)}
    </span>
  );
}

function Pagination({
  page,
  totalPages,
  params,
}: {
  page: number;
  totalPages: number;
  params: Record<string, string | undefined>;
}) {
  const link = (target: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v && k !== 'page') sp.set(k, v);
    }
    sp.set('page', String(target));
    return `/students?${sp.toString()}`;
  };

  return (
    <div className="mt-4 flex items-center justify-between border-t border-ink-200 pt-4">
      <p className="text-xs text-ink-500">
        Page {page} of {totalPages}
      </p>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={link(page - 1)}
            className="tap-target inline-flex items-center rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Previous
          </Link>
        )}
        {page < totalPages && (
          <Link
            href={link(page + 1)}
            className="tap-target inline-flex items-center rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Next
          </Link>
        )}
      </div>
    </div>
  );
}
