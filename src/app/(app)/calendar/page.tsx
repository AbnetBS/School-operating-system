/**
 * School calendar.
 *
 * Shows what is coming, with a plain marker for anything not published to
 * families — a member of staff must be able to tell at a glance whether
 * parents can see an entry. Past events are one click away, because "when was
 * the last parents' evening?" is a question people actually ask.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { listEvents } from '../../../lib/operations/calendar.ts';
import { EVENT_TYPES } from '../../../lib/operations/schema.ts';
import { formatDate, todayIso } from '../../../lib/calendar/ethiopian.ts';
import { roles as rolesTable, sections, gradeLevels } from '../../../db/schema/core.ts';
import { PageHeader, Card, EmptyState, Badge } from '../../../components/ui.tsx';
import EventManager from './EventManager.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.save',
  'action.cancel',
  'action.edit',
  'action.delete',
  'ops.saving',
  'ops.loading',
  'calendar.event',
  'calendar.newEvent',
  'calendar.editEvent',
  'calendar.eventSaved',
  'calendar.eventDeleted',
  'calendar.confirmDelete',
  'calendar.upcoming',
  'calendar.past',
  'calendar.noEvents',
  'calendar.noPast',
  'calendar.allDay',
  'calendar.startDate',
  'calendar.endDate',
  'calendar.startTime',
  'calendar.endTime',
  'calendar.location',
  'calendar.description',
  'calendar.eventTypeLabel',
  'calendar.audience',
  'calendar.audienceHelp',
  'calendar.audience.all',
  'calendar.audience.roles',
  'calendar.audience.sections',
  'calendar.audience.grades',
  'calendar.chooseRoles',
  'calendar.chooseSections',
  'calendar.chooseGrades',
  'calendar.showInPortal',
  'calendar.portalHelp',
  'calendar.internalOnly',
  'calendar.eventType.exam',
  'calendar.eventType.holiday',
  'calendar.eventType.meeting',
  'calendar.eventType.activity',
  'calendar.eventType.sport',
  'calendar.eventType.ceremony',
  'calendar.eventType.other',
];

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  if (!ctx.has('event.view')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const params = await searchParams;
  const showPast = params.view === 'past';

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);

  const shift = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  const events = showPast
    ? await listEvents(ctx, { from: shift(-365), to: shift(-1) })
    : await listEvents(ctx, { from: today, to: shift(120) });

  const canManage = ctx.has('event.manage');

  // Audience options come from this school only — there is no field in which
  // an id from elsewhere could be typed.
  const [roleRows, sectionRows, gradeRows] = canManage
    ? await Promise.all([
        ctx.db
          .select({ key: rolesTable.key, name: rolesTable.name, nameAm: rolesTable.nameAm })
          .from(rolesTable)
          .where(eq(rolesTable.schoolId, ctx.schoolId))
          .orderBy(asc(rolesTable.name)),
        ctx.db
          .select({ id: sections.id, name: sections.name, gradeName: gradeLevels.name })
          .from(sections)
          .leftJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
          .where(eq(sections.schoolId, ctx.schoolId))
          .orderBy(asc(gradeLevels.level), asc(sections.name)),
        ctx.db
          .select({ id: gradeLevels.id, name: gradeLevels.name, nameAm: gradeLevels.nameAm })
          .from(gradeLevels)
          .where(eq(gradeLevels.schoolId, ctx.schoolId))
          .orderBy(asc(gradeLevels.level)),
      ])
    : [[], [], []];

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader
        title={t('calendar.title')}
        description={showPast ? t('calendar.past') : t('calendar.upcoming')}
        action={
          <Link
            href={showPast ? '/calendar' : '/calendar?view=past'}
            className="tap-target rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {showPast ? t('calendar.upcoming') : t('calendar.past')}
          </Link>
        }
      />

      {canManage ? (
        <EventManager
          labels={labels}
          events={events.map((event) => ({
            id: event.id,
            title: event.title,
            description: event.description,
            eventType: event.eventType,
            startDate: event.startDate,
            endDate: event.endDate,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            location: event.location,
            audience: event.audience as never,
            visibleToPortal: event.visibleToPortal,
          }))}
          eventTypes={[...EVENT_TYPES]}
          roles={roleRows.map((r) => ({
            id: r.key,
            name: ctx.locale === 'am' && r.nameAm ? r.nameAm : r.name,
          }))}
          sections={sectionRows.map((s) => ({
            id: s.id,
            name: `${s.gradeName ?? ''} ${s.name}`.trim(),
          }))}
          grades={gradeRows.map((g) => ({
            id: g.id,
            name: ctx.locale === 'am' && g.nameAm ? g.nameAm : g.name,
          }))}
          today={today}
          canManage={canManage}
          showPast={showPast}
        />
      ) : (
        // Read-only view for someone with event.view but not event.manage.
        <Card>
          {events.length === 0 ? (
            <EmptyState title={showPast ? t('calendar.noPast') : t('calendar.noEvents')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {events.map((event) => (
                <li key={event.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-ink-900">{event.title}</p>
                      <p className="text-sm text-ink-600">
                        {formatDate(event.startDate, {
                          calendar: locale.calendarDisplay,
                          locale: ctx.locale,
                        })}
                        {event.endDate && event.endDate !== event.startDate && (
                          <>
                            {' — '}
                            {formatDate(event.endDate, {
                              calendar: locale.calendarDisplay,
                              locale: ctx.locale,
                            })}
                          </>
                        )}
                        {!event.allDay && event.startTime && ` · ${event.startTime}`}
                      </p>
                      {event.location && <p className="text-xs text-ink-500">{event.location}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{t(`calendar.eventType.${event.eventType}`)}</Badge>
                      {event.visibleToPortal ? (
                        <Badge tone="good">{t('calendar.showInPortal')}</Badge>
                      ) : (
                        <Badge tone="neutral">{t('calendar.internalOnly')}</Badge>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
