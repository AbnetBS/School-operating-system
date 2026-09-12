/**
 * A single physical copy.
 *
 * `updateCopy` has existed in the service since Group 8 with no route in front
 * of it, so a librarian could not mark a copy lost or damaged through the
 * application. This exposes it — the permission check and the school filter
 * both live in the service, as with every other library endpoint.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../../../lib/auth/context.ts';
import { route, ok } from '../../../../../lib/api/respond.ts';
import { libraryCopySchema } from '../../../../../lib/operations/schema.ts';
import { updateCopy } from '../../../../../lib/operations/library.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;
    const input = libraryCopySchema.parse(await request.json().catch(() => ({})));
    return ok(await updateCopy(ctx, id, input));
  },
);
