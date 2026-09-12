import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getRoster, checkAttendancePermission } from '../../../../lib/attendance/service.ts';
import { academicYears, sections, gradeLevels, users } from '../../../../db/schema/core.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { todayIso, formatDate } from '../../../../lib/calendar/ethiopian.ts';
import { PageHeader, Card, EmptyState, ActionAlert } from '../../../../components/ui.tsx';
import RegisterForm from './RegisterForm.tsx';

export const dynamic = 'force-dynamic';

export default async function TakeAttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ sectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.attendance) notFound();

  const { sectionId } = await params;
  const raw = await searchParams;
  const dateParam = Array.isArray(raw.date) ? raw.date[0] : raw.date;

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!year) notFound();

  // Scoped to this school, so another school's section id is simply not found.
  const [section] = await ctx.db
    .select({
      id: sections.id,
      name: sections.name,
      gradeName: gradeLevels.name,
      classTeacherId: sections.classTeacherId,
    })
    .from(sections)
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(
      and(
        eq(sections.schoolId, ctx.schoolId),
        eq(sections.id, sectionId),
        eq(sections.academicYearId, year.id),
      ),
    )
    .limit(1);
  if (!section) notFound();

  const [localeSettings, attendanceSettings] = await Promise.all([
    getSetting(ctx.db, ctx.schoolId, 'locale'),
    getSetting(ctx.db, ctx.schoolId, 'attendance'),
  ]);

  const today = todayIso(localeSettings.timezone);
  const date = dateParam ?? today;

  // Viewing a named class's roster requires a relationship to that class.
  //
  // `attendance.report` deliberately does NOT grant this: it covers aggregate
  // statistics, not the individual pupils of an arbitrary class. A user who is
  // restricted to their own sections stays restricted here, otherwise the
  // roster would be a way around `restrict.ownSectionsOnly`.
  const restricted = ctx.has('restrict.ownSectionsOnly');
  const canSeeAnyClass = ctx.has('attendance.editAny') && !restricted;
  if (!canSeeAnyClass && !ctx.relationships.sectionIds.includes(sectionId)) {
    notFound();
  }

  const roster = await getRoster(ctx.db, ctx.schoolId, {
    sectionId,
    sectionSubjectId: null,
    date,
    academicYearId: year.id,
  });

  // Ask the same function the API uses, so the UI and the server agree on
  // exactly why a register may not be edited.
  const permission = await checkAttendancePermission(ctx, { sectionId, date });
  const readOnly = !permission.allowed;

  const label = `${section.gradeName} ${section.name}`;

  let takenByName: string | null = null;
  if (roster.session?.takenBy) {
    const [taker] = await ctx.db
      .select({ givenName: users.givenName, fatherName: users.fatherName })
      .from(users)
      .where(eq(users.id, roster.session.takenBy))
      .limit(1);
    takenByName = taker ? `${taker.givenName} ${taker.fatherName ?? ''}`.trim() : null;
  }

  return (
    <>
      <div className="mb-3">
        <Link href={`/attendance?date=${date}`} className="text-sm text-brand-600 hover:underline">
          ← All classes
        </Link>
      </div>

      <PageHeader
        title={label}
        description={formatDate(date, {
          calendar: localeSettings.calendarDisplay,
          locale: ctx.locale,
        })}
      />

      {roster.isHoliday && (
        <div className="mb-3">
          <ActionAlert
            tone="info"
            title={`${roster.isHoliday.name} — school closed`}
            detail="Attendance is not normally recorded on this day."
          />
        </div>
      )}

      {roster.session && takenByName && (
        <p className="mb-3 text-xs text-ink-500">
          Taken by {takenByName}
          {roster.session.syncedOffline ? ' (synced from offline)' : ''}
        </p>
      )}

      {roster.students.length === 0 ? (
        <Card>
          <EmptyState
            title="No students enrolled in this class"
            description="Enrol students into this section before taking attendance."
          />
        </Card>
      ) : (
        <RegisterForm
          sectionId={sectionId}
          sectionLabel={label}
          date={date}
          students={roster.students}
          statuses={attendanceSettings.statuses}
          defaultStatus={attendanceSettings.defaultStatus}
          requireAbsenceReason={attendanceSettings.requireAbsenceReason}
          riskThreshold={attendanceSettings.riskThresholdPercent}
          alreadyTaken={roster.session !== null}
          readOnly={readOnly}
          readOnlyReason={permission.allowed ? undefined : permission.reason}
        />
      )}
    </>
  );
}
