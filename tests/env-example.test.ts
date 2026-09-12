/**
 * Regression tests for audit finding M7 — no `.env.example`, one-line README.
 *
 * The whole configuration surface was undocumented, which is what turned the
 * C1 silent-fallback failure from theoretical into likely: nobody could know
 * `DATABASE_URL` was load-bearing.
 *
 * Documentation rots faster than code, so these tests check the two directions
 * that actually matter:
 *
 *   - every variable the application reads is documented, and
 *   - every variable documented is one the application really reads.
 *
 * The second direction matters as much as the first: an invented variable sends
 * an operator hunting for a setting that does nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Set by Next.js itself, or internal to the config — never operator-supplied. */
const NOT_OPERATOR_SET = new Set([
  'NEXT_RUNTIME', // Next sets this; instrumentation.ts only reads it
  '__SOS_ORIGIN_NOTICE', // internal once-only guard in next.config.mjs
]);

async function sourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, acc);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Every environment variable the application actually reads. */
async function referencedVariables(): Promise<Set<string>> {
  const files = [
    ...(await sourceFiles(join(ROOT, 'src'))),
    ...(await sourceFiles(join(ROOT, 'scripts'))),
    join(ROOT, 'next.config.mjs'),
    join(ROOT, 'drizzle.config.ts'),
  ];

  const found = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // an optional file such as drizzle.config.ts
    }
    // Strip comments so prose mentioning a variable is not counted as a read.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

    // process.env.FOO / process.env['FOO'] / env.FOO — the third covers the
    // injected-env pattern used by resolveSslConfig, clientIp and origins.mjs.
    for (const re of [
      /process\.env\.([A-Z_][A-Z0-9_]*)/g,
      /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
      /\benv\.([A-Z_][A-Z0-9_]{2,})/g,
    ]) {
      for (const match of code.matchAll(re)) found.add(match[1]!);
    }
  }
  return found;
}

