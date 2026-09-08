import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listGuardians } from '../../../lib/guardians/service.ts';
import { guardianListSchema } from '../../../lib/guardians/schema.ts';
import { PageHeader, Card, Badge, EmptyState } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export default async function GuardiansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  if (!ctx.has('guardian.view')) {
    return (
      <Card>
        <EmptyState
          title="You do not have permission to view guardians"
          description="Contact your administrator if you believe this is a mistake."
        />
      </Card>
    );
  }

  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = guardianListSchema.safeParse(flat);
  const query = parsed.success ? parsed.data : guardianListSchema.parse({});

  const { rows, total } = await listGuardians(ctx.db, ctx.schoolId, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));

  const pageHref = (page: number) => {
    const sp = new URLSearchParams();
    if (query.search) sp.set('search', query.search);
    if (query.hasPortal) sp.set('hasPortal', query.hasPortal);
    sp.set('page', String(page));
    return `/guardians?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Parents & guardians"
        description={`${total} contact${total === 1 ? '' : 's'}`}
      />

      <Card className="p-3">
        <form method="get" className="flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            name="search"
            defaultValue={query.search ?? ''}
            placeholder="Search by name or phone…"
            className="tap-target flex-1 rounded-lg border border-ink-300 px-3 py-2 text-base sm:text-sm"
            aria-label="Search guardians"
          />
          <select
            name="hasPortal"
            defaultValue={query.hasPortal ?? ''}
            className="tap-target rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            aria-label="Filter by portal access"
          >
            <option value="">All</option>
            <option value="yes">Has portal login</option>
            <option value="no">No portal login</option>
          </select>
          <button
            type="submit"
            className="tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
          >
            Search
          </button>
        </form>
      </Card>

      <Card className="mt-4">
        {rows.length === 0 ? (
          <EmptyState
            title="No guardians found"
            description={
              query.search
                ? `Nothing matched “${query.search}”.`
                : 'Guardians are added when you register a student, or from a student profile.'
            }
          />
        ) : (
          <>
            {/* Mobile */}
            <ul className="divide-y divide-ink-100 sm:hidden">
              {rows.map((guardian) => (
                <li key={guardian.id} className="py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">
                        {guardian.givenName} {guardian.fatherName ?? ''}
                      </p>
                      <p className="truncate text-xs text-ink-500">
                        {guardian.childCount} child{guardian.childCount === 1 ? '' : 'ren'}
                        {guardian.childNames ? ` · ${guardian.childNames}` : ''}
                      </p>
                    </div>
                    {guardian.hasPortalAccess && <Badge tone="info">Portal</Badge>}
                  </div>
                  {guardian.phone && (
                    <a
                      href={`tel:${guardian.phone}`}
                      className="mt-1 inline-block text-sm text-brand-600"
                    >
                      {guardian.phone}
                    </a>
                  )}
                </li>
              ))}
            </ul>

            {/* Desktop */}
            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2.5 font-medium">Guardian</th>
                    <th className="px-4 py-2.5 font-medium">Phone</th>
                    <th className="px-4 py-2.5 font-medium">Children</th>
                    <th className="px-4 py-2.5 font-medium">Contact by</th>
                    <th className="px-4 py-2.5 font-medium">Portal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.map((guardian) => (
                    <tr key={guardian.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2.5 font-medium text-ink-900">
                        {guardian.givenName} {guardian.fatherName ?? ''}
                        {guardian.givenNameAm && (
                          <span lang="am" className="ml-2 text-xs text-ink-500">
                            {guardian.givenNameAm}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {guardian.phone ? (
                          <a href={`tel:${guardian.phone}`} className="text-brand-600 hover:underline">
                            {guardian.phone}
                          </a>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-600">
                        {guardian.childCount > 0 ? (
                          <span title={guardian.childNames ?? ''}>
                            {guardian.childCount}
                            <span className="ml-1 text-xs text-ink-400">
                              {guardian.childNames}
                            </span>
                          </span>
                        ) : (
                          <span className="text-amber-600">Not linked</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 capitalize text-ink-600">
                        {guardian.preferredChannel}
                      </td>
                      <td className="px-4 py-2.5">
                        {guardian.hasPortalAccess ? (
                          <Badge tone="good">Yes</Badge>
                        ) : (
                          <Badge tone="neutral">No</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between" aria-label="Pagination">
          <Link
            href={pageHref(Math.max(1, query.page - 1))}
            aria-disabled={query.page === 1}
            className={`tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm ${
              query.page === 1 ? 'pointer-events-none opacity-40' : 'hover:bg-ink-50'
            }`}
          >
            Previous
          </Link>
          <span className="text-sm text-ink-500">
            Page {query.page} of {totalPages}
          </span>
          <Link
            href={pageHref(Math.min(totalPages, query.page + 1))}
            aria-disabled={query.page === totalPages}
            className={`tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm ${
              query.page === totalPages ? 'pointer-events-none opacity-40' : 'hover:bg-ink-50'
            }`}
          >
            Next
          </Link>
        </nav>
      )}
    </>
  );
}
