# syntax=docker/dockerfile:1.7
#
# Expense Wise web (Next.js standalone server). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t expensewise-web \
#     --build-arg API_INTERNAL_URL=http://api:4100 .
#
# API_INTERNAL_URL is baked in at build time: it is the /api/* rewrite target
# and the address Server Components call. Rebuild the image to change it.

ARG NODE_VERSION=24

# --- base: Node + pnpm (the version pinned by package.json "packageManager") --
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# --- fetch: every package in the lockfile into the store (cached until it changes)
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch --store-dir /pnpm/store

# --- build ---------------------------------------------------------------------
FROM fetch AS build
# Every workspace package.json (the lockfile's importers); a new package needs a line.
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm/store --filter "@expensewise/web..."
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
ARG API_INTERNAL_URL=http://api:4100
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN pnpm --filter @expensewise/web build

# --- runtime: the traced standalone server, static assets and public files ------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# Next writes its cache here; everything else stays root-owned.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache

USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/icon.svg').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
