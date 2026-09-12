# syntax=docker/dockerfile:1

###############################################################################
# School Operating System — production image
#
# Multi-stage build. The runtime stage keeps the FULL node_modules because
# `npm run db:migrate` runs TypeScript through `tsx` (a devDependency), and it
# must run against the production database before `next start` serves traffic.
###############################################################################

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
# Dependencies. `next build` needs devDependencies (typescript, tailwindcss,
# @tailwindcss/postcss, tsx, drizzle-kit), and `npm ci` omits every one of them
# when NODE_ENV=production.
#
# Leaving NODE_ENV unset here is not enough, because the platform can put it
# into the build anyway. Coolify rewrites this file before building: for every
# variable marked "Available at Buildtime" it inserts an `ARG <key>=<value>`
# line immediately after each FROM instruction. Docker exports an ARG to every
# subsequent RUN as an environment variable, so `npm ci` saw NODE_ENV=production
# with no ARG declared in this file at all. The install then reported success
# with 53 packages instead of 92, and `next build` failed 20 seconds later with:
#
#     Error: Cannot find module '@tailwindcss/postcss'
#
# Because the platform edits this file, the guards below deliberately do not
# depend on instruction ordering. An ENV overrides an ARG of the same name; the
# inline assignment outranks both; and --include=dev forces devDependencies
# whatever NODE_ENV turns out to be.
# ---------------------------------------------------------------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN NODE_ENV=development npm ci --include=dev
# Assert the toolchain is actually installed, here rather than inside webpack.
# A one-line, legible failure now beats a module-resolution stack trace later.
RUN node -e "for (const m of ['next','typescript','tsx','tailwindcss','@tailwindcss/postcss','drizzle-kit']) require.resolve(m)" \
  || (echo 'ERROR: build toolchain missing from node_modules - devDependencies were not installed. Suspect a build-time NODE_ENV=production.' && exit 1)

# ---------------------------------------------------------------------------
# Build the Next.js production bundle.
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime. `node:22-bookworm-slim` (Debian/glibc) so native deps such as
# @tailwindcss/oxide and @next/swc get their prebuilt binaries.
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
# npm is on the container's start path (`npm run db:migrate`) and writes its
# debug log to $HOME/.npm/_logs. A `--system` user gets no home directory, so a
# failing migration — a wrong DATABASE_URL on a first deploy is the common case
# — would also print "Log files were not written". Give the user a real,
# writable home so the diagnostics survive.
ENV HOME=/home/nextjs
# Uploaded documents. Must point at a persistent volume (Coolify "Storage")
# mounted at this path, otherwise every redeploy destroys them.
#
# Ownership matters too: this container runs as uid 1001, so a bind-mounted
# host directory created as root cannot be written to. A Docker named volume
# inherits the ownership set below. The startup check in
# src/lib/operations/storageConfig.ts reports the exact `chown` to run if it
# cannot write here.
ENV STORAGE_ROOT=/var/lib/school-os/storage

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /home/nextjs nextjs \
  && mkdir -p /home/nextjs /var/lib/school-os/storage \
  && chown -R nextjs:nodejs /home/nextjs /var/lib/school-os/storage

COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/.next ./.next
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=build --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs
COPY --from=build --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=build --chown=nextjs:nodejs /app/src ./src

USER nextjs
EXPOSE 3000

# Migrations are transactional and idempotent, so re-running them on every
# container start is safe and guarantees the schema is current before serving.
#
# `exec` matters. Without it PID 1 is the shell, which does not forward signals
# to a child it is waiting for: `docker stop` (and therefore every Coolify
# redeploy) would wait out the grace period and then SIGKILL the server
# mid-request. With `exec` the server process replaces the shell, becomes PID 1
# and receives SIGTERM, so Next.js can finish in-flight requests and close the
# database pool. Verified: SIGTERM to `sh -c 'sleep 30'` orphans the child;
# SIGTERM to `sh -c 'exec sleep 30'` ends it immediately.
CMD ["sh", "-c", "npm run db:migrate && exec npm start"]
