/**
 * Stock.
 *
 * Low stock leads, because that is the only thing on this page that requires
 * a decision today. Everything else is a register.
 */

import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { money } from '../../../lib/finance/format.ts';
import { todayIso } from '../../../lib/calendar/ethiopian.ts';
import { listInventoryItems } from '../../../lib/operations/inventory.ts';
import { PageHeader, Card, StatCard, EmptyState, Badge } from '../../../components/ui.tsx';
import StockManager from './StockManager.tsx';

export const dynamic = 'force-dynamic';

/** Labels the client island needs — it cannot call the translator itself. */
const LABEL_KEYS = [
  'action.save',
  'action.cancel',
  'action.edit',
  'ops.saving',
  'ops.loading',
  'library.category',
  'library.inactive',
  'asset.note',
  'inventory.title',
  'inventory.item',
  'inventory.newItem',
  'inventory.editItem',
  'inventory.itemSaved',
  'inventory.sku',
  'inventory.unit',
  'inventory.quantity',
  'inventory.currentQuantity',
  'inventory.reorderLevel',
  'inventory.location',
  'inventory.unitCost',
  'inventory.active',
  'inventory.noItems',
  'inventory.noMovements',
  'inventory.recordMovement',
  'inventory.viewMovements',
  'inventory.movementSaved',
  'inventory.movedOn',
  'inventory.reference',
  'inventory.reason',
  'inventory.reasonRequired',
  'inventory.stockIn',
  'inventory.stockOut',
  'inventory.adjust',
  'inventory.adjustTo',
  'inventory.adjustToHelp',
  'inventory.movementType.receipt',
  'inventory.movementType.issue',
  'inventory.movementType.adjustment',
  'inventory.movementType.loss',
];

export default async function InventoryPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.inventory) {
    return (
      <Card>
        <EmptyState title={t('inventory.disabled')} />
      </Card>
    );
  }
  if (!ctx.has('inventory.view')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const canManage = ctx.has('inventory.manage');
  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);
  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  const [all, low] = await Promise.all([
    // Inactive items are included for a manager, who must be able to bring one
    // back into use; a viewer sees only what is in service.
    listInventoryItems(ctx, { limit: 100, includeInactive: canManage }),
    listInventoryItems(ctx, { lowOnly: true, limit: 50 }),
  ]);

  const stockValue = all.items.reduce(
    (sum, i) => sum + (i.unitCostCents ?? 0) * i.quantity,
    0,
  );

  return (
    <>
      <PageHeader title={t('inventory.title')} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label={t('inventory.item')} value={all.total} />
        <StatCard
          label={t('inventory.lowStock')}
          value={low.total}
          tone={low.total > 0 ? 'warn' : 'good'}
        />
        <StatCard label={t('finance.amount')} value={money(stockValue)} />
      </div>

      {low.items.length > 0 && (
        <Card title={`${t('inventory.lowStock')} — ${t('ops.workQueue')}`} className="mb-6">
          <ul className="divide-y divide-ink-100">
            {low.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-900">{item.name}</p>
                  <p className="text-xs text-ink-500">
                    {t('inventory.reorderLevel')}: {item.reorderLevel} {item.unit}
                  </p>
                </div>
                <Badge tone="warn">
                  {item.quantity} {item.unit}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* One list, with the write controls inline. A storekeeper should not
          have to navigate elsewhere to book stock in against the row they are
          already looking at. */}
      <StockManager labels={labels} items={all.items} today={today} canManage={canManage} />
    </>
  );
}
