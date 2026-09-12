/**
 * Database driver selection.
 *
 * This module is the single place that decides whether the application talks to
 * a real PostgreSQL server or to the embedded PGlite database. Both
 * `src/db/client.ts` and `scripts/migrate.ts` resolve through it, so the two
 * cannot drift apart and there is exactly one code path capable of choosing
 * PGlite.
 *
 * The rule it enforces:
 *
 *   - In production, DATABASE_URL is mandatory and must be a valid PostgreSQL
 *     URL. Anything else is a hard startup failure.
 *   - Outside production, PGlite remains the default so `npm run dev` and the
 *     test suite need no configuration at all.
 *
 * Why this matters: before this guard existed, a missing — or merely
 * mistyped — DATABASE_URL in production caused a silent fall back to the
 * embedded single-process database. The application looked completely healthy
 * while writing real student, grade and payment records into a local file that
 * no backup covers and that is destroyed on the next redeploy. Failing loudly
 * at startup is strictly better than succeeding quietly against the wrong
 * database.
 */

/** Thrown when the environment does not describe a usable database. */
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

export type DatabaseConfig =
  | { driver: 'postgres'; connectionString: string }
  | { driver: 'pglite'; dataDir: string };

/** The URL schemes `pg` accepts. Unchanged from the original driver check. */
const POSTGRES_SCHEMES = ['postgres:', 'postgresql:'];

export const DEFAULT_PGLITE_DATA_DIR = '.data/pgdata';

/**
 * Extract just the scheme from a string, for use in error messages.
 *
 * Returns only characters valid in a URL scheme, so a connection string
 * carrying a password can never leak through this function.
 */
function safeScheme(value: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value.trim());
  return match?.[1] ? `${match[1]}:` : null;
}

type UrlVerdict =
  | { ok: true }
  /** `reason` is safe to show an operator: it never contains the URL itself. */
  | { ok: false; reason: string };

/**
 * Decide whether a non-empty string is a PostgreSQL URL this app can use.
 *
 * Deliberately strict. A value that is close to correct but not correct is a
 * configuration mistake, and repairing it silently is how the original bug hurt
 * people: the operator believes one thing is true while the process does
 * another. Nothing here trims, rewrites or guesses.
 */
function inspectUrl(raw: string): UrlVerdict {
  if (raw.trim() !== raw) {
    return {
      ok: false,
      reason: 'it has leading or trailing whitespace (check for a stray newline or quote)',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    const scheme = safeScheme(raw);
    return {
      ok: false,
      reason: scheme
        ? `it starts with "${scheme}" but is not a parseable URL`
        : 'it is not a parseable URL',
    };
  }

  if (!POSTGRES_SCHEMES.includes(parsed.protocol)) {
    return {
      ok: false,
      reason: `its scheme is "${parsed.protocol}", but PostgreSQL requires "postgres:" or "postgresql:"`,
    };
  }

  // A hostname is not required: `postgres:///db?host=/var/run/postgresql` is a
  // legitimate Unix-socket connection string, and rejecting it would break a
  // real deployment style for no good reason.
  return { ok: true };
}

/** True when `value` is a PostgreSQL URL this application can connect with. */
export function isValidPostgresUrl(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  return inspectUrl(value).ok;
}

const MISSING_URL_MESSAGE = [
  'DATABASE_URL is required when NODE_ENV=production.',
  '',
  'The application refuses to start rather than fall back to its embedded',
  'development database (PGlite), because that database is stored on the local',
  'filesystem, is not covered by any backup, and is lost when the container is',
  'redeployed. Starting would risk silently accepting real school data into',
  'storage that cannot survive.',
  '',
  'Set DATABASE_URL to your PostgreSQL connection string, for example:',
  '  DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE',
].join('\n');

function invalidUrlMessage(reason: string): string {
  return [
    `DATABASE_URL is set but is not a valid PostgreSQL connection string: ${reason}.`,
    '',
    'It has not been modified or guessed at, and the application will not fall',
    'back to its embedded development database (PGlite), because that database',
    'is not backed up and is lost on redeploy.',
    '',
    'Expected format:',
    '  DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE',
    '',
    '(The value itself is not shown here so that credentials stay out of logs.)',
  ].join('\n');
}

export type EnvLike = {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
  PGLITE_DATA_DIR?: string | undefined;
};

/**
 * Resolve which database driver to use.
 *
 * @throws {DatabaseConfigError} in production when DATABASE_URL is absent,
 * empty, or not a valid PostgreSQL URL. The thrown message never contains the
 * connection string, so it is safe to log.
 */
export function resolveDatabaseConfig(env: EnvLike = process.env): DatabaseConfig {
  const isProduction = env.NODE_ENV === 'production';
  const raw = env.DATABASE_URL;
  const provided = raw !== undefined && raw.trim() !== '';

  if (provided) {
    const verdict = inspectUrl(raw);
    if (verdict.ok) {
      return { driver: 'postgres', connectionString: raw };
    }

    if (isProduction) {
      throw new DatabaseConfigError(invalidUrlMessage(verdict.reason));
    }

    // Outside production the embedded database is still the right default, but
    // a malformed value is almost always a typo the developer wants to know
    // about — and finding it here is far cheaper than finding it in production.
    console.warn(
      `[db] Ignoring DATABASE_URL: ${verdict.reason}. Using the embedded ` +
        'development database instead. This would be a fatal error under ' +
        'NODE_ENV=production.',
    );
  } else if (isProduction) {
    throw new DatabaseConfigError(MISSING_URL_MESSAGE);
  }

  return { driver: 'pglite', dataDir: env.PGLITE_DATA_DIR ?? DEFAULT_PGLITE_DATA_DIR };
}

// ---------------------------------------------------------------------------
// TLS for the PostgreSQL connection
// ---------------------------------------------------------------------------

/**
 * What to pass as `pg`'s `ssl` option.
 *
 * `undefined` means "pass nothing", which lets `pg` honour whatever `sslmode`
 * the operator put in DATABASE_URL. That distinction matters: supplying an
 * explicit `ssl` object *overrides* the URL, so the previous code silently
 * discarded an operator's `?sslmode=verify-full` or `?sslmode=disable`.
 */
export type SslConfig = undefined | false | { rejectUnauthorized: boolean; ca?: string };

/** Environment consulted when deciding TLS behaviour. */
export type SslEnvLike = {
  PG_SSL?: string | undefined;
  PG_CA_CERT?: string | undefined;
  DATABASE_URL?: string | undefined;
  [key: string]: string | undefined;
};

/** Recognised values for `PG_SSL`, mapped to how they were spelled. */
const SSL_MODES = ['verify', 'no-verify', 'false', 'disable'] as const;

/** True when the connection string already states an sslmode. */
function urlDeclaresSslMode(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).searchParams.has('sslmode');
  } catch {
    return false;
  }
}

