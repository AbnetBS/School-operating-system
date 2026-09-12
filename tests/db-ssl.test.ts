/**
 * Regression tests for audit finding H1 — database TLS certificate verification.
 *
 * Before the fix both `src/db/client.ts` and `scripts/migrate.ts` passed
 * `ssl: { rejectUnauthorized: false }` on every PostgreSQL connection. That
 * encrypts the link but authenticates nothing: any machine-in-the-middle can
 * present a self-signed certificate and read or modify every student, medical
 * and payment record travelling over it.
 *
 * The tests below cover both halves of the problem:
 *
 *   1. `resolveSslConfig()` returns verification-on by default and honours the
 *      documented opt-outs.
 *   2. A real TLS handshake against a rogue server proves the resulting
 *      settings actually block an impersonator — the old ones did not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSslConfig, DatabaseConfigError, type SslEnvLike } from '../src/db/config.ts';

const EMPTY: SslEnvLike = {};

// ---------------------------------------------------------------------------
// Defaults and opt-outs
// ---------------------------------------------------------------------------

test('TLS verification is ON by default', () => {
  const ssl = resolveSslConfig(EMPTY);
  assert.deepEqual(ssl, { rejectUnauthorized: true });
});

test('the old insecure default is gone', () => {
  // The precise regression: an unconfigured deployment must never again send
  // rejectUnauthorized:false.
  const ssl = resolveSslConfig(EMPTY);
  assert.notEqual(
    typeof ssl === 'object' && ssl !== null && ssl.rejectUnauthorized,
    false,
    'an unconfigured deployment must verify certificates',
  );
});

test('PG_SSL=no-verify is an explicit, greppable opt-out', () => {
  assert.deepEqual(resolveSslConfig({ PG_SSL: 'no-verify' }), { rejectUnauthorized: false });
});

test('PG_SSL=false and PG_SSL=disable turn TLS off entirely', () => {
  // For a Unix socket or a trusted private network, where TLS is not in play.
  assert.equal(resolveSslConfig({ PG_SSL: 'false' }), false);
  assert.equal(resolveSslConfig({ PG_SSL: 'disable' }), false);
});

test('PG_SSL=false keeps working exactly as before (no behaviour change)', () => {
  // This value was already supported; the fix must not break deployments
  // that rely on it.
  assert.equal(resolveSslConfig({ PG_SSL: 'false' }), false);
});

test('PG_CA_CERT supplies a private root while keeping verification on', () => {
  const ssl = resolveSslConfig({ PG_CA_CERT: '-----BEGIN CERTIFICATE-----\nMII...\n' });
  assert.equal(typeof ssl === 'object' && ssl !== null && ssl.rejectUnauthorized, true);
  assert.match(String(typeof ssl === 'object' && ssl !== null ? ssl.ca : ''), /BEGIN CERTIFICATE/);
});

test('PG_SSL=no-verify beats PG_CA_CERT when both are set', () => {
  // An explicit opt-out is explicit. It must not be silently upgraded.
  assert.deepEqual(
    resolveSslConfig({ PG_SSL: 'no-verify', PG_CA_CERT: 'x' }),
    { rejectUnauthorized: false },
  );
});

test('an unrecognised PG_SSL value fails loudly instead of guessing', () => {
  // A typo like PG_SSL=tru must not quietly fall back to something insecure.
  for (const bad of ['tru', 'true', 'yes', 'require', 'verify-full', '1']) {
    assert.throws(
      () => resolveSslConfig({ PG_SSL: bad }),
      DatabaseConfigError,
      `PG_SSL="${bad}" must be rejected`,
    );
  }
});

test('the PG_SSL error message names the valid values and leaks no secrets', () => {
  try {
    resolveSslConfig({ PG_SSL: 'tru', DATABASE_URL: 'postgresql://u:hunter2@h:5432/d' });
    assert.fail('expected a throw');
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /no-verify/);
    assert.match(message, /verify/);
    assert.ok(!message.includes('hunter2'), 'must not echo credentials');
  }
});

test('empty or whitespace PG_SSL is treated as unset, not as an error', () => {
  assert.deepEqual(resolveSslConfig({ PG_SSL: '' }), { rejectUnauthorized: true });
  assert.deepEqual(resolveSslConfig({ PG_SSL: '   ' }), { rejectUnauthorized: true });
});

// ---------------------------------------------------------------------------
// sslmode in the URL must not be overridden
// ---------------------------------------------------------------------------

test('an sslmode in DATABASE_URL is left for pg to interpret', () => {
  // Passing an explicit `ssl` object overrides the connection string, so a
  // deployment that carefully set `?sslmode=verify-full` would have had it
  // silently discarded. `undefined` means "do not override".
  for (const mode of ['verify-full', 'verify-ca', 'require', 'disable']) {
    assert.equal(
      resolveSslConfig({ DATABASE_URL: `postgresql://u:p@h:5432/d?sslmode=${mode}` }),
      undefined,
      `sslmode=${mode} in the URL must be honoured`,
    );
  }
});

test('an explicit PG_SSL still overrides an sslmode in the URL', () => {
  // Env wins when the operator sets it deliberately; the URL only wins when
  // PG_SSL is unset.
  assert.deepEqual(
    resolveSslConfig({
      PG_SSL: 'no-verify',
      DATABASE_URL: 'postgresql://u:p@h:5432/d?sslmode=verify-full',
    }),
    { rejectUnauthorized: false },
  );
  assert.equal(
    resolveSslConfig({ PG_SSL: 'false', DATABASE_URL: 'postgresql://u:p@h/d?sslmode=require' }),
    false,
  );
});

test('a URL without sslmode falls through to the verifying default', () => {
  assert.deepEqual(
    resolveSslConfig({ DATABASE_URL: 'postgresql://u:p@h:5432/d' }),
    { rejectUnauthorized: true },
  );
});

test('a malformed DATABASE_URL does not crash the TLS decision', () => {
  assert.deepEqual(
    resolveSslConfig({ DATABASE_URL: 'not a url' }),
    { rejectUnauthorized: true },
  );
});

// ---------------------------------------------------------------------------
// The settings must actually stop an impersonator
// ---------------------------------------------------------------------------

/**
 * Generate a throwaway self-signed certificate, as a MITM proxy would present.
 * Returns null when openssl is unavailable so the suite still runs elsewhere.
 */
