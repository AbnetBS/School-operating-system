/**
 * Assets and maintenance.
 *
 * The fault queue is the working half of this screen, ordered urgent-first and
 * oldest-first — the order a caretaker should work down it. The asset register
 * sits underneath because it is reference, not work.
 *
 * Two audiences share the page. A teacher gets one button ("report a fault")
 * and the queue, so they can see their report was picked up. A manager gets
 * the same queue with status controls, plus the register. The difference is
 * decided from permissions here and enforced again in the service.
 */

import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { todayIso } from '../../../lib/calendar/ethiopian.ts';
import { listAssets, listMaintenanceIssues } from '../../../lib/operations/facilities.ts';
import {
  ASSET_STATUSES,
  CONDITIONS,
  MAINTENANCE_STATUSES,
  PRIORITIES,
} from '../../../lib/operations/schema.ts';
import { sections, gradeLevels, users } from '../../../db/schema/core.ts';
import { staff } from '../../../db/schema/people.ts';
import { PageHeader, Card, StatCard, EmptyState } from '../../../components/ui.tsx';
import FaultReporter from './FaultReporter.tsx';
import IssueQueue from './IssueQueue.tsx';
import AssetManager from './AssetManager.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.save',
  'action.cancel',
  'action.edit',
  'ops.saving',
  'ops.loading',
  'ops.none',
  'library.category',
  'finance.status',
  'inventory.location',
  'asset.title',
  'asset.newAsset',
  'asset.assetSaved',
  'asset.tag',
  'asset.serialNumber',
  'asset.condition',
  'asset.assignedTo',
  'asset.unassigned',
  'asset.purchasedOn',
  'asset.purchaseCost',
  'asset.warrantyUntil',
  'asset.note',
  'asset.location',
  'asset.section',
  'asset.status',
  'asset.noAssets',
  'asset.status.in_use',
  'asset.status.in_storage',
  'asset.status.under_repair',
  'asset.status.disposed',
  'asset.status.lost',
  'asset.condition.new',
  'asset.condition.good',
  'asset.condition.fair',
  'asset.condition.poor',
  'maintenance.report',
  'maintenance.reportHelp',
  'maintenance.reported',
  'maintenance.issue',
  'maintenance.description',
  'maintenance.relatedAsset',
  'maintenance.noAsset',
  'maintenance.priority',
  'maintenance.priority.low',
  'maintenance.priority.normal',
  'maintenance.priority.high',
  'maintenance.priority.urgent',
  'maintenance.status.open',
  'maintenance.status.in_progress',
  'maintenance.status.resolved',
  'maintenance.status.closed',
  'maintenance.status.cancelled',
  'maintenance.reportedOn',
  'maintenance.assignedTo',
  'maintenance.assignTo',
  'maintenance.resolution',
  'maintenance.resolutionRequired',
  'maintenance.cost',
  'maintenance.updateIssue',
  'maintenance.issueUpdated',
  'maintenance.openCount',
];

