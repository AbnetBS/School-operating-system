import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { listRoles } from '../../../../lib/staff/service.ts';
import { PageHeader } from '../../../../components/ui.tsx';
import StaffForm from './StaffForm.tsx';

export const dynamic = 'force-dynamic';

export default async function NewStaffPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  // Creating staff also creates a login, so both permissions are required —
  // the API enforces the same pair.
  if (!ctx.has('staff.manage') || !ctx.has('user.manage')) notFound();

  const roles = await listRoles(ctx.db, ctx.schoolId);

  return (
    <>
      <div className="mb-3">
        <Link href="/staff" className="text-sm text-brand-600 hover:underline">
          ← All staff
        </Link>
      </div>
      <PageHeader
        title="Add staff member"
        description="Creates their employment record and their sign-in account together."
      />
      <StaffForm
        roles={roles.map((role) => ({
          id: role.id,
          name: role.name,
          nameAm: role.nameAm,
          description: role.description,
        }))}
      />
    </>
  );
}
