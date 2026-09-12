/**
 * Regression tests for audit finding H3 — uploaded documents on ephemeral storage.
 *
 * `STORAGE_ROOT` defaults to `<cwd>/storage`, inside the application directory.
 * A container redeploy replaces that directory, so every uploaded document is
 * destroyed while its database row survives. Confirmed end to end before the
 * fix: the document remained listed and downloading it returned a 500 saying
 * "Something went wrong. Please try again." — for a file that no longer exists.
 *
 * Two things are covered here:
 *
 *   1. The startup check classifies the configured location correctly and warns
 *      in production when it is ephemeral.
 *   2. A missing file is reported honestly instead of as a retryable fault.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  resolveStorageLocation,
  storageWarning,
  storageWritabilityProblem,
  type StorageEnvLike,
} from '../src/lib/operations/storageConfig.ts';

const APP_DIR = '/srv/school-os';

// ---------------------------------------------------------------------------
// Classifying the storage location
// ---------------------------------------------------------------------------

test('an unset STORAGE_ROOT defaults inside the application directory', () => {
  const location = resolveStorageLocation({}, APP_DIR);
  assert.equal(location.root, resolve(join(APP_DIR, 'storage')));
  assert.equal(location.configured, false);
  assert.equal(location.insideAppDirectory, true, 'the default is the ephemeral case');
});

test('a STORAGE_ROOT on a separate volume is recognised as durable', () => {
  const location = resolveStorageLocation({ STORAGE_ROOT: '/var/lib/school-os/storage' }, APP_DIR);
  assert.equal(location.root, '/var/lib/school-os/storage');
  assert.equal(location.configured, true);
  assert.equal(location.insideAppDirectory, false);
});

test('a STORAGE_ROOT set inside the app directory is still flagged', () => {
  // Setting the variable is not the same as setting it correctly.
  const location = resolveStorageLocation({ STORAGE_ROOT: `${APP_DIR}/uploads` }, APP_DIR);
  assert.equal(location.configured, true);
  assert.equal(location.insideAppDirectory, true);
});

test('the application directory itself is treated as inside', () => {
  assert.equal(resolveStorageLocation({ STORAGE_ROOT: APP_DIR }, APP_DIR).insideAppDirectory, true);
});

test('a sibling directory with a shared prefix is NOT treated as inside', () => {
  // `/srv/school-os-data` must not be mistaken for a child of `/srv/school-os`.
  const location = resolveStorageLocation({ STORAGE_ROOT: '/srv/school-os-data' }, APP_DIR);
  assert.equal(location.insideAppDirectory, false, 'prefix matching must respect separators');
});

test('a relative STORAGE_ROOT is resolved against the app directory', () => {
  const location = resolveStorageLocation({ STORAGE_ROOT: './storage' }, APP_DIR);
  assert.equal(location.insideAppDirectory, true, 'a relative path lands inside the app dir');
});

test('an empty or whitespace STORAGE_ROOT is treated as unset', () => {
  for (const raw of ['', '   ']) {
    const location = resolveStorageLocation({ STORAGE_ROOT: raw }, APP_DIR);
    assert.equal(location.configured, false);
    assert.equal(location.root, resolve(join(APP_DIR, 'storage')));
  }
});

test('a path traversing back out of the app directory is durable', () => {
  const location = resolveStorageLocation({ STORAGE_ROOT: `${APP_DIR}/../shared-storage` }, APP_DIR);
  assert.equal(location.insideAppDirectory, false);
  assert.equal(location.root, '/srv/shared-storage');
});

// ---------------------------------------------------------------------------
// The startup warning
// ---------------------------------------------------------------------------

test('production + default STORAGE_ROOT produces a warning', () => {
  const warning = storageWarning({ NODE_ENV: 'production' }, APP_DIR);
  assert.ok(warning, 'the ephemeral default must warn in production');
  assert.match(warning, /redeploy/i);
  assert.match(warning, /STORAGE_ROOT/);
  assert.match(warning, /persistent volume/i);
});

test('the warning names the actual resolved path, not a guess', () => {
  const warning = storageWarning({ NODE_ENV: 'production' }, APP_DIR);
  assert.ok(warning?.includes(resolve(join(APP_DIR, 'storage'))));
});

test('the warning distinguishes "unset" from "set but wrong"', () => {
  const unset = storageWarning({ NODE_ENV: 'production' }, APP_DIR);
  const wrong = storageWarning(
    { NODE_ENV: 'production', STORAGE_ROOT: `${APP_DIR}/uploads` },
    APP_DIR,
  );
  assert.match(String(unset), /not set/i);
  assert.match(String(wrong), /is set, but/i);
});

test('production + a persistent volume produces no warning', () => {
  assert.equal(
    storageWarning({ NODE_ENV: 'production', STORAGE_ROOT: '/var/lib/school-os/storage' }, APP_DIR),
    null,
  );
});

test('development never warns, whatever the configuration', () => {
  // `npm run dev` writing to ./storage is correct and must stay quiet.
  assert.equal(storageWarning({ NODE_ENV: 'development' }, APP_DIR), null);
  assert.equal(storageWarning({}, APP_DIR), null);
  assert.equal(storageWarning({ NODE_ENV: 'test' }, APP_DIR), null);
});

test('the warning leaks no credentials or unrelated environment values', () => {
  const warning = storageWarning(
    {
      NODE_ENV: 'production',
      // A realistic neighbouring secret; it must not be echoed.
      ...({ DATABASE_URL: 'postgresql://u:hunter2@db/school' } as StorageEnvLike),
    },
    APP_DIR,
  );
  assert.ok(warning);
  assert.ok(!warning.includes('hunter2'));
  assert.ok(!warning.includes('postgresql://'));
});

// ---------------------------------------------------------------------------
// A missing file must be reported honestly
// ---------------------------------------------------------------------------

test('getObject reports a lost file as MissingObjectError, not a raw ENOENT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sos-storage-'));
  const previous = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = dir;

  try {
    // Import after setting the variable: storage.ts reads it at module load.
    const mod = await import(`../src/lib/operations/storage.ts?h3=${randomUUID()}`);
    const { putObject, getObject, MissingObjectError } = mod as typeof import('../src/lib/operations/storage.ts');

    const key = `${randomUUID()}/${randomUUID()}`;
    await putObject(key, Buffer.from('PUPIL MEDICAL RECORD'));
    assert.equal((await getObject(key)).toString(), 'PUPIL MEDICAL RECORD', 'readable while present');

    // Simulate the redeploy that erases the directory.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    await assert.rejects(
      () => getObject(key),
      (error: Error) => {
        assert.ok(error instanceof MissingObjectError, `got ${error.name}`);
        // The message must tell an administrator what actually happened.
        assert.match(error.message, /no longer available/i);
        assert.match(error.message, /re-upload/i);
        // And must not tell them to simply try again, which can never work.
        assert.ok(
          !/please try again\.?$/i.test(error.message),
          'a permanent loss must not be described as retryable',
        );
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.STORAGE_ROOT;
    else process.env.STORAGE_ROOT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely present file is unaffected by the new error path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sos-storage-'));
  const previous = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = dir;

  try {
    const mod = await import(`../src/lib/operations/storage.ts?h3ok=${randomUUID()}`);
    const { putObject, getObject } = mod as typeof import('../src/lib/operations/storage.ts');

    const key = `${randomUUID()}/${randomUUID()}`;
    const payload = Buffer.from('attendance register scan');
    await putObject(key, payload);

    assert.deepEqual(await getObject(key), payload, 'normal reads must still work');
  } finally {
    if (previous === undefined) delete process.env.STORAGE_ROOT;
    else process.env.STORAGE_ROOT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed key still fails as a key error, not as a missing object', async () => {
  // The traversal guard must keep firing first; a bad key is a bug, not a
  // lost file, and the two must not be conflated.
  const mod = await import(`../src/lib/operations/storage.ts?h3bad=${randomUUID()}`);
  const { getObject, MissingObjectError } = mod as typeof import('../src/lib/operations/storage.ts');

  await assert.rejects(
    () => getObject('../../etc/passwd'),
    (error: Error) => {
      assert.ok(!(error instanceof MissingObjectError), 'traversal must not look like a lost file');
      assert.match(error.message, /Malformed storage key/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Can the process actually write there?
//
// The container runs unprivileged. A Docker named volume mounted at
// STORAGE_ROOT is initialised from the image and inherits its ownership; a
// bind mount is not — the platform creates the host directory as root, the
// mount hides the image's directory, and every upload fails with EACCES on a
// deployment that otherwise reported success.
// ---------------------------------------------------------------------------

/** Root ignores permission bits, so the unwritable case cannot be constructed. */
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a writable STORAGE_ROOT is reported as fine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sos-storage-w-'));
  try {
    assert.equal(
      await storageWritabilityProblem({ NODE_ENV: 'production', STORAGE_ROOT: dir }, APP_DIR),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a STORAGE_ROOT that does not exist yet is created, as the first upload would', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'sos-storage-p-'));
  const dir = join(parent, 'school-os', 'storage');
  try {
    assert.equal(
      await storageWritabilityProblem({ NODE_ENV: 'production', STORAGE_ROOT: dir }, APP_DIR),
      null,
      'a missing directory is not a fault',
    );
    assert.ok(existsSync(dir), 'the probe leaves the directory ready to use');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a directory the process cannot write is reported with the fix', async (t) => {
  if (runningAsRoot) return t.skip('running as root: permission bits are ignored');

  const dir = mkdtempSync(join(tmpdir(), 'sos-storage-ro-'));
  chmodSync(dir, 0o555); // read + traverse, no write — the bind-mount case
  try {
    const problem = await storageWritabilityProblem(
      { NODE_ENV: 'production', STORAGE_ROOT: dir },
      APP_DIR,
    );
    assert.ok(problem, 'an unwritable storage root must be reported');
    assert.match(problem, /not writable/i);
    assert.ok(problem.includes(dir), 'the message must name the real path');
    // Actionable: the command to run on the host, and the alternative.
    assert.match(problem, /chown/);
    assert.match(problem, /named volume/i);
    assert.match(problem, /bind mount/i);
    // The underlying reason is included, because EACCES and ENOSPC need
    // different responses.
    assert.match(problem, /EACCES/);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable parent is reported too, before the first upload creates it', async (t) => {
  if (runningAsRoot) return t.skip('running as root: permission bits are ignored');

  const parent = mkdtempSync(join(tmpdir(), 'sos-storage-pr-'));
  chmodSync(parent, 0o555);
  try {
    const problem = await storageWritabilityProblem(
      { NODE_ENV: 'production', STORAGE_ROOT: join(parent, 'storage') },
      APP_DIR,
    );
    assert.ok(problem, 'mkdir inside a read-only parent must be reported');
    assert.match(problem, /not writable/i);
  } finally {
    chmodSync(parent, 0o755);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a file where the directory must be is reported', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'sos-storage-f-'));
  const file = join(parent, 'storage');
  writeFileSync(file, 'not a directory');
  try {
    const problem = await storageWritabilityProblem(
      { NODE_ENV: 'production', STORAGE_ROOT: file },
      APP_DIR,
    );
    assert.ok(problem);
    assert.match(problem, /not a directory/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the writability probe stays quiet outside production', async (t) => {
  if (runningAsRoot) return t.skip('running as root: permission bits are ignored');

  const dir = mkdtempSync(join(tmpdir(), 'sos-storage-dev-'));
  chmodSync(dir, 0o555);
  try {
    // Development writes to ./storage and is allowed to be untidy about it;
    // matching storageWarning, this check is production-only.
    assert.equal(await storageWritabilityProblem({ STORAGE_ROOT: dir }, APP_DIR), null);
    assert.equal(
      await storageWritabilityProblem({ NODE_ENV: 'development', STORAGE_ROOT: dir }, APP_DIR),
      null,
    );
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the writability report leaks no credentials or unrelated environment values', async (t) => {
  if (runningAsRoot) return t.skip('running as root: permission bits are ignored');

  const dir = mkdtempSync(join(tmpdir(), 'sos-storage-leak-'));
  chmodSync(dir, 0o555);
  try {
    const problem = await storageWritabilityProblem(
      {
        NODE_ENV: 'production',
        STORAGE_ROOT: dir,
        ...({ DATABASE_URL: 'postgresql://u:hunter2@db/school' } as StorageEnvLike),
      },
      APP_DIR,
    );
    assert.ok(problem);
    assert.ok(!problem.includes('hunter2'));
    assert.ok(!problem.includes('postgresql://'));
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});
