import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../../lib/api/respond.ts';
import { issueLoanSchema } from '../../../../lib/operations/schema.ts';
import { listLoans, issueLoan } from '../../../../lib/operations/library.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['open', 'overdue', 'returned', 'all'] as const;
type LoanStatus = (typeof STATUSES)[number];

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('library');
  ctx.require('library.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);
  const requested = url.searchParams.get('status');
  const status = STATUSES.includes(requested as LoanStatus) ? (requested as LoanStatus) : 'open';

  const { loans, total } = await listLoans(ctx, {
    status,
    studentId: url.searchParams.get('studentId'),
    staffId: url.searchParams.get('staffId'),
    itemId: url.searchParams.get('itemId'),
    q: url.searchParams.get('q'),
    limit: pagination.limit,
    offset: pagination.offset,
  });

  return ok(paged(loans, total, pagination));
});

/** Issue a copy. The server picks the due date from the school's loan policy. */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = issueLoanSchema.parse(await request.json().catch(() => ({})));
  const { loan, accessionNumber } = await issueLoan(ctx, input);
  return created({ id: loan.id, dueOn: loan.dueOn, accessionNumber });
});
