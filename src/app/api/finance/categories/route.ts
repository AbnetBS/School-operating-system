/**
 * Fee categories.
 *
 * A category is the school's own label for a kind of charge — tuition,
 * transport, a uniform, an exam entry. Nothing in the system branches on a
 * category key, so a school can invent whatever it needs and delete the
 * suggestions it does not want.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok, created } from '../../../../lib/api/respond.ts';
import { feeCategorySchema } from '../../../../lib/finance/schema.ts';
import { listFeeCategories, createFeeCategory } from '../../../../lib/finance/service.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turn a display name into a slug.
 *
 * The key exists so imports and reports have something stable to match on;
 * asking a registrar to invent one is a needless obstacle. A name that
 * produces no usable characters — for example one written entirely in
 * Ethiopic — falls back to a generated key rather than being rejected.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `category-${crypto.randomUUID().slice(0, 8)}`;
}

/** The browser sends a name; the key is optional and derived when absent. */
const createBodySchema = feeCategorySchema
  .partial({ key: true })
  .extend({ key: z.string().trim().max(60).optional() });

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('fees');
  ctx.require('fee.view');

  const url = new URL(request.url);
  const categories = await listFeeCategories(ctx, url.searchParams.get('includeInactive') === '1');
  return ok({ categories });
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('fees');
  ctx.require('fee.manage');

  const body = createBodySchema.parse(await request.json().catch(() => ({})));
  const input = feeCategorySchema.parse({
    ...body,
    key: body.key && body.key.length > 0 ? body.key : slugify(body.name),
  });

  return created(await createFeeCategory(ctx, input));
});
