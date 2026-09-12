/**
 * Library service.
 *
 * THE CENTRAL RULE: AVAILABILITY IS DERIVED, NEVER STORED.
 *
 * A `library_items` row is a title; a `library_copies` row is a physical book.
 * How many copies can be lent right now is a question about the copies and the
 * open loans, computed at read time. There is no `available_count` column to
 * drift, and no pair of writes that can be interrupted halfway.
 *
 * This mirrors Group 7: a student's balance is never stored either, because a
 * stored total is a second source of truth that will eventually disagree with
 * the first one.
 *
 * ISSUING IS THE DANGEROUS PATH. Two librarians scanning the last copy at the
 * same moment must not both succeed. Three things prevent it, in order:
 *
 *   1. The issue runs in a transaction and locks the copy row `FOR UPDATE`
 *      before checking whether it is free.
 *   2. The open-loan check happens inside that lock.
 *   3. A partial unique index — `library_loans_open_copy_uq` on (copy_id)
 *      WHERE returned_at IS NULL — makes a second open loan impossible even if
 *      the first two were somehow bypassed.
 *
 * Layer 3 is the one that still works when a future refactor forgets layers 1
 * and 2. NOTE: PGlite serialises transactions, so a behavioural test cannot
 * distinguish a locked implementation from an unlocked one. The tests assert on
 * the emitted SQL and on the database constraint instead of on timing.
 *
 * AUTHORISATION IS THE CALLER'S JOB. As in finance, the read functions here do
 * NOT check permissions — they are used by routes, by the portal and by the
 * dashboard, each of which has different rules about who may call them. Every
 * caller must gate first. The mutations DO check, because there is exactly one
 * correct answer for who may issue a book.
 */

