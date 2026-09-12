/**
 * Domain error for the operations modules.
 *
 * Same contract as `FinanceError`: it carries the HTTP status it wants and is
 * marked with the domain-error symbol so `handleApiError` forwards the message
 * to the client. An unmarked error is treated as a bug and answered with a
 * generic 500, which is the correct default — a stray database or driver
 * message must never reach a user.
 */

import { markDomainError } from '../api/domain-error.ts';

export class OperationsError extends Error {
  status: number;
  fields?: Record<string, string>;

  constructor(message: string, status = 400, fields?: Record<string, string>) {
    super(message);
    this.name = 'OperationsError';
    this.status = status;
    if (fields) this.fields = fields;
    markDomainError(this);
  }
}

/** 404 for anything the caller may not see — never 403, which confirms it exists. */
export function notFoundError(what: string): OperationsError {
  return new OperationsError(`${what} not found`, 404);
}
