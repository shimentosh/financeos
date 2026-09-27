# syntax=docker/dockerfile:1.7
#
# Expense Wise API (NestJS). One image, three roles:
#   node dist/main.js               the HTTP API (default)
#   node dist/worker.js             a background worker (jobs, events, schedules)
#   node dist/scripts/migrate.js    the release step: apply database migrations
#
# Build from the repository root:
#   docker build -f apps/api/Dockerfile -t expensewise-api --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
#
# packages/core ships as TypeScript source and runs through Node's type
# stripping, so the image keeps the workspace layout (packages/core next to
# apps/api, linked through node_modules) instead of a flattened bundle.

ARG NODE_VERSION=24

# --- base: Node + pnpm (the version pinned by package.json "packageManager") --
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /app

# --- fetch: every package in the lockfile into the store (cached until it changes)
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch --store-dir /pnpm/store

# --- manifests: every workspace package.json (the lockfile's importers) --------
# A new workspace package needs a line here.
FROM fetch AS manifests
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/core/package.json packages/core/

# --- build: compile with SWC (nest build) -------------------------------------
FROM manifests AS build
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm/store --filter "@expensewise/api..."
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/api apps/api
RUN pnpm --filter @expensewise/api build

# --- prod-deps: runtime dependencies only --------------------------------------
# `pnpm fetch` also linked every package (dev tools, the web app's) into
# node_modules; start clean so only the API's runtime dependencies are linked.
FROM manifests AS prod-deps
RUN rm -rf node_modules && pnpm install --frozen-lockfile --offline --prod --store-dir /pnpm/store --filter "@expensewise/api..."

# --- runtime -------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    API_PORT=4100 \
    STORAGE_LOCAL_DIR=/app/apps/api/storage
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY apps/api/package.json apps/api/
# Read by dist/scripts/migrate.js and by GET /api/health/ready.
COPY apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/api/dist apps/api/dist

# Code stays root-owned (read-only for the app); only local uploads are writable.
# With STORAGE_DRIVER=s3 or a bucket saved in Admin → Storage this stays empty.
RUN mkdir -p /app/apps/api/storage && chown node:node /app/apps/api/storage

# Reported by /api/health and attached to error reports.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

USER node
WORKDIR /app/apps/api
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4100)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
