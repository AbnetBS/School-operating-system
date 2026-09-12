/**
 * File storage for documents.
 *
 * This module owns the bytes. Everything about it is written on the assumption
 * that the uploader is hostile and the filename is a lie.
 *
 * THE STORAGE KEY IS GENERATED HERE, NEVER SUPPLIED.
 * A key is `<schoolId>/<uuid>` — both server-generated. The user's filename is
 * kept only as a display label in the database and is never part of a path, so
 * `../../etc/passwd`, an absolute path, a NUL byte or a 300-character name
 * cannot influence where anything is written or read. `resolveKey` additionally
 * re-checks that the resolved absolute path is inside the storage root, so even
 * a future bug that let a crafted key through would still not escape.
 *
 * THE CLIENT'S MIME TYPE IS NOT TRUSTED.
 * `Content-Type` on a multipart part is attacker-controlled: a browser will
 * happily send `image/png` for an HTML file, and serving that back would be a
 * stored-XSS hole. So the bytes are sniffed and the declared type is discarded.
 * Only a small allowlist of formats a school actually files is accepted.
 *
 * DOWNLOADS ARE NEVER INLINE HTML.
 * The download route sends `Content-Disposition: attachment`, `X-Content-Type-
 * Options: nosniff` and a sanitised filename, so a document cannot execute in
 * the school's origin.
 *
 * Local disk is deliberate, not a placeholder: it is the only backend that
 * works for a school running this on one server with intermittent internet.
 * The seam is `STORAGE_ROOT`; swapping in object storage means replacing three
 * functions here and nothing else.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Where the bytes live. Outside the repo tree in production. */
const STORAGE_ROOT = resolve(process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage'));

/** Hard ceiling per file. A school scanning a birth certificate needs ~2 MB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type SniffedType = { mimeType: string; extension: string };

/**
 * Formats a school genuinely files: scans, photographs, and office documents.
 *
 * SVG is excluded on purpose — it is script-capable, and an "image" that can
 * run JavaScript is not an image for this purpose. HTML is excluded for the
 * same reason.
 */
const MAGIC: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  // OOXML (.docx/.xlsx/.pptx) and legacy OLE (.doc/.xls) are containers, so the
  // signature identifies the container, not the specific application.
  { mime: 'application/zip', ext: 'zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { mime: 'application/x-ole-storage', ext: 'doc', test: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
];

/** OOXML subtypes, distinguished by what the zip contains. */
function refineZip(bytes: Buffer, declared: string, fileName: string): SniffedType {
  const head = bytes.subarray(0, 4096).toString('latin1');
  const lower = fileName.toLowerCase();
  if (head.includes('word/') || lower.endsWith('.docx')) {
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx',
    };
  }
  if (head.includes('xl/') || lower.endsWith('.xlsx')) {
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    };
  }
  if (head.includes('ppt/') || lower.endsWith('.pptx')) {
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
    };
  }
  // A bare zip is refused rather than stored: a school filing "documents" has
  // no need for archives, and an archive is a good way to smuggle one.
  void declared;
  return { mimeType: 'application/zip', extension: 'zip' };
}

/**
 * Decide what a file actually is from its first bytes.
 *
 * Returns null when the content matches nothing on the allowlist, which is the
 * refusal case — an unrecognised file is not stored.
 */
export function sniffType(bytes: Buffer, fileName: string): SniffedType | null {
  if (bytes.length === 0) return null;

  for (const entry of MAGIC) {
    if (!entry.test(bytes)) continue;
    if (entry.mime === 'application/zip') {
      const refined = refineZip(bytes, entry.mime, fileName);
      // A plain zip is not an accepted document type.
      return refined.extension === 'zip' ? null : refined;
    }
    if (entry.mime === 'application/x-ole-storage') {
      return fileName.toLowerCase().endsWith('.xls')
        ? { mimeType: 'application/vnd.ms-excel', extension: 'xls' }
        : { mimeType: 'application/msword', extension: 'doc' };
    }
    return { mimeType: entry.mime, extension: entry.ext };
  }

  // Plain text has no signature. Accept it only if the bytes really are text:
  // no NUL, valid UTF-8, and not something that a browser might treat as
  // markup if it were ever served inline.
  const sample = bytes.subarray(0, 8192);
  if (!sample.includes(0)) {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
    const replacementRatio = (decoded.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, decoded.length);
    const looksLikeMarkup = /<\s*(!doctype|html|script|svg|iframe)\b/i.test(decoded);
    if (replacementRatio < 0.01 && !looksLikeMarkup) {
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.csv')) return { mimeType: 'text/csv', extension: 'csv' };
      return { mimeType: 'text/plain', extension: 'txt' };
    }
  }

  return null;
}

/**
 * Reduce a user-supplied filename to something safe to echo back.
 *
 * Used only for the download's `Content-Disposition` and for display. It never
 * touches a path.
 */
export function safeFileName(name: string, fallbackExtension: string): string {
  const base = name
    .replace(/[\u0000-\u001f\u007f]/g, '') // control characters
    .replace(/[\\/]/g, '_') // path separators
    .replace(/^\.+/, '') // leading dots: no ".htaccess", no ".."
    .trim()
    .slice(0, 120);
  const cleaned = base.length > 0 ? base : `document.${fallbackExtension}`;
  return cleaned.includes('.') ? cleaned : `${cleaned}.${fallbackExtension}`;
}

/** A storage key this module generated. Opaque to the client. */
export function newStorageKey(schoolId: string): string {
  return `${schoolId}/${randomUUID()}`;
}

/**
 * Turn a key into an absolute path, refusing anything that escapes the root.
 *
 * Keys are generated by `newStorageKey`, so this should never fire — which is
 * exactly why it is here. A traversal that depends on "the key is always well
 * formed" stops being safe the moment some future code path builds one
 * differently.
 */
function resolveKey(storageKey: string): string {
  if (!/^[0-9a-fA-F-]{36}\/[0-9a-fA-F-]{36}$/.test(storageKey)) {
    throw new Error('Malformed storage key');
  }
  const full = resolve(STORAGE_ROOT, storageKey);
  if (full !== STORAGE_ROOT && !full.startsWith(STORAGE_ROOT + sep)) {
    throw new Error('Storage key escapes the storage root');
  }
  return full;
}

export async function putObject(storageKey: string, bytes: Buffer): Promise<string> {
  const full = resolveKey(storageKey);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes, { flag: 'wx' }); // never silently overwrite
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Thrown when the metadata row exists but the bytes do not.
 *
 * This is not a hypothetical: if `STORAGE_ROOT` points inside the application
 * directory, a container redeploy erases every file while leaving every row
 * behind. Previously the resulting `ENOENT` escaped as an unhandled error and
 * the user was told "Something went wrong. Please try again." — advice that can
 * never work, for a file that is permanently gone. Saying so plainly lets an
 * administrator recognise the problem instead of retrying forever.
 */
export class MissingObjectError extends Error {
  constructor() {
    super(
      'This document is no longer available. Its file is missing from storage — ' +
        'it may have been lost in a server redeployment. Please re-upload it.',
    );
    this.name = 'MissingObjectError';
  }
}

export async function getObject(storageKey: string): Promise<Buffer> {
  try {
    return await readFile(resolveKey(storageKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MissingObjectError();
    }
    throw error;
  }
}

export async function deleteObject(storageKey: string): Promise<void> {
  try {
    await unlink(resolveKey(storageKey));
  } catch (error) {
    // A missing file must not stop the metadata row being removed; the row is
    // the thing a user can see.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
