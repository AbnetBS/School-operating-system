import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, asc } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSectionReportCardStatus } from '../../../lib/gradebook/reportCards.ts';
import { terms, sections, gradeLevels } from '../../../db/schema/core.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';
import SectionReportCards from './SectionReportCards.tsx';

export const dynamic = 'force-dynamic';

export default async function ReportCardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.reportCards) {
    return (
      <Card>
        <EmptyState
          title="Report cards are switched off for this school"
          description="An administrator can enable them in Settings."
        />
      </Card>
    );
  }

  if (!ctx.hasAny('reportCard.view', 'reportCard.generate')) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to report cards"
          description="Ask an administrator if you believe this is wrong."
        />
      </Card>
    );
  }

  const query = await searchParams;

  const termList = await ctx.db
    .select({ id: terms.id, name: terms.name, isCurrent: terms.isCurrent })
    .from(terms)
    .where(eq(terms.schoolId, ctx.schoolId))
    .orderBy(asc(terms.sequence));

  const term =
    termList.find((t) => t.id === query.termId) ?? termList.find((t) => t.isCurrent) ?? termList[0];

  // A class teacher sees their own classes; office staff see all of them.
  const canSeeAll = ctx.hasAny('reportCard.generate', 'reportCard.publish', 'grade.review');
  const allSections = await ctx.db
    .select({
      id: sections.id,
      name: sections.name,
      gradeName: gradeLevels.name,
      level: gradeLevels.level,
    })
    .from(sections)
    .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.isActive, true)))
    .orderBy(asc(gradeLevels.level), asc(sections.name));

  const sectionList = canSeeAll
    ? allSections
    : allSections.filter((s) => ctx.relationships.sectionIds.includes(s.id));

  const selected =
    sectionList.find((s) => s.id === query.sectionId) ?? sectionList[0];

  if (!term || sectionList.length === 0 || !selected) {
    return (
      <div className="space-y-6">
        <PageHeader title="Report cards" />
        <Card>
          <EmptyState
            title={!term ? 'No terms are set up' : 'No classes available'}
            description={
              !term
                ? 'An administrator must create the academic year and its terms first.'
                : 'You are not assigned as a class teacher for any class.'
            }
          />
        </Card>
      </div>
    );
  }

  const rows = await getSectionReportCardStatus(ctx, term.id, selected.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Report cards"
        description={`${selected.gradeName} ${selected.name} · ${term.name}`}
      />

      {termList.length > 1 && (
        <nav className="flex flex-wrap gap-2" aria-label="Term">
          {termList.map((t) => (
            <Link
              key={t.id}
              href={`/report-cards?termId=${t.id}&sectionId=${selected.id}`}
              className={`tap-target rounded-full px-3 py-1.5 text-sm font-medium ${
                t.id === term.id ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700'
              }`}
            >
              {t.name}
            </Link>
          ))}
        </nav>
      )}

      <nav className="flex flex-wrap gap-2" aria-label="Class">
        {sectionList.map((s) => (
          <Link
            key={s.id}
            href={`/report-cards?termId=${term.id}&sectionId=${s.id}`}
            className={`tap-target rounded-full px-3 py-1.5 text-sm font-medium ${
              s.id === selected.id ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'
            }`}
          >
            {s.gradeName} {s.name}
          </Link>
        ))}
      </nav>

      <SectionReportCards
        termId={term.id}
        sectionId={selected.id}
        initialRows={rows}
        canGenerate={ctx.has('reportCard.generate')}
        canApprove={ctx.has('reportCard.approve')}
        canPublish={ctx.has('reportCard.publish')}
      />
    </div>
  );
}
