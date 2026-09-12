/**
 * Documents: list and upload.
 *
 * The upload is multipart, so the body is not JSON and the metadata arrives as
 * form fields. Order matters here:
 *
 *   1. authenticate, 2. check the module, 3. check the size, 4. read the bytes,
 *   5. sniff the real type, 6. write to storage, 7. record the row.
 *
 * The row is written last because a metadata row pointing at a file that was
 * never stored is a broken download; a stored file with no row is merely an
 * orphan the cleanup can find. `createDocument` performs the ownership checks
 * (student access, staff.view, school-scoped owner) before it inserts.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { throttleByUser, UPLOAD_LIMIT } from '../../../lib/api/throttle.ts';
import {
  route,
  ok,
  created,
  badRequest,
  readPagination,
  paged,
} from '../../../lib/api/respond.ts';
import { documentMetaSchema } from '../../../lib/operations/schema.ts';
import { listDocuments, createDocument } from '../../../lib/operations/calendar.ts';
import {
  MAX_UPLOAD_BYTES,
  newStorageKey,
  putObject,
  deleteObject,
  safeFileName,
  sniffType,
} from '../../../lib/operations/storage.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('documents');
  ctx.require('document.view');

  const url = new URL(request.url);
  const pagination = readPagination(url);

  const ownerType = url.searchParams.get('ownerType');
  const ownerId = url.searchParams.get('ownerId');

  // Listing a person's documents requires the right to see that person, not
  // merely `document.view`. Without this, the list itself would disclose that
  // a pupil has a medical file.
  if (ownerType === 'student' && ownerId) {
    await ctx.requireStudentAccess(ownerId);
  } else if (ownerType === 'staff') {
    ctx.require('staff.view');
  } else if (ownerType !== 'school') {
    // An unfiltered listing spans students and staff, so it needs both.
    ctx.require('staff.view');
    if (ctx.has('restrict.ownSectionsOnly')) {
      return badRequest('Choose a student or a staff member to list documents for.');
    }
  }

  const { documents, total } = await listDocuments(ctx, {
    ownerType,
    ownerId,
    category: url.searchParams.get('category'),
    q: url.searchParams.get('q'),
    limit: pagination.limit,
    offset: pagination.offset,
  });

  return ok(paged(documents, total, pagination));
});

export const POST = route(async (request: NextRequest) => {
  const ctx = await requireAuth();
  await ctx.requireModule('documents');
  ctx.require('document.upload');

  // Audit M3. Each accepted upload writes up to 10 MB to the storage volume,
  // and nothing reclaims it automatically. After the permission and module
  // checks, so an unauthorised caller still gets 403 rather than 429.
  const throttled = throttleByUser(ctx.user.userId, 'upload:documents', UPLOAD_LIMIT);
  if (throttled) return throttled;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return badRequest('Send the file as multipart/form-data.');
  }

  // Refuse an over-large body before reading it, when the sender declares it.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES * 1.2) {
    return badRequest(`That file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
  }

  const form = await request.formData().catch(() => null);
  if (!form) return badRequest('The upload could not be read.');

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return badRequest(`That file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, {
      file: `Maximum ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    });
  }

  // Metadata is validated with the same schema the JSON paths use.
  const meta = documentMetaSchema.parse({
    ownerType: form.get('ownerType'),
    ownerId: form.get('ownerId') || null,
    title: form.get('title'),
    category: form.get('category') ?? 'other',
    description: form.get('description') || null,
    visibleToPortal: form.get('visibleToPortal') === 'true',
    expiresOn: form.get('expiresOn') || null,
  });

  const bytes = Buffer.from(await file.arrayBuffer());

  // The browser's Content-Type is discarded: it is attacker-controlled. What
  // the file IS decides what it is stored as.
  const sniffed = sniffType(bytes, file.name);
  if (!sniffed) {
    return badRequest('That kind of file cannot be uploaded.', {
      file: 'Upload a PDF, image, Word or Excel document.',
    });
  }

  const storageKey = newStorageKey(ctx.schoolId);
  const checksum = await putObject(storageKey, bytes);

  try {
    const row = await createDocument(ctx, {
      ...meta,
      fileName: safeFileName(file.name, sniffed.extension),
      mimeType: sniffed.mimeType,
      sizeBytes: bytes.length,
      storageKey,
      checksum,
    });

    return created({
      id: row.id,
      title: row.title,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    });
  } catch (error) {
    // The permission or ownership check failed after the bytes landed. Remove
    // them: an orphan file is a small leak of disk, but an orphan file for a
    // pupil the uploader may not see is a leak of information.
    await deleteObject(storageKey).catch(() => {});
    throw error;
  }
});