function makeSelfSignedCert(): { key: string; cert: string; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'sos-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
        '-days', '1', '-nodes', '-subj', '/CN=attacker.example.com',
      ],
      { stdio: 'pipe' },
    );
    return {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
      dir,
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/** Attempt a TLS handshake against a rogue server using the given ssl options. */
async function handshake(
  port: number,
  options: tls.ConnectionOptions,
): Promise<{ connected: boolean; authorized: boolean; code?: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, servername: 'db.myschool.example.com', ...options },
      () => {
        const authorized = socket.authorized;
        socket.destroy();
        resolve({ connected: true, authorized });
      },
    );
    socket.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ connected: false, authorized: false, code: error.code });
    });
  });
}

test('the resolved settings refuse a rogue server, and the old ones accepted it', async (t) => {
  const material = makeSelfSignedCert();
  if (!material) {
    t.skip('openssl is unavailable in this environment');
    return;
  }

  const server = tls.createServer({ key: material.key, cert: material.cert }, (socket) =>
    socket.end(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    // What the code used to send.
    const before = await handshake(port, { rejectUnauthorized: false });
    assert.equal(before.connected, true, 'the old setting connected to an impersonator');
    assert.equal(before.authorized, false, '...without the certificate ever being trusted');

    // What the code sends now.
    const ssl = resolveSslConfig(EMPTY);
    assert.ok(typeof ssl === 'object' && ssl !== null);
    const after = await handshake(port, { rejectUnauthorized: ssl.rejectUnauthorized });
    assert.equal(after.connected, false, 'the new default must refuse an impersonator');
    assert.match(String(after.code), /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/i);
  } finally {
    server.close();
    rmSync(material.dir, { recursive: true, force: true });
  }
});

test('PG_SSL=no-verify still connects, for providers with self-signed certs', async (t) => {
  const material = makeSelfSignedCert();
  if (!material) {
    t.skip('openssl is unavailable in this environment');
    return;
  }

  const server = tls.createServer({ key: material.key, cert: material.cert }, (socket) =>
    socket.end(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const ssl = resolveSslConfig({ PG_SSL: 'no-verify' });
    assert.ok(typeof ssl === 'object' && ssl !== null);
    const result = await handshake(port, { rejectUnauthorized: ssl.rejectUnauthorized });
    assert.equal(result.connected, true, 'the documented escape hatch must still work');
  } finally {
    server.close();
    rmSync(material.dir, { recursive: true, force: true });
  }
});

test('a certificate signed by a supplied CA is accepted when PG_CA_CERT is set', async (t) => {
  const material = makeSelfSignedCert();
  if (!material) {
    t.skip('openssl is unavailable in this environment');
    return;
  }

  const server = tls.createServer({ key: material.key, cert: material.cert }, (socket) =>
    socket.end(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const ssl = resolveSslConfig({ PG_CA_CERT: material.cert });
    assert.ok(typeof ssl === 'object' && ssl !== null);
    // Verification stays on; the supplied root is what makes it succeed. The
    // hostname must also match, which is why servername is set to the cert CN.
    const result = await handshake(port, {
      rejectUnauthorized: ssl.rejectUnauthorized,
      ca: ssl.ca,
      servername: 'attacker.example.com',
    });
    assert.equal(result.connected, true, 'a trusted private root must be accepted');
    assert.equal(result.authorized, true, 'and the connection must be genuinely authorized');
  } finally {
    server.close();
    rmSync(material.dir, { recursive: true, force: true });
  }
});

test('PG_CA_CERT does not make an unrelated certificate acceptable', async (t) => {
  const trusted = makeSelfSignedCert();
  const rogue = makeSelfSignedCert();
  if (!trusted || !rogue) {
    t.skip('openssl is unavailable in this environment');
    return;
  }

  const server = tls.createServer({ key: rogue.key, cert: rogue.cert }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const ssl = resolveSslConfig({ PG_CA_CERT: trusted.cert });
    assert.ok(typeof ssl === 'object' && ssl !== null);
    const result = await handshake(port, {
      rejectUnauthorized: ssl.rejectUnauthorized,
      ca: ssl.ca,
      servername: 'attacker.example.com',
    });
    assert.equal(result.connected, false, 'a different self-signed cert must still be refused');
  } finally {
    server.close();
    rmSync(trusted.dir, { recursive: true, force: true });
    rmSync(rogue.dir, { recursive: true, force: true });
  }
});
