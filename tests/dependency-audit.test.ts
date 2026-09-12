/**
 * Regression tests for audit finding L1 — `npm audit --production` reported
 * 1 high + 1 moderate, both `postcss <=8.5.22` reached through `next@15.5.25`.
 *
 * The audit's recommendation was to *defer*, because the only remedy npm
 * offered was `next@16`, a breaking major upgrade. That recommendation was
 * sound given the information in the report, but it rested on npm's framing.
 * Inspection showed a smaller remedy exists:
 *
 *   - `next@15.5.25` pins `postcss` to an exact `8.4.31`.
 *   - The advisories are fixed in `8.5.23`, the *same major version*.
 *   - Next 16's own fix was simply moving its pin to `8.5.23` — the major
 *     version bump carries unrelated breaking changes and is not what fixes
 *     postcss.
 *
 * So an `overrides` entry applies exactly the same patch that Next 16 applies,
 * without the framework upgrade. Verified during the fix: the compiled CSS is
 * byte-for-byte identical before and after, down to the same content hash.
 *
 * These tests exist so the override cannot be silently dropped, and so that a
 * future `next` upgrade that makes it redundant is noticed rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;

function pkg(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'));
}

/** Parse a semver-ish string into comparable numbers. */
function parts(version: string): [number, number, number] {
  const [maj, min, pat] = version.replace(/^[^\d]*/, '').split('.').map(Number);
  return [maj ?? 0, min ?? 0, pat ?? 0];
}

function atLeast(version: string, floor: string): boolean {
  const a = parts(version);
  const b = parts(floor);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The fix itself
// ---------------------------------------------------------------------------

test('L1: the resolved postcss is above the vulnerable range', () => {
  // Advisory range is <=8.5.22; the highest patched floor among the four
  // advisories is 8.5.23.
  const version = require_('postcss/package.json').version as string;
  assert.ok(
    atLeast(version, '8.5.23'),
    `postcss ${version} is within the vulnerable range (<=8.5.22)`,
  );
});

test('L1: no second, vulnerable postcss copy is nested under next', () => {
  // The original finding was reached through node_modules/next/node_modules/
  // postcss@8.4.31. A duplicate nested copy would reintroduce it while the
  // top-level version looked fine.
  let nested: string | null = null;
  try {
    nested = require_('next/node_modules/postcss/package.json').version as string;
  } catch {
    nested = null; // Deduplicated by the override — the expected state.
  }

  if (nested !== null) {
    assert.ok(
      atLeast(nested, '8.5.23'),
      `a nested postcss ${nested} under next is still vulnerable`,
    );
  }
});

test('L1: the override is declared, and explained', () => {
  const p = pkg();
  const overrides = p.overrides as Record<string, string> | undefined;

  assert.ok(overrides, 'the postcss override must not be dropped silently');
  assert.ok(overrides.postcss, 'expected an explicit postcss override');

  // An unexplained override is a trap for the next maintainer.
  const note = String(p.overridesComment ?? '');
  assert.match(note, /L1/, 'the override should reference the audit finding');
  assert.match(note, /postcss/i);
});

// ---------------------------------------------------------------------------
// The upgrade question the finding actually raised
// ---------------------------------------------------------------------------

test('L1: next is pinned exactly, so a major upgrade cannot arrive by accident', () => {
  // A caret on a framework is how an unreviewed major lands in a deploy.
  const deps = (pkg().dependencies ?? {}) as Record<string, string>;
  assert.match(
    deps.next!,
    /^\d+\.\d+\.\d+$/,
    'next must stay exactly pinned; a Next 16 upgrade is a deliberate, tested change',
  );
  for (const name of ['react', 'react-dom']) {
    assert.match(deps[name]!, /^\d+\.\d+\.\d+$/, `${name} should be exactly pinned too`);
  }
});

test('L1: the app stays clear of the Next 16 breaking changes it would hit', () => {
  // Not an upgrade, but a cheap tripwire: these are the migration blockers
  // documented for Next 16. The app is already clear of all of them, which is
  // what makes the deferred upgrade low-risk when it is eventually scheduled.
  const listed = execFileSync(
    'git',
    ['ls-files', 'src', 'next.config.mjs', 'middleware.ts', 'proxy.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter((f) => f && /\.(ts|tsx|mjs)$/.test(f));

  const offenders: string[] = [];
  for (const file of listed) {
    const source = readFileSync(`${ROOT}/${file}`, 'utf8');
    // Strip comments so prose about headers() is not mistaken for a call.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Only files that import the request APIs can misuse them. Without this
    // guard the check trips on unrelated identifiers — `next.config.mjs`
    // legitimately defines an async `headers()` config function, which has
    // nothing to do with `next/headers`.
    if (!/from\s+['"]next\/headers['"]/.test(code)) continue;

    // Sync request APIs are fully removed in Next 16.
    for (const api of ['cookies', 'headers', 'draftMode']) {
      const call = new RegExp(`(?<!await\\s)(?<!\\.)\\b${api}\\(\\)`, 'g');
      for (const match of code.matchAll(call)) {
        const before = code.slice(Math.max(0, match.index! - 30), match.index!);
        if (!/await\s*$/.test(before)) offenders.push(`${file}: unawaited ${api}()`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Next 16 blockers found: ${offenders.join(', ')}`);
});

test('L1: middleware.ts is still absent, so the proxy.ts rename is a non-issue', () => {
  // Next 16 renames middleware.ts to proxy.ts and, notably, breaks it
  // *silently* if missed. M5 was deliberately solved without a middleware, so
  // there is nothing to rename.
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(!/^middleware\.(ts|js)$/m.test(tracked), 'no middleware file expected');
  assert.ok(!/^src\/middleware\.(ts|js)$/m.test(tracked), 'no src/middleware file expected');
});

test('L1: no custom webpack config, which Turbopack-by-default would reject', () => {
  const config = readFileSync(`${ROOT}/next.config.mjs`, 'utf8');
  assert.ok(!/\bwebpack\s*[:(]/.test(config), 'a webpack config would block the Next 16 build');
});
