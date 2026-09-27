# Deploying Expense Wise

This guide takes Expense Wise from a clone to a public service: what runs,
what it needs, how to ship it with Docker, and how to keep it healthy.

## Architecture

```
            HTTPS
 browser ──────────► TLS reverse proxy (Caddy, nginx, a load balancer)
                          │
                          ▼
                 web  (Next.js standalone, :3100)
                   │  pages, Server Components, Server Actions
                   │  /api/* rewritten to the API ──┐
                   ▼                                 ▼
                 api  (NestJS, :4100, not public) ◄──┘
                   │ Better Auth sessions, workspace isolation, ledger, AI gateway
                   ▼
              PostgreSQL ◄──── worker (node dist/worker.js, 1..n)
                   ▲              job queue (FOR UPDATE SKIP LOCKED), domain events,
                   │              scheduled tasks (one run per slot, see Scaling)
    object storage (R2/S3) for uploads · Resend for email · Stripe / SSLCommerz for payments
```

- The browser only ever talks to the web origin (`APP_URL`). The web server
  proxies `/api/*` to the API, so the session cookie is first-party.
- One image (`apps/api/Dockerfile`) serves three roles: the API
  (`dist/main.js`), a worker (`dist/worker.js`) and the release step
  (`dist/scripts/migrate.js`).
- The ledger lives in PostgreSQL. Files live in object storage (or a local
  volume); PostgreSQL holds only their metadata.

## Environment

