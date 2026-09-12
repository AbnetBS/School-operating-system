import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../../lib/auth/context.ts';
import { route, created } from '../../../../../../lib/api/respond.ts';
import { addCopiesSchema } from '../../../../../../lib/operations/schema.ts';
import { addCopies } from '../../../../../../lib/operations/library.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Add physical copies of a title. Accession numbers are generated server-side. */
export const POST = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = addCopiesSchema.parse(await request.json().catch(() => ({})));
    const copies = await addCopies(ctx, id, input);
    return created({ added: copies.length, from: copies[0]?.accessionNumber ?? null });
  },
);
