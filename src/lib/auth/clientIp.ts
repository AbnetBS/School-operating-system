/**
 * Trusted client-IP resolution.
 *
 * ## The problem this solves
 *
 * The login limiter used to key on `x-forwarded-for.split(',')[0]` — the
 * left-most entry. That entry is whatever the *client* sent. An attacker sets a
 * different value on every request and the per-IP limiter never fires. This was
 * measured during the audit: 40 login attempts with a rotating header produced
 * 8 that reached password verification, and a spray across 17 accounts reached
 * 16 of them.
 *
 * ## What the deployment actually provides
 *
 * Verified empirically against this application, not assumed:
 *
 *   - `NextRequest` exposes **no socket peer address**. `request.ip` was
 *     removed in Next.js 15 (`'ip' in request === false`). A route handler
 *     genuinely cannot see the TCP source address.
 *   - Next.js passes `x-forwarded-for` through **verbatim**. It does not append
 *     the peer address, so the right-most entry is *not* automatically
 *     trustworthy either — with no proxy in front, the whole header is
 *     attacker-authored.
 *
 * So there is no header that is trustworthy by default. Trust has to be
 * declared by whoever deploys the app, because only they know whether a proxy
 * is in front of it and how many hops it adds.
 *
 * ## The model
 *
 * `TRUSTED_PROXY_HOPS` states how many trailing entries of `x-forwarded-for`
 * were appended by infrastructure you control.
 *
 *   - **unset / `0`** (default): the header is not trusted at all. Every
 *     request resolves to the same `unknown` bucket. This is the safe default:
 *     an attacker cannot escape their bucket by forging a header, and the
 *     per-account and global limits still apply.
 *   - **`1`**: one reverse proxy (Traefik/Caddy under Coolify, or nginx) sits
 *     in front and appends the real client IP as the last entry. The
 *     second-from-right entry is then the true client. This is the correct
 *     setting for the intended VPS/Coolify deployment.
 *   - **`n`**: n layers of infrastructure you control (e.g. CDN + proxy).
 *
 * Counting from the **right** is what makes this safe. A client can prepend any
 * number of fake entries on the left; it cannot alter the entries appended
 * after its request arrived. Selecting by index from the right therefore lands
 * on a value your own infrastructure wrote — provided the hop count is correct.
 *
 * Deliberately not implemented: parsing `X-Real-IP` (trivially spoofed and
 * carries no hop information) and CIDR allow-lists of proxy addresses (needs
 * the peer address, which is exactly what Next.js will not give us).
 */

/** Returned when no client IP can be established. */
export const UNKNOWN_CLIENT_IP = 'unknown';

export type HeaderLookup = { get(name: string): string | null };

/** Only the variables this module reads, so tests can pass a small object. */
export type ProxyEnv = { TRUSTED_PROXY_HOPS?: string | undefined; [key: string]: string | undefined };

/**
 * How many trailing `x-forwarded-for` entries come from infrastructure we
 * control. Read per call rather than cached at module load so tests, and a
 * process that reloads configuration, both see the current value.
 */
function trustedHops(env: ProxyEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * A conservative check that a string looks like an IP address.
 *
 * Not a full RFC validator: the goal is to reject obvious junk (`"unknown"`,
 * `"_hidden"`, an empty entry, a hostname) so that a malformed hop does not
 * silently become a limiter key that an attacker can vary at will.
 */
function looksLikeIp(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;

  // IPv4, optionally with a port (some proxies append `1.2.3.4:5678`).
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?$/.exec(value);
  if (v4) {
    return [v4[1], v4[2], v4[3], v4[4]].every((part) => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }

  // IPv6, optionally bracketed with a port: `[::1]:443`.
  const unwrapped = /^\[(.+)\](?::\d{1,5})?$/.exec(value)?.[1] ?? value;
  return /^[0-9a-fA-F:]+$/.test(unwrapped) && unwrapped.includes(':');
}

/**
 * Resolve the client IP to use for rate limiting.
 *
 * Returns {@link UNKNOWN_CLIENT_IP} when no trusted value is available, which
 * makes every untrusted caller share one bucket. That is intentional: sharing a
 * bucket degrades to a global limit, which is safe, whereas trusting a forged
 * header removes the limit entirely.
 */
export function resolveClientIp(headers: HeaderLookup, env: ProxyEnv = process.env): string {
  const hops = trustedHops(env);
  if (hops === 0) return UNKNOWN_CLIENT_IP;

  const raw = headers.get('x-forwarded-for');
  if (!raw) return UNKNOWN_CLIENT_IP;

  // Positions are preserved deliberately: empty entries are NOT filtered out.
  // Dropping them would let a client send "1.2.3.4, " and shift the index one
  // place to the left, landing on their own value instead of the proxy's. An
  // empty hop is simply an invalid hop, and is rejected below.
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length === 0) return UNKNOWN_CLIENT_IP;

  // Count from the right: the client controls the left of this list.
  const index = entries.length - hops;
  const candidate = index >= 0 ? entries[index] : undefined;

  // A short header means fewer hops arrived than configured — the request did
  // not traverse the expected path. Falling back to another entry here would
  // hand the attacker exactly the control this function exists to remove.
  if (candidate === undefined || !looksLikeIp(candidate)) return UNKNOWN_CLIENT_IP;

  return candidate;
}

/**
 * True when the deployment has declared a trusted proxy.
 *
 * Used to decide whether per-IP limits are meaningful, and to warn at startup
 * when they are not.
 */
export function hasTrustedProxy(env: ProxyEnv = process.env): boolean {
  return trustedHops(env) > 0;
}
