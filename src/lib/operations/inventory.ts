/**
 * Inventory service.
 *
 * THE MOVEMENT LEDGER IS THE TRUTH. `inventory_items.quantity` is a cache.
 * Every change appends a `stock_movements` row and recomputes the column
 * inside the same transaction, under `SELECT … FOR UPDATE` on the item.
 * `recomputeQuantity` can rebuild the column from the ledger at any time; the
 * reverse is impossible, which is what makes the ledger authoritative.
 *
 * WHY NOT `quantity = quantity - n`? Because a bare decrement cannot answer
 * "who took the last twelve exercise books, and when?" — the question a
 * storekeeper actually needs answered. It also cannot be audited: a wrong
 * total has no history to reconcile against.
 *
 * THE SIGN IS DECIDED HERE, NOT BY THE CLIENT. The API accepts a positive
 * magnitude and a movement type. If the client could send a negative number,
 * an "issue" of -50 would silently become a receipt of 50. `stockMovementSchema`
 * enforces `.positive()`; this module applies the sign.
 *
 * As in finance and library, the READ functions do not authorise — callers do.
 * The mutations authorise, because there is one correct answer for who may
 * move stock.
 */

import { and, asc, desc, eq, ilike, or, sql, count, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import { inventoryItems, stockMovements } from '../../db/schema/operations.ts';
import { users } from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { OperationsError, notFoundError } from './errors.ts';
import type { InventoryItemInput, StockMovementInput } from './schema.ts';

export type InventoryRow = {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit: string;
  quantity: number;
  reorderLevel: number;
  location: string | null;
  unitCostCents: number | null;
  active: boolean;
  isLow: boolean;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listInventoryItems(
  ctx: AuthContext,
  query: {
    q?: string | null;
    category?: string | null;
    lowOnly?: boolean;
    includeInactive?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: InventoryRow[]; total: number }> {
  const conditions: SQL[] = [eq(inventoryItems.schoolId, ctx.schoolId)];

  if (!query.includeInactive) conditions.push(eq(inventoryItems.active, true));
  if (query.category) conditions.push(eq(inventoryItems.category, query.category));
  if (query.q) {
    const needle = `%${query.q}%`;
    const match = or(
      ilike(inventoryItems.name, needle),
      ilike(inventoryItems.sku, needle),
      ilike(inventoryItems.location, needle),
    );
    if (match) conditions.push(match);
  }
  // "Low" means at or below the reorder level, and only where the school has
  // actually set one. A reorder level of 0 means "do not track", not
  // "everything is low".
  if (query.lowOnly) {
    conditions.push(
      sql`${inventoryItems.reorderLevel} > 0 and ${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
    );
  }

  const where = and(...conditions) as SQL;

  const rows = await ctx.db
    .select({
      id: inventoryItems.id,
      name: inventoryItems.name,
      sku: inventoryItems.sku,
      category: inventoryItems.category,
      unit: inventoryItems.unit,
      quantity: inventoryItems.quantity,
      reorderLevel: inventoryItems.reorderLevel,
      location: inventoryItems.location,
      unitCostCents: inventoryItems.unitCostCents,
      active: inventoryItems.active,
    })
    .from(inventoryItems)
    .where(where)
    .orderBy(asc(inventoryItems.name))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(inventoryItems)
    .where(where);

  return {
    items: rows.map((r) => ({
      ...r,
      isLow: r.reorderLevel > 0 && r.quantity <= r.reorderLevel,
    })),
    total: totalRow?.total ?? 0,
  };
}

/** Fetch one item, or 404. The school filter is inside so no caller can omit it. */
export async function getInventoryItemOwned(ctx: AuthContext, itemId: string) {
  const [row] = await ctx.db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.schoolId, ctx.schoolId), eq(inventoryItems.id, itemId)))
    .limit(1);
  if (!row) throw notFoundError('Item');
  return row;
}

export type MovementRow = {
  id: string;
  movementType: string;
  delta: number;
  balanceAfter: number;
  reference: string | null;
  note: string | null;
  movedOn: string;
  recordedByName: string | null;
  createdAt: Date;
};

export async function listMovements(
  ctx: AuthContext,
  itemId: string,
  query: { limit?: number; offset?: number } = {},
): Promise<{ movements: MovementRow[]; total: number }> {
  await getInventoryItemOwned(ctx, itemId);

  const where = and(
    eq(stockMovements.schoolId, ctx.schoolId),
    eq(stockMovements.itemId, itemId),
  ) as SQL;

  const rows = await ctx.db
    .select({
      id: stockMovements.id,
      movementType: stockMovements.movementType,
      delta: stockMovements.delta,
      balanceAfter: stockMovements.balanceAfter,
      reference: stockMovements.reference,
      note: stockMovements.note,
      movedOn: stockMovements.movedOn,
      createdAt: stockMovements.createdAt,
      givenName: users.givenName,
      fatherName: users.fatherName,
    })
    .from(stockMovements)
    .leftJoin(users, eq(users.id, stockMovements.recordedBy))
    .where(where)
    .orderBy(desc(stockMovements.movedOn), desc(stockMovements.createdAt))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(stockMovements)
    .where(where);

  return {
    movements: rows.map((r) => ({
      id: r.id,
      movementType: r.movementType,
      delta: r.delta,
      balanceAfter: r.balanceAfter,
      reference: r.reference,
      note: r.note,
      movedOn: r.movedOn,
      createdAt: r.createdAt,
      recordedByName: r.givenName ? [r.givenName, r.fatherName].filter(Boolean).join(' ') : null,
    })),
    total: totalRow?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createInventoryItem(ctx: AuthContext, input: InventoryItemInput) {
  await ctx.requireModule('inventory');
  ctx.require('inventory.manage');

  const [row] = await ctx.db
    .insert(inventoryItems)
    .values({
      schoolId: ctx.schoolId,
      name: input.name,
      sku: input.sku ?? null,
      category: input.category ?? null,
      unit: input.unit,
      // Opening stock arrives as a movement, never as a starting quantity.
      // Otherwise the ledger and the column disagree from the first day.
      quantity: 0,
      reorderLevel: input.reorderLevel,
      location: input.location ?? null,
      unitCostCents: input.unitCostCents ?? null,
      active: input.active,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'inventory.itemCreate',
    entityType: 'inventoryItem',
    entityId: row!.id,
    summary: row!.name,
    newValue: { name: row!.name, unit: row!.unit, reorderLevel: row!.reorderLevel },
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function updateInventoryItem(
  ctx: AuthContext,
  itemId: string,
  input: InventoryItemInput,
) {
  await ctx.requireModule('inventory');
  ctx.require('inventory.manage');

  const before = await getInventoryItemOwned(ctx, itemId);

  const [row] = await ctx.db
    .update(inventoryItems)
    .set({
      name: input.name,
      sku: input.sku ?? null,
      category: input.category ?? null,
      unit: input.unit,
      reorderLevel: input.reorderLevel,
      location: input.location ?? null,
      unitCostCents: input.unitCostCents ?? null,
      active: input.active,
      updatedAt: new Date(),
      // `quantity` is deliberately absent. It is owned by the ledger; letting
      // an edit form set it would make the column and the movements disagree.
    })
    .where(and(eq(inventoryItems.schoolId, ctx.schoolId), eq(inventoryItems.id, itemId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'inventory.itemUpdate',
    entityType: 'inventoryItem',
    entityId: itemId,
    summary: row!.name,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

/**
 * Record a stock movement and update the cached quantity atomically.
 *
 * Order matters: lock, read, compute, reject if negative, then write both rows.
 * A caller cannot observe the item between the movement insert and the quantity
 * update because both happen inside the transaction.
 */
export async function recordMovement(
  ctx: AuthContext,
  itemId: string,
  input: StockMovementInput,
) {
  await ctx.requireModule('inventory');
  ctx.require('inventory.manage');

  const result = await ctx.db.transaction(async (tx) => {
    // ---- 1. Lock the item, then read its quantity -------------------------
    const [item] = await tx
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        unit: inventoryItems.unit,
        quantity: inventoryItems.quantity,
        reorderLevel: inventoryItems.reorderLevel,
      })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.schoolId, ctx.schoolId), eq(inventoryItems.id, itemId)))
      .for('update');

    if (!item) throw notFoundError('Item');

    // ---- 2. The service owns the sign -------------------------------------
    // 'adjustment' is the one type that may go either way; the magnitude is
    // still positive, and the direction comes from the explicit sign the
    // caller chose via the movement type, so a client cannot invert an issue.
    const magnitude = input.quantity;
    const delta =
      input.movementType === 'receipt'
        ? magnitude
        : input.movementType === 'issue' || input.movementType === 'loss'
          ? -magnitude
          : // adjustment: set-to semantics would be ambiguous, so an
            // adjustment is a signed correction relative to the current count.
            magnitude - item.quantity;

    if (delta === 0) {
      throw new OperationsError('That movement would not change the stock level.', 400, {
        quantity: 'This is already the current quantity.',
      });
    }

    const balanceAfter = item.quantity + delta;

    // ---- 3. Refuse to go negative -----------------------------------------
    if (balanceAfter < 0) {
      throw new OperationsError(
        `Only ${item.quantity} ${item.unit} of ${item.name} are in stock.`,
        409,
        { quantity: `Only ${item.quantity} available.` },
      );
    }

    // ---- 4. Ledger first, then the cache ----------------------------------
    const [movement] = await tx
      .insert(stockMovements)
      .values({
        schoolId: ctx.schoolId,
        itemId,
        movementType: input.movementType,
        delta,
        balanceAfter,
        reference: input.reference ?? null,
        note: input.note ?? null,
        movedOn: input.movedOn,
        recordedBy: ctx.user.userId,
      })
      .returning();

    await tx
      .update(inventoryItems)
      .set({ quantity: balanceAfter, updatedAt: new Date() })
      .where(and(eq(inventoryItems.schoolId, ctx.schoolId), eq(inventoryItems.id, itemId)));

    return { movement: movement!, item, balanceAfter };
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'inventory.movement',
    entityType: 'inventoryItem',
    entityId: itemId,
    summary: `${input.movementType} ${result.movement.delta > 0 ? '+' : ''}${result.movement.delta} ${result.item.unit} of ${result.item.name}`,
    newValue: {
      movementType: input.movementType,
      delta: result.movement.delta,
      balanceAfter: result.balanceAfter,
      reference: input.reference ?? null,
    },
    ipAddress: ctx.ipAddress,
  });

  // Emitted after the commit so a handler failure cannot roll back the stock
  // movement. The work queue reads the level directly, so this event is for
  // notifications only.
  if (result.item.reorderLevel > 0 && result.balanceAfter <= result.item.reorderLevel) {
    await emitEvent(ctx.db, ctx.schoolId, 'inventory.lowStock', {
      itemId,
      name: result.item.name,
      quantity: result.balanceAfter,
      reorderLevel: result.item.reorderLevel,
    });
  }

  return result.movement;
}

/**
 * Rebuild the cached quantity from the ledger.
 *
 * Exists because the cache must be reconstructible — that is what makes it a
 * cache rather than a second source of truth. Used by tests to prove the two
 * never diverge, and available to an administrator if they ever do.
 */
export async function recomputeQuantity(ctx: AuthContext, itemId: string): Promise<number> {
  return await ctx.db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.schoolId, ctx.schoolId), eq(inventoryItems.id, itemId)))
      .for('update');
    if (!item) throw notFoundError('Item');

    const [sum] = await tx
      .select({ total: sql<number>`coalesce(sum(${stockMovements.delta}), 0)::int` })
      .from(stockMovements)
      .where(and(eq(stockMovements.schoolId, ctx.schoolId), eq(stockMovements.itemId, itemId)));

    const total = Number(sum?.total ?? 0);

    await tx
      .update(inventoryItems)
      .set({ quantity: total, updatedAt: new Date() })
      .where(and(eq(inventoryItems.schoolId, ctx.schoolId), eq(inventoryItems.id, itemId)));

    return total;
  });
}
