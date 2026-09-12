/**
 * Where uploaded documents are stored, and whether that location will survive.
 *
 * ## The problem this addresses
 *
 * `STORAGE_ROOT` defaults to `<cwd>/storage` — inside the application
 * directory. On a container deployment that directory is replaced wholesale on
 * every redeploy, so every uploaded document is destroyed while its database
 * row survives. Verified end to end: after removing the directory the document
 * is still listed, and downloading it returns a 500 reading "Something went
 * wrong. Please try again." — advice that can never succeed, for a file that is
 * permanently gone.
 *
 * The `STORAGE_ROOT` seam itself is sound. What was missing is anything telling
 * an operator that it *must* point at a persistent volume.
 *
 * ## What this module does
 *
 * Classifies the configured location and, in production, warns loudly at
 * startup when it is ephemeral. It deliberately does **not** refuse to boot:
 * unlike a missing DATABASE_URL — which silently accepts writes into a database
 * nobody will ever back up — a school running on a single VPS with no container
 * layer has a perfectly durable `<cwd>/storage`, and killing that deployment
 * would be wrong. The warning names the risk; the operator decides.
 */

import { isAbsolute, join, resolve, sep } from 'node:path';

/** Resolved storage location plus a judgement about its durability. */
export type StorageLocation = {
  /** Absolute path where document bytes are written. */
  root: string;
  /** True when STORAGE_ROOT was set explicitly rather than defaulted. */
  configured: boolean;
  /**
   * True when the path sits inside the application directory, which is the
   * arrangement a container redeploy destroys.
   */
  insideAppDirectory: boolean;
};

export type StorageEnvLike = {
  STORAGE_ROOT?: string | undefined;
  NODE_ENV?: string | undefined;
};

/**
 * Resolve the storage location exactly as `storage.ts` does.
 *
 * Kept in step with that module deliberately: a warning that describes a
 * different directory from the one actually written to would be worse than no
 * warning at all.
 */
export function resolveStorageLocation(
  env: StorageEnvLike = process.env,
  cwd: string = process.cwd(),
): StorageLocation {
  const raw = env.STORAGE_ROOT?.trim();
  const configured = raw !== undefined && raw !== '';
  const appDir = resolve(cwd);
  // Resolve relative values against `cwd` explicitly. `resolve(raw)` alone
  // would silently use the real `process.cwd()`, which makes the classification
  // wrong whenever the two differ — including in tests, which is how this was
  // caught. At runtime the two are the same, so behaviour is unchanged.
  const root = configured ? resolve(appDir, raw) : resolve(join(appDir, 'storage'));

  return {
    root,
    configured,
    // `===` covers the pathological case of STORAGE_ROOT being the app
    // directory itself; the separator check avoids matching a sibling whose
    // name merely starts with the same characters (`/srv/app-data` vs `/srv/app`).
    insideAppDirectory: root === appDir || root.startsWith(appDir + sep),
  };
}

/**
 * The warning to show, or null when the configuration is sound.
 *
 * Returns a string rather than logging directly so it can be asserted in tests
 * without capturing console output.
 */
export function storageWarning(
  env: StorageEnvLike = process.env,
  cwd: string = process.cwd(),
): string | null {
  const location = resolveStorageLocation(env, cwd);
  if (env.NODE_ENV !== 'production') return null;
  if (!location.insideAppDirectory) return null;

  return [
    `STORAGE_ROOT resolves to ${location.root}, which is inside the application directory.`,
    '',
    location.configured
      ? 'STORAGE_ROOT is set, but it points inside the application directory.'
      : 'STORAGE_ROOT is not set, so it has defaulted to <app>/storage.',
    '',
    'On a container deployment this directory is replaced on every redeploy.',
    'Uploaded documents — including medical and disciplinary records — would be',
    'destroyed while their database rows survive, leaving entries that can be',
    'listed but never opened. No backup covers this path either.',
    '',
    'Set STORAGE_ROOT to a persistent volume mounted outside the application',
    'directory, and include it in the backup policy. For example:',
    '  STORAGE_ROOT=/var/lib/school-os/storage',
    '',
    'If this server has no container layer and the application directory is',
    'genuinely durable, this warning can be ignored.',
  ].join('\n');
}

/** True when `candidate` is an absolute path. Used by the startup check. */
export function isAbsolutePath(candidate: string): boolean {
  return isAbsolute(candidate);
}
