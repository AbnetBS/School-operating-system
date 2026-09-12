import {
  resolveAllowedOrigins,
  resolveAllowedDevOrigins,
  originWarning,
} from './src/lib/config/origins.mjs';

// Surfaced at build time, since `next build` bakes this config into
// .next/required-server-files.json and `next start` reads that, not this file.
// Next loads this config in several worker processes, so the notice is printed
// once per process tree rather than once per load.
const warning = originWarning(process.env);
if (warning && !process.env.__SOS_ORIGIN_NOTICE) {
  process.env.__SOS_ORIGIN_NOTICE = '1';
  console.warn(`\n[config] ${warning}\n`);
}

/**
 * Security response headers (audit finding M6).
 *
 * Near-zero-cost defence in depth. Clickjacking risk is already low because
 * `SameSite=lax` means a cross-site iframe renders logged-out, but these close
 * the gap cheaply and cost nothing at runtime.
 *
 * Deliberately NOT set here:
 *
 *   - HSTS. It is meaningful only over HTTPS and belongs on the TLS-terminating
 *     proxy, which knows the real scheme. Emitting it from an app that also
 *     serves plain HTTP in development risks pinning `localhost` to HTTPS in a
 *     developer's browser, which is a genuine and annoying failure.
 *   - Content-Security-Policy. Next injects inline bootstrap scripts, so a
 *     useful CSP needs per-request nonces. A blanket `unsafe-inline` policy
 *     would look like protection while providing none, and a strict one would
 *     break the app. That is a separate, larger piece of work.
 */
function buildSecurityHeaders(env) {
  const headers = [
    // Do not leak a student's record URL to third-party sites via Referer.
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // Stop a browser second-guessing a declared content type — relevant
    // because the app serves user-uploaded documents.
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // The application uses none of these; deny them rather than inherit
    // permissive defaults.
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    },
  ];

  // Frame protection is the one header that can legitimately need to differ by
  // environment: the development preview is served inside an iframe, and
  // denying framing there breaks it without making production any safer.
  // Same reasoning, and same dev/prod split, as the origin allow-list in H2.
  if (env.NODE_ENV === 'production') {
    headers.push(
      // Belt and braces: older browsers honour only X-Frame-Options.
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    );
  }

  return headers;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The sandbox preview is served from https://{port}-{id}.e2b.app.
  // Dev-server only; `next start` ignores this.
  allowedDevOrigins: resolveAllowedDevOrigins(process.env),
  serverExternalPackages: ['@electric-sql/pglite'],
  eslint: { ignoreDuringBuilds: true },
  // Do not advertise the framework. Minor, but it is free to withhold.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: buildSecurityHeaders(process.env) }];
  },
  experimental: {
    // Cross-origin Server Action origins. The sandbox wildcard is excluded
    // from production builds; see src/lib/config/origins.mjs.
    serverActions: { allowedOrigins: resolveAllowedOrigins(process.env) },
  },
};
export default nextConfig;
