# Audit Stage 1 — Production Environment & Deployment Readiness

Read-only inspection. **No application code was modified.** Date: 2026-09-10.
Verified with `git diff --stat HEAD` → empty (no tracked file changed during the audit).

---

## 1. Verified safe — inspected and found correct

These were examined specifically looking for flaws and none were found. **Do not "improve" them.**

| Area | Why it is sound |
|---|---|
| **Session management** (`src/lib/auth/session.ts`) | Tokens are 256-bit random, stored **SHA-256 hashed** — a database leak does not yield usable sessions. 12 h absolute TTL, 8 h idle timeout, `lastSeenAt` throttled to 1 write/min, single + global revocation, `purgeExpiredSessions`. Being DB-backed rather than JWT, **no session signing secret is needed** — one less production secret to leak. |
| **Cookie flags** | Confirmed live in a real production build: `Secure; HttpOnly; SameSite=lax; Path=/`. |
| **Password hashing** (`password.ts`) | scrypt N=2¹⁵, r=8, p=1, parameters embedded in the hash, constant-time comparison, `needsRehash` upgrade path, strength policy + weak-list. |
| **Login hardening** | Identical generic failure message for unknown user / wrong password / disabled account → **no user enumeration**. Account lockout after 8 failures for 15 min — **verified to actually hold** during brute-force testing. |
| **Error handling** (`src/lib/api/respond.ts`) | No stack traces, SQL, or driver internals reach the client. 500 returns a fixed string. Tenant violations are logged then answered **404, not 403** (no existence oracle). |
| **File storage** (`operations/storage.ts`) | Keys are **server-generated** `<schoolId>/<uuid>` — never client-controlled. Regex validation + root-containment re-check (path traversal blocked), magic-byte sniffing, SVG/HTML/bare-zip refused, 10 MB cap, `wx` write flag (no overwrite). |
| **Document downloads** (`api/documents/[id]/route.ts`) | Authorization resolved **before a single byte is read from disk**; every download is audit-logged; served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox` — a stored file cannot execute in the school's origin. |
| **Demo credentials** | `DemoAccounts` returns `null` when `NODE_ENV==='production'`. Confirmed on the real production build: `Demo@2018` appears **0 times** in the served `/login` HTML. |
| **Startup safety** | `instrumentation.ts` → `bootstrap.ts` registers notification handlers only. **No seed or demo code can execute at boot.** |
| **Graceful shutdown** | SIGINT/SIGTERM/`beforeExit` → `closeDb()` → `pool.end()`, then removes its own listener and re-raises the signal so the process genuinely exits. Correct. |
| **Migration runner** | SHA-256 checksum-drift detection aborts on edited history; deterministic filename ordering; `_migrations` tracking. Re-run confirmed idempotent: *"0 applied, 13 already up to date"*. |
| **Migration content** | No `DROP TABLE/COLUMN/DATABASE`, no `TRUNCATE` anywhere in 13 files. The single `DELETE` (`0010`) is correctly scoped — unpaid duplicates only, never touches allocated payments, keeps the earliest row. **No `CREATE EXTENSION`** → works on managed Postgres. |
| **Input caps** | Uploads 10 MB (with a `content-length` pre-check), XLSX 5 MB, CSV/sheet parse 2000 rows. |
| **Logging hygiene** | Only 5 `console.*` sites in the entire `src/`, all appropriate. No password, token, or wholesale request body is ever written to a log or audit record. |
| **Multi-process compatibility** | **No SSE, no WebSocket, no in-process cron/`setInterval`.** The 6 `globalThis` caches are all TTL-bounded, per-process, non-authoritative. The app scales horizontally without redesign. |

---

## 2–6. Real problems — severity, location, why it matters, recommended fix

### 🔴 CRITICAL

**C1 — Production silently runs on the embedded dev database if `DATABASE_URL` is missing *or malformed***

- **Location:** `src/db/client.ts:48,145`
- **Proven by execution, not inference:**
  ```
  NODE_ENV=production, DATABASE_URL unset          -> PGlite: true
  NODE_ENV=production, DATABASE_URL="postgre://…"  -> PGlite: true   (one missing 's')
  ```
- **Why it matters:** the app boots, serves traffic, and looks completely healthy while writing every student, grade, payment and audit record into a **single-process WASM file at `.data/pgdata`** — a path that is in `.gitignore`, inside the application directory, with **no volume declared anywhere in the repo** (there is no Dockerfile or compose file). Consequences: no `pg_dump` covers it, no backup job sees it, it dies with the container, and it cannot serve more than one instance. A school could operate for weeks and lose everything on the first redeploy. The typo case is the dangerous one — that is a realistic Coolify copy-paste error, and nothing anywhere reports it.
- **Fix:** in `getDb()`, if `NODE_ENV === 'production'` and the resolved driver is PGlite, **throw and refuse to start** with an explicit message. Fail loudly at boot rather than silently succeed. Opt-in escape hatch only via an explicit `ALLOW_EMBEDDED_DB=true`.

### 🟠 HIGH

**H1 — Database TLS accepted without certificate verification**
- **Location:** `src/db/client.ts:58`, `scripts/migrate.ts:30` — `ssl: { rejectUnauthorized: false }` unless `PG_SSL === 'false'`.
- **Why:** encrypts the link but authenticates nothing. Any MITM on the path to the database can present a self-signed certificate and read/modify **all** student, health and payment data in clear. This is the single highest-value data path in the system.
- **Fix:** default to verification on; allow `PG_SSL=no-verify` explicitly for providers with self-signed certs, and support a `PG_CA_CERT` path.

**H2 — `next.config.mjs` ships sandbox origins; no production origin exists**
- **Location:** `next.config.mjs` — `allowedDevOrigins: ['*.e2b.app']`, `serverActions.allowedOrigins: ['*.e2b.app','localhost:3000']`.
- **Why:** Server Actions are CSRF-sensitive. Shipping a wildcard for a third-party domain into production is wrong on its face, and the school's real domain is **not** in the list, so Server Actions may be rejected outright once deployed. Confirmed: `NEXT_PUBLIC_SITE_URL` (or any origin/base-URL concept) **does not exist anywhere in the codebase**.
- **Fix:** drive `allowedOrigins` from an env var holding the production domain; keep the e2b entry only under `NODE_ENV !== 'production'`.
- **RESOLVED**, with one correction to the finding. `src/lib/config/origins.mjs` now builds the list: sandbox entries are added only outside production, production origins come from `APP_ORIGIN`/`APP_ORIGINS`. Verified in the build artifact — `.next/required-server-files.json` previously carried `["*.e2b.app","localhost:3000"]` and now carries only the configured origin (or `[]`). `allowedDevOrigins` deliberately keeps the sandbox host, as it applies only to `next dev`.
- **Correction:** the claim that Server Actions "may be rejected outright once deployed" because the real domain is absent is **wrong**. Next checks `origin !== host` *first* (`action-handler.js:407-415`) and only consults `allowedOrigins` when they differ, so an ordinary same-origin deployment needs no configuration. `APP_ORIGIN` is therefore optional and only matters behind a proxy that does not forward the public hostname; the build prints an informational notice rather than a warning.
- **Also established:** this application defines **zero Server Actions** (`server-reference-manifest.json`: 0 node, 0 edge; no `'use server'` anywhere). All 37 UI mutations go through `/api/*`. So the wildcard was latent exposure, not an active hole — it would have become live the moment anyone added a Server Action. Covered by `tests/config-origins.test.ts` (22 tests, asserted against Next's own `isCsrfOriginAllowed`).
- **Related gap left open (not this finding):** `/api/*` handlers perform no `Origin` check and rely solely on `SameSite=lax`. Adequate for current browsers; noted in the runbook.

**H3 — Uploaded documents live on the container filesystem with no volume**
- **Location:** `STORAGE_ROOT` defaults to `process.cwd()/storage`; `storage/` is in `.gitignore`; no volume is declared in the repo.
- **Why:** on a standard container deploy, **every uploaded document is destroyed on each redeploy** — including the medical and disciplinary records the download route so carefully protects. The `STORAGE_ROOT` seam is well-designed; the problem is purely that nothing documents that it *must* point at a persistent volume.
- **Fix:** no code change needed — document it, and add a startup warning if `STORAGE_ROOT` resolves inside the app directory in production.
- **RESOLVED.** Startup warning added (`src/lib/operations/storageConfig.ts`, wired in `src/instrumentation.ts`): in production, if the resolved path is inside the application directory it prints the exact path plus the fix, and continues booting — a single VPS without a container layer is a legitimate deployment, so this warns rather than refuses. Documented in `docs/11-operations-runbook.md` ("Uploaded document storage"), including the backup requirement.
- **Second defect found while confirming this.** A document whose file was gone returned a generic **500 "Something went wrong. Please try again."** while still being listed — telling staff to retry forever on a permanently lost file. `getObject` now raises `MissingObjectError` on `ENOENT` and the download route maps it to **410 Gone** with a re-upload instruction. Verified it stays behind the ownership check, so it is not a cross-tenant existence oracle. Covered by `tests/storage-durability.test.ts` (17 tests).

**H4 — Password spraying is unmitigated (IP limit is trivially bypassed)**
- **Location:** `src/app/api/auth/login/route.ts:18` and `src/lib/auth/context.ts:193` — `x-forwarded-for?.split(',')[0]`, i.e. the **first**, client-supplied hop.
- **Proven by execution:**
  - fixed IP, 24 attempts → correctly `429` from attempt ~19 onward ✅
  - **rotating spoofed `x-forwarded-for`, 40 attempts → 8 reached the login logic** (only the per-account lockout stopped it)
  - **spraying one password across 17 accounts → 16 reached the login logic**, because per-account lockout never triggers when each account sees a single failure
- **Why:** taking the leftmost XFF hop means the value is attacker-controlled even behind a correct reverse proxy (the proxy *appends*, it does not overwrite). Layered defence saved the single-account case, but credential spraying — the realistic attack against a school with predictable usernames like `teacher1`…`teacher12` — is unthrottled.
- **Fix:** take the **rightmost** hop, or add a `TRUSTED_PROXY_HOPS` count; and add a second limiter keyed on `schoolCode + username` so spraying is bounded regardless of source IP.

### 🟡 MEDIUM

**M1 — Migrations execute outside any transaction**
`scripts/migrate.ts` — confirmed no `BEGIN`/`COMMIT`/`ROLLBACK` in the runner, and no migration file opens its own. A failure midway through a multi-statement file leaves **partially applied DDL with no `_migrations` row**; the retry then fails on the already-created object, requiring manual repair on a live system. **Fix:** wrap each file's statements in a single transaction (Postgres has transactional DDL — this is nearly free).
- **RESOLVED.** `scripts/migrate.ts` now wraps each file — DDL *and* its `_migrations` row — in one `begin`/`commit`, with a best-effort `rollback` that never masks the original error. Proven end-to-end through the real runner against a deliberately broken migration: the partial table was rolled back, the preceding good migration was retained, and the runner reported "failed and was rolled back; the database is unchanged." Verified all 13 migrations still apply from scratch and remain idempotent. A test fails the build if any migration ever adds a statement that cannot run in a transaction.

**M2 — PostgreSQL 15+ is a hard requirement, documented nowhere**
`drizzle/0010` uses `NULLS NOT DISTINCT` (PG15+); `drizzle/0008` uses a `GENERATED ALWAYS AS … STORED` column (PG12+). On PG14 the deploy fails **midway through migration 10** — and per M1, in a partially applied state. **Fix:** document minimum PG15, and add a server-version check at the top of the migrate script.
- **RESOLVED.** `checkServerVersion` reads `server_version_num` and refuses to run on anything below 15, *before* the first write, so an unsupported server leaves the database untouched instead of half-migrated. An unreadable version is deliberately allowed through rather than blocking a deploy on a Postgres-compatible engine. Minimum documented in `docs/11-operations-runbook.md`. Covered by `tests/migrate-safety.test.ts` (13 tests).

**M3 — No rate limiting on expensive authenticated endpoints**
Confirmed by execution: 10 consecutive full-school `/api/students/export` and 10 `/api/analytics/export` calls → **all 200, no throttling**. Also unthrottled: search, imports, uploads, messaging, and every mutation. These are permission-gated, so this is resource-abuse/DoS rather than a data breach — one authenticated registrar can saturate the database. **Fix:** a small shared limiter on export/import/search/messaging routes.
- **RESOLVED.** Added `src/lib/api/throttle.ts` — a shared per-user limiter reusing the existing `rateLimit()` — and applied it to the endpoints that measurement showed are actually expensive. Limits were chosen from measured cost, not guessed: a 300-row import commit takes **3.2 s and writes 300 rows** (`IMPORT_LIMIT` 6/min); document upload writes up to 10 MB to disk (`UPLOAD_LIMIT` 20/min); messages and announcements fan out per recipient (`MESSAGING_LIMIT` 30/min); exports were already covered by C2 (`EXPORT_LIMIT` 10/min).
- **Two things deliberately left unthrottled**, because throttling them would cost usability and buy nothing: `search?q=` runs in **49 ms** and backs a debounced type-ahead, so a limit would break normal typing; and import **validation** — the preview step — writes nothing and takes ~50 ms even at 2,000 rows, so users can iterate on a bad spreadsheet freely. Only the `commit` branch is limited.
- **The limiter runs *after* authorisation, never before.** This is the mistake C2 found twice: throttling before the permission check lets an unauthorised caller burn a legitimate user's budget. Verified by execution — a teacher without `student.import` got **403 eight times and never a 429**.
- **Proven by execution on a production build:** 10 consecutive import commits → **6×200 then 4×429**; uploads **20×201 then 3×429**; announcements **30×201 then 3×429**. Counter-tests confirm the blast radius is one user: a second admin imported normally while the first was throttled, the throttled user's exports/searches/reads all stayed 200, and a second school was unaffected. Covered by `tests/expensive-endpoint-throttle.test.ts` (13 tests).

**M4 — `pruneRateLimiter()` is defined and never called**
`src/lib/auth/login.ts:193` — zero call sites; entries are only ever removed by this uncalled function. The map grows one entry per distinct source IP for the process lifetime — and per H4 the key is attacker-controlled, so it is **remotely inflatable**. A slow memory leak that doubles as a DoS vector. **Fix:** call it opportunistically inside the limiter, or on an interval.

**M5 — No health/readiness endpoint**
Confirmed absent, as is `middleware.ts`. Coolify, load balancers and uptime monitors have nothing to probe, so a process that is alive but cannot reach the database is indistinguishable from a healthy one — and rolling deploys cannot gate on readiness. **Fix:** a `/api/health` returning process liveness plus a cheap `SELECT 1`.
- **RESOLVED.** Added `src/app/api/health/route.ts`. No `middleware.ts` was needed.
- **Liveness and readiness are separated, which is the point of the endpoint.** `GET /api/health` is *readiness*: it runs `select 1` and returns **200** or **503**. `GET /api/health?live=1` is *liveness*: it touches nothing and always returns 200. Collapsing the two would be actively harmful — an orchestrator restarts a container that fails liveness, so a database outage would turn into a cluster-wide crash loop. Split this way, a database outage **drains** instances from the load balancer and they recover on their own when the database returns.
- **Bounded and non-cacheable.** The query is capped at **3 s** via `Promise.race`, because a probe that hangs is worse than one that fails — an orchestrator blocked on a stuck connection keeps a broken instance in rotation. `Cache-Control: no-store` prevents a proxy serving a stale "healthy".
- **Unauthenticated by necessity, so deliberately terse.** A load balancer cannot hold a session. The body carries only `status`, `check`, `checks.database` and a duration — no version, hostname, driver, schema or database error text. The failure reason goes to the server log where operators can see it. `/api/health` is registered in the route-contract test's explicit `PUBLIC_ROUTES` list, so making an endpoint public stays a written-down decision rather than an accident.
- **Proven by execution:** live readiness 200 (3 ms) and liveness 200 against the running server; a genuine **503** against an unreachable Postgres; `POST` correctly 405. A test scans the response body and fails if a password, username, hostname or `ECONNREFUSED` ever leaks into it. Covered by `tests/health-endpoint.test.ts` (11 tests).

**M6 — No security response headers; framework version disclosed**
Confirmed on the production build: the only notable header is `X-Powered-By: Next.js`. Missing `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`, HSTS. *Accurate impact:* clickjacking risk is **low in practice** because `SameSite=lax` means a cross-site iframe renders logged-out — but the headers are near-zero-cost defence in depth. **Fix:** a `headers()` block in `next.config.mjs` plus `poweredByHeader: false`.
- **RESOLVED.** `next.config.mjs` now sets `poweredByHeader: false` and a `headers()` block scoped to `/:path*`, so the headers apply to pages, API responses, 401s and 404s alike — verified on all four.
- **Applied everywhere:** `Referrer-Policy: strict-origin-when-cross-origin` (a student record URL must not leak to third-party sites in a `Referer`), `X-Content-Type-Options: nosniff` (this app serves user-uploaded documents, so MIME sniffing is a real concern, not a checkbox), and a `Permissions-Policy` denying camera, microphone, geolocation, payment and USB — capabilities the application never uses.
- **Frame protection is production-only, on purpose.** `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` are emitted when `NODE_ENV=production`. The development preview is served inside an iframe, and denying framing there breaks the preview while making production no safer — the same dev/prod split already used for the H2 origin allow-list. Note these are baked in at **build** time, so the build's `NODE_ENV` decides.
- **Two headers deliberately NOT set, and the reasons matter more than the omissions.** **HSTS** belongs on the TLS-terminating proxy, which knows the real scheme; emitting it from an app that also serves plain HTTP in development can pin `localhost` to HTTPS in a developer's browser. **A full CSP** is not attempted: Next injects inline bootstrap scripts, so a useful policy needs per-request nonces, and a blanket `unsafe-inline` policy would *look* like protection while providing none. A test asserts no `unsafe-inline` CSP is ever shipped. The `frame-ancestors` directive above stands alone and needs no nonces.
- **Proven by execution:** production build → all five headers present on `/login`, `/api/health`, a 401 and a 404, with `X-Powered-By` gone (0 occurrences across four routes). Development build → the three safe headers present, frame headers correctly absent, preview still renders. Covered by `tests/security-headers.test.ts` (10 tests, including one asserting the H2 production origin allow-list did not regress).

**M7 — `README.md` is one line; there is no `.env.example`**
The entire configuration surface is **8 environment variables** (`NODE_ENV`, `DATABASE_URL`, `PGLITE_DATA_DIR`, `PG_POOL_MAX`, `PG_SSL`, `STORAGE_ROOT`, `NEXT_RUNTIME`) and not one is documented. Combined with C1 this is what makes the silent-fallback failure likely rather than theoretical. **Fix:** `.env.example` + a deployment section in the README.
- **RESOLVED.** Added `.env.example` documenting all **10** operator-settable variables — grouped as required / database TLS / deployment-specific / optional / development-only — each naming the file that reads it, with only `CHANGE_ME` as a credential. `README.md` replaced (1 line → full deployment guide): PostgreSQL 15 requirement, migrations, HTTPS and `Secure` cookies, trusted-proxy configuration, database TLS, storage volume, backup/recovery, and the honest state of SMS/payment providers.
- **Correction to the finding's count.** The audit says "8 environment variables" and then lists **7**. The real number is **10** operator-settable (`NODE_ENV`, `DATABASE_URL`, `PG_SSL`, `PG_CA_CERT`, `TRUSTED_PROXY_HOPS`, `STORAGE_ROOT`, `APP_ORIGIN`, `APP_ORIGINS`, `PG_POOL_MAX`, `PGLITE_DATA_DIR`) plus 2 not operator-set (`NEXT_RUNTIME`, `__SOS_ORIGIN_NOTICE`) — the list predates the C2/H2 fixes.
- **Drift protection:** `tests/env-example.test.ts` (15 tests) checks **both directions** — every variable the code reads is documented, and every documented variable is really read (so nobody invents configuration that does nothing) — plus a committed-secret scan. Verified by deliberately introducing an undocumented variable, an invented one, and a fake secret; each failed the suite.
- **Hazard documented, not silently fixed:** `npm run db:seed` creates users with the published password `Demo@2018` and has **no** production guard. The README warns against running it in production. Adding a guard is a code change outside M7's scope.
- **Resolved later, during the deployment work.** `npm run db:seed` now refuses when `NODE_ENV=production` unless `ALLOW_DEMO_SEED_IN_PRODUCTION=true` is set alongside it, and `npm run db:bootstrap` creates a real school and a real first administrator — with a generated password, never the published one. The demo seed is therefore no longer the only way into a fresh production database. See the runbook's *First run: the production bootstrap*.

### 🟢 LOW

**L1 — `npm audit --production`: 1 high + 1 moderate, both `postcss ≤8.5.22` via `next@15.5.25`**
XSS via unescaped `</style>`, and arbitrary `.map` read via attacker-controlled `sourceMappingURL`. **This is a build-time surface** — postcss does not process untrusted input at runtime here. The only offered remedy is `next@16.3.4`, a **breaking major upgrade**. Recommendation: **do not upgrade as part of a deployment hardening pass.** Note it, schedule it separately.
- **RESOLVED — without the framework upgrade.** `npm audit --production` now reports **0 vulnerabilities**. Next.js stays on **15.5.25**; nothing was upgraded.
- **The finding's premise was npm's, and it was too pessimistic.** npm said "Will install next@16.3.5, which is a breaking change", and the audit reasonably took that as the only remedy. Inspection showed otherwise: `next@15.5.25` pins postcss to an **exact `8.4.31`**, the advisories are fixed in **`8.5.23`** — the *same major version* — and **Next 16's own fix was simply moving its pin to `8.5.23`**. The major bump carries unrelated breaking changes; it is not what fixes postcss. So a one-line `overrides: { "postcss": "^8.5.28" }` applies precisely the patch Next 16 applies, with none of the migration risk. npm offers the major upgrade because that is the only published `next` release satisfying the advisory, not because the postcss fix requires it.
- **Verified non-cosmetic.** The vulnerable nested copy at `node_modules/next/node_modules/postcss@8.4.31` is **gone**, not merely shadowed — the tree now resolves a single postcss `8.5.28`. Both `npm audit --production` (the exact command the finding cites) and the nested-copy check are asserted by tests.
- **Proven to change nothing else.** The compiled stylesheet is **byte-for-byte identical** before and after the override — 37,181 bytes, same content hash `a13dc0f2a45566f2` — so the CSS pipeline is provably unaffected. Full verification: `tsc` clean, **732/732 tests**, production build ✓, and live checks of auth (401/200/401), tenant isolation (own student 200, cross-tenant 404, counts 370/429), the six main API groups, the M5 health endpoint, the M6 headers, the M3 throttle (10×200 → 429), and the dev preview compiling CSS through the overridden postcss.
- **The audit's underlying caution still stands, and is preserved.** Next 16 remains **deferred maintenance**, tracked in `docs/11-operations-runbook.md`, because it is a real migration (Turbopack default, `middleware.ts` → `proxy.ts`, sync request APIs removed, Node 20.9+). It is simply **no longer a security matter** — it is a routine upgrade to schedule on its own merits. Encouragingly, the app is already clear of every documented blocker: **56 `Promise`-typed `params`** and zero sync ones, all `cookies()`/`headers()` awaited, no `middleware.ts`, no webpack config, no `revalidateTag`, no AMP or runtime config. `tests/dependency-audit.test.ts` (7 tests) keeps it that way and pins `next`/`react` exactly so a major can never arrive unreviewed.

**L2 — Shutdown hooks are registered lazily inside `getDb()`**
A process killed before its first database query has no handler. Harmless (nothing to clean up), noted only for completeness.
- **CONFIRMED HARMLESS — no code change made.** The audit's own conclusion is correct, and it was re-tested rather than taken on trust. Writing code here would add risk to the shutdown path to fix nothing.
- **Three independent reasons.** (1) The audit's literal case — killed *before* the first query — means no client exists, and `closeDb()` returns immediately; there is nothing to close. (2) The only genuine window is `getDb()` *in flight*: the datadir is opening but the hook is not yet attached. (3) Any stale `postmaster.pid` from such a kill is removed automatically on the next boot by `createDatabase()`, before the datadir is opened.
- **Proven by execution, not reasoning.** A victim process was killed at **0.2 s, 0.5 s, 0.8 s and 1.0 s** into a fresh database initialisation, including with **SIGKILL** — which no handler can ever intercept. In every trial the data directory **reopened cleanly** and a row written before the signal was still present. A follow-up boot against a datadir left locked by SIGKILL started normally with no manual cleanup, confirming the self-healing path.
- **Production is unaffected either way.** Production uses the `pg` driver, where `closeDb()` ends a TCP pool — sockets are reclaimed by the OS on exit and nothing is buffered client-side, so a missed hook cannot cost data. The write-buffering concern that motivates the hook at all applies only to embedded PGlite, which is development-only.
- **What is now protected.** Since the *recovery* path is what makes this finding harmless, `tests/shutdown-hooks.test.ts` (8 tests) pins it down: the stale-lock removal must happen **before** the datadir is opened, `closeDb()` must stay a no-op with no client, hooks must remain idempotent, and the handler must keep re-raising the original signal so the exit status does not lie to an orchestrator. If someone deletes the lock-clearing logic, L2 stops being harmless — and now a test fails.

**L3 — Account lockout is a mild self-DoS vector**
8 failed attempts locks any known username. Auto-unlock after 15 minutes bounds the damage; the security tradeoff is correct as-is. No change recommended.
- **ACCEPTED RISK — no code change made.** The audit's recommendation is followed exactly. Weakening the lockout to remove the nuisance would trade a bounded 15-minute inconvenience for a real credential-stuffing exposure, which is the wrong direction for a system holding children's records.
- **Verified against the running system**, rather than read from the source: attempts 1–8 returned `invalid`, attempt **9 returned `locked`**, the correct password was refused while locked, and after the deadline passed the correct password signed in and reset the counter to **0** with `locked_until` cleared. Constants confirmed as `MAX_FAILED_LOGINS = 8`, `LOCKOUT_MINUTES = 15` (`src/lib/auth/session.ts:163-164`).
- **The property that actually bounds the damage.** A locked account returns at `src/lib/auth/login.ts:98` — *before* `verifyPassword` and *before* `registerFailedLogin`. So a persistent attacker cannot push the deadline forward: **15 further failed attempts left `locked_until` byte-identical**, and the failure counter stayed at 0. Had that order been reversed, the "15 minutes" bound would be fiction and an attacker could keep a headteacher out permanently — a genuine DoS rather than a mild one. The 15-minute cap is therefore real, and no administrator action is ever required to recover.
- **The blast radius is one username.** Locking `headteacher` was confirmed not to affect `registrar` in the same school, so an attacker cannot lock out a whole staff room through one account.
- **Newly protected, because none of the above was covered by a test.** `tests/account-lockout.test.ts` (9 tests) asserts the threshold is exactly 8 (not earlier — a staff-room computer sees typos daily), that the deadline is ~15 minutes, that hammering cannot extend it, that the counter does not accumulate while locked, that the lock self-expires, and that neighbouring accounts are unaffected. `tests/auth-abuse.test.ts` already covered "does it lock at all"; this file covers the properties that make the risk *acceptable*.
- **These tests were mutation-checked.** Moving the lockout check to *after* `registerFailedLogin` — the exact regression that would make this finding dangerous — makes both CRITICAL tests fail. They are load-bearing, not decorative.

---

## 7. Must fix before deploying to a real school

1. **C1** — refuse to boot on PGlite in production. *Without this, one typo silently costs a school all its data.*
2. **H1** — verify database TLS certificates.
3. **H3** — persistent volume for `STORAGE_ROOT` (config + documentation).
4. **H2** — real production origin for Server Actions; drop the sandbox wildcard.
5. **M2 + M1** — document PG15 minimum and wrap migrations in transactions (these compound: the version failure lands you in the partial-migration failure).
6. **M7** — `.env.example` + deployment README.
7. **H4** — fix XFF hop selection and add a per-account login limiter.

Defer: M3, M4, M5, M6 (soon after launch), L1 (scheduled separately).

> **Status update — every finding has now been worked.** The deferred items were not deferred: **M3, M4, M5, M6 and M7 are resolved**, alongside every Critical and High finding. **L1 is resolved too**, and without the breaking `next@16` upgrade the report assumed was required — `npm audit --production` now reports **0 vulnerabilities** on Next 15.5.25.
>
> The two remaining LOW findings were investigated and deliberately **not** changed, because the audit's own judgement was right in both cases:
>
> - **L2 — confirmed harmless.** No code change. Re-tested by killing a process mid-initialisation (including SIGKILL); the data directory reopened cleanly every time, and a stale lock self-heals on the next boot. `tests/shutdown-hooks.test.ts` now protects that recovery path.
> - **L3 — accepted risk.** No code change. The 15-minute bound was verified real: a locked account cannot have its lockout extended, so the damage stays bounded and self-recovering. `tests/account-lockout.test.ts` now protects the properties that make it acceptable.
>
> One item remains genuinely open as **deferred maintenance**: the **Next.js 16 upgrade**. It is no longer a security matter — the only security-relevant part of it (the postcss bump) is already applied. It is a routine framework migration to schedule on its own merits, documented with a full breaking-change exposure table in `docs/11-operations-runbook.md`. The application is already clear of every documented blocker.

---

## 8. Tests performed

| # | Test | Result |
|---|---|---|
| 1 | `tsc --noEmit` | **clean** |
| 2 | `npm run build` from a clean `.next` | **compiled successfully, 19.6 s** |
| 3 | `NODE_ENV=production npm start` | **ready in 432 ms** |
| 4 | Full test suite | **545 / 545 pass, 0 fail** |
| 5 | Migrations re-run | idempotent — 0 applied, 13 up to date |
| 6 | PGlite fallback, unset `DATABASE_URL`, `NODE_ENV=production` | **fallback confirmed** |
| 7 | PGlite fallback, typo'd `DATABASE_URL` | **fallback confirmed** |
| 8 | Login rate limit, fixed IP × 24 | 429 from ~19 ✅ |
| 9 | Login rate limit, rotating spoofed XFF × 40 | **8 bypassed** ❌ |
| 10 | Password spray, 17 accounts, rotating XFF | **16 reached login logic** ❌ |
| 11 | Account lockout after brute force | **held — correct password still 429** ✅ |
| 12 | Production `Set-Cookie` flags | `Secure; HttpOnly; SameSite=lax` ✅ |
| 13 | `Demo@2018` in production `/login` HTML | **0 occurrences** ✅ |
| 14 | Cross-tenant: `aps` admin → `bfa` student (production build) | **404** ✅ |
| 15 | Control: `bfa` registrar → same student | 200 ✅ |
| 16 | Parent → non-child student | **404** ✅ |
| 17 | Anonymous → student record | **401** ✅ |
| 18 | 10× students export + 10× analytics export | all 200 — **no throttle** ❌ |
| 19 | Security headers on production HTML | only `X-Powered-By` ❌ |
| 20 | `npm audit --production` | 1 high + 1 moderate (build-time) |
| 21 | `console.*` sweep across `src/` | 5 sites, all appropriate ✅ |
| 22 | Secret/PII leakage into logs & audit records | none found ✅ |
| 23 | SSE / WebSocket / cron scan | none — horizontally scalable ✅ |
| 24 | Destructive DDL scan, 13 migrations | none ✅ |

## 9. Do not change

Session and cookie design · password hashing · generic login failure message · account lockout · `respond.ts` error shaping and the deny-with-404 convention · storage key generation, path containment and magic-byte sniffing · the documents download route's authorization-before-read ordering and its header set · demo-account gating · `instrumentation.ts`/`bootstrap.ts` · the migration runner's checksum and ordering logic · the `0010` DELETE scope · upload/XLSX/row caps · the `STORAGE_ROOT` seam itself (the seam is right; only its default and documentation need attention) · the six `globalThis` caches.

## 10. External configuration still required (outside the codebase)

1. **Managed PostgreSQL ≥ 15**, with automated backups and a **tested restore**.
2. **Persistent volume** mounted at `STORAGE_ROOT` — separate from the container filesystem, included in the backup policy.
3. **TLS termination** at the reverse proxy with a valid certificate. The session cookie is `Secure`, so **the app is unusable over plain HTTP** — this is correct, but it makes HTTPS a hard prerequisite, not an option.
4. **Reverse proxy configured to overwrite (not append) `X-Forwarded-For`**, plus HSTS at the proxy.
5. **Environment variables** set at deploy time: `DATABASE_URL`, `STORAGE_ROOT`, `NODE_ENV=production`, and `PG_POOL_MAX` tuned to the database's connection limit × instance count.
6. **Off-site backup retention** covering both the database and the storage volume — per `docs/11-operations-runbook.md`.
7. **SMS provider credentials** — currently `sms.provider:'none'`, which honestly queues to an `unconfigured` outbox rather than pretending to send.
