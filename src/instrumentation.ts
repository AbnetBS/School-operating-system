/**
 * Next.js instrumentation hook.
 *
 * Runs once when the server starts, before the first request. This is where
 * the event handlers get registered — see src/lib/bootstrap.ts — and where the
 * database configuration is validated.
 *
 * Next.js does not execute this hook during `next build`, only when the server
 * actually boots, so validating here cannot break a production build that
 * legitimately has no database available at compile time.
 */

export async function register(): Promise<void> {
  // Only the Node.js runtime can reach the database; the edge runtime cannot
  // run these handlers, and importing them there would fail the build.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Validate the database configuration before anything serves traffic.
    //
    // The check also runs lazily inside `getDb()`, but doing it here means a
    // misconfigured production deployment dies immediately and visibly at
    // startup instead of booting "successfully" and then failing on whichever
    // request happens to touch the database first. An operator watching a
    // deploy should see this, not a health-check timeout ten minutes later.
    const { resolveDatabaseConfig, DatabaseConfigError } = await import('./db/config.ts');
    try {
      resolveDatabaseConfig();
    } catch (error) {
      if (error instanceof DatabaseConfigError) {
        // The message is written for a human reading deployment logs and never
        // contains the connection string itself.
        console.error(`\n[startup] ${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }

    // Warn — but do not refuse to boot — when uploaded documents are being
    // written somewhere a redeploy will erase. This is a warning rather than a
    // hard failure because a single-VPS deployment with no container layer has
    // a perfectly durable application directory; only the operator knows which
    // they are running.
    const { storageWarning } = await import('./lib/operations/storageConfig.ts');
    const warning = storageWarning();
    if (warning) {
      console.warn(`\n[startup] ${warning}\n`);
    }

    const { bootstrap } = await import('./lib/bootstrap.ts');
    bootstrap();
  }
}
