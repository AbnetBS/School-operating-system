/**
 * Regression tests for audit finding H2 — sandbox origins in next.config.mjs.
 *
 * `serverActions.allowedOrigins` was hard-coded to `['*.e2b.app',
 * 'localhost:3000']`. `e2b.app` is a third-party sandbox host on which anyone
 * can provision a subdomain, so that wildcard names attacker-controllable
 * origins, and it was baked into production builds.
 *
 * Next only consults this list when a request's `Origin` differs from its
 * `Host`, so an ordinary same-origin deployment needs no entries at all. The
 * fix is therefore to keep the sandbox wildcard out of production rather than
 * to invent a production origin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEV_ORIGINS,
  normaliseOrigin,
  parseOrigins,
  resolveAllowedOrigins,
  resolveAllowedDevOrigins,
  originWarning,
} from '../src/lib/config/origins.mjs';

// Next's own matcher, so these tests assert real behaviour rather than a
// re-implementation of it.
import { isCsrfOriginAllowed } from 'next/dist/server/app-render/csrf-protection.js';

const PROD = { NODE_ENV: 'production' };

// ---------------------------------------------------------------------------
// The finding itself: no sandbox wildcard in production
// ---------------------------------------------------------------------------

test('production builds contain no e2b sandbox origin', () => {
  const origins = resolveAllowedOrigins({ ...PROD, APP_ORIGIN: 'school.edu.et' });
  assert.ok(!origins.some((o) => o.includes('e2b.app')), `leaked: ${origins.join(', ')}`);
  assert.deepEqual(origins, ['school.edu.et']);
});

test('production with no APP_ORIGIN allows nothing cross-origin', () => {
  // Safe by construction: same-origin requests never consult this list.
  assert.deepEqual(resolveAllowedOrigins(PROD), []);
});

test('an attacker-controlled sandbox origin is rejected in production', () => {
  const origins = resolveAllowedOrigins({ ...PROD, APP_ORIGIN: 'school.edu.et' });
  for (const hostile of [
    'attacker-sandbox.e2b.app',
    '3000-abcdef.e2b.app',
    'evil.e2b.app',
    'localhost:3000',
    'attacker.com',
  ]) {
    assert.equal(
      isCsrfOriginAllowed(hostile, origins),
      false,
      `${hostile} must not be accepted in production`,
    );
  }
});

test('the old configuration really did accept hostile sandbox origins', () => {
  // Pins the vulnerability this finding is about, so a revert fails loudly.
  const old = ['*.e2b.app', 'localhost:3000'];
  assert.equal(isCsrfOriginAllowed('attacker-sandbox.e2b.app', old), true);
  assert.equal(isCsrfOriginAllowed('evil.e2b.app', old), true);
});

test('the configured production origin is accepted by Next matcher', () => {
  const origins = resolveAllowedOrigins({ ...PROD, APP_ORIGIN: 'school.edu.et' });
  assert.equal(isCsrfOriginAllowed('school.edu.et', origins), true);
  // A subdomain is not implied by a bare host.
  assert.equal(isCsrfOriginAllowed('evil.school.edu.et', origins), false);
});

// ---------------------------------------------------------------------------
// Development keeps working
// ---------------------------------------------------------------------------

test('development still allows the sandbox preview', () => {
  const origins = resolveAllowedOrigins({ NODE_ENV: 'development' });
  assert.deepEqual(origins, DEV_ORIGINS);
  assert.equal(isCsrfOriginAllowed('3000-abc.e2b.app', origins), true);
});

test('an unset NODE_ENV is treated as non-production', () => {
  assert.ok(resolveAllowedOrigins({}).includes('*.e2b.app'));
});

test('allowedDevOrigins keeps the sandbox host even in production', () => {
  // This setting only applies to `next dev`, so it is not a production risk,
  // and stripping it would break a preview started with NODE_ENV=production.
  assert.ok(resolveAllowedDevOrigins(PROD).includes('*.e2b.app'));
});

test('development merges configured origins with the sandbox ones', () => {
  const origins = resolveAllowedOrigins({ NODE_ENV: 'development', APP_ORIGIN: 'staging.school.et' });
  assert.ok(origins.includes('staging.school.et'));
  assert.ok(origins.includes('*.e2b.app'));
});

// ---------------------------------------------------------------------------
// Operator input: normalisation and boundaries
// ---------------------------------------------------------------------------

test('a full URL is reduced to the host Next compares against', () => {
  // Next uses new URL(origin).host, so a scheme or path would never match.
  assert.equal(normaliseOrigin('https://school.edu.et'), 'school.edu.et');
  assert.equal(normaliseOrigin('https://school.edu.et/'), 'school.edu.et');
  assert.equal(normaliseOrigin('http://school.edu.et/portal?x=1'), 'school.edu.et');
  assert.equal(normaliseOrigin('//school.edu.et'), 'school.edu.et');
});

test('the port is preserved, because Next includes it in the host', () => {
  assert.equal(normaliseOrigin('https://school.edu.et:8443'), 'school.edu.et:8443');
});

test('case and a trailing dot are normalised', () => {
  assert.equal(normaliseOrigin('  HTTPS://School.EDU.et.  '), 'school.edu.et');
});

test('credentials in a URL are stripped', () => {
  assert.equal(normaliseOrigin('https://user:pw@school.edu.et'), 'school.edu.et');
});

test('empty and malformed entries are dropped, not passed through', () => {
  for (const bad of ['', '   ', 'https://', '//', 'a b.com']) {
    assert.equal(normaliseOrigin(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('a bare wildcard is refused outright', () => {
  // '*' would match every origin; it must never reach the config.
  assert.equal(normaliseOrigin('*'), null);
  assert.equal(normaliseOrigin('**'), null);
  assert.deepEqual(parseOrigins('*,**'), []);
});

test('a non-string input cannot crash the build', () => {
  assert.equal(normaliseOrigin(undefined as unknown as string), null);
  assert.equal(normaliseOrigin(null as unknown as string), null);
  assert.equal(normaliseOrigin(42 as unknown as string), null);
});

test('multiple origins parse, trim and de-duplicate', () => {
  assert.deepEqual(
    parseOrigins('school.edu.et, https://school.edu.et , portal.school.edu.et,,'),
    ['school.edu.et', 'portal.school.edu.et'],
  );
});

test('APP_ORIGINS takes precedence over APP_ORIGIN', () => {
  const origins = resolveAllowedOrigins({
    ...PROD,
    APP_ORIGIN: 'ignored.example',
    APP_ORIGINS: 'a.school.et,b.school.et',
  });
  assert.deepEqual(origins, ['a.school.et', 'b.school.et']);
});

test('an operator wildcard subdomain still works if deliberately set', () => {
  // Not forbidden — a school may legitimately run per-tenant subdomains.
  const origins = resolveAllowedOrigins({ ...PROD, APP_ORIGIN: '*.school.edu.et' });
  assert.equal(isCsrfOriginAllowed('addis.school.edu.et', origins), true);
  assert.equal(isCsrfOriginAllowed('attacker.com', origins), false);
});

// ---------------------------------------------------------------------------
// The build-time warning
// ---------------------------------------------------------------------------

test('a production build with no origin explains itself', () => {
  const warning = originWarning(PROD);
  assert.ok(warning);
  assert.match(warning, /APP_ORIGIN/);
  // It must not imply the deployment is broken; same-origin is fine.
  assert.match(warning, /safe for a normal deployment/i);
});

test('no warning once an origin is configured, or outside production', () => {
  assert.equal(originWarning({ ...PROD, APP_ORIGIN: 'school.edu.et' }), null);
  assert.equal(originWarning({ NODE_ENV: 'development' }), null);
  assert.equal(originWarning({}), null);
});

test('the warning leaks no neighbouring secrets', () => {
  const warning = originWarning({
    ...PROD,
    ...({ DATABASE_URL: 'postgresql://u:hunter2@db/school' } as Record<string, string>),
  });
  assert.ok(warning);
  assert.ok(!warning.includes('hunter2'));
});
