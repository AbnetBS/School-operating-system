/**
 * Library catalogue.
 *
 * Reading the catalogue needs `library.view`; changing it needs
 * `library.manage`. Both are checked here, server-side, because the form that
 * normally calls this endpoint is not the only thing that can.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created, readPagination, paged } from '../../../../lib/api/respond.ts';
import { libraryItemSchema } from '../../../../lib/operations/schema.ts';
import { listLibraryItems, createLibraryItem } from '../../../../lib/operations/library.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('library');
  ctx.require('library.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);
  const { items, total } = await listLibraryItems(ctx, {
    q: url.searchParams.get('q'),
    itemType: url.searchParams.get('itemType'),
    category: url.searchParams.get('category'),
    availableOnly: url.searchParams.get('availableOnly') === '1',
    limit: pagination.limit,
    offset: pagination.offset,
  });

  return ok(paged(items, total, pagination));
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  const input = libraryItemSchema.parse(await request.json().catch(() => ({})));
  return created(await createLibraryItem(ctx, input));
});