/**
 * Decide the TLS settings for a PostgreSQL connection.
 *
 * Default is **certificate verification on**. Before this, the code sent
 * `rejectUnauthorized: false` on every connection, which encrypts the link but
 * authenticates nothing: a machine-in-the-middle presenting any self-signed
 * certificate is accepted, and every student, medical and payment record on
 * that link can be read or altered. Verified by test — a rogue TLS server with
 * a mismatched CN is accepted under the old setting and refused under this one.
 *
 * Precedence, most specific first:
 *
 *   1. `sslmode` in DATABASE_URL — the operator was explicit; `pg` handles it.
 *   2. `PG_CA_CERT` — verify against a supplied CA (managed providers with a
 *      private root, e.g. some DigitalOcean/Azure setups).
 *   3. `PG_SSL` — `verify` (default), `no-verify`, or `false`/`disable`.
 *
 * `PG_SSL=no-verify` remains available because some managed providers still
 * issue self-signed certificates, and a deployment that cannot connect at all
 * is not more secure. It is now an explicit, greppable opt-out rather than the
 * silent default.
 *
 * @throws {DatabaseConfigError} when `PG_SSL` holds an unrecognised value, so a
 * typo such as `PG_SSL=tru` fails loudly instead of quietly disabling TLS.
 */
export function resolveSslConfig(env: SslEnvLike = process.env): SslConfig {
  const raw = env.PG_SSL?.trim();

  if (raw !== undefined && raw !== '' && !SSL_MODES.includes(raw as (typeof SSL_MODES)[number])) {
    throw new DatabaseConfigError(
      [
        `PG_SSL has an unrecognised value: "${raw}".`,
        '',
        'Valid values:',
        '  verify     (default) require TLS and verify the server certificate',
        '  no-verify  require TLS but accept a self-signed certificate',
        '  false      disable TLS entirely (only for a Unix socket or a trusted private network)',
        '',
        'Refusing to start rather than guess, because guessing wrong here means',
        'sending student and payment data over an unauthenticated connection.',
      ].join('\n'),
    );
  }

  if (raw === 'false' || raw === 'disable') return false;

  // An explicit sslmode in the URL wins: passing an `ssl` object here would
  // override it, which is how an operator's `verify-full` could be lost.
  if (raw === undefined || raw === '') {
    if (urlDeclaresSslMode(env.DATABASE_URL)) return undefined;
  }

  if (raw === 'no-verify') return { rejectUnauthorized: false };

  const ca = env.PG_CA_CERT?.trim();
  if (ca) return { rejectUnauthorized: true, ca };

  return { rejectUnauthorized: true };
}
