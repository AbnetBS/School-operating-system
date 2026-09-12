/**
 * One document: download the bytes, or delete it.
 *
 * The download is the endpoint that matters. `getDocumentForAccess` is the
 * single place that decides "may this person read this file?" — it enforces
 * the school boundary, then `staff.view` for a staff document, then
 * `requireStudentAccess` (including `restrict.ownSectionsOnly`) for a pupil's.
 * A document id belonging to another school is reported as 404, exactly like a
 * document that does not exist, so guessing ids reveals nothing.
 *
 * Nothing here is cacheable and nothing is served inline.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/auth/context.ts';
import { route, ok } from '../../../../lib/api/respond.ts';
import { getDocumentForAccess, deleteDocument } from '../../../../lib/operations/calendar.ts';
import {
  getObject,
  deleteObject,
  safeFileName,
  MissingObjectError,
} from '../../../../lib/operations/storage.ts';
import { recordAudit } from '../../../../lib/audit/index.ts';
import { OperationsError } from '../../../../lib/operations/errors.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    await ctx.requireModule('documents');

    const { id } = await context.params;

    // Authorisation happens here, before a single byte is read from disk.
    const row = await getDocumentForAccess(ctx, id);

    // A row whose bytes have vanished is a real, permanent condition — not a
    // transient fault the user should retry. Report it as 410 Gone with an
    // explanation rather than a generic 500.
    let bytes: Buffer;
    try {
      bytes = await getObject(row.storageKey);
    } catch (error) {
      if (error instanceof MissingObjectError) {
        throw new OperationsError(error.message, 410);
      }
      throw error;
    }

    // Reading a pupil's medical record is itself an event worth recording.
    await recordAudit(ctx.db, {
      schoolId: ctx.schoolId,
      actorUserId: ctx.user.userId,
      actorName: ctx.displayName(),
      action: 'document.download',
      entityType: 'document',
      entityId: row.id,
      summary: row.title,
      ipAddress: ctx.ipAddress,
    });

    const filename = safeFileName(row.fileName, 'bin');

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': row.mimeType,
        // `attachment` and `nosniff` together mean a stored file cannot execute
        // as script in the school's own origin.
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Length': String(bytes.length),
        // A pupil's document must never sit in a shared cache.
        'Cache-Control': 'private, no-store, max-age=0',
      },
    });
  },
);

export const DELETE = route(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAuth();
    const { id } = await context.params;

    // Checks the module, `document.delete`, and access to the owner; writes the
    // audit entry and removes the row.
    const row = await deleteDocument(ctx, id);

    // The row is gone, so the bytes must go too. Done after, because a failure
    // to unlink must not leave a readable row behind.
    await deleteObject(row.storageKey).catch(() => {});

    return ok({ id, title: row.title });
  },
);
