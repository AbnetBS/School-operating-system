/**
 * Assets, maintenance and transport.
 *
 * ASSETS AND MAINTENANCE ARE SEPARATE ON PURPOSE. The commonest real report is
 * "the tap in the Grade 3 corridor is broken" — about a thing nobody has
 * tagged. Requiring an asset row would mean the report is never filed, which
 * is worse than an untidy register. So `maintenance_issues.asset_id` is
 * nullable and a free-text location stands in.
 *
 * TRANSPORT IS AN ASSIGNMENT REGISTER, NOT A TRACKER. Routes, stops, vehicles
 * and who rides which bus. Live GPS is deferred to Group 10; nothing here
 * pretends to know where a vehicle is.
 *
 * A pupil's transport subscription is scoped to an academic year because a
 * family's arrangement changes yearly and last year's must stay readable. One
 * active subscription per pupil per year is enforced by a partial unique index,
 * so a double-submitted form cannot put a child on two buses.
 */

import { and, asc, desc, eq, ilike, or, sql, count, inArray, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import {
  assets,
  maintenanceIssues,
  vehicles,
  transportRoutes,
  routeStops,
  studentTransport,
} from '../../db/schema/operations.ts';
import { students, staff } from '../../db/schema/people.ts';
import { users, sections, gradeLevels, academicYears } from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { OperationsError, notFoundError } from './errors.ts';
import type {
  AssetInput,
  MaintenanceIssueInput,
  UpdateMaintenanceInput,
  VehicleInput,
  TransportRouteInput,
  RouteStopInput,
  AssignTransportInput,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type AssetRow = {
  id: string;
  name: string;
  assetTag: string | null;
  category: string | null;
  serialNumber: string | null;
  status: string;
  condition: string;
  location: string | null;
  /** Raw ids, so an edit form can pre-select without a second query. */
  sectionId: string | null;
  assignedStaffId: string | null;
  sectionName: string | null;
  assignedTo: string | null;
  purchasedOn: string | null;
  purchaseCostCents: number | null;
  openIssues: number;
};

const openIssueCountExpr = sql<number>`(
  select count(*)::int from ${maintenanceIssues} mi
  where mi.asset_id = ${assets}.${sql.identifier('id')}
    and mi.status in ('open','in_progress')
)`;

export async function listAssets(
  ctx: AuthContext,
  query: {
    q?: string | null;
    status?: string | null;
    category?: string | null;
    sectionId?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ assets: AssetRow[]; total: number }> {
  const conditions: SQL[] = [eq(assets.schoolId, ctx.schoolId)];
  if (query.status) conditions.push(eq(assets.status, query.status));
  if (query.category) conditions.push(eq(assets.category, query.category));
  if (query.sectionId) conditions.push(eq(assets.sectionId, query.sectionId));
  if (query.q) {
    const needle = `%${query.q}%`;
    const match = or(
      ilike(assets.name, needle),
      ilike(assets.assetTag, needle),
      ilike(assets.serialNumber, needle),
      ilike(assets.location, needle),
    );
    if (match) conditions.push(match);
  }
  const where = and(...conditions) as SQL;

  const rows = await ctx.db
    .select({
      id: assets.id,
      name: assets.name,
      assetTag: assets.assetTag,
      category: assets.category,
      serialNumber: assets.serialNumber,
      status: assets.status,
      condition: assets.condition,
      location: assets.location,
      sectionId: assets.sectionId,
      assignedStaffId: assets.assignedStaffId,
      sectionName: sections.name,
      gradeName: gradeLevels.name,
      givenName: users.givenName,
      fatherName: users.fatherName,
      purchasedOn: assets.purchasedOn,
      purchaseCostCents: assets.purchaseCostCents,
      openIssues: openIssueCountExpr,
    })
    .from(assets)
    .leftJoin(sections, eq(sections.id, assets.sectionId))
    .leftJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .leftJoin(staff, eq(staff.id, assets.assignedStaffId))
    .leftJoin(users, eq(users.id, staff.userId))
    .where(where)
    .orderBy(asc(assets.name))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db.select({ total: count() }).from(assets).where(where);

  return {
    assets: rows.map((r) => ({
      id: r.id,
      name: r.name,
      assetTag: r.assetTag,
      category: r.category,
      serialNumber: r.serialNumber,
      status: r.status,
      condition: r.condition,
      location: r.location,
      sectionId: r.sectionId,
      assignedStaffId: r.assignedStaffId,
      sectionName: r.sectionName ? `${r.gradeName ?? ''} ${r.sectionName}`.trim() : null,
      assignedTo: r.givenName ? [r.givenName, r.fatherName].filter(Boolean).join(' ') : null,
      purchasedOn: r.purchasedOn,
      purchaseCostCents: r.purchaseCostCents,
      openIssues: Number(r.openIssues ?? 0),
    })),
    total: totalRow?.total ?? 0,
  };
}

export async function getAssetOwned(ctx: AuthContext, assetId: string) {
  const [row] = await ctx.db
    .select()
    .from(assets)
    .where(and(eq(assets.schoolId, ctx.schoolId), eq(assets.id, assetId)))
    .limit(1);
  if (!row) throw notFoundError('Asset');
  return row;
}

export async function createAsset(ctx: AuthContext, input: AssetInput) {
  await ctx.requireModule('maintenance');
  ctx.require('asset.manage');

  const [row] = await ctx.db
    .insert(assets)
    .values({
      schoolId: ctx.schoolId,
      name: input.name,
      assetTag: input.assetTag ?? null,
      category: input.category ?? null,
      serialNumber: input.serialNumber ?? null,
      sectionId: input.sectionId ?? null,
      location: input.location ?? null,
      assignedStaffId: input.assignedStaffId ?? null,
      status: input.status,
      condition: input.condition,
      purchasedOn: input.purchasedOn ?? null,
      purchaseCostCents: input.purchaseCostCents ?? null,
      warrantyUntil: input.warrantyUntil ?? null,
      note: input.note ?? null,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'asset.create',
    entityType: 'asset',
    entityId: row!.id,
    summary: row!.name,
    newValue: { name: row!.name, assetTag: row!.assetTag, status: row!.status },
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function updateAsset(ctx: AuthContext, assetId: string, input: AssetInput) {
  await ctx.requireModule('maintenance');
  ctx.require('asset.manage');

  const before = await getAssetOwned(ctx, assetId);

  const [row] = await ctx.db
    .update(assets)
    .set({
      name: input.name,
      assetTag: input.assetTag ?? null,
      category: input.category ?? null,
      serialNumber: input.serialNumber ?? null,
      sectionId: input.sectionId ?? null,
      location: input.location ?? null,
      assignedStaffId: input.assignedStaffId ?? null,
      status: input.status,
      condition: input.condition,
      purchasedOn: input.purchasedOn ?? null,
      purchaseCostCents: input.purchaseCostCents ?? null,
      warrantyUntil: input.warrantyUntil ?? null,
      note: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(assets.schoolId, ctx.schoolId), eq(assets.id, assetId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'asset.update',
    entityType: 'asset',
    entityId: assetId,
    summary: row!.name,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export type IssueRow = {
  id: string;
  title: string;
  description: string | null;
  assetId: string | null;
  assetName: string | null;
  location: string | null;
  priority: string;
  status: string;
  reportedOn: string;
  reportedByName: string | null;
  assignedToName: string | null;
  /** Raw id and note, so the update form does not blank them on save. */
  assignedStaffId: string | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  costCents: number | null;
  ageDays: number;
};

export async function listMaintenanceIssues(
  ctx: AuthContext,
  query: {
    status?: string | null;
    priority?: string | null;
    assetId?: string | null;
    openOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ issues: IssueRow[]; total: number }> {
  const conditions: SQL[] = [eq(maintenanceIssues.schoolId, ctx.schoolId)];
  if (query.status) conditions.push(eq(maintenanceIssues.status, query.status));
  if (query.openOnly) {
    conditions.push(inArray(maintenanceIssues.status, ['open', 'in_progress']));
  }
  if (query.priority) conditions.push(eq(maintenanceIssues.priority, query.priority));
  if (query.assetId) conditions.push(eq(maintenanceIssues.assetId, query.assetId));
  const where = and(...conditions) as SQL;

  const assignee = users;

  const rows = await ctx.db
    .select({
      id: maintenanceIssues.id,
      title: maintenanceIssues.title,
      description: maintenanceIssues.description,
      assetId: maintenanceIssues.assetId,
      assetName: assets.name,
      location: maintenanceIssues.location,
      priority: maintenanceIssues.priority,
      status: maintenanceIssues.status,
      reportedOn: maintenanceIssues.reportedOn,
      reporterGiven: sql<string | null>`reporter.given_name`,
      reporterFather: sql<string | null>`reporter.father_name`,
      assigneeGiven: assignee.givenName,
      assigneeFather: assignee.fatherName,
      assignedStaffId: maintenanceIssues.assignedStaffId,
      resolutionNote: maintenanceIssues.resolutionNote,
      resolvedAt: maintenanceIssues.resolvedAt,
      costCents: maintenanceIssues.costCents,
      ageDays: sql<number>`(current_date - ${maintenanceIssues.reportedOn})::int`,
    })
    .from(maintenanceIssues)
    .leftJoin(assets, eq(assets.id, maintenanceIssues.assetId))
    .leftJoin(sql`${users} as reporter`, sql`reporter.id = ${maintenanceIssues.reportedBy}`)
    .leftJoin(staff, eq(staff.id, maintenanceIssues.assignedStaffId))
    .leftJoin(assignee, eq(assignee.id, staff.userId))
    .where(where)
    // Urgent first, then oldest: the queue a caretaker should work top-down.
    .orderBy(
      sql`case ${maintenanceIssues.priority}
            when 'urgent' then 0 when 'high' then 1
            when 'normal' then 2 else 3 end`,
      asc(maintenanceIssues.reportedOn),
    )
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(maintenanceIssues)
    .where(where);

  return {
    issues: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      assetId: r.assetId,
      assetName: r.assetName,
      location: r.location,
      priority: r.priority,
      status: r.status,
      reportedOn: r.reportedOn,
      reportedByName: r.reporterGiven
        ? [r.reporterGiven, r.reporterFather].filter(Boolean).join(' ')
        : null,
      assignedToName: r.assigneeGiven
        ? [r.assigneeGiven, r.assigneeFather].filter(Boolean).join(' ')
        : null,
      assignedStaffId: r.assignedStaffId,
      resolutionNote: r.resolutionNote,
      resolvedAt: r.resolvedAt,
      costCents: r.costCents,
      ageDays: Number(r.ageDays ?? 0),
    })),
    total: totalRow?.total ?? 0,
  };
}

/**
 * Report a fault.
 *
 * Deliberately the lowest-privilege write in the module: any member of staff
 * with `maintenance.report` can file one, including a teacher. A school that
 * makes reporting hard gets no reports.
 */
export async function reportIssue(ctx: AuthContext, input: MaintenanceIssueInput) {
  await ctx.requireModule('maintenance');
  ctx.require('maintenance.report');

  // A named asset must be this school's.
  if (input.assetId) await getAssetOwned(ctx, input.assetId);

  const [row] = await ctx.db
    .insert(maintenanceIssues)
    .values({
      schoolId: ctx.schoolId,
      assetId: input.assetId ?? null,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      priority: input.priority,
      status: 'open',
      reportedBy: ctx.user.userId,
      reportedOn: input.reportedOn,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'maintenance.report',
    entityType: 'maintenanceIssue',
    entityId: row!.id,
    summary: `${input.priority}: ${input.title}`,
    newValue: { title: input.title, priority: input.priority, assetId: input.assetId ?? null },
    ipAddress: ctx.ipAddress,
  });

  await emitEvent(ctx.db, ctx.schoolId, 'maintenance.reported', {
    issueId: row!.id,
    title: row!.title,
    priority: row!.priority,
    location: row!.location,
  });

  return row!;
}

export async function updateIssue(
  ctx: AuthContext,
  issueId: string,
  input: UpdateMaintenanceInput,
) {
  await ctx.requireModule('maintenance');
  ctx.require('maintenance.manage');

  const [before] = await ctx.db
    .select()
    .from(maintenanceIssues)
    .where(and(eq(maintenanceIssues.schoolId, ctx.schoolId), eq(maintenanceIssues.id, issueId)))
    .limit(1);
  if (!before) throw notFoundError('Issue');

  if (input.assignedStaffId) {
    const [person] = await ctx.db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.id, input.assignedStaffId)))
      .limit(1);
    if (!person) throw notFoundError('Staff member');
  }

  const closing = input.status === 'resolved' || input.status === 'closed';

  const [row] = await ctx.db
    .update(maintenanceIssues)
    .set({
      status: input.status ?? before.status,
      priority: input.priority ?? before.priority,
      assignedStaffId:
        input.assignedStaffId === undefined ? before.assignedStaffId : input.assignedStaffId,
      resolutionNote: input.resolutionNote ?? before.resolutionNote,
      costCents: input.costCents ?? before.costCents,
      // The CHECK requires a timestamp on a closed issue; set it here rather
      // than trusting the client to.
      resolvedAt: closing ? (before.resolvedAt ?? new Date()) : before.resolvedAt,
      updatedAt: new Date(),
    })
    .where(and(eq(maintenanceIssues.schoolId, ctx.schoolId), eq(maintenanceIssues.id, issueId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'maintenance.update',
    entityType: 'maintenanceIssue',
    entityId: issueId,
    summary: `${row!.status}: ${row!.title}`,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

// ---------------------------------------------------------------------------
// Transport: vehicles
// ---------------------------------------------------------------------------

export async function listVehicles(ctx: AuthContext, includeRetired = false) {
  const conditions: SQL[] = [eq(vehicles.schoolId, ctx.schoolId)];
  if (!includeRetired) conditions.push(sql`${vehicles.status} <> 'retired'`);

  const driver = users;
  return await ctx.db
    .select({
      id: vehicles.id,
      plateNumber: vehicles.plateNumber,
      label: vehicles.label,
      vehicleType: vehicles.vehicleType,
      capacity: vehicles.capacity,
      status: vehicles.status,
      insuranceUntil: vehicles.insuranceUntil,
      inspectionUntil: vehicles.inspectionUntil,
      // Raw ids so an edit form can pre-select the current crew rather than
      // blanking it on save.
      driverStaffId: vehicles.driverStaffId,
      assistantStaffId: vehicles.assistantStaffId,
      driverName: sql<string | null>`${driver.givenName} || coalesce(' ' || ${driver.fatherName}, '')`,
      routeCount: sql<number>`(
        select count(*)::int from ${transportRoutes} r
        where r.vehicle_id = ${vehicles}.${sql.identifier('id')} and r.active = true
      )`,
    })
    .from(vehicles)
    .leftJoin(staff, eq(staff.id, vehicles.driverStaffId))
    .leftJoin(driver, eq(driver.id, staff.userId))
    .where(and(...conditions))
    .orderBy(asc(vehicles.plateNumber));
}

export async function createVehicle(ctx: AuthContext, input: VehicleInput) {
  await ctx.requireModule('transport');
  ctx.require('transport.manage');
  await assertStaffOwned(ctx, [input.driverStaffId, input.assistantStaffId]);

  const [row] = await ctx.db
    .insert(vehicles)
    .values({
      schoolId: ctx.schoolId,
      plateNumber: input.plateNumber,
      label: input.label ?? null,
      vehicleType: input.vehicleType,
      capacity: input.capacity,
      driverStaffId: input.driverStaffId ?? null,
      assistantStaffId: input.assistantStaffId ?? null,
      status: input.status,
      insuranceUntil: input.insuranceUntil ?? null,
      inspectionUntil: input.inspectionUntil ?? null,
      note: input.note ?? null,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'transport.vehicleCreate',
    entityType: 'vehicle',
    entityId: row!.id,
    summary: row!.plateNumber,
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function updateVehicle(ctx: AuthContext, vehicleId: string, input: VehicleInput) {
  await ctx.requireModule('transport');
  ctx.require('transport.manage');
  await assertStaffOwned(ctx, [input.driverStaffId, input.assistantStaffId]);

  const [before] = await ctx.db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.schoolId, ctx.schoolId), eq(vehicles.id, vehicleId)))
    .limit(1);
  if (!before) throw notFoundError('Vehicle');

  const [row] = await ctx.db
    .update(vehicles)
    .set({
      plateNumber: input.plateNumber,
      label: input.label ?? null,
      vehicleType: input.vehicleType,
      capacity: input.capacity,
      driverStaffId: input.driverStaffId ?? null,
      assistantStaffId: input.assistantStaffId ?? null,
      status: input.status,
      insuranceUntil: input.insuranceUntil ?? null,
      inspectionUntil: input.inspectionUntil ?? null,
      note: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(vehicles.schoolId, ctx.schoolId), eq(vehicles.id, vehicleId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'transport.vehicleUpdate',
    entityType: 'vehicle',
    entityId: vehicleId,
    summary: row!.plateNumber,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

/** Every named staff id must belong to this school. */
async function assertStaffOwned(ctx: AuthContext, ids: (string | null | undefined)[]) {
  const wanted = ids.filter((v): v is string => Boolean(v));
  if (wanted.length === 0) return;
  const found = await ctx.db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.schoolId, ctx.schoolId), inArray(staff.id, wanted)));
  if (found.length !== new Set(wanted).size) throw notFoundError('Staff member');
}

// ---------------------------------------------------------------------------
// Transport: routes
// ---------------------------------------------------------------------------

export async function listRoutes(ctx: AuthContext, includeInactive = false) {
  const conditions: SQL[] = [eq(transportRoutes.schoolId, ctx.schoolId)];
  if (!includeInactive) conditions.push(eq(transportRoutes.active, true));

  return await ctx.db
    .select({
      id: transportRoutes.id,
      name: transportRoutes.name,
      code: transportRoutes.code,
      direction: transportRoutes.direction,
      monthlyFeeCents: transportRoutes.monthlyFeeCents,
      active: transportRoutes.active,
      vehicleId: transportRoutes.vehicleId,
      plateNumber: vehicles.plateNumber,
      capacity: vehicles.capacity,
      stopCount: sql<number>`(
        select count(*)::int from ${routeStops} s
        where s.route_id = ${transportRoutes}.${sql.identifier('id')}
      )`,
      riderCount: sql<number>`(
        select count(*)::int from ${studentTransport} st
        where st.route_id = ${transportRoutes}.${sql.identifier('id')}
          and st.status = 'active'
      )`,
    })
    .from(transportRoutes)
    .leftJoin(vehicles, eq(vehicles.id, transportRoutes.vehicleId))
    .where(and(...conditions))
    .orderBy(asc(transportRoutes.name));
}

export async function getRouteOwned(ctx: AuthContext, routeId: string) {
  const [row] = await ctx.db
    .select()
    .from(transportRoutes)
    .where(and(eq(transportRoutes.schoolId, ctx.schoolId), eq(transportRoutes.id, routeId)))
    .limit(1);
  if (!row) throw notFoundError('Route');
  return row;
}

export async function createRoute(ctx: AuthContext, input: TransportRouteInput) {
  await ctx.requireModule('transport');
  ctx.require('transport.manage');

  if (input.vehicleId) {
    const [v] = await ctx.db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(and(eq(vehicles.schoolId, ctx.schoolId), eq(vehicles.id, input.vehicleId)))
      .limit(1);
    if (!v) throw notFoundError('Vehicle');
  }

  const [row] = await ctx.db
    .insert(transportRoutes)
    .values({
      schoolId: ctx.schoolId,
      name: input.name,
      code: input.code ?? null,
      vehicleId: input.vehicleId ?? null,
      direction: input.direction,
      monthlyFeeCents: input.monthlyFeeCents ?? null,
      active: input.active,
      note: input.note ?? null,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'transport.routeCreate',
    entityType: 'transportRoute',
    entityId: row!.id,
    summary: row!.name,
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function updateRoute(
  ctx: AuthContext,
  routeId: string,
  input: TransportRouteInput,
) {
  await ctx.requireModule('transport');
  ctx.require('transport.manage');
  const before = await getRouteOwned(ctx, routeId);

  const [row] = await ctx.db
    .update(transportRoutes)
    .set({
      name: input.name,
      code: input.code ?? null,
      vehicleId: input.vehicleId ?? null,
      direction: input.direction,
      monthlyFeeCents: input.monthlyFeeCents ?? null,
      active: input.active,
      note: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(transportRoutes.schoolId, ctx.schoolId), eq(transportRoutes.id, routeId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'transport.routeUpdate',
    entityType: 'transportRoute',
    entityId: routeId,
    summary: row!.name,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function listStops(ctx: AuthContext, routeId: string) {
  await getRouteOwned(ctx, routeId);
  return await ctx.db
    .select()
    .from(routeStops)
    .where(and(eq(routeStops.schoolId, ctx.schoolId), eq(routeStops.routeId, routeId)))
    .orderBy(asc(routeStops.sortOrder), asc(routeStops.name));
}

export async function addStop(ctx: AuthContext, routeId: string, input: RouteStopInput) {
  await ctx.requireModule('transport');
  ctx.require('transport.manage');
  await getRouteOwned(ctx, routeId);

  const [row] = await ctx.db
    .insert(routeStops)
    .values({
      schoolId: ctx.schoolId,
      routeId,
      name: input.name,
      sortOrder: input.sortOrder,
      pickupTime: input.pickupTime ?? null,
      dropoffTime: input.dropoffTime ?? null,
      landmark: input.landmark ?? null,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'transport.routeUpdate',
    entityType: 'transportRoute',
    entityId: routeId,
    summary: `Added stop ${input.name}`,
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

// ---------------------------------------------------------------------------
// Transport: who rides which bus
// ---------------------------------------------------------------------------

export type RiderRow = {
  id: string;
  studentId: string;
  studentName: string;
  studentCode: string;
  gradeName: string | null;
  sectionName: string | null;
  routeId: string;
  routeName: string;
  pickupStop: string | null;
  dropoffStop: string | null;
  startDate: string;
  status: string;
};

export async function listRiders(
  ctx: AuthContext,
  query: { routeId?: string | null; studentId?: string | null; limit?: number; offset?: number } = {},
): Promise<{ riders: RiderRow[]; total: number }> {
  const conditions: SQL[] = [
    eq(studentTransport.schoolId, ctx.schoolId),
    eq(studentTransport.status, 'active'),
  ];
  if (query.routeId) conditions.push(eq(studentTransport.routeId, query.routeId));
  if (query.studentId) conditions.push(eq(studentTransport.studentId, query.studentId));
  const where = and(...conditions) as SQL;

  const rows = await ctx.db
    .select({
      id: studentTransport.id,
      studentId: studentTransport.studentId,
      givenName: students.givenName,
      fatherName: students.fatherName,
      studentCode: students.studentCode,
      gradeName: gradeLevels.name,
      sectionName: sections.name,
      routeId: studentTransport.routeId,
      routeName: transportRoutes.name,
      pickupStop: sql<string | null>`pickup.name`,
      dropoffStop: sql<string | null>`dropoff.name`,
      startDate: studentTransport.startDate,
      status: studentTransport.status,
    })
    .from(studentTransport)
    .innerJoin(students, eq(students.id, studentTransport.studentId))
    .innerJoin(transportRoutes, eq(transportRoutes.id, studentTransport.routeId))
    .leftJoin(sql`${routeStops} as pickup`, sql`pickup.id = ${studentTransport.pickupStopId}`)
    .leftJoin(sql`${routeStops} as dropoff`, sql`dropoff.id = ${studentTransport.dropoffStopId}`)
    .leftJoin(
      sections,
      sql`${sections.id} = (
        select e.section_id from enrollments e
        where e.student_id = ${students.id} and e.status = 'enrolled'
        order by e.enrolled_on desc limit 1
      )`,
    )
    .leftJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
    .where(where)
    .orderBy(asc(students.givenName))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(studentTransport)
    .where(where);

  return {
    riders: rows.map((r) => ({
      id: r.id,
      studentId: r.studentId,
      studentName: [r.givenName, r.fatherName].filter(Boolean).join(' '),
      studentCode: r.studentCode,
      gradeName: r.gradeName,
      sectionName: r.sectionName,
      routeId: r.routeId,
      routeName: r.routeName,
      pickupStop: r.pickupStop,
      dropoffStop: r.dropoffStop,
      startDate: r.startDate,
      status: r.status,
    })),
    total: totalRow?.total ?? 0,
  };
}

/**
 * Put a pupil on a route.
 *
 * Capacity is checked inside the transaction against the vehicle's seats, so
 * two clerks assigning the last seat cannot both succeed.
 */
export async function assignTransport(ctx: AuthContext, input: AssignTransportInput) {
  await ctx.requireModule('transport');
  ctx.require('transport.manage');
  // The pupil must be one this user may see.
  await ctx.requireStudentAccess(input.studentId);

  const [year] = await ctx.db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!year) {
    throw new OperationsError('Set a current academic year before assigning transport.', 400);
  }

  const row = await ctx.db.transaction(async (tx) => {
    const [route] = await tx
      .select({
        id: transportRoutes.id,
        name: transportRoutes.name,
        vehicleId: transportRoutes.vehicleId,
      })
      .from(transportRoutes)
      .where(
        and(
          eq(transportRoutes.schoolId, ctx.schoolId),
          eq(transportRoutes.id, input.routeId),
          eq(transportRoutes.active, true),
        ),
      )
      .for('update');
    if (!route) throw notFoundError('Route');

    if (route.vehicleId) {
      const [vehicle] = await tx
        .select({ capacity: vehicles.capacity })
        .from(vehicles)
        .where(eq(vehicles.id, route.vehicleId))
        .limit(1);

      if (vehicle && vehicle.capacity > 0) {
        const [riders] = await tx
          .select({ n: count() })
          .from(studentTransport)
          .where(
            and(
              eq(studentTransport.schoolId, ctx.schoolId),
              eq(studentTransport.routeId, route.id),
              eq(studentTransport.status, 'active'),
            ),
          );
        if ((riders?.n ?? 0) >= vehicle.capacity) {
          throw new OperationsError(
            `${route.name} is full (${vehicle.capacity} seats).`,
            409,
          );
        }
      }
    }

    // A pupil already riding this year moves route rather than gaining a
    // second subscription. The partial unique index enforces it regardless.
    await tx
      .update(studentTransport)
      .set({ status: 'ended', endDate: input.startDate, updatedAt: new Date() })
      .where(
        and(
          eq(studentTransport.schoolId, ctx.schoolId),
          eq(studentTransport.studentId, input.studentId),
          eq(studentTransport.academicYearId, year.id),
          eq(studentTransport.status, 'active'),
        ),
      );

    const [created] = await tx
      .insert(studentTransport)
      .values({
        schoolId: ctx.schoolId,
        studentId: input.studentId,
        academicYearId: year.id,
        routeId: input.routeId,
        pickupStopId: input.pickupStopId ?? null,
        dropoffStopId: input.dropoffStopId ?? null,
        startDate: input.startDate,
        status: 'active',
        note: input.note ?? null,
      })
      .returning();

    return created!;
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'transport.assign',
    entityType: 'studentTransport',
    entityId: row.id,
    summary: `Assigned to route`,
    newValue: { studentId: input.studentId, routeId: input.routeId },
    ipAddress: ctx.ipAddress,
  });

  return row;
}

export async function endTransport(ctx: AuthContext, assignmentId: string, endDate: string) {
  await ctx.requireModule('transport');
  ctx.require('transport.manage');

  const [before] = await ctx.db
    .select()
    .from(studentTransport)
    .where(
      and(eq(studentTransport.schoolId, ctx.schoolId), eq(studentTransport.id, assignmentId)),
    )
    .limit(1);
  if (!before) throw notFoundError('Assignment');
  if (before.status !== 'active') {
    throw new OperationsError('This assignment has already ended.', 409);
  }

  const [row] = await ctx.db
    .update(studentTransport)
    .set({ status: 'ended', endDate, updatedAt: new Date() })
    .where(
      and(eq(studentTransport.schoolId, ctx.schoolId), eq(studentTransport.id, assignmentId)),
    )
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'transport.unassign',
    entityType: 'studentTransport',
    entityId: assignmentId,
    summary: `Ended ${endDate}`,
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

/** One pupil's current transport, for the portal and the student profile. */
export async function getStudentTransport(ctx: AuthContext, studentId: string) {
  const [row] = await ctx.db
    .select({
      id: studentTransport.id,
      routeName: transportRoutes.name,
      direction: transportRoutes.direction,
      plateNumber: vehicles.plateNumber,
      pickupStop: sql<string | null>`pickup.name`,
      pickupTime: sql<string | null>`pickup.pickup_time`,
      dropoffStop: sql<string | null>`dropoff.name`,
      dropoffTime: sql<string | null>`dropoff.dropoff_time`,
      startDate: studentTransport.startDate,
    })
    .from(studentTransport)
    .innerJoin(transportRoutes, eq(transportRoutes.id, studentTransport.routeId))
    .leftJoin(vehicles, eq(vehicles.id, transportRoutes.vehicleId))
    .leftJoin(sql`${routeStops} as pickup`, sql`pickup.id = ${studentTransport.pickupStopId}`)
    .leftJoin(sql`${routeStops} as dropoff`, sql`dropoff.id = ${studentTransport.dropoffStopId}`)
    .where(
      and(
        eq(studentTransport.schoolId, ctx.schoolId),
        eq(studentTransport.studentId, studentId),
        eq(studentTransport.status, 'active'),
      ),
    )
    .limit(1);

  return row ?? null;
}
