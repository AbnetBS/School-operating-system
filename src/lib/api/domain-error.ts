/**
 * Marker for errors that carry their own HTTP status.
 *
 * A service should not import Next.js to say "this is a 404". Instead it
 * throws an error tagged with this symbol, and the API layer maps it.
 *
 * The tag is a symbol rather than a `status` property so that an unrelated
 * error which happens to have a numeric `status` — undici and several HTTP
 * clients attach one — can never be mistaken for a deliberate domain error and
 * have its internal message forwarded to the browser.
 */

export const DOMAIN_ERROR = Symbol.for('sos.domainError');

export type DomainError = Error & {
  [DOMAIN_ERROR]: true;
  status: number;
};

/** Tag an error as safe to surface with its own status and message. */
export function markDomainError<T extends Error & { status: number }>(error: T): T {
  Object.defineProperty(error, DOMAIN_ERROR, {
    value: true,
    enumerable: false,
  });
  return error;
}

export function isDomainError(error: unknown): error is DomainError {
  return (
    error instanceof Error &&
    (error as Partial<DomainError>)[DOMAIN_ERROR] === true &&
    typeof (error as Partial<DomainError>).status === 'number'
  );
}
