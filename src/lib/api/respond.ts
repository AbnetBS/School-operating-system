/**
 * Consistent API responses and error handling.
 *
 * Every route uses these so that clients see one error shape, and so that a
 * thrown AuthError becomes a 401/403 rather than a stack trace with a 500.
 * Internal error details are logged server-side and never returned to the
 * browser — an error message is an information leak if it exposes schema,
 * file paths or whether a record merely exists.
 */

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AuthError } from '../auth/context.ts';
import { TenantIsolationError } from '../../db/scope.ts';
import { friendlyDbError } from '../../db/errors.ts';

export type ApiErrorBody = {
  error: string;
  /** Field-level messages for form display. */
  fields?: Record<string, string>;
  code?: string;
};

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { status: 200, ...init });
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export function badRequest(message: string, fields?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: message, fields } satisfies ApiErrorBody, { status: 400 });
}

export function unauthorized(message = 'Authentication required'): NextResponse {
  return NextResponse.json({ error: message } satisfies ApiErrorBody, { status: 401 });
}

export function forbidden(message = 'You are not allowed to do this'): NextResponse {
  return NextResponse.json({ error: message } satisfies ApiErrorBody, { status: 403 });
}

export function notFound(message = 'Not found'): NextResponse {
  return NextResponse.json({ error: message } satisfies ApiErrorBody, { status: 404 });
}

export function conflict(message: string): NextResponse {
  return NextResponse.json({ error: message } satisfies ApiErrorBody, { status: 409 });
}

/** Convert a Zod error into field-keyed messages for the form. */
export function zodFields(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

/**
 * Convert a thrown error into the correct HTTP response.
 *
 * Order matters: authorization errors must not be swallowed by the generic
 * handler, and tenant-isolation errors are reported as 404 so that probing for
 * another school's record ids yields no signal.
 */
export function handleApiError(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    const body: ApiErrorBody = { error: error.message };
    return NextResponse.json(body, { status: error.status });
  }

  if (error instanceof TenantIsolationError) {
    // Deliberately a 404: a 403 would confirm the record exists elsewhere.
    console.error('[security] tenant isolation violation:', error.message);
    return notFound();
  }

  if (error instanceof ZodError) {
    return badRequest('Please check the highlighted fields.', zodFields(error));
  }

  const dbMessage = friendlyDbError(error);
  if (dbMessage) {
    return conflict(dbMessage);
  }

  console.error('[api] unhandled error:', error);
  return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
}

/** Wrap an async route handler with the standard error mapping. */
export function route<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>,
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (error) {
      return handleApiError(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export type Pagination = { limit: number; offset: number; page: number };

/**
 * Read pagination from the query string, with a hard ceiling.
 * Without a cap, one request for a school with 5,000 students would try to
 * serialise every row.
 */
export function readPagination(url: URL): Pagination {
  const rawPage = Number(url.searchParams.get('page') ?? '1');
  const rawSize = Number(url.searchParams.get('pageSize') ?? DEFAULT_PAGE_SIZE);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawSize)
    ? Math.min(Math.max(Math.floor(rawSize), 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  return { limit, offset: (page - 1) * limit, page };
}

export type Paged<T> = {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export function paged<T>(data: T[], total: number, pagination: Pagination): Paged<T> {
  return {
    data,
    total,
    page: pagination.page,
    pageSize: pagination.limit,
    totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
  };
}
