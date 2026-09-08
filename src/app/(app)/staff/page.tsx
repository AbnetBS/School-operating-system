import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { listStaff, listRoles } from '../../../lib/staff/service.ts';
import { staffListSchema, STAFF_TYPES } from '../../../lib/staff/schema.ts';
import { PageHeader, Card, Badge, EmptyState } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  active: 'good',
  on_leave: 'warn',
  resigned: 'neutral',
  terminated: 'bad',
};

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  if (!ctx.has('staff.view')) {
    return (
      <Card>
        <EmptyState
          title="You do not have permission to view staff"
          description="Contact your administrator if you believe this is a mistake."
        />
      </Card>
    );
  }

  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = staffListSchema.safeParse(flat);
  const query = parsed.success ? parsed.data : staffListSchema.parse({});

  const [{ rows, total }, roles] = await Promise.all([
    listStaff(ctx.db, ctx.schoolId, query),
    listRoles(ctx.db, ctx.schoolId),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));

  const pageHref = (page: number) => {
    const sp = new URLSearchParams();
    if (query.search) sp.set('search', query.search);
    if (query.staffType) sp.set('staffType', query.staffType);
    if (query.status) sp.set('status', query.status);
    sp.set('page', String(page));
    return `/staff?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Staff"
        description={`${total} staff member${total === 1 ? '' : 's'}`}
        action={
          ctx.has('staff.manage') && ctx.has('user.manage') ? (
            <Link
              href="/staff/new"
              className="tap-target inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Add staff
            </Link>
          ) : null
        }
      />

      <Card className="p-3">
        <form method="get" className="flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            name="search"
            defaultValue={query.search ?? ''}
            placeholder="Search by name, ID or job title…"
            className="tap-target flex-1 rounded-lg border border-ink-300 px-3 py-2 text-base sm:text-sm"
            aria-label="Search staff"
          />
          <select
            name="staffType"
            defaultValue={query.staffType ?? ''}
            className="tap-target rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            aria-label="Filter by staff type"
          >
            <option value="">All types</option>
            {STAFF_TYPES.map((type) => (
              <option key={type} value={type}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={query.status ?? ''}
            className="tap-target rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="on_leave">On leave</option>
            <option value="resigned">Resigned</option>
            <option value="terminated">Terminated</option>
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
            title="No staff found"
            description={query.search ? `Nothing matched “${query.search}”.` : 'Add your first staff member.'}
          />
        ) : (
          <>
            {/* Mobile */}
            <ul className="divide-y divide-ink-100 sm:hidden">
              {rows.map((member) => (
                <li key={member.id}>
                  <Link
                    href={`/staff/${member.id}`}
                    className="tap-target -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-3 hover:bg-ink-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">
                        {member.givenName} {member.fatherName ?? ''}
                      </p>
                      <p className="truncate text-xs text-ink-500">
                        {member.staffCode} · {member.jobTitle ?? member.staffType}
                        {member.sectionCount > 0 ? ` · ${member.sectionCount} classes` : ''}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[member.status] ?? 'neutral'}>
                      {member.status.replace('_', ' ')}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>

            {/* Desktop */}
            <div className="-mx-4 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Staff ID</th>
                    <th className="px-4 py-2.5 font-medium">Role</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
                    <th className="px-4 py-2.5 font-medium text-right">Classes</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.map((member) => (
                    <tr key={member.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2.5">
                        <Link href={`/staff/${member.id}`} className="font-medium text-ink-900 hover:underline">
                          {member.givenName} {member.fatherName ?? ''}
                        </Link>
                        <span className="ml-2 text-xs text-ink-400">@{member.username}</span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-600">{member.staffCode}</td>
                      <td className="px-4 py-2.5 text-ink-600">{member.roleNames ?? '—'}</td>
                      <td className="px-4 py-2.5 capitalize text-ink-600">{member.staffType}</td>
                      <td className="px-4 py-2.5 text-right text-ink-600">
                        {member.sectionCount || '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[member.status] ?? 'neutral'}>
                          {member.status.replace('_', ' ')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {ctx.has('role.view') && roles.length > 0 && (
        <Card className="mt-4" title="Roles at this school">
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {roles.map((role) => (
              <li
                key={role.id}
                className="rounded-lg border border-ink-200 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">{role.name}</p>
                    {role.nameAm && (
                      <p lang="am" className="truncate text-xs text-ink-500">
                        {role.nameAm}
                      </p>
                    )}
                  </div>
                  {role.isSystem && <Badge tone="neutral">Built-in</Badge>}
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {role.userCount} user{role.userCount === 1 ? '' : 's'} · {role.permissionCount}{' '}
                  permission{role.permissionCount === 1 ? '' : 's'}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between" aria-label="Pagination">
          <Link
            href={pageHref(Math.max(1, query.page - 1))}
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
