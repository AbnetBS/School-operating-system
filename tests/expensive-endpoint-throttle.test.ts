/**
 * Regression tests for audit finding M3 — no rate limiting on expensive
 * authenticated endpoints.
 *
 * The audit found exports unthrottled; that half was fixed with C2. Still open
 * were imports, uploads and messaging. Measured against the running
 * application before the fix:
 *
 *   - one 300-row import commit: **3.2 s** of database time
 *   - three consecutive commits wrote 900 students in 9.4 s, all HTTP 200
 *   - a paginated list read, by comparison: ~130 ms
 *
 * The per-file bound (5 MB / 5,000 rows) limits the size of one request, not
 * how many a caller may issue.
 *
 * The hard lesson from C2 is encoded here: a limiter that stops abuse but also
 * stops legitimate work is a denial of service of its own. Every policy below
 * is therefore checked from both directions — the attacker is stopped, and a
 * second user working normally is not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  throttleByUser,
  EXPORT_LIMIT,
  IMPORT_LIMIT,
  UPLOAD_LIMIT,
  MESSAGING_LIMIT,
} from '../src/lib/api/throttle.ts';

/** Drive a bucket n times and report how many were allowed. */
function drive(userId: string, bucket: string, policy: { limit: number; windowMs: number }, n: number) {
  let allowed = 0;
  let firstBlockedAt = -1;
  let lastResponse: ReturnType<typeof throttleByUser> = null;
  for (let i = 0; i < n; i++) {
    const verdict = throttleByUser(userId, bucket, policy);
    if (verdict === null) allowed++;
    else {
      if (firstBlockedAt === -1) firstBlockedAt = i;
      lastResponse = verdict;
    }
  }
  return { allowed, firstBlockedAt, lastResponse };
}

// ---------------------------------------------------------------------------
// Policies are actually enforced
// ---------------------------------------------------------------------------

test('the import commit limit stops a sustained run', () => {
  const user = randomUUID();
  const { allowed, firstBlockedAt } = drive(user, 'import:students', IMPORT_LIMIT, 30);
  assert.equal(allowed, IMPORT_LIMIT.limit, 'exactly the budget should pass');
  assert.equal(firstBlockedAt, IMPORT_LIMIT.limit, 'blocking starts right after the budget');
});

test('the upload limit stops a sustained run', () => {
  const user = randomUUID();
  const { allowed } = drive(user, 'upload:documents', UPLOAD_LIMIT, 60);
  assert.equal(allowed, UPLOAD_LIMIT.limit);
});

test('the messaging limit stops a sustained run', () => {
  const user = randomUUID();
  const { allowed } = drive(user, 'message:thread', MESSAGING_LIMIT, 90);
  assert.equal(allowed, MESSAGING_LIMIT.limit);
});

test('exports remain limited exactly as C2 left them', () => {
  // Guards against this change loosening a closed finding.
  assert.deepEqual({ ...EXPORT_LIMIT }, { limit: 10, windowMs: 60_000 });
  const { allowed } = drive(randomUUID(), 'export:students', EXPORT_LIMIT, 25);
  assert.equal(allowed, 10);
});

// ---------------------------------------------------------------------------
// The C2 lesson: legitimate users must not be collateral damage
// ---------------------------------------------------------------------------

test('one user hitting the limit does not block anyone else', () => {
  // The exact failure C2 shipped twice: an abusive caller locking out staff.
  const attacker = randomUUID();
  drive(attacker, 'import:students', IMPORT_LIMIT, 50);
  assert.equal(throttleByUser(attacker, 'import:students', IMPORT_LIMIT) !== null, true);

  for (let i = 0; i < 5; i++) {
    const colleague = randomUUID();
    assert.equal(
      throttleByUser(colleague, 'import:students', IMPORT_LIMIT),
      null,
      'a different member of staff must be unaffected',
    );
  }
});

test('buckets are independent, so one activity cannot exhaust another', () => {
  const user = randomUUID();
  drive(user, 'import:students', IMPORT_LIMIT, 50);
  assert.ok(throttleByUser(user, 'import:students', IMPORT_LIMIT) !== null, 'imports blocked');

  // The same person must still be able to upload, message and export.
  assert.equal(throttleByUser(user, 'upload:documents', UPLOAD_LIMIT), null);
  assert.equal(throttleByUser(user, 'message:thread', MESSAGING_LIMIT), null);
  assert.equal(throttleByUser(user, 'export:students', EXPORT_LIMIT), null);
});

