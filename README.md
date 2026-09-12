# School Operating System

A configurable, multi-tenant school management system for Ethiopian schools.
One record, entered once, flows through attendance, grades, report cards, fees,
portals, communication, documents and analytics.

Built around Ethiopian realities rather than retrofitted to them: given/father's
/grandfather's names instead of first/last, the Ethiopian calendar alongside the
Gregorian one, English and Amharic throughout, and schools that may run three
terms or two semesters, rank students or not, and start mid-year.

---

## Contents

- [Requirements](#requirements)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Deploying to production](#deploying-to-production)
- [Deploying with Docker](#deploying-with-docker)
- [Migrations](#migrations)
- [HTTPS and cookies](#https-and-cookies)
- [Running behind a proxy](#running-behind-a-proxy)
- [Database TLS](#database-tls)
- [File storage](#file-storage)
- [Backups and recovery](#backups-and-recovery)
- [External providers](#external-providers)
- [Testing](#testing)
- [Further documentation](#further-documentation)

---

## Requirements

| | |
|---|---|
| Node.js | 20 or newer (developed on 22) |
| PostgreSQL | **15 or newer** — required, see [Migrations](#migrations) |
| Disk | A persistent volume for uploaded documents |

PostgreSQL 15 is a hard floor: migration `0010` uses `NULLS NOT DISTINCT`, which
is what stops a repeated fee application from billing a family twice.
`npm run db:migrate` checks the server version and refuses to run on anything
older, before applying any changes.

Development needs no PostgreSQL install — an embedded PGlite database is used
automatically when `NODE_ENV` is not `production`.

---

## Local development

```bash
npm install
npm run db:migrate     # create the schema in .data/pgdata
npm run db:seed        # two demo schools with realistic data
npm run dev            # http://localhost:3000
```

Optional extra demo data:

```bash
npx tsx scripts/seed-finance.ts
npx tsx scripts/seed-operations.ts
```

The seed creates two deliberately different schools, to keep configurability
honest:

| Code | School | Structure |
|---|---|---|
| `bfa` | Bright Future Academy | 3 terms, ranking on, English, all modules |
| `aps` | Addis Preparatory | 2 semesters, ranking off, GPA, Amharic, fewer modules |

Demo sign-ins are listed on the login page in development, and hidden when
`NODE_ENV=production`.

> **Never run `npm run db:seed` against a production database.** It creates
> users with a known, published password. It has no environment guard, so
> nothing but care prevents this.

---

## Configuration

All configuration is environment variables. Copy the template and edit:

```bash
cp .env.example .env
```

`.env.example` documents every variable the application actually reads,
including which file reads it. Summary:

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | **Yes** in production | Enables the production protections below |
| `DATABASE_URL` | **Yes** in production | PostgreSQL connection string |
| `PG_SSL` | No | Database TLS mode; defaults to full verification |
| `PG_CA_CERT` | No | CA root for a provider with a private certificate authority |
| `STORAGE_ROOT` | Deployment-specific | Persistent path for uploaded documents |
| `TRUSTED_PROXY_HOPS` | Deployment-specific | Number of trusted reverse proxies |
| `APP_ORIGIN` / `APP_ORIGINS` | Deployment-specific | Extra Server Action origins |
| `PG_POOL_MAX` | No | Connection pool size (default 10) |
| `PGLITE_DATA_DIR` | No | Embedded database path, development only |

Setting `NODE_ENV=production` is not cosmetic. It makes `DATABASE_URL`
mandatory, adds `Secure` to session cookies, hides the demo credentials, arms
the storage warning, and drops the sandbox origin wildcard.

---

## Deploying to production

```bash
# 1. Configure. At minimum:
export NODE_ENV=production
export DATABASE_URL='postgresql://user:password@host:5432/school_os'
export STORAGE_ROOT=/var/lib/school-os/storage

# 2. Install and build.
npm ci
npm run build

# 3. Apply migrations. Run this before starting the new version.
npm run db:migrate

# 4. Start.
npm start          # binds 0.0.0.0:3000
```

Put a TLS-terminating reverse proxy in front; the app speaks plain HTTP on
port 3000.

A few things that are easy to get wrong:

- **`APP_ORIGIN` is read at build time**, not at start time, because Next bakes
  it into the build output. If you need it, set it before `npm run build`.
- **`npm run db:migrate` needs the same `DATABASE_URL`** as the app. It applies
  the identical C1 guard, so it cannot accidentally migrate the embedded
  development database and report success.
- **Start-up refuses rather than guesses.** A missing or malformed
  `DATABASE_URL`, or an unrecognised `PG_SSL`, stops the process with an
  explanatory message instead of starting in a degraded state.

---

## Deploying with Docker

The repository ships a multi-stage `Dockerfile`: Node 22 on Debian slim, an
install stage, a build stage, and a runtime stage that runs as an unprivileged
user. The container applies outstanding migrations and then starts serving, so
a redeploy brings the schema current before it takes traffic.

```bash
docker build -t school-os .

docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL='postgresql://user:password@host:5432/school_os' \
  -e TRUSTED_PROXY_HOPS=1 \
  -v school-os-storage:/var/lib/school-os/storage \
  school-os
```

Add `-e PG_SSL=false` only when the database genuinely has no TLS — the default
requires and verifies it, see [Database TLS](#database-tls).

`STORAGE_ROOT` is already set to `/var/lib/school-os/storage` in the image; what
the image cannot do is make that path survive a redeploy. Mount a volume there
or uploaded documents are destroyed while their database rows remain. The
container runs as uid 1001, so a bind-mounted host directory must be owned by
`1001:1001`; a Docker named volume inherits that from the image on first use.
See [File storage](#file-storage).

### Coolify settings

| Setting | Value |
|---|---|
| Build pack | Dockerfile |
| Ports exposes | `3000` — `next start` binds `0.0.0.0:3000` |
| Health check path | `/api/health` — `200` once the database answers, `503` before |
| Volume | `/var/lib/school-os/storage` — a Docker volume, or a bind mount chowned to `1001:1001` |
| `NODE_ENV` | `production`, at **runtime** only — see below |
| `DATABASE_URL` | PostgreSQL **15 or newer**, mandatory in production |
| `PG_SSL` | `false` for a database on the same Docker network with no TLS; otherwise leave unset (defaults to `verify`) |
| `TRUSTED_PROXY_HOPS` | `1` — Coolify's proxy appends the real client IP |

### Why `NODE_ENV` must not be a build-time variable

`npm ci` skips devDependencies when `NODE_ENV=production`, and devDependencies
are precisely what build this app: TypeScript, Tailwind, `@tailwindcss/postcss`,
`tsx`, `drizzle-kit`. The install still *succeeds* — about half the packages, no
error — and the build then dies in webpack with:

    Error: Cannot find module '@tailwindcss/postcss'

Leaving `NODE_ENV` out of the Dockerfile does not prevent this. Before building,
Coolify **rewrites the Dockerfile**: for every variable marked "Available at
Buildtime" it inserts an `ARG <key>=<value>` line immediately after each `FROM`
instruction. Docker exports an `ARG` to all subsequent `RUN` instructions as an
environment variable, so `npm ci` sees `NODE_ENV=production` even though this
repository declares no such `ARG`. Two details in the deploy log confirm the
rewrite — the Dockerfile BuildKit receives is larger than the one committed
here, and the line numbers in its error output no longer match the file.

The deps stage therefore does not rely on instruction ordering: `ENV
NODE_ENV=development` (an `ENV` overrides an `ARG` of the same name), an inline
`NODE_ENV=development` on the install command itself, `--include=dev`, and an
assertion that the toolchain is really installed. A build-time
`NODE_ENV=production` is now harmless.

Two Coolify settings also address it at the source. Uncheck "Available at
Buildtime" on `NODE_ENV` — the better option, since the value matters to the
running container and not to the build — or set *Application → Advanced → Build
→ Build arguments* to "Managed manually in Dockerfile" to stop the `ARG`
injection entirely. The second one also preserves the Docker layer cache, which
the injected `ARG` lines otherwise invalidate on every deploy.

Two lines in a Coolify build log are expected and harmless: the
`[config] APP_ORIGIN is not set…` notice from `next build`, and
`useradd warning: nextjs's uid 1001 is greater than SYS_UID_MAX 999`.

---

## Migrations

```bash
npm run db:migrate     # apply everything outstanding; safe to re-run
```

- Each file runs inside a single transaction together with its `_migrations`
  row, so a failure rolls back completely and leaves the database unchanged.
  Fix the file and run it again — no manual repair.
- Applied migrations are checksummed. Editing one that has already run is a
  hard error; add a new migration instead.
- The runner refuses to start on PostgreSQL older than 15, before writing
  anything.

---

## HTTPS and cookies

Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` whenever
`NODE_ENV=production`.

A `Secure` cookie is not stored by browsers over plain HTTP, so **the app must
be served over HTTPS in production or nobody will be able to stay signed in.**
Terminate TLS at the proxy and forward to the app over the internal network.

`SameSite=Lax` is also what protects the `/api/*` routes from cross-site
request forgery today — those handlers do not perform their own `Origin` check.
Keep it in mind before relaxing the attribute or adding CORS headers.

---

## Running behind a proxy

Set `TRUSTED_PROXY_HOPS` to the number of proxies between the internet and the
app — typically `1`.

The client IP is taken by counting that many entries from the **right** of
`X-Forwarded-For`, because a client can forge entries on the left. Login abuse
protection uses that IP.

- Unset or `0` (the default) means no proxy is trusted, and per-IP limits are
  disabled. Per-account and global limits still apply, so login abuse
  protection is reduced but not absent.
- Setting it **higher** than the real number of proxies is the dangerous
  mistake: it lets a client inject a forged address and evade per-IP limits.

Also ensure the proxy forwards the public hostname as `Host` or
`X-Forwarded-Host`; if it does not, set `APP_ORIGIN`.

---

## Database TLS

By default the app requires TLS and verifies the server's certificate.

| `PG_SSL` | Behaviour |
|---|---|
| unset / `verify` | Require TLS, verify the certificate |
| `no-verify` | Require TLS, accept a self-signed certificate |
| `false` / `disable` | No TLS |

If `DATABASE_URL` already contains `?sslmode=...` and `PG_SSL` is unset, the URL
is honoured as written.

A managed database whose root is not publicly trusted fails with
`SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Supply the
provider's root via `PG_CA_CERT` rather than reaching for `no-verify`.

---

## File storage

Uploaded documents — including medical and disciplinary records — are written
to the filesystem at `STORAGE_ROOT`, not into the database.

It defaults to `<app>/storage`, which on a container platform is **destroyed on
every redeploy** while the database rows survive, leaving documents that can be
listed but never opened. Point it at a persistent volume mounted outside the
application directory, and mount the same volume on every instance.

In production the app prints a startup warning if `STORAGE_ROOT` resolves inside
the application directory. It warns rather than refuses, because a single
server with no container layer has a perfectly durable application directory.

Mounting the volume is not quite the whole job. The container runs
unprivileged (uid 1001), and a **bind mount** shows the host directory's
ownership — which the platform created as root, hiding the ownership the image
sets. Uploads then fail with `EACCES` on a deployment that reported success.
Either mount a Docker *named* volume, which an empty one inherits from the
image, or run `sudo chown -R 1001:1001 <volume source path>` on the host. A
second startup check probes the directory and prints that exact command when it
cannot write there.

A document whose file has gone missing returns `410 Gone` with an instruction to
re-upload, rather than a generic error.

---

## Backups and recovery

Two things must be backed up **together**:

1. The PostgreSQL database.
2. The `STORAGE_ROOT` volume.

A database backup alone is not sufficient. Restoring it on its own gives you
document rows whose files do not exist. Uploaded files exist in exactly one
place and are not reconstructible.

Test a restore into a scratch environment before relying on it, and confirm that
a document uploaded before the backup can still be downloaded afterwards.

---

## External providers

**No SMS, email, push or payment gateway is connected**, and the system does not
pretend otherwise.

- **SMS.** `src/lib/sms/provider.ts` defines the provider seam and sends
  nothing. Messages are stored with status `unconfigured`, and the UI says so.
  There is deliberately no mock provider marking messages as sent — a school
  would believe absence alerts reached parents when nothing left the building.
  Per-school SMS settings live in the database; `apiKeyRef` there names a
  credential rather than storing one.
- **Payments.** Telebirr and CBE are supported as *recorded payment methods*, so
  a cashier can enter what a family paid. No gateway call is made and no
  provider credentials are required. Receipts, allocation and balances are all
  real.

Adding a provider means registering it against the existing seam; no calling
code changes, and its environment variable should be added to `.env.example`
and to the table above.

---

## Testing

```bash
npm test           # full suite
npm run typecheck  # tsc --noEmit
npm run build      # production build
```

Tests run against a temporary embedded database and do not touch `.data/pgdata`.
Stop the dev server first — the two cannot share the embedded data directory.

---

## Further documentation

| Document | Contents |
|---|---|
| `docs/00-assessment-and-plan.md` | Architecture and build plan |
| `docs/11-operations-runbook.md` | Day-to-day operations, incidents, configuration detail |
| `docs/12-production-audit.md` | Production readiness audit and its findings |
