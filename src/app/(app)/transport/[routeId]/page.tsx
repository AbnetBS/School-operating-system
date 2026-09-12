/**
 * One route: stops and riders.
 *
 * `getRouteOwned` throws a 404 for a route id belonging to another school, so
 * a guessed id in the URL yields the same "not found" as a nonexistent one.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { getSetting } from '../../../../lib/settings/service.ts';
import { createTranslator } from '../../../../lib/i18n/index.ts';
import { todayIso } from '../../../../lib/calendar/ethiopian.ts';
import { money } from '../../../../lib/finance/format.ts';
import {
  getRouteOwned,
  listStops,
  listRiders,
  listVehicles,
} from '../../../../lib/operations/facilities.ts';
import { isDomainError } from '../../../../lib/api/domain-error.ts';
import { PageHeader, Card, StatCard, EmptyState } from '../../../../components/ui.tsx';
import RouteDetail from './RouteDetail.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.save',
  'action.cancel',
  'ops.saving',
  'ops.loading',
  'ops.none',
  'ops.change',
  'ops.searchStudent',
  'asset.note',
  'academics.students',
  'transport.stops',
  'transport.addStop',
  'transport.stopName',
  'transport.stopSaved',
  'transport.sortOrder',
  'transport.landmark',
  'transport.pickupTime',
  'transport.dropoffTime',
  'transport.pickupStop',
  'transport.dropoffStop',
  'transport.noStops',
  'transport.riderList',
  'transport.noRiders',
  'transport.assignStudent',
  'transport.assigned',
  'transport.startDate',
  'transport.endAssignment',
  'transport.confirmEnd',
  'transport.full',
];

export default async function RoutePage({
  params,
}: {
  params: Promise<{ routeId: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.transport) {
    return (
      <Card>
        <EmptyState title={t('transport.disabled')} />
      </Card>
    );
  }
  if (!ctx.has('transport.view')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const { routeId } = await params;

  // The service 404s on another school's id. Convert that into Next's own
  // not-found rather than letting a domain error become a 500 in a page.
  let route;
  try {
    route = await getRouteOwned(ctx, routeId);
  } catch (error) {
    if (isDomainError(error) && error.status === 404) notFound();
    throw error;
  }

  const canManage = ctx.has('transport.manage');
  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);

  const [stops, riders, vehicles] = await Promise.all([
    listStops(ctx, routeId),
    listRiders(ctx, { routeId, limit: 100 }),
    listVehicles(ctx, true),
  ]);

  const vehicle = route.vehicleId ? vehicles.find((v) => v.id === route.vehicleId) : undefined;
  const capacity = vehicle?.capacity ?? 0;
  const seatsLeft = capacity > 0 ? capacity - riders.total : null;

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader
        title={route.name}
        description={[
          route.code,
          vehicle?.plateNumber,
          t(`transport.direction.${route.direction}`),
          route.monthlyFeeCents !== null ? money(route.monthlyFeeCents) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        action={
          <Link
            href="/transport"
            className="tap-target rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {t('action.back')}
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label={t('transport.stops')} value={stops.length} />
        <StatCard label={t('transport.riders')} value={riders.total} />
        <StatCard
          label={t('transport.capacity')}
          value={capacity > 0 ? capacity : '—'}
          tone={seatsLeft !== null && seatsLeft <= 0 ? 'bad' : 'default'}
          sub={
            seatsLeft !== null
              ? t('transport.seatsLeft', { count: String(Math.max(0, seatsLeft)) })
              : undefined
          }
        />
      </div>

      <RouteDetail
        labels={labels}
        routeId={routeId}
        routeName={route.name}
        stops={stops.map((s) => ({
          id: s.id,
          name: s.name,
          sortOrder: s.sortOrder,
          pickupTime: s.pickupTime,
          dropoffTime: s.dropoffTime,
          landmark: s.landmark,
        }))}
        riders={riders.riders}
        seatsLeft={seatsLeft}
        today={today}
        canManage={canManage}
      />
    </>
  );
}
