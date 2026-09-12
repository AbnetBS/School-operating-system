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
# Dependencies. No NODE_ENV here on purpose: `next build` needs devDependencies
# (typescript, tailwindcss, tsx, drizzle-kit), and `npm ci` omits them when
# NODE_ENV=production.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

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
# Uploaded documents. Must point at a persistent volume (Coolify "Storage")
# mounted at this path, otherwise every redeploy destroys them.
ENV STORAGE_ROOT=/var/lib/school-os/storage

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /var/lib/school-os/storage \
  && chown -R nextjs:nodejs /var/lib/school-os/storage

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
CMD ["sh", "-c", "npm run db:migrate && npm start"]
