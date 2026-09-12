/**
 * Abuse protection for expensive authenticated endpoints.
 *
 * ## Why only a few endpoints
 *
 * Rate limiting everything is its own kind of bug: it breaks legitimate use and
 * hides real problems behind noise. Endpoints were measured against the running
 * application before anything was added here:
 *
 *   | endpoint                      | time  | body    | verdict            |
 *   |-------------------------------|-------|---------|--------------------|
 *   | /api/students/export          | 262ms | 28 KB   | protected          |
 *   | /api/analytics/export         | 101ms | 20 KB   | protected          |
 *   | /api/search?q=…               |  60ms | 1.9 KB  | left alone         |
 *   | /api/students?pageSize=25     | 143ms | 9.8 KB  | left alone         |
 *
 * The exports are the outliers, and they scale with the school: the student
 * export pages through up to 20,000 rows, so on a real tenant one request is
 * far more than the 28 KB measured against demo data. The paginated list is
 * bounded at 100 rows by `readPagination`, and search is bounded to 5 results
 * per source — neither grows with school size.
 *
 * Search is deliberately *not* throttled: `SearchBox.tsx` is a debounced
 * type-ahead, so a limiter there would fire during ordinary typing. That is the
 * "do not interfere with normal dashboard usage" case, and a 60 ms bounded
 * query is not a production risk.
 *
 * ## Why the key is the user id
 *
 * These routes run after `requireAuth()`, so a stable, server-issued identity
 * is already available. Keying on it rather than on an IP means the limit
 * cannot be evaded with a forged header, and a school behind one NAT address
 * does not share a bucket — every member of staff gets their own budget.
 */

import { NextResponse } from 'next/server';
import { rateLimit } from '../auth/login.ts';

/**
 * Generous enough that no human clicking "Export" will meet it, low enough that
 * a script cannot spin the database. A full export takes a person seconds to
 * even open, so 10 per minute is far beyond real use.
 */
export const EXPORT_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/**
 * Committing a spreadsheet import (audit finding M3).
 *
 * Measured on the running application: one 300-row commit takes **3.2 s** of
 * database time, against ~130 ms for a paginated list read. Three consecutive
 * calls wrote 900 students in 9.4 s with nothing to stop them, and the file
 * bound (5 MB / 5,000 rows) limits the size of one request, not how many.
 *
 * Six per minute leaves a registrar working through several files unimpeded —
 * each commit is preceded by a human reviewing a validation preview — while
 * removing the ability to hold the database open indefinitely.
 */
export const IMPORT_LIMIT = { limit: 6, windowMs: 60_000 } as const;

/**
 * Uploading a document.
 *
 * Each accepted upload writes up to 10 MB to the storage volume, and unlike a
 * database row nothing reclaims it automatically. 20 per minute is well beyond
 * a person attaching files one at a time.
 */
export const UPLOAD_LIMIT = { limit: 20, windowMs: 60_000 } as const;

/**
 * Sending a message or publishing an announcement.
 *
 * One announcement fans out to an audience, so the cost is per recipient rather
 * than per request. 30 per minute is far above human composition speed.
 */
export const MESSAGING_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/**
 * Human-readable wording per bucket family. A generic "too many requests" is
 * unhelpful to a member of staff who is mid-task and needs to know whether to
 * wait or to change what they are doing.
 */
function messageFor(bucket: string): string {
  if (bucket.startsWith('export:')) {
    return 'That export is being requested too quickly. Please wait a moment and try again.';
  }
  if (bucket.startsWith('import:')) {
    return 'Too many imports in a short time. Please wait a moment before importing again.';
  }
  if (bucket.startsWith('upload:')) {
    return 'Too many uploads in a short time. Please wait a moment and try again.';
  }
  if (bucket.startsWith('message:')) {
    return 'You are sending messages too quickly. Please wait a moment and try again.';
  }
  return 'Too many requests. Please wait a moment and try again.';
}

/**
 * Apply a per-user limit to an expensive operation.
 *
 * Returns a 429 response to return directly, or `null` when the call may
 * proceed. The message says nothing about who else is calling or from where.
 */
export function throttleByUser(
  userId: string,
  bucket: string,
  policy: { limit: number; windowMs: number } = EXPORT_LIMIT,
): NextResponse | null {
  const verdict = rateLimit(`${bucket}:${userId}`, policy.limit, policy.windowMs);
  if (verdict.allowed) return null;

  return NextResponse.json(
    { error: messageFor(bucket) },
    { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
  );
}
