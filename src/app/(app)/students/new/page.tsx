import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getStudentFilters } from '../../../../lib/students/service.ts';
import { academicYears, sections, gradeLevels } from '../../../../db/schema/core.ts';
import { PageHeader, Card, EmptyState, ActionAlert } from '../../../../components/ui.tsx';
import StudentForm from './StudentForm.tsx';

export const dynamic = 'force-dynamic';

export default async function NewStudentPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  // Server-side gate. The nav hides this link without the permission, but that
  // is presentation only — this is the check that actually matters.
  if (!ctx.has('student.create')) {
    return (
      <Card>
        <EmptyState
          title="You do not have permission to register students"
          description="Contact your administrator if you believe this is a mistake."
        />
      </Card>
    );
  }

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  if (!year) {
    return (
      <>
        <PageHeader title="Register student" />
        <ActionAlert
          tone="warn"
          title="No academic year is set up yet"
          detail="Create an academic year before registering students, so their enrolment can be recorded."
          href="/settings/academic"
          linkLabel="Set up academic year"
        />
      </>
    );
  }

  const filters = await getStudentFilters(ctx.db, ctx.schoolId, year.id);

  // The section dropdown filters by grade on the client, so it needs to know
  // which grade each section belongs to.
  const sectionRows = await ctx.db
    .select({
      id: sections.id,
      name: sections.name,
      gradeLevelId: sections.gradeLevelId,
      gradeName: gradeLevels.name,
      level: gradeLevels.level,
    })
    .from(sections)
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.academicYearId, year.id)))
    .orderBy(gradeLevels.level, sections.name);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="Register student"
        description="Enter the details once — they flow into attendance, grades, fees and report cards."
      />
      {filters.grades.length === 0 ? (
        <ActionAlert
          tone="warn"
          title="No grade levels defined"
          detail="Add the grades your school offers before registering students."
          href="/settings/academic"
          linkLabel="Add grade levels"
        />
      ) : (
        <StudentForm
          grades={filters.grades}
          sections={sectionRows}
          defaultAdmissionDate={today}
          canSeeSensitive={ctx.has('student.viewSensitive')}
        />
      )}
    </>
  );
}
