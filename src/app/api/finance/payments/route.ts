/**
 * Payments.
 *
 * The POST body never contains a balance or an allocation amount — only the
 * student, the total received and optionally which charges to settle. The
 * server derives everything else inside a locked transaction, so a tampered
 * browser cannot decide how much a debt was reduced by.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, readPagination } from '../../../../lib/api/respond.ts';
import { recordPaymentSchema } from '../../../../lib/finance/schema.ts';
import { recordPayment, listPayments, announcePayment } from '../../../../lib/finance/payments.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('payments');
  ctx.require('payment.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);
  const studentId = url.searchParams.get('studentId');

  // Filtering by student still requires the right to see that student.
  if (studentId) await ctx.requireStudentAccess(studentId);

  const result = await listPayments(ctx, {
    studentId: studentId ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    method: url.searchParams.get('method') ?? undefined,
    includeVoided: url.searchParams.get('includeVoided') === '1',
    limit: pagination.limit,
    offset: pagination.offset,
  });

  return ok({ ...result, page: pagination.page, pageSize: pagination.limit });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('payments');
  ctx.require('payment.record');

  const input = recordPaymentSchema.parse(await request.json().catch(() => ({})));
  const result = await recordPayment(ctx, input);

  // Notify only for a genuinely new payment. A replayed submission must not
  // tell the family twice that money was received.
  if (!result.duplicate) {
    await announcePayment(
      ctx,
      {
        id: result.id,
        receiptNumber: result.receiptNumber,
        amountCents: result.amountCents,
        method: input.method,
      },
      input.studentId,
    );
  }

  return result.duplicate ? ok(result) : created(result);
});
