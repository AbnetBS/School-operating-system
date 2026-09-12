import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { route, ok, badRequest } from '../../../lib/api/respond.ts';
import { requireAuth } from '../../../lib/auth/context.ts';
import { globalSearch, MIN_QUERY_LENGTH, type SearchKind } from '../../../lib/analytics/search.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEARCH_KINDS = [
  'student',
  'guardian',
  'staff',
  'section',
  'subject',
  'fee',
  'library',
  'inventory',
  'asset',
  'vehicle',
  'route',
  'document',
] as const;

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  kinds: z.string().optional(),
});

/**
 * GET /api/search?q=…
 *
 * Permission-aware search across the school. The service decides which sources
 * the caller may see; this route's job is to establish who is asking and to
 * refuse the callers who should not be asking at all.
 *
 * Portal users are rejected outright. A parent or a pupil has purpose-built
 * screens for their own records; letting them run a school-wide query would
 * turn a convenience feature into a directory of other people's children.
 */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();

  // Staff-only. `student.view` is the weakest permission that implies a
  // legitimate operational view of the school; a portal account holds none of
  // the searchable-source permissions, so without this guard it would receive
  // an empty result set rather than a refusal — the same outcome, but for the
  // wrong reason and one permission change away from being a leak.
  ctx.requireAny(
    'student.view',
    'staff.view',
    'guardian.view',
    'academic.view',
    'fee.view',
    'library.view',
    'inventory.view',
    'asset.view',
    'transport.view',
    'document.view',
  );

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest('A search term is required.');

  const kinds = parsed.data.kinds
    ?.split(',')
    .map((k) => k.trim())
    .filter((k): k is SearchKind => (SEARCH_KINDS as readonly string[]).includes(k));

  const results = await globalSearch(ctx, parsed.data.q, kinds ? { kinds } : {});

  return ok({ ...results, minLength: MIN_QUERY_LENGTH });
});
