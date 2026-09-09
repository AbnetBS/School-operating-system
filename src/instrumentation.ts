/**
 * Next.js instrumentation hook.
 *
 * Runs once when the server starts, before the first request. This is where
 * the event handlers get registered — see src/lib/bootstrap.ts.
 */

export async function register(): Promise<void> {
  // Only the Node.js runtime can reach the database; the edge runtime cannot
  // run these handlers, and importing them there would fail the build.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrap } = await import('./lib/bootstrap.ts');
    bootstrap();
  }
}
