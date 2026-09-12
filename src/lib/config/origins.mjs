/**
 * Allowed-origin configuration for Server Actions and dev-time cross-origin
 * requests (audit finding H2).
 *
 * The sandbox preview is served from `https://{port}-{id}.e2b.app`, so local
 * development needs `*.e2b.app` in the allow-list. That wildcard must not ship
 * to production: `e2b.app` is a third-party sandbox host that anyone can
 * provision a subdomain on, so `*.e2b.app` names attacker-controllable origins.
 *
 * Production origins come from `APP_ORIGIN` (or `APP_ORIGINS` for several,
 * comma-separated). Leaving it unset is safe: Next only consults this list when
 * the request's `Origin` does not match its `Host`, so an ordinary same-origin
 * deployment needs no configuration at all. It is needed when the app sits
 * behind a reverse proxy that does not forward the public hostname.
 *
 * Plain `.mjs` so `next.config.mjs` can import it directly without a build step.
 */

/** Origins allowed only outside production, for the sandbox preview proxy. */
export const DEV_ORIGINS = ['*.e2b.app', 'localhost:3000'];

/**
 * Normalise one entry to the form Next compares against.
 *
 * Next derives the origin as `new URL(request.headers.origin).host` — a
 * hostname with an optional port, and no scheme or path. An operator who sets
 * `APP_ORIGIN=https://school.edu.et/` would otherwise never match anything,
 * failing open-endedly and silently, so the scheme, any path and a trailing
 * dot are stripped here.
 *
 * @param {string} value
 * @returns {string | null} the normalised host, or null if unusable
 */
export function normaliseOrigin(value) {
  if (typeof value !== 'string') return null;

  let host = value.trim();
  if (host === '') return null;

  // Strip scheme, including a protocol-relative prefix.
  host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
  // Strip credentials, path, query and fragment.
  host = host.replace(/^[^/@]*@/, '').split(/[/?#]/)[0];
  host = host.trim().toLowerCase().replace(/\.$/, '');

  if (host === '') return null;
  // Whitespace inside a host is always malformed.
  if (/\s/.test(host)) return null;
  // A bare wildcard would allow every origin. Next rejects these too, but they
  // must never reach the config in the first place.
  if (host === '*' || host === '**') return null;

  return host;
}

/**
 * Parse a comma-separated origin list into normalised, de-duplicated hosts.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseOrigins(raw) {
  if (!raw) return [];
  /** @type {string[]} */
  const out = [];
  for (const part of raw.split(',')) {
    const host = normaliseOrigin(part);
    if (host !== null && !out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * Build the Server Actions allow-list for the current environment.
 *
 * In production: only the operator's configured origins — never the sandbox
 * wildcard. Outside production: configured origins plus the sandbox preview.
 *
 * @param {{ NODE_ENV?: string, APP_ORIGIN?: string, APP_ORIGINS?: string }} [env]
 * @returns {string[]}
 */
export function resolveAllowedOrigins(env = process.env) {
  const configured = parseOrigins(env.APP_ORIGINS ?? env.APP_ORIGIN);
  if (env.NODE_ENV === 'production') return configured;

  const merged = [...configured];
  for (const origin of DEV_ORIGINS) {
    if (!merged.includes(origin)) merged.push(origin);
  }
  return merged;
}

/**
 * Origins allowed for Next's dev-server cross-origin check. This setting only
 * applies to `next dev`, so the sandbox host is always appropriate here.
 *
 * @param {{ NODE_ENV?: string, APP_ORIGIN?: string, APP_ORIGINS?: string }} [env]
 * @returns {string[]}
 */
export function resolveAllowedDevOrigins(env = process.env) {
  const configured = parseOrigins(env.APP_ORIGINS ?? env.APP_ORIGIN);
  const merged = [...configured];
  for (const origin of DEV_ORIGINS) {
    if (!merged.includes(origin)) merged.push(origin);
  }
  return merged;
}

/**
 * Warning text for a production build with no origin configured, or null when
 * there is nothing to say. Returned rather than logged so it can be tested.
 *
 * @param {{ NODE_ENV?: string, APP_ORIGIN?: string, APP_ORIGINS?: string }} [env]
 * @returns {string | null}
 */
export function originWarning(env = process.env) {
  if (env.NODE_ENV !== 'production') return null;
  if (resolveAllowedOrigins(env).length > 0) return null;

  return (
    'APP_ORIGIN is not set for this production build, so no cross-origin ' +
    'Server Action origins are allowed.\n' +
    'This is safe for a normal deployment: requests whose Origin matches the ' +
    "Host are always permitted and never consult this list.\n" +
    'Set it only if the app runs behind a proxy that does not forward the ' +
    'public hostname, e.g. APP_ORIGIN=school.edu.et'
  );
}