export default async function FacilitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.maintenance) {
    return (
      <Card>
        <EmptyState title={t('maintenance.disabled')} />
      </Card>
    );
  }
  if (!ctx.hasAny('asset.view', 'maintenance.manage', 'maintenance.report')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const params = await searchParams;
  const showHistory = params.view === 'history';

  const canSeeAssets = ctx.has('asset.view');
  const canManageAssets = ctx.has('asset.manage');
  const canManageIssues = ctx.has('maintenance.manage');
  const canReport = ctx.has('maintenance.report');

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);

  const [open, closed, assets] = await Promise.all([
    listMaintenanceIssues(ctx, { openOnly: true, limit: 50 }),
    showHistory
      ? listMaintenanceIssues(ctx, { status: 'closed', limit: 50 })
      : Promise.resolve({ issues: [], total: 0 }),
    canSeeAssets ? listAssets(ctx, { limit: 100 }) : Promise.resolve({ assets: [], total: 0 }),
  ]);

  // Assignment targets. Only fetched for someone who can assign — a teacher
  // has no business receiving the staff list from this page.
  const [staffRows, sectionRows] = await Promise.all([
    canManageIssues || canManageAssets
      ? ctx.db
          .select({
            id: staff.id,
            givenName: users.givenName,
            fatherName: users.fatherName,
          })
          .from(staff)
          .innerJoin(users, eq(users.id, staff.userId))
          .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.status, 'active')))
          .orderBy(asc(users.givenName))
      : Promise.resolve([]),
    canManageAssets
      ? ctx.db
          .select({
            id: sections.id,
            name: sections.name,
            gradeName: gradeLevels.name,
          })
          .from(sections)
          .leftJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
          .where(eq(sections.schoolId, ctx.schoolId))
          .orderBy(asc(gradeLevels.level), asc(sections.name))
      : Promise.resolve([]),
  ]);

  const staffOptions = staffRows.map((row) => ({
    id: row.id,
    name: [row.givenName, row.fatherName].filter(Boolean).join(' '),
  }));
  const sectionOptions = sectionRows.map((row) => ({
    id: row.id,
    name: `${row.gradeName ?? ''} ${row.name}`.trim(),
  }));

  const urgent = open.issues.filter((i) => i.priority === 'urgent').length;
  const underRepair = assets.assets.filter((a) => a.status === 'under_repair').length;

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader title={t('maintenance.title')} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t('maintenance.status.open')}
          value={open.total}
          tone={open.total > 0 ? 'warn' : 'good'}
        />
        <StatCard
          label={t('maintenance.priority.urgent')}
          value={urgent}
          tone={urgent > 0 ? 'bad' : 'good'}
        />
        {canSeeAssets && <StatCard label={t('asset.title')} value={assets.total} />}
        {canSeeAssets && (
          <StatCard
            label={t('asset.status.under_repair')}
            value={underRepair}
            tone={underRepair > 0 ? 'warn' : 'default'}
          />
        )}
      </div>

      {canReport && (
        <div className="mb-6">
          <FaultReporter
            labels={labels}
            priorities={[...PRIORITIES]}
            // Only offer the asset list to someone allowed to see it.
            assets={
              canSeeAssets
                ? assets.assets.map((a) => ({
                    id: a.id,
                    name: a.name,
                    assetTag: a.assetTag,
                  }))
                : []
            }
            today={today}
          />
        </div>
      )}

      <Card
        title={`${t('maintenance.title')} — ${t('ops.workQueue')}`}
        className="mb-6"
        action={
          <a
            href={showHistory ? '/facilities' : '/facilities?view=history'}
            className="text-xs font-semibold text-brand-700 underline"
          >
            {showHistory ? t('ops.workQueue') : t('maintenance.history')}
          </a>
        }
      >
        {open.issues.length === 0 ? (
          <EmptyState title={t('maintenance.noIssues')} />
        ) : (
          <IssueQueue
            labels={labels}
            issues={open.issues}
            statuses={[...MAINTENANCE_STATUSES]}
            priorities={[...PRIORITIES]}
            staff={staffOptions}
            canManage={canManageIssues}
          />
        )}
      </Card>

      {showHistory && (
        <Card title={t('maintenance.history')} className="mb-6">
          {closed.issues.length === 0 ? (
            <EmptyState title={t('maintenance.noHistory')} />
          ) : (
            <IssueQueue
              labels={labels}
              issues={closed.issues}
              statuses={[...MAINTENANCE_STATUSES]}
              priorities={[...PRIORITIES]}
              staff={staffOptions}
              canManage={canManageIssues}
            />
          )}
        </Card>
      )}

      {canSeeAssets && (
        <AssetManager
          labels={labels}
          assets={assets.assets}
          statuses={[...ASSET_STATUSES]}
          conditions={[...CONDITIONS]}
          sections={sectionOptions}
          staff={staffOptions}
          canManage={canManageAssets}
        />
      )}
    </>
  );
}
