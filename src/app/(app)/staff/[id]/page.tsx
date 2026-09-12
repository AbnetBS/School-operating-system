import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getStaffProfile } from '../../../../lib/staff/service.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { PageHeader, Card, Badge, EmptyState } from '../../../../components/ui.tsx';
import { initials, formatSchoolDate } from '../../../../lib/format.ts';

export const dynamic = 'force-dynamic';

export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.has('staff.view')) notFound();

  const { id } = await params;
  const profile = await getStaffProfile(ctx.db, ctx.schoolId, id);
  if (!profile) notFound();

  const localeSettings = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const cal = localeSettings.calendarDisplay;
  const { staff, user, roles, teaching, homerooms } = profile;

  return (
    <>
      <div className="mb-3">
        <Link href="/staff" className="text-sm text-brand-600 hover:underline">
          ← All staff
        </Link>
      </div>

      <div className="card mb-4 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-xl font-bold text-brand-700">
            {initials(user)}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">
              {[user.givenName, user.fatherName, user.grandfatherName].filter(Boolean).join(' ')}
            </h1>
            {user.givenNameAm && (
              <p lang="am" className="text-base text-ink-600">
                {[user.givenNameAm, user.fatherNameAm].filter(Boolean).join(' ')}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-600">
              <span className="font-mono text-xs">{staff.staffCode}</span>
              <span aria-hidden>·</span>
              <span className="capitalize">{staff.jobTitle ?? staff.staffType}</span>
              <span aria-hidden>·</span>
              <Badge tone={staff.status === 'active' ? 'good' : 'neutral'}>
                {staff.status.replace('_', ' ')}
              </Badge>
              {!user.isActive && <Badge tone="bad">Login disabled</Badge>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Employment">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label="Staff ID" value={staff.staffCode} />
              <Field label="Type" value={staff.staffType} />
              <Field label="Job title" value={staff.jobTitle} />
              <Field label="Department" value={staff.department} />
              <Field label="Employment" value={staff.employmentType} />
              <Field label="Hired" value={formatSchoolDate(staff.hireDate, cal, ctx.locale)} />
              <Field label="Qualification" value={staff.qualification} />
              <Field label="Phone" value={staff.phone} />
              <Field label="Gender" value={staff.gender} />
              <Field
                label="Date of birth"
                value={formatSchoolDate(staff.dateOfBirth, cal, ctx.locale)}
              />
              <Field label="Address" value={staff.address} />
            </dl>
          </Card>

          <Card title="Teaching load">
            {teaching.length === 0 && homerooms.length === 0 ? (
              <EmptyState
                title="Not assigned to any class"
                description="Assign subjects from the Academics area so this teacher can take attendance and enter marks."
              />
            ) : (
              <>
                {homerooms.length > 0 && (
                  <div className="mb-3">
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-500">
                      Class teacher for
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {homerooms.map((room) => (
                        <Badge key={room.id} tone="info">
                          {room.gradeName} {room.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {teaching.length > 0 && (
                  <ul className="divide-y divide-ink-100">
                    {teaching.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                        <span className="text-sm text-ink-900">{item.subjectName}</span>
                        <span className="text-xs text-ink-500">
                          {item.gradeName} {item.sectionName}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Login">
            <dl className="space-y-2">
              <Field label="Username" value={user.username} />
              <Field label="Email" value={user.email} />
              <Field
                label="Last signed in"
                value={
                  user.lastLoginAt
                    ? new Date(user.lastLoginAt).toLocaleString('en-GB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })
                    : 'Never'
                }
              />
            </dl>
            {user.mustChangePassword && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Must change password at next sign-in.
              </p>
            )}
          </Card>

          <Card title="Roles">
            {roles.length === 0 ? (
              <EmptyState title="No role assigned" description="This person cannot do anything until a role is given." />
            ) : (
              <ul className="space-y-2">
                {roles.map((role) => (
                  <li key={role.id} className="rounded-lg border border-ink-200 px-3 py-2">
                    <p className="text-sm font-medium text-ink-900">{role.name}</p>
                    {role.nameAm && (
                      <p lang="am" className="text-xs text-ink-500">
                        {role.nameAm}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm capitalize text-ink-900">{value || '—'}</dd>
    </div>
  );
}