/** Variable names mentioned in .env.example, whether commented out or not. */
async function documentedVariables(): Promise<Set<string>> {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    // `FOO=...` or `# FOO=...`, but not prose that happens to contain a word.
    const match = /^#?\s*([A-Z_][A-Z0-9_]*)=/.exec(line.trim());
    if (match) names.add(match[1]!);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The files exist at all
// ---------------------------------------------------------------------------

test('.env.example exists and is not empty', async () => {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  assert.ok(text.length > 500, 'a stub would not be documentation');
});

test('the README is a real deployment document, not a placeholder', async () => {
  const text = await readFile(join(ROOT, 'README.md'), 'utf8');
  assert.ok(text.split('\n').length > 50, 'the M7 finding was a one-line README');
});

// ---------------------------------------------------------------------------
// Documentation matches the code, both directions
// ---------------------------------------------------------------------------

test('every variable the application reads is documented', async () => {
  const referenced = await referencedVariables();
  const documented = await documentedVariables();
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  const example = await readFile(join(ROOT, '.env.example'), 'utf8');

  const missing: string[] = [];
  for (const name of referenced) {
    if (NOT_OPERATOR_SET.has(name)) {
      // Still must be explained somewhere, so its absence is not a mystery.
      assert.ok(example.includes(name), `${name} should be mentioned in .env.example`);
      continue;
    }
    if (!documented.has(name) && !readme.includes(name)) missing.push(name);
  }

  assert.deepEqual(missing, [], `undocumented environment variables: ${missing.join(', ')}`);
});

test('every documented variable is really used by the application', async () => {
  // Guards against inventing configuration that does nothing.
  const referenced = await referencedVariables();
  const documented = await documentedVariables();

  const invented = [...documented].filter((name) => !referenced.has(name));
  assert.deepEqual(invented, [], `documented but never read: ${invented.join(', ')}`);
});

test('the variables from the completed production fixes are all present', async () => {
  // C1, C2, C3/H1, H2, H3 each introduced or depend on one of these.
  const documented = await documentedVariables();
  for (const name of [
    'DATABASE_URL', // C1
    'NODE_ENV', // C1 and others
    'PG_SSL', // C3 / H1
    'PG_CA_CERT', // C3 / H1
    'TRUSTED_PROXY_HOPS', // C2
    'APP_ORIGIN', // H2
    'APP_ORIGINS', // H2
    'STORAGE_ROOT', // H3
    'PG_POOL_MAX',
    'PGLITE_DATA_DIR',
  ]) {
    assert.ok(documented.has(name), `${name} must appear in .env.example`);
  }
});

// ---------------------------------------------------------------------------
// Required vs optional, and safety of the committed values
// ---------------------------------------------------------------------------

test('required and optional variables are visibly distinguished', async () => {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  assert.match(text, /REQUIRED IN PRODUCTION/);
  assert.match(text, /OPTIONAL/);
  assert.match(text, /DEPLOYMENT-SPECIFIC/);
  assert.match(text, /DEVELOPMENT ONLY/);
});

test('the two production-mandatory variables are uncommented', async () => {
  // An operator copying this file should get a template that fails loudly on
  // the placeholder, not one that silently starts with everything disabled.
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  assert.match(text, /^NODE_ENV=production$/m);
  assert.match(text, /^DATABASE_URL=postgresql:\/\//m);
});

test('optional variables are commented out so copying changes no behaviour', async () => {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  for (const name of ['PG_SSL', 'PG_POOL_MAX', 'STORAGE_ROOT', 'TRUSTED_PROXY_HOPS', 'APP_ORIGIN']) {
    assert.match(
      text,
      new RegExp(`^#\\s*${name}=`, 'm'),
      `${name} must be commented out, not active`,
    );
  }
});

test('the placeholder credential is obviously a placeholder', async () => {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  const url = /^DATABASE_URL=(.+)$/m.exec(text)?.[1] ?? '';
  assert.match(url, /CHANGE_ME/, 'the example password must be unmistakably fake');
  assert.match(url, /example\.internal|localhost|example\.com/, 'the host must not be real');
});

test('no real secret is committed in .env.example', async () => {
  const text = await readFile(join(ROOT, '.env.example'), 'utf8');
  // A private key or a long random-looking token would mean a real credential
  // reached the repository.
  assert.ok(!/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(text), 'private key in .env.example');
  assert.ok(!/\bsk_live_|\bAKIA[0-9A-Z]{16}\b/.test(text), 'live API key in .env.example');

  for (const line of text.split('\n')) {
    const match = /^#?\s*[A-Z_]+=(.*)$/.exec(line.trim());
    const value = match?.[1] ?? '';
    // Ignore the documented CA-certificate placeholder block.
    if (value.includes('BEGIN CERTIFICATE')) continue;
    const bare = value.replace(/^["']|["']$/g, '');
    if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(bare)) {
      assert.fail(`possible secret committed: ${line.slice(0, 40)}…`);
    }
  }
});

test('.env itself stays ignored by git', async () => {
  const text = await readFile(join(ROOT, '.gitignore'), 'utf8');
  const lines = text.split('\n').map((l) => l.trim());
  assert.ok(lines.includes('.env'), '.env must never be committed');
  // ...but the template must not be swept up by that rule.
  assert.ok(!lines.includes('.env.example'), '.env.example must be committed');
});

// ---------------------------------------------------------------------------
// The README covers what a deployer actually has to decide
// ---------------------------------------------------------------------------

test('the README covers each required deployment topic', async () => {
  const text = (await readFile(join(ROOT, 'README.md'), 'utf8')).toLowerCase();
  const topics: [string, RegExp][] = [
    ['PostgreSQL version', /postgresql 15|postgresql\*\* 15|15 or newer/],
    ['migrations', /db:migrate/],
    ['environment variables', /\.env\.example/],
    ['HTTPS / secure cookies', /https/],
    ['trusted proxy', /trusted_proxy_hops/],
    ['database TLS', /pg_ssl/],
    ['file storage', /storage_root/],
    ['backups', /backup/],
    ['external providers', /sms/],
  ];
  for (const [label, pattern] of topics) {
    assert.match(text, pattern, `README must cover ${label}`);
  }
});

test('the README warns against seeding a production database', async () => {
  // db:seed creates users with a published password and has no env guard.
  const text = await readFile(join(ROOT, 'README.md'), 'utf8');
  assert.match(text, /never run `npm run db:seed` against a production database/i);
});

test('the documented npm scripts all exist', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const match of readme.matchAll(/npm run ([a-z:]+)/g)) {
    const script = match[1]!;
    assert.ok(pkg.scripts[script], `README references missing script "${script}"`);
  }
});

test('the documents the README points at exist', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  for (const match of readme.matchAll(/`(docs\/[a-z0-9-]+\.md)`/g)) {
    const path = match[1]!;
    await assert.doesNotReject(
      () => readFile(join(ROOT, path), 'utf8'),
      `README points at missing ${path}`,
    );
  }
});
