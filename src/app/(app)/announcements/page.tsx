import { redirect } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import {
  listVisibleAnnouncements,
  listManageableAnnouncements,
} from '../../../lib/comms/announcements.ts';
import { sections, gradeLevels } from '../../../db/schema/core.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';
import AnnouncementBoard from './AnnouncementBoard.tsx';

export const dynamic = 'force-dynamic';

export default async function AnnouncementsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.announcements) {
    return (
      <Card>
        <EmptyState
          title="Announcements are switched off for this school"
          description="An administrator can enable them in Settings."
        />
      </Card>
    );
  }

  if (!ctx.has('announcement.view')) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to announcements"
          description="Ask an administrator if you believe this is wrong."
        />
      </Card>
    );
  }

  const canCreate = ctx.has('announcement.create');
  const schoolWide = ctx.hasAny('school.manage', 'announcement.publishSchoolWide');

  const [visible, manageable] = await Promise.all([
    listVisibleAnnouncements(ctx, { limit: 50 }),
    canCreate ? listManageableAnnouncements(ctx, { limit: 50 }) : Promise.resolve([]),
  ]);

  // A teacher may only target their own classes, so the picker offers exactly
  // those; an administrator gets every class. The server re-checks either way.
  let sectionOptions: { id: string; name: string }[] = [];
  let gradeOptions: { id: string; name: string }[] = [];

  if (canCreate) {
    if (schoolWide) {
      sectionOptions = await ctx.db
        .select({ id: sections.id, name: sections.name })
        .from(sections)
        .where(eq(sections.schoolId, ctx.schoolId))
        .orderBy(sections.name);
      gradeOptions = await ctx.db
        .select({ id: gradeLevels.id, name: gradeLevels.name })
        .from(gradeLevels)
        .where(eq(gradeLevels.schoolId, ctx.schoolId))
        .orderBy(gradeLevels.level);
    } else if (ctx.relationships.sectionIds.length > 0) {
      sectionOptions = await ctx.db
        .select({ id: sections.id, name: sections.name })
        .from(sections)
        .where(
          and(
            eq(sections.schoolId, ctx.schoolId),
            inArray(sections.id, ctx.relationships.sectionIds),
          ),
        )
        .orderBy(sections.name);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Announcements"
        description="Notices from the school. Pinned items stay at the top."
      />

      <AnnouncementBoard
        visible={visible.map(serialise)}
        manageable={manageable.map(serialise)}
        canCreate={canCreate}
        schoolWide={schoolWide}
        sectionOptions={sectionOptions}
        gradeOptions={gradeOptions}
        locale={ctx.locale}
      />
    </div>
  );
}

/** Dates cannot cross the server/client boundary as Date objects. */
function serialise(a: {
  id: string;
  title: string;
  titleAm: string | null;
  body: string;
  bodyAm: string | null;
  audience: string;
  isPinned: boolean;
  isPublished: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  authorName: string | null;
  isRead: boolean;
}) {
  return {
    id: a.id,
    title: a.title,
    titleAm: a.titleAm,
    body: a.body,
    bodyAm: a.bodyAm,
    audience: a.audience,
    isPinned: a.isPinned,
    isPublished: a.isPublished,
    publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    authorName: a.authorName,
    isRead: a.isRead,
  };
}