All configuration is environment variables; `.env.example` documents every
one. For production, at least:

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` (the images set it). Turns on secure cookies, email verification, HSTS and the CSP. |
| `APP_URL` | The public origin, e.g. `https://books.example.com`. Auth callbacks, email links, webhook URLs and the CSRF origin check use it. |
| `DATABASE_URL` | PostgreSQL 17+ connection string (CI runs 17, development 18). With the bundled database: `postgres://expensewise:<POSTGRES_PASSWORD>@postgres:5432/expensewise`. |
| `POSTGRES_PASSWORD` | Only for the bundled `postgres` service in `compose.prod.yml`. |
| `BETTER_AUTH_SECRET` | 32+ random bytes (`openssl rand -base64 32`). Signs sessions and encrypts two-factor secrets; changing it signs everyone out and breaks enrolled 2FA. |
| `ENCRYPTION_KEY` | Base64 of exactly 32 bytes (`openssl rand -base64 32`). Encrypts integration credentials, webhook secrets and the AI/storage/billing keys saved in the admin panel. See [Key rotation](#key-rotation). |
| `ADMIN_EMAILS` | Comma-separated emails that get the platform admin role on sign-up. In production this is the **only** way to become admin: the "first user is admin" rule applies only outside production, so nobody can claim a fresh deployment by signing up first. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email. Without a key emails are only logged, which is not usable in production (verification is required). |
| `SUPPORT_EMAIL` | Where support requests go. |
| `RUN_WORKER_IN_PROCESS` | `false` on the API when a separate worker runs (compose does this). |
| `LOG_FORMAT` | `json` in production: one object per line with `requestId`. |
| `SENTRY_DSN` | Optional error reporting (Sentry, GlitchTip, self-hosted Sentry). |
| `TRUST_PROXY` | How the API derives the client IP. `1` covers the web server's proxy plus one reverse proxy in front of it; use the number of proxies for a longer chain (CDN + load balancer: `2`). |
| `DATABASE_POOL_MAX` | Connections per process (default 10). See [Scaling](#scaling). |
| `CRON_SECRET` | Only for hosts without long-running processes (see below). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional "Continue with Google"; redirect URI `<APP_URL>/api/auth/callback/google`. |
| `APP_VERSION` | Build argument; shown by `/api/health` and attached to error reports. |

AI providers, the storage bucket and payment gateways are configured in the
admin panel (Admin → AI / Storage / Billing); keys saved there are encrypted
with `ENCRYPTION_KEY` and never shown again.

## Docker Compose (one server)

`compose.prod.yml` runs PostgreSQL, the release step, the API, a worker and
the web server on one host.

1. **Server.** Docker Engine 24+ with the compose plugin, a DNS name pointing
   at the server, ports 80/443 open.
2. **Configuration.** In a clone of the repository:

   ```bash
   cp .env.example .env
   # edit .env:
   #   NODE_ENV=production
   #   APP_URL=https://books.example.com
   #   POSTGRES_PASSWORD=<openssl rand -hex 24>
   #   DATABASE_URL=postgres://expensewise:<same password>@postgres:5432/expensewise
   #   BETTER_AUTH_SECRET=<openssl rand -base64 32>
   #   ENCRYPTION_KEY=<openssl rand -base64 32>
   #   ADMIN_EMAILS=you@example.com
   #   RESEND_API_KEY=...  EMAIL_FROM="Expense Wise <hello@example.com>"
   #   SENTRY_DSN=...      (optional)
   chmod 600 .env
   ```

3. **Build and start.**

   ```bash
   export APP_VERSION=$(git rev-parse --short HEAD)
   docker compose -f compose.prod.yml up -d --build
   docker compose -f compose.prod.yml ps
   docker compose -f compose.prod.yml logs -f migrate api worker
   ```

   Startup order: `postgres` healthy → `migrate` applies pending migrations
   and exits 0 → `api` and `worker` start → `web` starts once the API is
   healthy. A failed migration stops the rollout with the old schema intact.

4. **TLS.** The web container listens on `127.0.0.1:3100` only. Put a reverse
   proxy in front of it; with Caddy (automatic certificates):

   ```
   books.example.com {
       reverse_proxy 127.0.0.1:3100
   }
   ```

   Caddy replaces any `X-Forwarded-For` a client sends, so `TRUST_PROXY=1` is
   right. With nginx use `proxy_set_header X-Forwarded-For $remote_addr;`.

5. **First admin.** Sign up with an address listed in `ADMIN_EMAILS`, verify
   it, and open `/admin`. Then set up AI (Admin → AI), storage (Admin →
   Storage) and billing (Admin → Billing).

6. **Check.** `curl -fsS https://books.example.com/api/health/ready` returns
   `{"status":"ready",...}`; `GET /api/admin/system` (signed in as a platform
   admin) shows the worker heartbeat and when each schedule last ran.

### Without Compose

Kubernetes, Nomad, Fly.io, Render, ECS: build the two images and run

| Process | Image | Command | Probes |
|---|---|---|---|
| release (before each rollout) | api | `node --enable-source-maps dist/scripts/migrate.js` | exit code |
| api (≥1) | api | default (`node --enable-source-maps dist/main.js`) with `RUN_WORKER_IN_PROCESS=false` | liveness `GET /api/health`, readiness `GET /api/health/ready` on :4100 |
| worker (≥1) | api | `node --enable-source-maps dist/worker.js` | heartbeat in `/api/admin/system` |
| web (≥1) | web | default (`node apps/web/server.js`) | `GET /icon.svg` on :3100 |

```bash
docker build -f apps/api/Dockerfile -t expensewise-api --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
docker build -f apps/web/Dockerfile -t expensewise-web --build-arg API_INTERNAL_URL=http://api:4100 .
```

`API_INTERNAL_URL` is compiled into the web image (it is the `/api/*` rewrite
target); build one image per environment if the API's internal address
differs. The web container needs only `APP_URL` at runtime, no secrets.

Hosts without long-running processes can skip the worker and call
`POST /api/system/tick` with header `x-cron-secret: $CRON_SECRET` every
minute; each call runs one worker pass. Scheduled tasks need a running
worker, so this mode suits small installs only.

## Database

- **Managed PostgreSQL** (Neon, Supabase, RDS, Cloud SQL, Crunchy) is the
  recommended production setup: automated backups, point-in-time recovery,
  failover. Point `DATABASE_URL` at it (add `?sslmode=require` if the provider
  needs it) and delete the `postgres` service from `compose.prod.yml`.
- **Connections.** Every process opens up to `DATABASE_POOL_MAX` connections:
  (api replicas + worker replicas + 1 for migrations) × `DATABASE_POOL_MAX`
  must stay below the server's `max_connections`, or put PgBouncer (session
  mode) in between.
- **Migrations** are generated SQL in `apps/api/drizzle`, applied by the
  release step under an advisory lock (concurrent runs wait for each other),
  each in a transaction.

### Backups

- **Managed:** enable point-in-time recovery with at least 7 days of
  retention, plus a daily logical dump kept elsewhere (a different provider
  or account) for 30 days.
- **Bundled postgres:** a nightly logical dump from the host's cron:

  ```bash
  # /etc/cron.d/expensewise-backup — 02:30 every night, keep 30 days
  30 2 * * * root cd /srv/expensewise && docker compose -f compose.prod.yml exec -T postgres \
    pg_dump -U expensewise -Fc expensewise > /var/backups/expensewise-$(date +\%F).dump \
    && find /var/backups -name 'expensewise-*.dump' -mtime +30 -delete
  ```

  Copy the dumps off the server (restic, rclone to R2/S3, or your backup
  service). The `uploads` volume holds files when no bucket is configured;
  back it up too, or move files to R2 (below).

### Restore drill (do it quarterly)

1. Restore the latest dump into a scratch database:
   `createdb expensewise_restore && pg_restore -d expensewise_restore --no-owner /var/backups/expensewise-YYYY-MM-DD.dump`
   (managed: restore a PITR branch/instance to a timestamp).
2. Run the release step against it:
   `DATABASE_URL=postgres://…/expensewise_restore node dist/scripts/migrate.js`.
3. Start an API against it on a spare port and check `GET /api/health/ready`,
   then sign in and compare a few account balances and the latest
   transactions with production.
4. Write down how long it took; that is your real recovery time. Drop the
   scratch database.

## Files (Cloudflare R2)

Uploads (receipts, screenshots, statements) go to local disk by default,
which only works for one server. For production use a bucket:
**Admin → Storage**, choose Cloudflare R2 (or any S3-compatible store), paste
an API token with Object Read & Write on the bucket, **Test**, save. New files
go to the bucket at once; the panel can copy existing files over. The bucket
stays private: files are streamed through the API to members of their
workspace only.

## Email (Resend)

1. Add your sending domain in Resend and publish the DNS records it gives:
   **SPF** (TXT, `include:` Resend), **DKIM** (the CNAME/TXT keys) and a
   **DMARC** policy (`_dmarc` TXT, start with `p=none; rua=mailto:…`, move to
   `quarantine` once reports are clean).
2. `RESEND_API_KEY=re_…` and `EMAIL_FROM="Expense Wise <hello@your-domain>"`
   (an address on the verified domain).
3. Sign up with a new address and check the verification email arrives and
   passes SPF/DKIM (Gmail: "Show original").

## Payments

Configure keys in **Admin → Billing** (stored encrypted), then register these
URLs with the providers (`<APP_URL>` = your public origin):

| Provider | URL | Notes |
|---|---|---|
| Stripe webhook | `<APP_URL>/api/billing/webhooks/stripe` | Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Paste the signing secret into Admin → Billing. |
| SSLCommerz success | `<APP_URL>/api/billing/sslcommerz/success` | |
| SSLCommerz fail | `<APP_URL>/api/billing/sslcommerz/fail` | |
| SSLCommerz cancel | `<APP_URL>/api/billing/sslcommerz/cancel` | |
| SSLCommerz IPN | `<APP_URL>/api/billing/sslcommerz/ipn` | Set in the SSLCommerz merchant panel. |

These callbacks (and `/api/webhooks/*` for integrations) are exempt from the
CSRF origin check because the provider's site calls them; they are verified
by signature or by validating the transaction with the provider.

## Scaling

- **Separate the worker.** Set `RUN_WORKER_IN_PROCESS=false` on API instances
  and run one or more `dist/worker.js` processes. Workers claim jobs with
  `FOR UPDATE SKIP LOCKED`, so any number can share the queue.
- **Scheduled tasks run once per slot.** Every process running the worker
  starts the crons, but each firing first inserts `(task, minute)` into
  `scheduler_run`; only the process whose insert lands runs the task. "Run
  now" in Admin → Jobs always runs. Claims older than 30 days and expired
  rate-limit counters are pruned daily (`system.prune-ops`).
- **API replicas** are stateless (sessions in PostgreSQL, rate limits in
  PostgreSQL), so no sticky sessions. With local file storage all replicas
  and workers must share the uploads volume; use R2/S3 instead.
- **Web replicas** are stateless too.

## Upgrades

1. Read the release notes for new required variables.
2. Build the new images (`APP_VERSION` = the commit).
3. **Run the release step first** (`migrate`); compose does this on
   `up -d --build`. On other platforms make it a pre-deploy job that must
   succeed before the rollout.
4. Roll out api and worker, then web. `GET /api/health/ready` stays 503 on a
   new instance until migrations are applied, so load balancers hold traffic.
5. Keep migrations backward compatible with the previous release (add,
   backfill, then drop in a later release), so old and new instances can
   overlap during a rolling deploy.

Rolling back code is safe while the schema is compatible; never roll back a
migration by hand on production — restore from backup into a scratch
database first if in doubt.

## Key rotation

`ENCRYPTION_KEY` protects stored secrets (integration credentials, webhook
signing secrets, and the AI, storage and billing keys in platform settings).
To rotate it without downtime:

1. Generate a new key: `openssl rand -base64 32`.
2. Set `ENCRYPTION_KEY=<new>` and `ENCRYPTION_KEY_PREVIOUS=<old>` (comma-separate
   several old keys) on every API and worker process; deploy. Reads try the
   new key, then the old ones; new writes use the new key.
3. Re-seal everything with the new key:

   ```bash
   docker compose -f compose.prod.yml run --rm api node dist/scripts/rotate-keys.js --dry-run
   docker compose -f compose.prod.yml run --rm api node dist/scripts/rotate-keys.js
   # from a checkout: pnpm --filter @expensewise/api rotate-keys [--dry-run]
   ```

   It is idempotent, prints a summary per kind of secret, and exits 1 if any
   secret opens with none of the keys (reconnect that integration or re-enter
   that key).
4. When a run reports nothing left to re-seal, remove
   `ENCRYPTION_KEY_PREVIOUS` and deploy.

`BETTER_AUTH_SECRET` has no dual-key mode: rotating it signs every user out
and invalidates enrolled two-factor secrets. Rotate it only after a suspected
leak.

## Monitoring

| Signal | Where |
|---|---|
| Liveness | `GET /api/health` → `{status, database: {ok}, version}` (503 when the database is unreachable). Public and deliberately minimal. |
| Readiness | `GET /api/health/ready` → 503 until the database answers **and** no migration is pending. |
| System view | `GET /api/admin/system` (platform admins): version, migrations, AI provider, storage, worker mode and last heartbeat (stale after 3 minutes), last run of each schedule across instances. |
| Errors | `SENTRY_DSN`: 5xx responses, unhandled rejections, crashes and browser errors (via `POST /api/system/client-errors`) with the request id, user id and scrubbed request (no cookies, auth headers or query strings). |
| Logs | `LOG_FORMAT=json`: one JSON object per line (`level`, `time`, `context`, `message`, `requestId`, `stack`) plus one access line per request (`method`, `route`, `status`, `ms`, `userId`). Every response carries `x-request-id`, and error bodies include `requestId`, so a user's report leads straight to the log lines. |

Suggested alerts: readiness failing for 2 minutes; worker heartbeat older
than 5 minutes; dead jobs (Admin → Jobs); error-rate spikes in Sentry;
database storage above 80%; backup job not producing a file for 26 hours.

## Security checklist

- `NODE_ENV=production`, HTTPS only (HSTS is sent), `APP_URL` exactly the
  public origin.
- Content Security Policy (production): `default-src 'self'`, no third-party
  scripts, `frame-ancestors 'none'`.
- CSRF: cookie-authenticated `POST/PUT/PATCH/DELETE` requests whose `Origin`
  (or `Referer`) is not `APP_URL` get 403. Exempt: `/api/auth/*` (Better Auth
  checks origins itself), `/api/billing/webhooks/*`,
  `/api/billing/sslcommerz/*`, `/api/webhooks/*`, `/api/v1/*` and `/api/mcp`
  (API keys). Requests with neither header (server-to-server) pass.
- Rate limits: explicit per-route limits, plus a default of 300 writes a
  minute per user (or IP) for every other mutating route.
- `ADMIN_EMAILS` set; `ALLOW_SIGN_UP=false` for a private install.
- `.env` readable only by the deploy user; secrets never in images (the
  `.dockerignore` excludes `.env`).
- Backups encrypted and stored off the server; a restore drill on the
  calendar.
