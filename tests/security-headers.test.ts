/**
 * Regression tests for audit finding M6 — no security response headers, and
 * the framework version disclosed.
 *
 * Baseline measured on the production build before the fix: the only notable
 * response header was `X-Powered-By: Next.js`. Missing were `X-Frame-Options`
 * / `frame-ancestors`, `Referrer-Policy` and `Permissions-Policy`.
 *
 * The audit is honest that the practical clickjacking risk is low, because
 * `SameSite=lax` means a cross-site iframe renders logged-out. These headers
 * are cheap defence in depth, not a fix for an exploited hole — so the tests
 * assert the headers are present and correctly scoped, and deliberately record
 * what is intentionally absent and why.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

type HeaderEntry = { key: string; value: string };

async function headersFor(env: Record<string, string | undefined>): Promise<Map<string, string>> {
  const suffix = `m6-${Math.random().toString(36).slice(2)}`;
  const saved = process.env.NODE_ENV;
  const mutable = process.env as Record<string, string | undefined>;
  if (env.NODE_ENV === undefined) delete mutable.NODE_ENV;
  else mutable.NODE_ENV = env.NODE_ENV;

  try {
    const config = (await import(`../next.config.mjs?${suffix}`)).default as {
      headers: () => Promise<{ source: string; headers: HeaderEntry[] }[]>;
    };
    const rules = await config.headers();
    return new Map(rules[0]!.headers.map((h) => [h.key, h.value]));
  } finally {
    mutable.NODE_ENV = saved;
  }
}

async function loadConfig() {
  const suffix = `m6cfg-${Math.random().toString(36).slice(2)}`;
  return (await import(`../next.config.mjs?${suffix}`)).default as Record<string, unknown> & {
    headers: () => Promise<{ source: string; headers: HeaderEntry[] }[]>;
  };
}

// ---------------------------------------------------------------------------
// The framework banner
// ---------------------------------------------------------------------------

test('the X-Powered-By banner is disabled', async () => {
  const config = await loadConfig();
  assert.equal(config.poweredByHeader, false);
});

// ---------------------------------------------------------------------------
// Headers that apply everywhere
// ---------------------------------------------------------------------------

test('Referrer-Policy does not leak record URLs to third parties', async () => {
  // A student record URL in a Referer header sent off-site is a real leak.
  for (const env of ['production', 'development']) {
    const headers = await headersFor({ NODE_ENV: env });
    assert.equal(headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin', env);
  }
});

test('nosniff is set, which matters because the app serves uploads', async () => {
  for (const env of ['production', 'development']) {
    const headers = await headersFor({ NODE_ENV: env });
    assert.equal(headers.get('X-Content-Type-Options'), 'nosniff', env);
  }
});

test('Permissions-Policy denies capabilities the app never uses', async () => {
  const headers = await headersFor({ NODE_ENV: 'production' });
  const policy = headers.get('Permissions-Policy') ?? '';
  for (const capability of ['camera', 'microphone', 'geolocation', 'payment']) {
    assert.match(policy, new RegExp(`${capability}=\\(\\)`), `${capability} should be denied`);
  }
});

test('the headers apply to every path, not just pages', async () => {
  const config = await loadConfig();
  const rules = await config.headers();
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.source, '/:path*', 'must cover API routes and uploads too');
});

// ---------------------------------------------------------------------------
// Frame protection, and why it is environment-dependent
// ---------------------------------------------------------------------------

test('production denies framing two ways', async () => {
  const headers = await headersFor({ NODE_ENV: 'production' });
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
  assert.equal(headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
});

test('development does not deny framing, so the preview still works', async () => {
  // The dev preview is served inside an iframe. Denying framing there breaks
  // it and makes production no safer — the same dev/prod split as H2.
  const headers = await headersFor({ NODE_ENV: 'development' });
  assert.equal(headers.get('X-Frame-Options'), undefined);
  assert.equal(headers.get('Content-Security-Policy'), undefined);
  // The environment-independent headers must still be present.
  assert.ok(headers.has('Referrer-Policy'));
  assert.ok(headers.has('X-Content-Type-Options'));
});

// ---------------------------------------------------------------------------
// What is deliberately NOT set
// ---------------------------------------------------------------------------

test('no HSTS is emitted by the application', async () => {
  // HSTS belongs on the TLS-terminating proxy, which knows the real scheme.
  // Emitting it from an app that also serves plain HTTP in development can pin
  // localhost to HTTPS in a developer's browser.
  for (const env of ['production', 'development']) {
    const headers = await headersFor({ NODE_ENV: env });
    assert.equal(headers.get('Strict-Transport-Security'), undefined, env);
  }
});

test('no blanket unsafe-inline CSP is shipped', async () => {
  // Next injects inline bootstrap scripts, so a real CSP needs per-request
  // nonces. A policy with unsafe-inline would look like protection and provide
  // none; that is worse than admitting the gap.
  const headers = await headersFor({ NODE_ENV: 'production' });
  const csp = headers.get('Content-Security-Policy') ?? '';
  assert.ok(!csp.includes('unsafe-inline'), 'a fake CSP is worse than none');
  assert.ok(!csp.includes('script-src'), 'script-src needs nonces; not attempted here');
});

// ---------------------------------------------------------------------------
// Previously closed findings must not regress
// ---------------------------------------------------------------------------

test('the H2 origin configuration is untouched', async () => {
  const config = await loadConfig();
  const experimental = config.experimental as { serverActions: { allowedOrigins: string[] } };
  const saved = process.env.NODE_ENV;
  const mutable = process.env as Record<string, string | undefined>;

  try {
    assert.ok(Array.isArray(experimental.serverActions.allowedOrigins));
    mutable.NODE_ENV = 'production';
    const prod = (await import(`../next.config.mjs?m6h2-${Date.now()}`)).default as typeof config;
    const origins = (prod.experimental as { serverActions: { allowedOrigins: string[] } })
      .serverActions.allowedOrigins;
    assert.ok(
      !origins.some((o) => o.includes('e2b.app')),
      'H2: the sandbox wildcard must stay out of production',
    );
  } finally {
    mutable.NODE_ENV = saved;
  }
});
