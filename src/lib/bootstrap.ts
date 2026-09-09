/**
 * Application bootstrap.
 *
 * Registers the event handlers that make automation work. This must run before
 * any request is served, because a handler that is not registered when an
 * event fires simply never runs — the event is marked processed with zero
 * handlers and no notification is ever produced.
 *
 * Two entry points call it:
 *
 *   - `instrumentation.ts`, which Next.js runs once at server start;
 *   - tests, explicitly, because they never boot the Next.js server.
 *
 * Registration is idempotent (the bus rejects duplicate handler names), so
 * calling it more than once is harmless.
 */

import { registerNotificationHandlers } from './notifications/handlers.ts';

let started = false;

export function bootstrap(): void {
  if (started) return;
  started = true;
  registerNotificationHandlers();
}
