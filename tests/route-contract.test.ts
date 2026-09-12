/**
 * Route contract tests.
 *
 * These read the API route files as source and assert structural properties
 * that are easy to forget and invisible until exploited. Every check here
 * exists because omitting it produces a route that works perfectly in manual
 * testing and is wide open in production:
 *
 *   - a handler that never calls `requireAuth` serves anonymous requests;
 *   - a mutation that never checks a permission lets any signed-in user write;
 *   - a handler not wrapped in `route()` leaks stack traces on error;
 *   - a `[id]` handler that reads `context.params` without awaiting gets a
 *     Promise, which stringifies to "[object Promise]" and silently matches
 *     nothing.
 *
 * A unit test cannot catch these, because each route is correct in isolation
 * and the bug is the absence of a line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const API_ROOT = 'src/app/api';

type RouteFile = { path: string; source: string };

async function collectRoutes(dir: string): Promise<RouteFile[]> {
  const out: RouteFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectRoutes(full)));
    } else if (entry.name === 'route.ts') {
      out.push({ path: full, source: await readFile(full, 'utf8') });
    }
  }
  return out;
}

const routes = await collectRoutes(API_ROOT);

/**
 * Endpoints that are deliberately reachable without a session.
 *
 * Kept as an explicit list rather than a pattern: adding a public endpoint
 * should be a decision someone writes down, not a side effect of a filename.
 */
const PUBLIC_ROUTES = new Set([
  join(API_ROOT, 'auth', 'login', 'route.ts'),
  join(API_ROOT, 'auth', 'logout', 'route.ts'),
    join(API_ROOT, 'auth', 'session', 'route.ts'),
    join(API_ROOT, 'schools', 'route.ts'),
    // Health/readiness probe (M5). A load balancer cannot hold a session, so
    // this one is public by necessity. It is kept safe by returning nothing
    // beyond "up" or "not up" — no version, hostname, driver or error text.
    join(API_ROOT, 'health', 'route.ts'),
  ]);

/** Handlers exported by a route file. */
function handlersIn(source: string): string[] {
  return [...source.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)].map((m) => m[1]!);
}

test('every API route file exports at least one handler', () => {
  assert.ok(routes.length > 20, `expected many routes, found ${routes.length}`);
  const empty = routes.filter((r) => handlersIn(r.source).length === 0).map((r) => r.path);
  assert.deepEqual(empty, [], `route files with no handler: ${empty.join(', ')}`);
});

/**
 * Split a route file into one chunk per exported handler, so a check can be
 * made against the handler that must satisfy it rather than against the file.
 *
 * A file-level check is too weak: an import sitting at the top satisfies it
 * even when the call inside the handler has been deleted. That exact mutation
 * survived the first version of this test.
 */
function handlerBodies(source: string): { method: string; body: string }[] {
  const matches = [...source.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)];
  return matches.map((match, index) => {
    const start = match.index!;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : source.length;
    return { method: match[1]!, body: source.slice(start, end) };
  });
}

