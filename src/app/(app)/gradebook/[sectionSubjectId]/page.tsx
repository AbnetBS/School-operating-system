import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, eq, asc } from 'drizzle-orm';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import {
  listAssessments,
  checkGradebookAccess,
  getClassRoster,
} from '../../../../lib/gradebook/service.ts';
import { terms, sectionSubjects, sections, subjects, gradeLevels } from '../../../../db/schema/core.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { PageHeader, Card, Badge, EmptyState } from '../../../../components/ui.tsx';
import ClassGradebook from './ClassGradebook.tsx';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  draft: 'neutral',
  submitted: 'warn',
  approved: 'info',
  locked: 'good',
};

export default async function ClassGradebookPage({
  params,
  searchParams,
}: {
  params: Promise<{ sectionSubjectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.gradebook) notFound();

  const { sectionSubjectId } = await params;
  const query = await searchParams;

  // The same relationship check the API uses. A class the user may not open
  // is reported as missing rather than forbidden.
  const access = await checkGradebookAccess(ctx, sectionSubjectId, 'view');
  if (!access.allowed) {
    if (access.status === 404) notFound();
    return (
      <Card>
        <EmptyState
          title="You are not assigned to this class"
          description="Only the class teacher and school staff can open this gradebook."
        />
      </Card>
    );
  }

  const termList = await ctx.db
    .select({ id: terms.id, name: terms.name, isCurrent: terms.isCurrent })
    .from(terms)
    .where(eq(terms.schoolId, ctx.schoolId))
    .orderBy(asc(terms.sequence));

  const requestedTerm = typeof query.termId === 'string' ? query.termId : undefined;
  const term =
    termList.find((t) => t.id === requestedTerm) ?? termList.find((t) => t.isCurrent) ?? termList[0];

  if (!term) {
    return (
      <Card>
        <EmptyState
          title="No terms are set up"
          description="An administrator must create the academic year and its terms first."
        />
      </Card>
    );
  }

  const [info] = await ctx.db
    .select({
      subjectName: subjects.name,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
    })
    .from(sectionSubjects)
    .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
    .innerJoin(sections, eq(sections.id, sectionSubjects.sectionId))
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(
      and(eq(sectionSubjects.id, sectionSubjectId), eq(sectionSubjects.schoolId, ctx.schoolId)),
    )
    .limit(1);

  if (!info) notFound();

  const { assessments: rows, config } = await listAssessments(ctx, sectionSubjectId, term.id);
  const roster = await getClassRoster(ctx, sectionSubjectId);
  const entryAccess = await checkGradebookAccess(ctx, sectionSubjectId, 'enter');

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${info.subjectName} — ${info.gradeName} ${info.sectionName}`}
        description={`${roster.length} students · ${config.configName ?? 'School default'} weighting`}
        action={
          <Link href="/gradebook" className="text-sm font-medium text-brand-700 hover:underline">
            All classes
          </Link>
        }
      />

      {/* Terms are configurable per school, so they are listed rather than assumed. */}
      {termList.length > 1 && (
        <nav className="flex flex-wrap gap-2" aria-label="Term">
          {termList.map((t) => (
            <Link
              key={t.id}
              href={`/gradebook/${sectionSubjectId}?termId=${t.id}`}
              className={`tap-target rounded-full px-3 py-1.5 text-sm font-medium ${
                t.id === term.id
                  ? 'bg-brand-600 text-white'
                  : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
              }`}
            >
              {t.name}
            </Link>
          ))}
        </nav>
      )}

      <Card title="Assessment structure">
        <ul className="flex flex-wrap gap-2 text-xs">
          {config.components.map((c) => (
            <li key={c.key} className="rounded-full bg-ink-100 px-3 py-1 text-ink-700">
              {c.name} · {c.weightPercent}%
              {c.instances > 1 ? ` · ${c.instances} each` : ''}
              {c.dropLowest > 0 ? ` · drop ${c.dropLowest}` : ''}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-500">
          Pass mark {config.passMarkPercent}%. This structure comes from the school&rsquo;s
          configuration, so changing it there changes every mark sheet.
        </p>
      </Card>

      <ClassGradebook
        sectionSubjectId={sectionSubjectId}
        termId={term.id}
        components={config.components.map((c) => ({
          key: c.key,
          name: c.name,
          instances: c.instances,
          maxMark: c.maxMark,
        }))}
        initialAssessments={rows}
        canEnter={entryAccess.allowed}
        canReview={ctx.has('grade.review')}
        canLock={ctx.has('grade.lock')}
        canOverride={ctx.has('grade.overrideLocked')}
        statusTone={STATUS_TONE}
      />
    </div>
  );
}
