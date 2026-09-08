import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getStudentProfile } from '../../../../lib/students/service.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { PageHeader, Card, Badge, EmptyState } from '../../../../components/ui.tsx';
import { personName, initials, formatSchoolDate } from '../../../../lib/format.ts';

export const dynamic = 'force-dynamic';

export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const { id } = await params;

  // Authorization before any data is read. A parent reaching another child's
  // URL gets the same 404 as a nonexistent id.
  const allowed = await ctx.canViewStudent(id);
  if (!allowed) notFound();

  const profile = await getStudentProfile(ctx.db, ctx.schoolId, id);
  if (!profile) notFound();

  const localeSettings = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const cal = localeSettings.calendarDisplay;
  const { student, currentEnrolment, enrolments, guardians, statusHistory } = profile;

  const canSeeSensitive = ctx.has('student.viewSensitive');

  return (
    <>
      <div className="mb-4">
        <Link href="/students" className="text-sm text-brand-600 hover:underline">
          ← Back to students
        </Link>
      </div>

      <div className="card mb-4 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-xl font-bold text-brand-700">
            {initials(student)}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">
              {personName(student, { full: true })}
            </h1>
            {student.givenNameAm && (
              <p lang="am" className="text-base text-ink-600">
                {personName(student, { locale: 'am', full: true })}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-600">
              <span className="font-mono text-xs">{student.studentCode}</span>
              <span aria-hidden>·</span>
              <Badge tone={student.status === 'active' ? 'good' : 'neutral'}>
                {student.status}
              </Badge>
              {currentEnrolment && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    {currentEnrolment.gradeName}
                    {currentEnrolment.sectionName ? ` ${currentEnrolment.sectionName}` : ''}
                  </span>
                </>
              )}
            </div>
          </div>
          {ctx.has('student.edit') && (
            <Link
              href={`/students/${id}/edit`}
              className="tap-target inline-flex items-center rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              Edit
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Student information">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label="Given name" value={student.givenName} />
              <Field label="Father's name" value={student.fatherName} />
              <Field label="Grandfather's name" value={student.grandfatherName} />
              <Field label="Gender" value={student.gender} />
              <Field
                label="Date of birth"
                value={formatSchoolDate(student.dateOfBirth, cal, ctx.locale)}
              />
              <Field
                label="Admission date"
                value={formatSchoolDate(student.admissionDate, cal, ctx.locale)}
              />
              <Field label="Phone" value={student.phone} />
              <Field label="Email" value={student.email} />
              <Field label="Sub-city" value={student.subCity} />
              <Field label="Woreda" value={student.woreda} />
              <Field label="Previous school" value={student.previousSchool} />
              <Field label="Address" value={student.address} />
            </dl>
          </Card>

          {canSeeSensitive && (student.medicalNotes || student.bloodGroup) && (
            <Card title="Medical information">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                <Field label="Blood group" value={student.bloodGroup} />
                <Field label="Notes" value={student.medicalNotes} />
              </dl>
              <p className="mt-3 text-xs text-ink-400">
                Visible only to staff with permission to view sensitive information.
              </p>
            </Card>
          )}

          <Card title="Enrolment history">
            {enrolments.length === 0 ? (
              <EmptyState title="No enrolment records" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {enrolments.map((enrolment) => (
                  <li key={enrolment.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-900">
                        {enrolment.gradeName}
                        {enrolment.sectionName ? ` ${enrolment.sectionName}` : ''}
                        <span className="ml-2 font-normal text-ink-500">{enrolment.yearName}</span>
                      </p>
                      <p className="text-xs text-ink-500">
                        {formatSchoolDate(enrolment.enrolledOn, cal, ctx.locale)}
                        {enrolment.endedOn
                          ? ` → ${formatSchoolDate(enrolment.endedOn, cal, ctx.locale)}`
                          : ' → present'}
                      </p>
                    </div>
                    <Badge tone={enrolment.endedOn ? 'neutral' : 'good'}>{enrolment.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Parents & guardians">
            {guardians.length === 0 ? (
              <EmptyState title="No guardian linked" description="Add a guardian to enable parent notifications." />
            ) : (
              <ul className="space-y-3">
                {guardians.map((guardian) => (
                  <li key={guardian.id} className="rounded-lg border border-ink-200 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink-900">
                          {[guardian.givenName, guardian.fatherName].filter(Boolean).join(' ')}
                        </p>
                        <p className="text-xs capitalize text-ink-500">{guardian.relationship}</p>
                      </div>
                      {guardian.isPrimary && <Badge tone="info">Primary</Badge>}
                    </div>
                    {guardian.phone && (
                      <a
                        href={`tel:${guardian.phone}`}
                        className="mt-2 inline-block text-sm text-brand-600 hover:underline"
                      >
                        {guardian.phone}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Emergency contact">
            {student.emergencyContactName ? (
              <dl className="space-y-2">
                <Field label="Name" value={student.emergencyContactName} />
                <Field label="Relationship" value={student.emergencyContactRelation} />
                <Field label="Phone" value={student.emergencyContactPhone} />
              </dl>
            ) : (
              <EmptyState title="Not recorded" />
            )}
          </Card>

          {statusHistory.length > 0 && (
            <Card title="Status history">
              <ul className="space-y-2.5">
                {statusHistory.map((entry) => (
                  <li key={entry.id} className="text-xs">
                    <p className="font-medium text-ink-800">
                      {entry.fromStatus ? `${entry.fromStatus} → ` : ''}
                      {entry.toStatus}
                    </p>
                    <p className="text-ink-500">
                      {formatSchoolDate(entry.effectiveDate, cal, ctx.locale)}
                      {entry.reason ? ` · ${entry.reason}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink-900">{value || '—'}</dd>
    </div>
  );
}
