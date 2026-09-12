# Operations runbook

Backup, recovery and data portability for a live deployment.

This is deliberately a document rather than a feature. A restore performed
through the web application would run as an authenticated HTTP request holding
the power to overwrite every school's data; that is not a capability worth
adding a login screen to. The safe version lives on the server, run by whoever
administers it.

## What the application provides

| Need | Where |
| --- | --- |
| Export students (with the school's own custom fields) | `GET /api/students/export` — `student.export` |
| Export attendance, academic, risk, enrolment, teacher reports | `GET /api/analytics/export?report=…` — one permission per report |
| Audit trail of every export | `audit_log`, action `export.run`, with the row count and filters |
| Per-school configuration snapshot | `school_settings` rows, readable through the settings API |

Every export is permission-checked, scoped to the caller's school, restricted
to their sections where `restrict.ownSectionsOnly` applies, audited, and
written as UTF-8 CSV that opens correctly in Excel and LibreOffice with Amharic
text intact.

## What the application deliberately does not provide

- **No restore endpoint.** Nothing in the UI can overwrite the database.
- **No raw SQL surface.** No query box, no console, no database credentials in
  any page or API response.
- **No cross-school export.** There is no "export everything" endpoint; a
  request is always scoped to the caller's own school.

## Database backup

The application stores everything in one PostgreSQL database. In development it
runs PGlite against `.data/pgdata`; in production it is ordinary PostgreSQL, so
ordinary PostgreSQL tooling applies.

    # Nightly logical backup, compressed, with the schema.
    pg_dump --format=custom --compress=9 \
            --file="/backups/sos-$(date +%F).dump" \
            "$DATABASE_URL"

Keep at least: 7 daily, 4 weekly, 12 monthly. Store off the application server —
a backup on the same disk protects against nothing that actually happens.

### Verifying a backup is restorable

An unverified backup is a hope, not a backup. Restore into a scratch database
and check that the row counts are plausible:

    createdb sos_restore_test
    pg_restore --dbname=sos_restore_test --no-owner "/backups/sos-2026-09-10.dump"

    psql sos_restore_test -c "
      select
        (select count(*) from schools)   as schools,
        (select count(*) from students)  as students,
        (select count(*) from users)     as users,
        (select count(*) from audit_log) as audit_rows;"

    dropdb sos_restore_test

Do this monthly, and after any change to the backup job. A restore that has
never been tried is the most common way organisations discover they had no
backups at all.

## Recovery

1. **Stop the application** so nothing writes during the restore.
2. Restore into a *new* database, never over the live one:
   `pg_restore --dbname=sos_recovered --no-owner <dump>`.
3. Run the verification queries above.
4. Repoint `DATABASE_URL` at the recovered database and start the application.
5. Run `npm run db:migrate` — migrations are idempotent, so this is safe and
   catches the case where the dump predates a schema change.
6. Check the audit log for the last recorded action to establish exactly how
   much time the restore lost.

Keeping the damaged database untouched until the recovery is confirmed means a
failed recovery is not also a second data loss.

## Migrations

13 migrations, applied in filename order, idempotent — re-running is safe. Five
(`0003`, `0005`, `0007`, `0009`, `0012`) are hand-written integrity migrations
absent from drizzle's journal; the runner sorts by filename, so they apply in
the right place regardless.

Always take a backup immediately before applying migrations to production.

## Clean-machine reproducibility

The whole system rebuilds from source with no manual steps:

    npm install
    npm run db:migrate
    npm run db:seed
    npx tsx scripts/seed-finance.ts
    npx tsx scripts/seed-operations.ts
    npm run dev

This is verified at the end of every build group by deleting `.data/pgdata` and
running the full test suite against the rebuilt database.

> The development database and the test suite cannot share the datadir: PGlite
> permits one connection, so a second aborts. Stop the dev server before running
> tests.

## A school leaving the platform

A school is entitled to its data. Exports cover students (including that
school's own custom fields), attendance, academic results, risk, enrolment and
teacher activity, plus finance reporting. All are CSV, all are permission-
checked and audited, and all are scoped to the requesting school.

For a complete handover, take a filtered `pg_dump` of that school's rows and
provide it alongside the CSVs — the CSVs are what a school can actually use,
the dump is what a successor system can import.

## Reverse proxy and client IP (added with audit fix C2)

The login limiter needs to know which network a request came from. The
application cannot work this out on its own: `NextRequest` exposes no socket
peer address (`request.ip` was removed in Next.js 15), and Next passes
`X-Forwarded-For` through **verbatim** without appending anything. Whatever the
client sends is what the application sees.

Trust therefore has to be declared by whoever deploys it.

### `TRUSTED_PROXY_HOPS`

| Value | Meaning |
|---|---|
| unset / `0` | **Default.** `X-Forwarded-For` is not trusted. Every caller shares one limiter bucket. Safe, but per-network limits are not available. |
| `1` | One reverse proxy (Traefik/Caddy under Coolify, or nginx) sits in front and appends the real client IP. **This is the correct setting for the standard deployment.** |
| `n` | `n` layers of infrastructure you control, e.g. CDN plus proxy. |

The value counts entries from the **right**. A client can prepend any number of
fake entries on the left; it cannot alter what your own proxy appended after the
request arrived.

**Set this to `1` once the app is behind a proxy.** Until it is set, an attacker
and a school share one bucket, so the per-network protections degrade to global
ones. Nothing becomes unsafe — the failure-only controls still apply — but
throttling is less precise.

If the header carries fewer entries than `TRUSTED_PROXY_HOPS` promises, the
request resolves to `unknown` rather than falling back to another entry.
Guessing there would hand back exactly the control this setting exists to remove.

### Limitations of the in-memory limiter

- State is **per process**. Running N instances multiplies every effective
  limit by N.
- State is **lost on restart**, which resets counters.
- The database-backed per-account lockout (8 failures / 15 minutes) is
  unaffected by both of the above and remains the strongest control.

Shared state (Redis) would be needed only if the app is scaled to multiple
instances. It is deliberately not a dependency today.

## Database TLS (added with audit fix H1)

The connection to PostgreSQL carries every student, medical and payment record
in the system. It is the highest-value data path there is, so the certificate
presented by the database server is now **verified by default**.

Previously the code sent `rejectUnauthorized: false` on every connection. That
encrypts the link but authenticates nothing: anything able to intercept the
route to the database could present a self-signed certificate and read or alter
the traffic. This was confirmed by test — a rogue TLS server with a mismatched
common name was accepted under the old setting and is refused under the new one.

### Configuration

| Variable | Effect |
|---|---|
| *(nothing set)* | **Default.** TLS required, server certificate verified against the system trust store. |
| `PG_CA_CERT` | PEM of a private root CA. Verification stays on and this root is trusted as well — for managed providers that issue certificates from their own CA. |
| `PG_SSL=no-verify` | TLS required but the certificate is not verified. An explicit, greppable escape hatch for providers that still issue self-signed certificates. |
| `PG_SSL=false` or `PG_SSL=disable` | No TLS at all. Only appropriate for a Unix socket or a genuinely trusted private network. |

An unrecognised `PG_SSL` value (`true`, `require`, a typo like `tru`) is a
**startup failure**, not a silent fallback. Guessing there would mean sending
school data over an unauthenticated link.

### `sslmode` in the connection string

If `DATABASE_URL` already contains an `sslmode` parameter — `verify-full`,
`verify-ca`, `require`, `disable` — and `PG_SSL` is not set, the application
passes no `ssl` option and lets `pg` interpret the URL. This matters because
supplying an explicit `ssl` object *overrides* the connection string, so an
operator's carefully chosen `?sslmode=verify-full` would otherwise be discarded.

Setting `PG_SSL` explicitly takes precedence over the URL.

### If the deployment cannot connect after this change

A `SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE` error means
the provider's certificate is not signed by a public CA. Prefer supplying the
provider's root via `PG_CA_CERT`; use `PG_SSL=no-verify` only if that root is
genuinely unavailable.

## Uploaded document storage (added with audit fix H3)

Uploaded documents are written to the filesystem, not to the database. The
location is `STORAGE_ROOT`, and **if it is not set it defaults to
`<app>/storage` — inside the application directory.**

On any container platform that directory is part of the image's writable layer
and is replaced on every redeploy. The database rows survive, so the documents
stay listed in the UI while their files are gone. Before this fix, opening one
returned a generic 500 "Something went wrong. Please try again." — advice that
could never succeed, for a file that no longer existed.

### Required configuration

Set `STORAGE_ROOT` to a path on a persistent volume mounted **outside** the
application directory, and mount that volume at the same path on every instance:

    STORAGE_ROOT=/var/lib/school-os/storage

The application checks this at startup. When `NODE_ENV=production` and the
resolved path is inside the application directory, it prints a `[startup]`
warning naming the exact path and the fix. It **does not refuse to boot**: on a
single VPS with no container layer the application directory is durable, and
that is a legitimate deployment. The warning is silent in development, and
silent in production once the path points somewhere durable.

Note that setting the variable is not by itself sufficient — `STORAGE_ROOT=./uploads`
still resolves inside the application directory and still warns.

### Volume ownership in containers

Durable is not the same as usable. The image runs unprivileged as uid 1001 and
creates `/var/lib/school-os/storage` at build time, so a Docker **named volume**
mounted there is initialised from the image and inherits the correct ownership.

A **bind mount** is not. The platform creates the host directory as root, and
mounting it hides the image's directory along with its permissions, so the
application sees a path it cannot write to. Every sign of a healthy deployment
is present — migrations apply, the server starts, `/api/health` returns 200 —
and document uploads then fail with `EACCES`, whenever a teacher first tries to
file a scan.

A startup check probes the directory and, in production, prints the command
that fixes it:

    sudo chown -R 1001:1001 /data/coolify/applications/<uuid>/storage

The path to chown is the volume's **source** on the host, not `STORAGE_ROOT`
inside the container. As with the ephemeral-storage warning this reports rather
than refuses to boot: attendance, grades and fees all still work without the
documents module, and taking them down would be the worse outcome.

### Backups

This path holds the only copy of every uploaded file. A database backup alone
does not protect it and will restore rows whose files are missing. Back up the
`STORAGE_ROOT` volume on the same schedule as the database, and restore the two
together — see §10 of the production audit.

### If documents are already missing

A document whose file has been lost now returns **410 Gone** with an explicit
message telling the user to re-upload, instead of a misleading 500. The 410 is
returned only after the normal ownership check, so it never reveals to another
school that a document exists. To find affected rows, compare the `storage_key`
values in the `documents` table against the files present under `STORAGE_ROOT`;
they must be re-uploaded, as the content is unrecoverable.

## Application origin for Server Actions (added with audit fix H2)

The sandbox preview is served from `https://{port}-{id}.e2b.app`, and the
allowed-origin list used to be hard-coded to `['*.e2b.app', 'localhost:3000']`
in `next.config.mjs`. `e2b.app` is a third-party sandbox host on which anyone
can provision a subdomain, so that wildcard named origins outside the school's
control — and `next build` baked it into the production bundle.

The list is now built by `src/lib/config/origins.mjs`: the sandbox entries are
added only outside production, and production origins come from the environment.

### Configuration

    APP_ORIGIN=school.edu.et          # or APP_ORIGINS=a.example,b.example

**Leaving this unset is safe and is the normal case.** Next only consults the
allow-list when a request's `Origin` header differs from its `Host`. A standard
deployment where both are the school's domain never reaches that check. The
build prints an informational `[config]` notice when it is unset, saying exactly
this.

Set it when the app runs behind a reverse proxy or load balancer that does not
forward the public hostname as `Host`/`X-Forwarded-Host`, or when the app is
reached on more than one hostname. Values are normalised, so
`https://school.edu.et/` and `school.edu.et` are equivalent; a port is kept
(`school.edu.et:8443`) because Next compares against `URL.host`. A bare `*` is
rejected.

### Note on CSRF scope

This setting only governs Next Server Actions. This application currently
defines **none** — every mutation goes through `/api/*` route handlers, which are
protected by the `sos_session` cookie being `SameSite=lax`, `HttpOnly` and
`Secure`. `SameSite=lax` means a browser does not attach the session to a
cross-site `POST`, which is what blocks form-based CSRF today.

Note that the API route handlers themselves perform **no `Origin` header
check** — they rely entirely on the cookie's `SameSite` attribute. That is
adequate for current browsers, but if a future change relaxes `SameSite`,
introduces CORS, or adds Server Actions, an explicit origin check becomes
necessary.

## PostgreSQL version and migration safety (added with audit fixes M2 + M1)

### Minimum server version: PostgreSQL 15

`drizzle/0010_finance_apply_idempotence.sql` uses `NULLS NOT DISTINCT`, added
in PostgreSQL 15. It is what makes "apply this fee" idempotent for fees with no
term (registration, monthly, one-off): without it a repeated apply silently
bills those families a second time.

`drizzle/0008_finance.sql` additionally uses a `GENERATED ALWAYS AS … STORED`
column, which needs PostgreSQL 12 or newer.

`npm run db:migrate` now reads `server_version_num` and **refuses to start** on
anything older than 15, before applying a single file. Previously an old server
failed part-way through migration 0010, leaving the database half-migrated.

If the server does not expose `server_version_num` — some Postgres-compatible
engines do not — the check is skipped rather than blocking the deploy, and the
migration itself will fail loudly if the feature is genuinely absent.

### Each migration file is atomic

Every file now runs inside a single transaction that also records its
`_migrations` row, so the two commit or roll back together. PostgreSQL has
transactional DDL, which makes this nearly free.

Before this, a failure mid-file left partially applied DDL with **no**
`_migrations` row. The retry then failed on the objects already created — for
example `relation "alpha" already exists` — and required someone to repair a
live database by hand. Now a failed migration reports:

    Migration "0011_operations.sql" failed and was rolled back; the database is unchanged.
    Cause: <the underlying error>

so the correct response is simply to fix the file and run `npm run db:migrate`
again.

This is safe only while no migration needs to run outside a transaction. A
test (`tests/migrate-safety.test.ts`) fails the build if anyone adds
`CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX`, `ALTER SYSTEM`, or
`ALTER TYPE … ADD VALUE`. If one of those is ever genuinely required, it needs
its own runner path rather than a loosened transaction.

## Dependency advisories and the deferred Next.js 16 upgrade (added with audit fix L1)

### Checking

```bash
npm audit --omit=dev   # what ships to production; expected: 0 vulnerabilities
npm audit              # includes build tooling; see "known and accepted" below
```

`npm audit --omit=dev` is the number that matters for a deployed school. It
should be **zero**. If it is not, read the advisory before acting — npm's
suggested `npm audit fix --force` is willing to install a **breaking major
version**, which is usually the wrong trade for a build-time issue.

### The postcss override

`package.json` carries:

```json
"overrides": { "postcss": "^8.5.28" }
```

Next.js 15.5.25 pins postcss to an exact `8.4.31`, which sits inside the
advisory range `<=8.5.22`. npm's only offered remedy was `next@16`, a breaking
major upgrade. It is not needed: the advisories are fixed in postcss `8.5.23`,
the **same major version**, and Next 16's own fix was simply moving its pin to
`8.5.23`. The override applies that same patch on Next 15.

This was verified to be behaviour-neutral: the compiled stylesheet is
byte-for-byte identical with and without the override, down to the same content
hash. `tests/dependency-audit.test.ts` fails if the override is dropped or if a
vulnerable postcss reappears nested under `next`.

**Remove the override** once `next` itself depends on postcss `>8.5.22`. Check
with `npm view next dependencies.postcss`; the test will still pass, and
deleting a redundant override keeps the tree honest.

### Known and accepted: `drizzle-kit` (development only)

`npm audit` (without `--omit=dev`) reports moderate advisories in `esbuild` via
`@esbuild-kit/*` via `drizzle-kit`. These are **not deployed**: `drizzle-kit` is
a devDependency used only to generate migration SQL on a developer machine, and
the affected esbuild dev-server behaviour is never run here. The fix npm offers
is `drizzle-kit@0.18.1`, a **downgrade** from 0.31.6 that would break migration
generation. Left as-is deliberately.

### Next.js 16 — deferred maintenance, not a security item

Next 16 is a genuine migration and should be scheduled on its own, with time to
test. It is **not** a security fix — the only security-relevant part of it was
the postcss bump, which is already applied above.

Known breaking changes and this application's exposure:

| Breaking change in Next 16 | Exposure here |
| --- | --- |
| Sync `cookies()`/`headers()`/`draftMode()` removed | **None** — all call sites already `await` |
| `params`/`searchParams` must be awaited | **None** — 56 `Promise`-typed `params`, 0 sync |
| `middleware.ts` → `proxy.ts` (fails *silently*) | **None** — no middleware file exists |
| Turbopack default; build fails on webpack config | **None** — no custom webpack config |
| `revalidateTag(tag)` needs a cache profile | **None** — not used |
| AMP, `next lint`, runtime config, `devIndicators` removed | **None** — not used |
| Implicit route caching removed | **Low** — routes are already `force-dynamic` |
| Node 20.9+, TypeScript 5.1+ | **Met** — Node 22, TS 5.9.3 |
| React 19.2 | **Met** — React 19.2.8 |

Before upgrading: run `npx @next/codemod@canary upgrade latest`, then the full
test suite, a production build, and a manual pass over sign-in, attendance,
gradebook, report cards and document upload. Re-check that the M6 security
headers still apply and that the dev preview is still frameable.