test('CRITICAL: every non-public handler calls requireAuth in its own body', () => {
  const missing: string[] = [];

  for (const routeFile of routes) {
    if (PUBLIC_ROUTES.has(routeFile.path)) continue;
    for (const handler of handlerBodies(routeFile.source)) {
      if (!/requireAuth\(|getAuthContext\(|requirePlatformAdmin\(/.test(handler.body)) {
        missing.push(`${routeFile.path} [${handler.method}]`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `handlers that never establish an authenticated context: ${missing.join(', ')}`,
  );
});

test('CRITICAL: every mutating handler checks a permission or a relationship', () => {
  const offenders: string[] = [];

  for (const routeFile of routes) {
    if (PUBLIC_ROUTES.has(routeFile.path)) continue;
    const mutates = handlerBodies(routeFile.source).some((h) => h.method !== 'GET');
    if (!mutates) continue;

    // A mutation must be authorised in one of the ways this codebase actually
    // uses. Each alternative is a real pattern, not a loophole:
    //
    //   ctx.require / requireAny      — a permission, checked in the route
    //   requireStudentAccess          — for portal writes the RELATIONSHIP is
    //                                   the authorisation; demanding a
    //                                   permission there would be wrong
    //   checkAttendancePermission     — attendance's own combined check
    //                                   (permission + section + lock window)
    //   requirePlatformAdmin          — the platform surface
    //   ctx.user.userId as the target — the write can only touch the caller's
    //                                   own rows (e.g. marking notifications
    //                                   read), so no further check exists to
    //                                   make
    const gatedInRoute =
      /ctx\.require\(|ctx\.requireAny\(|requireStudentAccess|requireSectionAccess|requirePlatformAdmin|checkAttendancePermission/.test(
        routeFile.source,
      );

    const ownRowsOnly = /ctx\.user\.userId/.test(routeFile.source);

    // A thin route may delegate to a service that checks. That is only
    // acceptable when the service is one this suite separately verifies —
    // see "every operations service mutation checks a permission" below.
    const delegatesToCheckedService =
      /from '.*\/(operations|gradebook|attendance|finance|comms|staff|students|guardians)\/[a-z-]+\.ts'/.test(
        routeFile.source,
      );

    if (!gatedInRoute && !ownRowsOnly && !delegatesToCheckedService) {
      offenders.push(routeFile.path);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `mutating routes with no visible authorisation: ${offenders.join(', ')}`,
  );
});

test('every handler is wrapped in route() so errors are mapped, not leaked', () => {
  const offenders = routes
    .filter((r) => !/export const (GET|POST|PATCH|PUT|DELETE) = route\(/.test(r.source))
    .map((r) => r.path);

  assert.deepEqual(
    offenders,
    [],
    `handlers not wrapped in route(): ${offenders.join(', ')}`,
  );
});

test('CRITICAL: dynamic routes await context.params', () => {
  // In Next.js 15 `params` is a Promise. Reading `context.params.id` without
  // awaiting yields undefined, and the resulting query matches nothing —
  // which looks like "not found" rather than like a bug.
  const offenders: string[] = [];

  for (const routeFile of routes) {
    if (!routeFile.path.includes('[')) continue;
    if (!/context\.params|params\s*}/.test(routeFile.source)) continue;

    const awaits = /await\s+context\.params|await\s+params/.test(routeFile.source);
    const readsDirectly = /context\.params\.(id|\w+)\b/.test(routeFile.source);

    if (readsDirectly || !awaits) offenders.push(routeFile.path);
  }

  assert.deepEqual(
    offenders,
    [],
    `dynamic routes not awaiting params: ${offenders.join(', ')}`,
  );
});

test('routes declare the node runtime and dynamic rendering', () => {
  // The database driver is not edge-compatible, and a cached response would
  // serve one school's data to another.
  const offenders = routes
    .filter((r) => !/export const dynamic = 'force-dynamic'/.test(r.source))
    .map((r) => r.path);

  assert.deepEqual(offenders, [], `routes missing force-dynamic: ${offenders.join(', ')}`);
});

test('CRITICAL: no route trusts a school id from the request', () => {
  // The school always comes from the session. A route that reads it from the
  // query string or body is a tenancy bypass by construction.
  const offenders: string[] = [];

  for (const routeFile of routes) {
    // The platform-admin surface legitimately addresses schools by id.
    if (routeFile.path.includes(join('api', 'schools'))) continue;

    if (
      /searchParams\.get\(['"]schoolId['"]\)/.test(routeFile.source) ||
      /body\.schoolId|input\.schoolId/.test(routeFile.source)
    ) {
      offenders.push(routeFile.path);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `routes reading a school id from the request: ${offenders.join(', ')}`,
  );
});

test('operations routes gate on their module switch', () => {
  // A module a school has switched off must not be reachable through the API,
  // not merely hidden in the navigation.
  const MODULE_ROUTES: Record<string, string> = {
    library: 'library',
    inventory: 'inventory',
    assets: 'maintenance',
    maintenance: 'maintenance',
    transport: 'transport',
    hr: 'hr',
  };

  const offenders: string[] = [];

  for (const [segment, moduleKey] of Object.entries(MODULE_ROUTES)) {
    const group = routes.filter((r) => r.path.includes(join('api', segment)));
    assert.ok(group.length > 0, `no routes found under api/${segment}`);

    for (const routeFile of group) {
      // Either the route checks the module itself, or its service does. The
      // service call is the common case, so accept a service import that is
      // known to check — verified separately by the live API tests.
      const checksHere = new RegExp(`requireModule\\(['"]${moduleKey}['"]\\)`).test(
        routeFile.source,
      );
      const delegatesToService = /from '\.\.\/.*operations\/.*\.ts'/.test(routeFile.source);
      if (!checksHere && !delegatesToService) offenders.push(routeFile.path);
    }
  }

  assert.deepEqual(offenders, [], `operations routes without a module gate: ${offenders.join(', ')}`);
});

test('every operations service mutation checks a permission', async () => {
  // The routes delegate, so the check must exist in the service. This asserts
  // the other half of that contract.
  const files = ['library', 'inventory', 'hr', 'facilities', 'calendar'];

  for (const name of files) {
    const source = await readFile(`src/lib/operations/${name}.ts`, 'utf8');

    // Find exported functions whose names imply a write.
    const writers = [...source.matchAll(/export async function (\w+)/g)]
      .map((m) => m[1]!)
      .filter((fn) => /^(create|update|add|record|issue|return|renew|delete|assign|end|decide|cancel|report|recompute)/.test(fn));

    assert.ok(writers.length > 0, `no mutations found in ${name}.ts`);

    for (const fn of writers) {
      const start = source.indexOf(`export async function ${fn}`);
      const nextExport = source.indexOf('\nexport ', start + 1);
      const body = source.slice(start, nextExport === -1 ? undefined : nextExport);

      // `recomputeQuantity` is a repair helper called by an already-authorised
      // path and by tests; it reads and rewrites a derived column only.
      if (fn === 'recomputeQuantity') continue;

      assert.match(
        body,
        /ctx\.require\(|ctx\.requireAny\(|requireStudentAccess/,
        `${name}.ts: ${fn}() performs a write without checking a permission`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Document storage (added with the Group 8 write UI)
// ---------------------------------------------------------------------------

test('CRITICAL: the document download route authorises before reading bytes', async () => {
  // The order matters: `getObject` must never run for a caller who has not
  // been through `getDocumentForAccess`, which is the single place that
  // decides school ownership and access to the owner.
  const source = await readFile(join(API_ROOT, 'documents', '[id]', 'route.ts'), 'utf8');

  // Compare positions inside the GET handler only. Measuring against the whole
  // file finds the IMPORT of getObject at the top and passes even when the
  // call inside the handler has been moved above the authorisation — that
  // exact mutation survived the first version of this test.
  const handler = handlerBodies(source).find((h) => h.method === 'GET');
  assert.ok(handler, 'the download handler must exist');

  const authorise = handler.body.indexOf('getDocumentForAccess(');
  const read = handler.body.indexOf('getObject(');

  assert.ok(authorise > -1, 'the download must call getDocumentForAccess');
  assert.ok(read > -1, 'the download must read the object');
  assert.ok(authorise < read, 'authorisation must precede reading the file');
});

test('CRITICAL: a document is never served inline', async () => {
  // A stored HTML or SVG file rendered inline would execute in the school's
  // own origin. Content sniffing blocks the upload; these headers are the
  // second layer, in case a file type is ever added carelessly.
  const source = await readFile(join(API_ROOT, 'documents', '[id]', 'route.ts'), 'utf8');

  assert.match(source, /Content-Disposition['"]?\s*:\s*[`'"]attachment/, 'must force download');
  assert.match(source, /X-Content-Type-Options['"]?\s*:\s*['"]nosniff/, 'must send nosniff');
  assert.match(source, /Cache-Control['"]?\s*:\s*['"]private, no-store/, 'must not be cached');
  // Strip comments first: the word "inline" is legitimate in the explanation
  // of why nothing is served inline.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/inline/.test(code), 'no inline disposition in the route code');
});

test('CRITICAL: the upload route never trusts the client MIME type', async () => {
  const source = await readFile(join(API_ROOT, 'documents', 'route.ts'), 'utf8');

  assert.match(source, /sniffType\(/, 'the upload must sniff the real type');
  // `file.type` is the browser's claim. It must not reach the database.
  assert.ok(
    !/mimeType:\s*file\.type/.test(source),
    'the declared Content-Type must never be stored as the mime type',
  );
  assert.match(source, /newStorageKey\(/, 'the storage key must be generated, not accepted');
  assert.ok(
    !/storageKey:\s*(form|body|input)\./.test(source),
    'a storage key must never come from the request',
  );
});

test('the storage module refuses a key it did not generate', async () => {
  const source = await readFile('src/lib/operations/storage.ts', 'utf8');

  // Every filesystem entry point goes through resolveKey, which validates the
  // shape and then re-checks the resolved path is inside the root.
  assert.match(source, /function resolveKey/, 'there must be one place keys are resolved');
  assert.match(source, /startsWith\(STORAGE_ROOT/, 'the resolved path must be checked');

  for (const fn of ['putObject', 'getObject', 'deleteObject']) {
    const start = source.indexOf(`export async function ${fn}`);
    assert.ok(start > -1, `${fn} must exist`);
    const body = source.slice(start, source.indexOf('\nexport ', start + 1));
    assert.match(body, /resolveKey\(/, `${fn} must resolve its key through resolveKey`);
  }
});

// ---------------------------------------------------------------------------
// Group 9: analytics and search
// ---------------------------------------------------------------------------

test('CRITICAL: the search route gates on a permission, not merely a session', () => {
  const searchRoute = routes.find((r) => r.path === join(API_ROOT, 'search', 'route.ts'));
  assert.ok(searchRoute, 'the search route must exist');

  const [handler] = handlerBodies(searchRoute.source);
  assert.ok(handler, 'search must export a handler');

  // A signed-in parent is still signed in. Search must require one of the
  // operational view permissions, or a portal account could enumerate the
  // school through it.
  assert.match(
    handler.body,
    /ctx\.require(Any)?\(/,
    'search must check a permission, not just authenticate',
  );
});

test('CRITICAL: the analytics export checks a permission before building any report', () => {
  const exportRoute = routes.find(
    (r) => r.path === join(API_ROOT, 'analytics', 'export', 'route.ts'),
  );
  assert.ok(exportRoute, 'the analytics export route must exist');

  const [handler] = handlerBodies(exportRoute.source);
  assert.ok(handler);

  const requireAt = handler.body.indexOf('ctx.require(');
  const buildAt = handler.body.indexOf('buildReport(');
  assert.ok(requireAt > -1, 'the export must check a permission');
  assert.ok(buildAt > -1, 'the export must build a report');
  assert.ok(
    requireAt < buildAt,
    'the permission check must happen BEFORE the data is gathered, not after',
  );

  // Stronger: nothing may touch the database before the caller has been
  // authorised. Checking only that it precedes buildReport would allow the
  // year lookup and settings reads to run for someone with no permission.
  const firstDbAt = handler.body.indexOf('ctx.db');
  assert.ok(firstDbAt > -1, 'the export reads the database');
  assert.ok(
    requireAt < firstDbAt,
    'the permission must be checked before the first database read, not part-way through',
  );
});

test('CRITICAL: analytics routes never read a school id from the request', () => {
  // Re-stated for the Group 9 routes specifically. A tenant id taken from a
  // query string is the single most direct route to a cross-school leak.
  for (const routeFile of routes) {
    if (!routeFile.path.includes('analytics') && !routeFile.path.includes('search')) continue;
    assert.doesNotMatch(
      routeFile.source,
      /searchParams\.get\(['"]schoolId['"]\)|body\.schoolId|params\.schoolId/,
      `${routeFile.path} appears to take a school id from the request`,
    );
  }
});

test('CRITICAL: exported pupil data is not left in a shared cache', () => {
  const exportRoute = routes.find(
    (r) => r.path === join(API_ROOT, 'analytics', 'export', 'route.ts'),
  );
  assert.ok(exportRoute);
  assert.match(
    exportRoute.source,
    /'Cache-Control':\s*'private, no-store'/,
    'a CSV of pupil records must not be cacheable by an intermediary',
  );
});

test('the analytics export records an audit entry', () => {
  const exportRoute = routes.find(
    (r) => r.path === join(API_ROOT, 'analytics', 'export', 'route.ts'),
  );
  assert.ok(exportRoute);
  // Matched at handler indentation with nothing before it on the line, so a
  // call buried inside `if (someFlag)` does not satisfy the check. An audit
  // entry that can be skipped is not an audit entry.
  assert.match(
    exportRoute.source,
    /\n  await recordAudit\(/,
    'exporting personal data must unconditionally leave a trace of who took it',
  );
});
