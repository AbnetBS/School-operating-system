import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import {
  getSchoolOverview,
  getEnrollmentByGrade,
  getSectionSummaries,
  getTeacherAssignments,
  getSectionsWithoutTeacher,
  getUnassignedSubjects,
} from '../../../lib/dashboard/queries.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { PageHeader, StatCard, Card, Badge, ActionAlert, EmptyState, BarRow } from '../../../components/ui.tsx';
import { formatDate, todayIso } from '../../../lib/calendar/ethiopian.ts';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const overview = await getSchoolOverview(ctx.db, ctx.schoolId);
  const localeSettings = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(localeSettings.timezone);

  // A teacher sees their own classes; management sees the whole school.
  const isTeacherView =
    ctx.has('attendance.take') && !ctx.hasAny('academic.manage', 'student.create');

  if (!overview.currentYearId) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ActionAlert
          tone="warn"
          title="No academic year is set up yet"
          detail="Create an academic year to start using attendance, the gradebook and reports."
          href="/academics"
          linkLabel="Set up now"
        />
      </>
    );
  }

  if (isTeacherView) {
    return <TeacherDashboard ctx={ctx} yearId={overview.currentYearId} today={today} />;
  }

  const [byGrade, sections, missingTeachers, unassigned] = await Promise.all([
    getEnrollmentByGrade(ctx.db, ctx.schoolId, overview.currentYearId),
    getSectionSummaries(ctx.db, ctx.schoolId, overview.currentYearId, { limit: 12 }),
    getSectionsWithoutTeacher(ctx.db, ctx.schoolId, overview.currentYearId),
    getUnassignedSubjects(ctx.db, ctx.schoolId, overview.currentYearId),
  ]);

  const maxGrade = Math.max(1, ...byGrade.map((g) => g.studentCount));

  return (
    <>
      <PageHeader
        title={`Good day, ${ctx.user.givenName}`}
        description={`${formatDate(today, { calendar: 'both', locale: ctx.locale })} · ${overview.currentYearName}`}
      />

      {/* Action-oriented alerts: things that need a human decision. */}
      <div className="mb-6 space-y-2">
        {missingTeachers.length > 0 && (
          <ActionAlert
            tone="warn"
            title={`${missingTeachers.length} section${missingTeachers.length === 1 ? '' : 's'} without a class teacher`}
            detail={missingTeachers
              .slice(0, 4)
              .map((s) => `${s.gradeName} ${s.name}`)
              .join(', ')}
            href="/academics"
            linkLabel="Assign"
          />
        )}
        {unassigned.count > 0 && (
          <ActionAlert
            tone="warn"
            title={`${unassigned.count} subject assignment${unassigned.count === 1 ? '' : 's'} have no teacher`}
            detail="Attendance and marks cannot be recorded for these until a teacher is assigned."
            href="/academics"
            linkLabel="Fix"
          />
        )}
        {missingTeachers.length === 0 && unassigned.count === 0 && (
          <ActionAlert
            tone="info"
            title="Setup is complete"
            detail="Every section has a class teacher and every subject has a teacher assigned."
          />
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Students" value={overview.activeStudents} sub="Active" href="/students" />
        <StatCard
          label="Girls / Boys"
          value={`${overview.femaleStudents}/${overview.maleStudents}`}
          sub="Active students"
        />
        <StatCard label="Teachers" value={overview.teachers} href="/staff" />
        <StatCard label="Sections" value={overview.sections} href="/academics" />
        <StatCard label="Subjects" value={overview.subjects} href="/academics" />
        <StatCard label="Guardians" value={overview.guardianCount} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Enrolment by grade">
          {byGrade.length === 0 ? (
            <EmptyState title="No grade levels yet" />
          ) : (
            <div className="space-y-0.5">
              {byGrade.map((grade) => (
                <BarRow
                  key={grade.gradeLevelId}
                  label={grade.gradeName}
                  value={grade.studentCount}
                  max={maxGrade}
                  hint={`${grade.studentCount}`}
                />
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Sections"
          action={
            <Link href="/academics" className="text-xs font-medium text-brand-600 hover:underline">
              View all
            </Link>
          }
        >
          {sections.length === 0 ? (
            <EmptyState title="No sections yet" />
          ) : (
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">Class</th>
                    <th className="px-4 py-2 font-medium">Class teacher</th>
                    <th className="px-4 py-2 text-right font-medium">Students</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((section) => (
                    <tr key={section.sectionId} className="border-b border-ink-100 last:border-0">
                      <td className="px-4 py-2.5 font-medium text-ink-900">
                        {section.gradeName} {section.sectionName}
                      </td>
                      <td className="px-4 py-2.5 text-ink-600">
                        {section.classTeacherName ?? (
                          <Badge tone="warn">Not assigned</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-700">
                        {section.studentCount}
                        {section.capacity ? (
                          <span className="text-ink-400"> / {section.capacity}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/** A teacher's home screen: their classes, ready to act on. */
async function TeacherDashboard({
  ctx,
  yearId,
  today,
}: {
  ctx: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;
  yearId: string;
  today: string;
}) {
  const assignments = await getTeacherAssignments(ctx.db, ctx.schoolId, ctx.user.userId, yearId);

  const totalStudents = assignments.reduce((sum, a) => sum + a.studentCount, 0);
  const uniqueSections = new Set(assignments.map((a) => a.sectionId)).size;

  return (
    <>
      <PageHeader
        title={`Good day, ${ctx.user.givenName}`}
        description={formatDate(today, { calendar: 'both', locale: ctx.locale })}
      />

      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatCard label="My classes" value={uniqueSections} />
        <StatCard label="Subjects" value={assignments.length} />
        <StatCard label="Students" value={totalStudents} />
      </div>

      <Card title="My classes">
        {assignments.length === 0 ? (
          <EmptyState
            title="No classes assigned yet"
            description="Once an administrator assigns you to a class and subject, it will appear here."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {assignments.map((assignment) => (
              <li key={assignment.sectionSubjectId}>
                <Link
                  href={`/attendance?section=${assignment.sectionId}&subject=${assignment.subjectId}`}
                  className="-mx-4 flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {assignment.gradeName} {assignment.sectionName} · {assignment.subjectName}
                    </p>
                    <p className="text-xs text-ink-500">{assignment.studentCount} students</p>
                  </div>
                  <span className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white">
                    Take attendance
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
