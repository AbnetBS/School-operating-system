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
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  resolveStorageLocation,
  storageWarning,
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
