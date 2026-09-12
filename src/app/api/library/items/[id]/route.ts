import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { libraryItemSchema } from '../../../../../lib/operations/schema.ts';
import {
  getLibraryItemOwned,
  listCopies,
  updateLibraryItem,
} from '../../../../../lib/operations/library.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('library');
    ctx.require('library.view');

    const { id } = await context.params;
    const item = await getLibraryItemOwned(ctx, id);
    const copies = await listCopies(ctx, id);
    return ok({ item, copies });
  },
);

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = libraryItemSchema.parse(await request.json().catch(() => ({})));
    return ok(await updateLibraryItem(ctx, id, input));
  },
);
