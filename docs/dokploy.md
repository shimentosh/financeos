# Deploying FinanceOS on Dokploy

FinanceOS runs on a Dokploy-managed VPS as one **Docker Compose** service
(`compose.dokploy.yml`) plus a Dokploy **PostgreSQL** database service.
[deploy.md](deploy.md) covers the architecture, every environment variable,
scaling and backups; this page covers only what is specific to Dokploy.

```
 browser ──HTTPS──► Traefik (Dokploy) ──► web :3100 ──/api/*──► api :4100
                                                                  │
                         Dokploy PostgreSQL ◄── migrate · api · worker
```

No Redis is needed: the job queue, domain events and scheduled tasks all run
on PostgreSQL.

## Server

- 2 vCPU and **4 GB RAM** at least; the Next.js build needs most of it. On
  2 GB, add swap before the first deploy.
- A DNS `A` record for the app domain pointing at the VPS.

## 1. PostgreSQL

In the Dokploy project: **Create Service → Database → PostgreSQL**.

- Version 17 or newer, database `financeos`, user `financeos`, a strong
  password.
- Do **not** expose it externally.
- After it is deployed, copy the **Internal Connection URL**
  (`postgresql://financeos:<password>@<app-name>:5432/financeos`). That is
  `DATABASE_URL`.
- Set up backups under the database's **Backups** tab (an S3/R2 destination
  in Dokploy settings).

## 2. The app (Compose)

**Create Service → Compose**:

- **Provider:** your Git repository, branch `main`.
- **Compose type:** Docker Compose. **Compose path:** `./compose.dokploy.yml`.
- **Isolated deployment:** off. The file sets up its networks itself and joins
  `dokploy-network` to reach Traefik and PostgreSQL.

### Environment

Paste into the **Environment** tab (Dokploy writes it to `.env` next to the
compose file; every service reads it). Generate secrets with
`openssl rand -base64 32`.

```env
APP_URL=https://books.example.com
DATABASE_URL=postgresql://financeos:<password>@<postgres-app-name>:5432/financeos

BETTER_AUTH_SECRET=
ENCRYPTION_KEY=
ADMIN_EMAILS=you@example.com

RESEND_API_KEY=
EMAIL_FROM="FinanceOS <hello@example.com>"
SUPPORT_EMAIL=

# Traefik is the one proxy in front of the web server.
TRUST_PROXY=1
DATABASE_POOL_MAX=10
LOG_FORMAT=json
SENTRY_DSN=

# Optional: shown by /api/health and on error reports.
APP_VERSION=
```

AI providers, the storage bucket and billing are configured later in the app
(Admin → AI / Storage / Billing). `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY`
must never change after the first deploy (see deploy.md → Key rotation).

### Domain

**Domains → Add domain**: host `books.example.com`, service **`web`**, port
**3100**, HTTPS on with Let's Encrypt. Do not add a domain for `api`; the
web server proxies `/api/*` to it.

### Deploy

Press **Deploy**. Order: `migrate` applies pending migrations and exits →
`api` and `worker` start → `web` starts once the API is healthy. A failed
migration stops the rollout; read the `migrate` logs. `migrate` shows as
exited afterwards; that is expected.

Turn on **Auto Deploy** (or the webhook) to deploy on every push to `main`.

## 3. After the first deploy

1. Open `https://books.example.com/api/health/ready`; it returns
   `{"status":"ready",...}`.
2. Sign up with an address in `ADMIN_EMAILS`, verify it, and open `/admin`.
3. **Admin → Storage:** connect Cloudflare R2 (or another S3 bucket).
   Until then uploads live on the `uploads` Docker volume on this VPS, which
   Dokploy's database backups do not cover.
4. **Admin → AI** and **Admin → Billing** as needed.
5. `/admin/system` shows the worker heartbeat and when each schedule last ran.

## Operations

- **Logs:** the Compose service's **Logs** tab, per container.
- **One-off commands** (e.g. key rotation): open a terminal on the `api`
  container and run `node dist/scripts/rotate-keys.js`.
- **More workers:** add `deploy: { replicas: 2 }` to `worker`. Keep
  `DATABASE_POOL_MAX × processes` below PostgreSQL's `max_connections`.
