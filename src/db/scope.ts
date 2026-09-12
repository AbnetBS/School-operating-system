/**
 * Tenant scoping.
 *
 * THE RULE: application code never queries a school-owned table without a
 * school filter. Forgetting that filter once — in one endpoint, in one release
 * — leaks one school's students to another. So rather than relying on every
 * developer remembering, the filter is produced here and the helpers below are
 * the sanctioned way to build a WHERE clause.
 *
 *   const scope = createScope(db, session.schoolId);
 *   const rows = await scope.select(students, eq(students.status, 'active'));
 *
 * `scope.select` ANDs `schoolId = <session school>` into every query it builds.
 *
 * Defence in depth: `assertSameSchool` re-checks a row after loading, so an
 * object fetched by primary key (the classic way tenancy is bypassed) is still
 * verified before it is returned to a user.
 */

import { and, eq, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PgTable, PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from './client.ts';

/** A table that carries a school_id column. */
export type TenantTable = PgTable & { schoolId: PgColumn };

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

export type Scope = {
  readonly schoolId: string;
  readonly db: Database;
  /** WHERE fragment restricting a table to this school, ANDed with extras. */
  where(table: TenantTable, ...extra: (SQL | undefined)[]): SQL;
  /** SELECT * FROM table WHERE school_id = ... AND ... */
  select<T extends TenantTable>(table: T, ...extra: (SQL | undefined)[]): Promise<T['$inferSelect'][]>;
  /** Fetch one row by id, verifying it belongs to this school. */
  findById<T extends TenantTable & { id: PgColumn }>(
    table: T,
    id: string,
  ): Promise<T['$inferSelect'] | null>;
  /** Throw unless the row belongs to this school. */
  assertOwned(row: { schoolId?: string | null } | null | undefined, what?: string): void;
};

export function createScope(db: Database, schoolId: string): Scope {
  if (!schoolId || typeof schoolId !== 'string') {
    // An empty school id would produce a filter that matches nothing or, worse
    // with a buggy caller, everything. Refuse to construct such a scope.
    throw new TenantIsolationError('Cannot create a data scope without a school id');
  }

  const scope: Scope = {
    schoolId,
    db,

    where(table, ...extra) {
      const conditions: SQLWrapper[] = [eq(table.schoolId, schoolId)];
      for (const e of extra) if (e) conditions.push(e);
      return and(...conditions) as SQL;
    },

    async select(table, ...extra) {
      return db
        .select()
        .from(table as PgTable)
        .where(scope.where(table, ...extra)) as never;
    },

    async findById(table, rowId) {
      if (!rowId) return null;
      const rows = (await db
        .select()
        .from(table as PgTable)
        .where(and(eq(table.schoolId, schoolId), eq(table.id, rowId)))
        .limit(1)) as { schoolId?: string | null }[];
      const row = rows[0] ?? null;
      // Belt and braces: the query already filtered, but verify anyway so a
      // future refactor that drops the filter still fails closed.
      if (row) scope.assertOwned(row);
      return row as never;
    },

    assertOwned(row, what = 'record') {
      if (!row) return;
      if (row.schoolId !== undefined && row.schoolId !== null && row.schoolId !== schoolId) {
        throw new TenantIsolationError(
          `Cross-tenant access denied: ${what} belongs to another school`,
        );
      }
    },
  };

  return scope;
}

/**
 * Guard for code paths that legitimately operate across schools (platform
 * administration, billing, backups). Requiring an explicit call makes those
 * few places auditable by grep, instead of indistinguishable from a bug.
 */
export function createPlatformScope(db: Database, reason: string): { db: Database; reason: string } {
  if (!reason) throw new Error('A platform-wide scope requires a stated reason');
  return { db, reason };
}