import { and, asc, desc, eq, ilike, isNull, or, sql, count, inArray, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import { OperationsError, notFoundError } from './errors.ts';
import {
  libraryItems,
  libraryCopies,
  libraryLoans,
} from '../../db/schema/operations.ts';
import { students, staff } from '../../db/schema/people.ts';
import { users, sections, gradeLevels } from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { getSetting, getSettings } from '../settings/service.ts';
import { todayIso } from '../calendar/ethiopian.ts';
import type {
  LibraryItemInput,
  LibraryCopyInput,
  AddCopiesInput,
  IssueLoanInput,
  ReturnLoanInput,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

/**
 * Add whole days to a YYYY-MM-DD string, staying in the calendar domain.
 *
 * Uses UTC arithmetic on a date-only value deliberately: constructing a local
 * Date from 'YYYY-MM-DD' and adding days shifts across a DST boundary in some
 * timezones, producing an off-by-one due date.
 */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const base = Date.UTC(y!, m! - 1, d!);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Derived-availability expressions
// ---------------------------------------------------------------------------

/**
 * Number of copies of a title that could be lent: physically present (status
 * 'available') and not currently out.
 *
 * Written as a correlated subquery rather than a join so it composes into a
 * list query without multiplying rows.
 */
/**
 * NOTE ON `${libraryItems}.${sql.identifier('id')}`.
 *
 * Drizzle only table-qualifies an interpolated column when the outer query has
 * a JOIN. These expressions are used both with and without one, so a bare
 * `${libraryItems.id}` renders as `"id"` inside the subquery, where it binds to
 * the SUBQUERY's own table and silently counts every copy in the school. The
 * explicit qualification is what makes the correlation correct. The same trap
 * was hit in finance; see `paidExpr` there.
 */
const availableCopiesExpr = sql<number>`(
  select count(*)::int from ${libraryCopies} c
  where c.item_id = ${libraryItems}.${sql.identifier('id')}
    and c.status = 'available'
    and not exists (
      select 1 from ${libraryLoans} l
      where l.copy_id = c.id and l.returned_at is null
    )
)`;

const totalCopiesExpr = sql<number>`(
  select count(*)::int from ${libraryCopies} c
  where c.item_id = ${libraryItems}.${sql.identifier('id')}
)`;

const onLoanExpr = sql<number>`(
  select count(*)::int from ${libraryLoans} l
  join ${libraryCopies} c on c.id = l.copy_id
  where c.item_id = ${libraryItems}.${sql.identifier('id')} and l.returned_at is null
)`;

export type LibraryItemRow = {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  itemType: string;
  category: string | null;
  callNumber: string | null;
  language: string | null;
  active: boolean;
  totalCopies: number;
  availableCopies: number;
  onLoan: number;
};

// ---------------------------------------------------------------------------
// Catalogue reads
// ---------------------------------------------------------------------------

export async function listLibraryItems(
  ctx: AuthContext,
  query: {
    q?: string | null;
    itemType?: string | null;
    category?: string | null;
    availableOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: LibraryItemRow[]; total: number }> {
  const conditions: SQL[] = [eq(libraryItems.schoolId, ctx.schoolId)];

  if (query.q) {
    const needle = `%${query.q}%`;
    const match = or(
      ilike(libraryItems.title, needle),
      ilike(libraryItems.author, needle),
      ilike(libraryItems.isbn, needle),
      ilike(libraryItems.callNumber, needle),
    );
    if (match) conditions.push(match);
  }
  if (query.itemType) conditions.push(eq(libraryItems.itemType, query.itemType));
  if (query.category) conditions.push(eq(libraryItems.category, query.category));

  const where = and(...conditions) as SQL;

  const rows = await ctx.db
    .select({
      id: libraryItems.id,
      title: libraryItems.title,
      author: libraryItems.author,
      isbn: libraryItems.isbn,
      itemType: libraryItems.itemType,
      category: libraryItems.category,
      callNumber: libraryItems.callNumber,
      language: libraryItems.language,
      active: libraryItems.active,
      totalCopies: totalCopiesExpr,
      availableCopies: availableCopiesExpr,
      onLoan: onLoanExpr,
    })
    .from(libraryItems)
    .where(query.availableOnly ? and(where, sql`${availableCopiesExpr} > 0`) : where)
    .orderBy(asc(libraryItems.title))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(libraryItems)
    .where(query.availableOnly ? and(where, sql`${availableCopiesExpr} > 0`) : where);

  return { items: rows as LibraryItemRow[], total: totalRow?.total ?? 0 };
}

/**
 * Fetch one title, or throw 404.
 *
 * Named `…Owned` for the same reason as `getChargeOwned` in finance: the school
 * filter is inside, so no caller can forget it. A title belonging to another
 * school is reported as missing, never as forbidden — a 403 would confirm the
 * id exists somewhere.
 */
export async function getLibraryItemOwned(ctx: AuthContext, itemId: string) {
  const [row] = await ctx.db
    .select()
    .from(libraryItems)
    .where(and(eq(libraryItems.schoolId, ctx.schoolId), eq(libraryItems.id, itemId)))
    .limit(1);
  if (!row) throw notFoundError('Item');
  return row;
}

export type CopyRow = {
  id: string;
  accessionNumber: string;
  status: string;
  condition: string;
  acquiredOn: string | null;
  note: string | null;
  loanId: string | null;
  borrowerName: string | null;
  dueOn: string | null;
};

/** Copies of one title, each with its current loan if it has one. */
export async function listCopies(ctx: AuthContext, itemId: string): Promise<CopyRow[]> {
  await getLibraryItemOwned(ctx, itemId);

  const rows = await ctx.db
    .select({
      id: libraryCopies.id,
      accessionNumber: libraryCopies.accessionNumber,
      status: libraryCopies.status,
      condition: libraryCopies.condition,
      acquiredOn: libraryCopies.acquiredOn,
      note: libraryCopies.note,
      loanId: libraryLoans.id,
      dueOn: libraryLoans.dueOn,
      studentGiven: students.givenName,
      studentFather: students.fatherName,
      staffGiven: users.givenName,
      staffFather: users.fatherName,
    })
    .from(libraryCopies)
    .leftJoin(
      libraryLoans,
      and(eq(libraryLoans.copyId, libraryCopies.id), isNull(libraryLoans.returnedAt)),
    )
    .leftJoin(students, eq(students.id, libraryLoans.studentId))
    .leftJoin(staff, eq(staff.id, libraryLoans.staffId))
    .leftJoin(users, eq(users.id, staff.userId))
    .where(and(eq(libraryCopies.schoolId, ctx.schoolId), eq(libraryCopies.itemId, itemId)))
    .orderBy(asc(libraryCopies.accessionNumber));

  return rows.map((r) => ({
    id: r.id,
    accessionNumber: r.accessionNumber,
    status: r.status,
    condition: r.condition,
    acquiredOn: r.acquiredOn,
    note: r.note,
    loanId: r.loanId,
    dueOn: r.dueOn,
    borrowerName: r.studentGiven
      ? [r.studentGiven, r.studentFather].filter(Boolean).join(' ')
      : r.staffGiven
        ? [r.staffGiven, r.staffFather].filter(Boolean).join(' ')
        : null,
  }));
}

// ---------------------------------------------------------------------------
// Catalogue writes
// ---------------------------------------------------------------------------

export async function createLibraryItem(ctx: AuthContext, input: LibraryItemInput) {
  await ctx.requireModule('library');
  ctx.require('library.manage');

  const [row] = await ctx.db
    .insert(libraryItems)
    .values({
      schoolId: ctx.schoolId,
      title: input.title,
      author: input.author ?? null,
      isbn: input.isbn ?? null,
      publisher: input.publisher ?? null,
      publishedYear: input.publishedYear ?? null,
      itemType: input.itemType,
      category: input.category ?? null,
      callNumber: input.callNumber ?? null,
      language: input.language ?? null,
      description: input.description ?? null,
      active: input.active,
    })
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'library.itemCreate',
    entityType: 'libraryItem',
    entityId: row!.id,
    summary: row!.title,
    newValue: { title: row!.title, itemType: row!.itemType },
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

export async function updateLibraryItem(
  ctx: AuthContext,
  itemId: string,
  input: LibraryItemInput,
) {
  await ctx.requireModule('library');
  ctx.require('library.manage');

  const before = await getLibraryItemOwned(ctx, itemId);

  const [row] = await ctx.db
    .update(libraryItems)
    .set({
      title: input.title,
      author: input.author ?? null,
      isbn: input.isbn ?? null,
      publisher: input.publisher ?? null,
      publishedYear: input.publishedYear ?? null,
      itemType: input.itemType,
      category: input.category ?? null,
      callNumber: input.callNumber ?? null,
      language: input.language ?? null,
      description: input.description ?? null,
      active: input.active,
      updatedAt: new Date(),
    })
    .where(and(eq(libraryItems.schoolId, ctx.schoolId), eq(libraryItems.id, itemId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'library.itemUpdate',
    entityType: 'libraryItem',
    entityId: itemId,
    summary: row!.title,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

/**
 * Add copies of a title.
 *
 * Accession numbers are generated from the school's own prefix and the highest
 * existing number, then inserted in one statement. A collision with an
 * existing accession number raises 23505 and the whole batch is rejected —
 * partially-added stock would be worse than none.
 */
export async function addCopies(ctx: AuthContext, itemId: string, input: AddCopiesInput) {
  await ctx.requireModule('library');
  ctx.require('library.manage');

  const item = await getLibraryItemOwned(ctx, itemId);

  const prefix = (input.prefix ?? '').trim() || 'ACC';

  // Highest numeric suffix already used with this prefix, so re-adding stock
  // after a deletion does not reuse a number that is on a physical label.
  const [maxRow] = await ctx.db
    .select({
      maxSeq: sql<number>`coalesce(max(
        nullif(regexp_replace(${libraryCopies.accessionNumber}, '^.*[^0-9]', '', 'g'), '')::int
      ), 0)`,
    })
    .from(libraryCopies)
    .where(
      and(
        eq(libraryCopies.schoolId, ctx.schoolId),
        ilike(libraryCopies.accessionNumber, `${prefix}%`),
      ),
    );

  let seq = Number(maxRow?.maxSeq ?? 0);

  const values = Array.from({ length: input.count }, () => {
    seq += 1;
    return {
      schoolId: ctx.schoolId,
      itemId,
      accessionNumber: `${prefix}-${String(seq).padStart(5, '0')}`,
      status: 'available',
      condition: input.condition,
      acquiredOn: input.acquiredOn ?? null,
    };
  });

  const rows = await ctx.db.insert(libraryCopies).values(values).returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'library.copyCreate',
    entityType: 'libraryItem',
    entityId: itemId,
    summary: `Added ${rows.length} copies of ${item.title}`,
    newValue: { count: rows.length, from: values[0]?.accessionNumber },
    ipAddress: ctx.ipAddress,
  });

  return rows;
}

export async function updateCopy(ctx: AuthContext, copyId: string, input: LibraryCopyInput) {
  await ctx.requireModule('library');
  ctx.require('library.manage');

  const [before] = await ctx.db
    .select()
    .from(libraryCopies)
    .where(and(eq(libraryCopies.schoolId, ctx.schoolId), eq(libraryCopies.id, copyId)))
    .limit(1);
  if (!before) throw notFoundError('Copy');

  const [row] = await ctx.db
    .update(libraryCopies)
    .set({
      accessionNumber: input.accessionNumber,
      status: input.status,
      condition: input.condition,
      acquiredOn: input.acquiredOn ?? null,
      note: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(libraryCopies.schoolId, ctx.schoolId), eq(libraryCopies.id, copyId)))
    .returning();

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'library.copyUpdate',
    entityType: 'libraryCopy',
    entityId: copyId,
    summary: row!.accessionNumber,
    ...diffValues(before as Record<string, unknown>, row as Record<string, unknown>),
    ipAddress: ctx.ipAddress,
  });

  return row!;
}

// ---------------------------------------------------------------------------
// Lending
// ---------------------------------------------------------------------------

export type LoanRow = {
  id: string;
  copyId: string;
  accessionNumber: string;
  itemId: string;
  title: string;
  borrowerType: 'student' | 'staff';
  borrowerId: string;
  borrowerName: string;
  borrowerRef: string | null;
  issuedOn: string;
  dueOn: string;
  returnedOn: string | null;
  renewalCount: number;
  fineCents: number;
  fineWaived: boolean;
  daysOverdue: number;
};

const daysOverdueExpr = sql<number>`
  greatest(0, (coalesce(${libraryLoans.returnedOn}, current_date) - ${libraryLoans.dueOn}))::int
`;

export async function listLoans(
  ctx: AuthContext,
  query: {
    status?: 'open' | 'overdue' | 'returned' | 'all';
    studentId?: string | null;
    staffId?: string | null;
    itemId?: string | null;
    q?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ loans: LoanRow[]; total: number }> {
  const conditions: SQL[] = [eq(libraryLoans.schoolId, ctx.schoolId)];

  switch (query.status ?? 'open') {
    case 'open':
      conditions.push(isNull(libraryLoans.returnedAt));
      break;
    case 'overdue':
      conditions.push(isNull(libraryLoans.returnedAt));
      conditions.push(sql`${libraryLoans.dueOn} < current_date`);
      break;
    case 'returned':
      conditions.push(sql`${libraryLoans.returnedAt} is not null`);
      break;
    case 'all':
      break;
  }

  if (query.studentId) conditions.push(eq(libraryLoans.studentId, query.studentId));
  if (query.staffId) conditions.push(eq(libraryLoans.staffId, query.staffId));
  if (query.itemId) conditions.push(eq(libraryLoans.itemId, query.itemId));
  if (query.q) {
    const needle = `%${query.q}%`;
    const match = or(
      ilike(libraryItems.title, needle),
      ilike(libraryCopies.accessionNumber, needle),
      ilike(students.givenName, needle),
      ilike(students.studentCode, needle),
    );
    if (match) conditions.push(match);
  }

  const where = and(...conditions) as SQL;

  const base = ctx.db
    .select({
      id: libraryLoans.id,
      copyId: libraryLoans.copyId,
      accessionNumber: libraryCopies.accessionNumber,
      itemId: libraryLoans.itemId,
      title: libraryItems.title,
      studentId: libraryLoans.studentId,
      staffId: libraryLoans.staffId,
      studentGiven: students.givenName,
      studentFather: students.fatherName,
      studentCode: students.studentCode,
      staffGiven: users.givenName,
      staffFather: users.fatherName,
      staffCode: staff.staffCode,
      issuedOn: libraryLoans.issuedOn,
      dueOn: libraryLoans.dueOn,
      returnedOn: libraryLoans.returnedOn,
      renewalCount: libraryLoans.renewalCount,
      fineCents: libraryLoans.fineCents,
      fineWaived: libraryLoans.fineWaived,
      daysOverdue: daysOverdueExpr,
    })
    .from(libraryLoans)
    .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
    .innerJoin(libraryItems, eq(libraryItems.id, libraryLoans.itemId))
    .leftJoin(students, eq(students.id, libraryLoans.studentId))
    .leftJoin(staff, eq(staff.id, libraryLoans.staffId))
    .leftJoin(users, eq(users.id, staff.userId));

  const rows = await base
    .where(where)
    .orderBy(asc(libraryLoans.dueOn), asc(libraryLoans.id))
    .limit(query.limit ?? 25)
    .offset(query.offset ?? 0);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(libraryLoans)
    .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
    .innerJoin(libraryItems, eq(libraryItems.id, libraryLoans.itemId))
    .leftJoin(students, eq(students.id, libraryLoans.studentId))
    .where(where);

  const loans: LoanRow[] = rows.map((r) => ({
    id: r.id,
    copyId: r.copyId,
    accessionNumber: r.accessionNumber,
    itemId: r.itemId,
    title: r.title,
    borrowerType: r.studentId ? 'student' : 'staff',
    borrowerId: (r.studentId ?? r.staffId)!,
    borrowerName: r.studentId
      ? [r.studentGiven, r.studentFather].filter(Boolean).join(' ')
      : [r.staffGiven, r.staffFather].filter(Boolean).join(' '),
    borrowerRef: r.studentId ? r.studentCode : r.staffCode,
    issuedOn: r.issuedOn,
    dueOn: r.dueOn,
    returnedOn: r.returnedOn,
    renewalCount: r.renewalCount,
    fineCents: r.fineCents,
    fineWaived: r.fineWaived,
    daysOverdue: Number(r.daysOverdue ?? 0),
  }));

  return { loans, total: totalRow?.total ?? 0 };
}

/**
 * Issue a copy to a borrower.
 *
 * The lock/check/insert sequence is described in the module header. Read it
 * before changing anything in this function.
 */
export async function issueLoan(ctx: AuthContext, input: IssueLoanInput) {
  await ctx.requireModule('library');
  ctx.require('library.issue');

  // The borrower must be someone this user is allowed to see. Without this a
  // librarian could confirm the existence of a pupil id by issuing to it.
  if (input.studentId) {
    await ctx.requireStudentAccess(input.studentId);
  }

  const { library: settings, locale } = await getSettings(ctx.db, ctx.schoolId, [
    'library',
    'locale',
  ]);
  const loanDays = settings.loanDays;
  const maxPerBorrower = settings.maxLoansPerBorrower;

  // School-local "today", not the server's. A book issued at 08:00 in Addis
  // must not be dated to the previous day because the server runs in UTC.
  const today = todayIso(locale.timezone);
  const defaultDue = addDays(today, loanDays);

  const result = await ctx.db.transaction(async (tx) => {
    // ---- 1. Lock the copy, then look at it -------------------------------
    const [copy] = await tx
      .select({
        id: libraryCopies.id,
        itemId: libraryCopies.itemId,
        status: libraryCopies.status,
        accessionNumber: libraryCopies.accessionNumber,
      })
      .from(libraryCopies)
      .where(and(eq(libraryCopies.schoolId, ctx.schoolId), eq(libraryCopies.id, input.copyId)))
      .for('update');

    if (!copy) throw notFoundError('Copy');

    if (copy.status !== 'available') {
      throw new OperationsError(`This copy is marked ${copy.status} and cannot be issued.`, 403);
    }

    // ---- 2. Is it already out? Checked inside the lock -------------------
    const [openLoan] = await tx
      .select({ id: libraryLoans.id })
      .from(libraryLoans)
      .where(and(eq(libraryLoans.copyId, copy.id), isNull(libraryLoans.returnedAt)))
      .limit(1);

    if (openLoan) {
      throw new OperationsError('This copy is already on loan.', 409);
    }

    // ---- 3. Borrowing limit ----------------------------------------------
    const borrowerCondition = input.studentId
      ? eq(libraryLoans.studentId, input.studentId)
      : eq(libraryLoans.staffId, input.staffId!);

    const [openCount] = await tx
      .select({ n: count() })
      .from(libraryLoans)
      .where(
        and(
          eq(libraryLoans.schoolId, ctx.schoolId),
          borrowerCondition,
          isNull(libraryLoans.returnedAt),
        ),
      );

    if ((openCount?.n ?? 0) >= maxPerBorrower) {
      throw new OperationsError(
        `This borrower already has ${openCount?.n} items out; the limit is ${maxPerBorrower}.`,
        409,
      );
    }

    // ---- 4. Insert --------------------------------------------------------
    const dueOn = input.dueOn ?? defaultDue;
    if (dueOn < today) {
      throw new OperationsError('The due date cannot be before today.', 400, {
        dueOn: 'The due date cannot be before today.',
      });
    }

    const [loan] = await tx
      .insert(libraryLoans)
      .values({
        schoolId: ctx.schoolId,
        copyId: copy.id,
        itemId: copy.itemId,
        studentId: input.studentId ?? null,
        staffId: input.staffId ?? null,
        issuedOn: today,
        dueOn,
        issuedBy: ctx.user.userId,
        note: input.note ?? null,
      })
      .returning();

    return { loan: loan!, accessionNumber: copy.accessionNumber };
  });

  // Audit and events happen AFTER the transaction commits, never inside it.
  // A failing notification handler must not roll back a book that has
  // physically left the shelf — the same rule finance follows for payments.
  const [item] = await ctx.db
    .select({ title: libraryItems.title })
    .from(libraryItems)
    .where(and(eq(libraryItems.schoolId, ctx.schoolId), eq(libraryItems.id, result.loan.itemId)))
    .limit(1);

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'library.issue',
    entityType: 'libraryLoan',
    entityId: result.loan.id,
    summary: `${item?.title ?? 'Item'} (${result.accessionNumber}) issued, due ${result.loan.dueOn}`,
    newValue: {
      copyId: result.loan.copyId,
      studentId: result.loan.studentId,
      staffId: result.loan.staffId,
      dueOn: result.loan.dueOn,
    },
    ipAddress: ctx.ipAddress,
  });

  await emitEvent(ctx.db, ctx.schoolId, 'library.loanIssued', {
    loanId: result.loan.id,
    studentId: result.loan.studentId,
    staffId: result.loan.staffId,
    itemTitle: item?.title ?? '',
    dueOn: result.loan.dueOn,
  });

  return result;
}

/** Take a copy back. Append-only in spirit: the loan row is closed, not deleted. */
export async function returnLoan(ctx: AuthContext, loanId: string, input: ReturnLoanInput) {
  await ctx.requireModule('library');
  ctx.require('library.issue');

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const today = todayIso(locale.timezone);

  const updated = await ctx.db.transaction(async (tx) => {
    const [loan] = await tx
      .select()
      .from(libraryLoans)
      .where(and(eq(libraryLoans.schoolId, ctx.schoolId), eq(libraryLoans.id, loanId)))
      .for('update');

    if (!loan) throw notFoundError('Loan');
    if (loan.returnedAt) throw new OperationsError('This loan has already been closed.', 409);

    const [updated] = await tx
      .update(libraryLoans)
      .set({
        returnedAt: new Date(),
        returnedOn: today,
        receivedBy: ctx.user.userId,
        fineCents: input.waiveFine ? 0 : (input.fineCents ?? 0),
        fineWaived: input.waiveFine,
        note: input.note ?? loan.note,
        updatedAt: new Date(),
      })
      .where(and(eq(libraryLoans.schoolId, ctx.schoolId), eq(libraryLoans.id, loanId)))
      .returning();

    // A copy returned damaged stops being lendable without anyone having to
    // remember to edit it separately.
    if (input.condition && input.condition !== 'good' && input.condition !== 'new') {
      await tx
        .update(libraryCopies)
        .set({
          condition: input.condition,
          status: input.condition === 'poor' ? 'damaged' : 'available',
          updatedAt: new Date(),
        })
        .where(and(eq(libraryCopies.schoolId, ctx.schoolId), eq(libraryCopies.id, loan.copyId)));
    }

    return updated!;
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'library.return',
    entityType: 'libraryLoan',
    entityId: updated.id,
    summary:
      updated.fineCents > 0
        ? `Returned with a fine of ${updated.fineCents} cents`
        : 'Returned',
    newValue: {
      returnedOn: updated.returnedOn,
      fineCents: updated.fineCents,
      fineWaived: updated.fineWaived,
      condition: input.condition ?? null,
    },
    ipAddress: ctx.ipAddress,
  });

  if (input.waiveFine) {
    await recordAudit(ctx.db, {
      schoolId: ctx.schoolId,
      actorUserId: ctx.user.userId,
      actorName: ctx.displayName(),
      action: 'library.fineWaive',
      entityType: 'libraryLoan',
      entityId: updated.id,
      summary: 'Fine waived',
      reason: input.note ?? null,
      ipAddress: ctx.ipAddress,
    });
  }

  return updated;
}

/** Extend a loan. Renewal is refused once the school's limit is reached. */
export async function renewLoan(ctx: AuthContext, loanId: string) {
  await ctx.requireModule('library');
  ctx.require('library.issue');

  const settings = await getSetting(ctx.db, ctx.schoolId, 'library');
  const loanDays = settings.loanDays;
  const maxRenewals = settings.maxRenewals;

  const renewed = await ctx.db.transaction(async (tx) => {
    const [loan] = await tx
      .select()
      .from(libraryLoans)
      .where(and(eq(libraryLoans.schoolId, ctx.schoolId), eq(libraryLoans.id, loanId)))
      .for('update');

    if (!loan) throw notFoundError('Loan');
    if (loan.returnedAt) throw new OperationsError('This loan has already been closed.', 409);
    if (loan.renewalCount >= maxRenewals) {
      throw new OperationsError(`This loan has already been renewed ${maxRenewals} times.`, 409);
    }

    const [updated] = await tx
      .update(libraryLoans)
      .set({
        dueOn: addDays(loan.dueOn, loanDays),
        renewalCount: loan.renewalCount + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(libraryLoans.schoolId, ctx.schoolId), eq(libraryLoans.id, loanId)))
      .returning();

    return updated!;
  });

  await recordAudit(ctx.db, {
    schoolId: ctx.schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'library.renew',
    entityType: 'libraryLoan',
    entityId: renewed.id,
    summary: `Renewed to ${renewed.dueOn}`,
    newValue: { dueOn: renewed.dueOn, renewalCount: renewed.renewalCount },
    ipAddress: ctx.ipAddress,
  });

  return renewed;
}
