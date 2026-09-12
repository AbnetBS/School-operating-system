/**
 * Transport — routes, their buses, and how full they are.
 *
 * Capacity is shown against every route because "can another child join this
 * bus?" is the question the office is asked, and answering it wrongly means a
 * child left standing at a stop. Assigning a child happens on the route's own
 * page, where the stops are visible.
 */

import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { listRoutes, listVehicles } from '../../../lib/operations/facilities.ts';
import {
  ROUTE_DIRECTIONS,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
} from '../../../lib/operations/schema.ts';
import { users } from '../../../db/schema/core.ts';
import { staff } from '../../../db/schema/people.ts';
import { PageHeader, Card, StatCard, EmptyState } from '../../../components/ui.tsx';
import { RouteManager, VehicleManager } from './TransportManager.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.save',
  'action.cancel',
  'action.edit',
  'ops.saving',
  'ops.loading',
  'finance.status',
  'asset.note',
  'asset.unassigned',
  'library.inactive',
  'transport.routes',
  'transport.route',
  'transport.newRoute',
  'transport.routeSaved',
  'transport.routeCode',
  'transport.direction',
  'transport.direction.morning',
  'transport.direction.afternoon',
  'transport.direction.both',
  'transport.monthlyFee',
  'transport.active',
  'transport.manageRoute',
  'transport.noRoutes',
  'transport.stops',
  'transport.riders',
  'transport.seatsLeft',
  'transport.full',
  'transport.vehicles',
  'transport.vehicle',
  'transport.newVehicle',
  'transport.vehicleSaved',
  'transport.noVehicle',
  'transport.noVehicles',
  'transport.plateNumber',
  'transport.capacity',
  'transport.driver',
  'transport.assistant',
  'transport.insuranceUntil',
  'transport.inspectionUntil',
  'transport.vehicleType',
  'transport.vehicleType.bus',
  'transport.vehicleType.minibus',
  'transport.vehicleType.van',
  'transport.vehicleType.car',
  'transport.vehicleType.other',
  'transport.status.active',
  'transport.status.maintenance',
  'transport.status.retired',
];

export default async function TransportPage() {
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

  const canManage = ctx.has('transport.manage');

  const [routes, vehicles] = await Promise.all([
    // A manager needs to see a route they switched off in order to switch it
    // back on; a viewer sees only what is running.
    listRoutes(ctx, canManage),
    listVehicles(ctx, canManage),
  ]);

  const staffRows = canManage
    ? await ctx.db
        .select({ id: staff.id, givenName: users.givenName, fatherName: users.fatherName })
        .from(staff)
        .innerJoin(users, eq(users.id, staff.userId))
        .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.status, 'active')))
        .orderBy(asc(users.givenName))
    : [];

  const staffOptions = staffRows.map((row) => ({
    id: row.id,
    name: [row.givenName, row.fatherName].filter(Boolean).join(' '),
  }));

  const totalRiders = routes.reduce((sum, r) => sum + Number(r.riderCount ?? 0), 0);
  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader title={t('transport.title')} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label={t('transport.routes')} value={routes.length} />
        <StatCard label={t('transport.vehicles')} value={vehicles.length} />
        <StatCard label={t('transport.riders')} value={totalRiders} />
      </div>

      <RouteManager
        labels={labels}
        routes={routes.map((r) => ({
          ...r,
          riderCount: Number(r.riderCount ?? 0),
          stopCount: Number(r.stopCount ?? 0),
        }))}
        vehicles={vehicles.map((v) => ({ id: v.id, plateNumber: v.plateNumber }))}
        directions={[...ROUTE_DIRECTIONS]}
        canManage={canManage}
      />

      <VehicleManager
        labels={labels}
        vehicles={vehicles.map((v) => ({ ...v, routeCount: Number(v.routeCount ?? 0) }))}
        types={[...VEHICLE_TYPES]}
        statuses={[...VEHICLE_STATUSES]}
        staff={staffOptions}
        canManage={canManage}
      />
    </>
  );
}