test('threads and announcements have separate budgets', () => {
  const user = randomUUID();
  drive(user, 'message:thread', MESSAGING_LIMIT, 60);
  assert.ok(throttleByUser(user, 'message:thread', MESSAGING_LIMIT) !== null);
  assert.equal(
    throttleByUser(user, 'message:announcement', MESSAGING_LIMIT),
    null,
    'publishing an announcement is a different activity from a private thread',
  );
});

test('the budget is generous enough for real staff work', () => {
  // A registrar importing several files in one sitting must not be stopped.
  // Each commit follows a human reviewing a validation preview.
  const registrar = randomUUID();
  for (let i = 0; i < 5; i++) {
    assert.equal(
      throttleByUser(registrar, 'import:students', IMPORT_LIMIT),
      null,
      `import ${i + 1} of a normal working batch must pass`,
    );
  }
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

test('a blocked call returns 429 with Retry-After', async () => {
  const user = randomUUID();
  const { lastResponse } = drive(user, 'import:students', IMPORT_LIMIT, 20);
  assert.ok(lastResponse, 'expected a throttled response');
  assert.equal(lastResponse.status, 429);

  const retryAfter = Number(lastResponse.headers.get('Retry-After'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, 'Retry-After must be a positive number');
  assert.ok(retryAfter <= IMPORT_LIMIT.windowMs / 1000, 'and no longer than the window');
});

test('each activity explains itself in its own words', async () => {
  const cases: [string, { limit: number; windowMs: number }, RegExp][] = [
    ['import:students', IMPORT_LIMIT, /import/i],
    ['upload:documents', UPLOAD_LIMIT, /upload/i],
    ['message:thread', MESSAGING_LIMIT, /message/i],
    ['export:students', EXPORT_LIMIT, /export/i],
  ];
  for (const [bucket, policy, pattern] of cases) {
    const { lastResponse } = drive(randomUUID(), bucket, policy, policy.limit + 3);
    const body = (await lastResponse!.json()) as { error: string };
    assert.match(body.error, pattern, `${bucket} should name the activity`);
    // Never disclose other callers or infrastructure.
    assert.ok(!/ip|address|user|proxy/i.test(body.error), `${bucket} must not leak details`);
  }
});

// ---------------------------------------------------------------------------
// Routes wire the limiter in the right place
// ---------------------------------------------------------------------------

test('throttling happens after authorisation, never before', async () => {
  // Otherwise an unauthorised caller gets 429 instead of 403, and the limiter
  // becomes a probe for what exists. Also keeps a rejected caller from
  // consuming a legitimate user's budget.
  const { readFile } = await import('node:fs/promises');
  const routes: [string, string][] = [
    ['src/app/api/students/import/route.ts', "ctx.require('student.create')"],
    ['src/app/api/documents/route.ts', "ctx.require('document.upload')"],
    ['src/app/api/announcements/route.ts', "ctx.requireModule('announcements')"],
  ];

  for (const [path, guard] of routes) {
    const source = await readFile(path, 'utf8');
    const guardAt = source.indexOf(guard);
    // The call site, not the import statement at the top of the file.
    const throttleAt = source.indexOf('= throttleByUser(');
    assert.ok(guardAt > -1, `${path}: expected guard ${guard}`);
    assert.ok(throttleAt > -1, `${path}: expected a throttle call`);
    assert.ok(guardAt < throttleAt, `${path}: permission check must come first`);
  }
});

test('validation-only imports stay unthrottled', async () => {
  // Staff iterate on a preview until the file is clean; that path writes
  // nothing and must not be rationed.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/app/api/students/import/route.ts', 'utf8');

  const commitBlock = source.indexOf("if (mode === 'commit')");
  const throttleAt = source.indexOf('= throttleByUser(');
  assert.ok(commitBlock > -1 && throttleAt > commitBlock, 'the throttle must sit inside the commit branch');
});

test('search is still deliberately unthrottled', async () => {
  // C2 measured this at 60 ms and left it alone on purpose: SearchBox is a
  // debounced type-ahead, so a limiter there fires during ordinary typing.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/app/api/search/route.ts', 'utf8');
  assert.ok(!source.includes('throttleByUser'), 'throttling type-ahead would break normal use');
});
