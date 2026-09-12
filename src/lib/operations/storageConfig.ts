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
 *
 * It also probes whether the process can *write* there at all, which is a
 * distinct and more common container failure — see
 * `storageWritabilityProblem`.
 */

import { access, constants, mkdir, stat } from 'node:fs/promises';
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

/**
 * Whether the process can actually write to `STORAGE_ROOT` — null when it can.
 *
 * ## The problem this addresses
 *
 * A directory that survives redeploys can still be one the application cannot
 * write to. The container image runs unprivileged and creates the storage
 * directory at build time, so a Docker *named* volume mounted there is
 * initialised from the image and inherits that ownership. A *bind* mount is
 * not: the platform creates the host directory as root, and mounting it hides
 * the image's directory along with its permissions.
 *
 * Nothing reports that. Migrations apply, the server boots, `/api/health`
 * returns 200 and the deployment is marked successful — then every document
 * upload fails with `EACCES`, whenever a teacher first tries to file a scan.
 *
 * ## What this does
 *
 * Probes the directory in production and returns a message naming the exact
 * host-side fix. Like `storageWarning` it warns rather than refuses to boot:
 * documents are one module, and taking down attendance, grades and fees
 * because an upload directory is mis-permissioned would be the worse outcome.
 * A loud, specific line in the deploy log is the proportionate response.
 */
export async function storageWritabilityProblem(
  env: StorageEnvLike = process.env,
  cwd: string = process.cwd(),
): Promise<string | null> {
  if (env.NODE_ENV !== 'production') return null;

  const { root } = resolveStorageLocation(env, cwd);

  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      return unwritable(root, 'it exists but is not a directory');
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return unwritable(root, describeError(error));
    // Not created yet. `putObject` creates it on the first upload, so do the
    // same now: an unwritable parent is exactly the failure being looked for,
    // and leaving the directory in place costs nothing.
    try {
      await mkdir(root, { recursive: true });
    } catch (mkdirError) {
      return unwritable(root, describeError(mkdirError));
    }
    return null;
  }

  try {
    await access(root, constants.W_OK);
  } catch (error) {
    return unwritable(root, describeError(error));
  }

  return null;
}

/** The process identity, as far as this platform can describe it. */
function currentIdentity(): { label: string; owner: string } {
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    const uid = process.getuid();
    const gid = process.getgid();
    return { label: `uid ${uid}, gid ${gid}`, owner: `${uid}:${gid}` };
  }
  // Windows has no process uid. The image's user is the one that matters.
  return { label: 'the application user', owner: '1001:1001' };
}

function describeError(error: unknown): string {
  const message = (error as NodeJS.ErrnoException | undefined)?.message;
  return message ? message : String(error);
}

/**
 * The operator-facing report. Returns a string rather than logging so it can be
 * asserted in tests without capturing console output, as with `storageWarning`.
 */
function unwritable(root: string, reason: string): string {
  const { label, owner } = currentIdentity();

  return [
    `STORAGE_ROOT (${root}) is not writable by this process (${label}).`,
    '',
    `Reason: ${reason}.`,
    '',
    'The rest of the application will look healthy — migrations apply, the',
    'server starts, health checks pass — while every document upload fails.',
    'The container runs unprivileged on purpose; a bind-mounted host directory',
    'is created by the platform as root and hides the ownership the image sets',
    'at build time.',
    '',
    'On the Docker host, give the mounted directory to the container user. The',
    `path is the volume's source, not STORAGE_ROOT:`,
    `  sudo chown -R ${owner} <host directory mounted at ${root}>`,
    '',
    'Or mount a Docker named volume at that path instead of a bind mount: an',
    'empty named volume is initialised from the image and inherits its',
    'ownership.',
  ].join('\n');
}
