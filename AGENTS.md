# Expense Wise — engineering guide

Expense Wise is a personal + business financial operating system: Capture → Connect → Understand → Act. The **ledger is the source of truth**; AI extracts, classifies, suggests and explains, but never becomes the record.

This is an operating guide for anyone (human or agent) changing the code.

## Architecture

```
packages/core   Pure TypeScript: finance engine, money/dates, parsers, shared Zod contracts,
                enum vocabularies. No IO. Erasable syntax only (Node runs it via type
                stripping; Next transpiles it). Relative imports use `.ts` extensions.
apps/api        NestJS 12 (ESM, SWC). Auth (Better Auth), workspace isolation, domain
                services, AI gateway, integrations, jobs. Drizzle + PostgreSQL.
apps/web        Next.js 16 App Router dashboard + /admin. Proxies /api/* to the API so
                cookies stay first-party. Design system ported from TeamOS (coss/Base UI).
apps/desktop    Tauri 2 shell (Windows MSI via `pnpm desktop:build`). Loads a running web
                server in a native window; no business logic, no IPC from remote pages.
```

- Ports: web **3100**, API **4100**, Postgres **5436** (`docker compose up -d postgres`).
- One `.env` at the repo root (see `.env.example`).

## Commands

```
pnpm dev                          # api + web
pnpm --filter @expensewise/api build | typecheck | test
pnpm --filter @expensewise/core test
pnpm db:generate / db:migrate / db:seed
pnpm --filter @expensewise/api migrate:prod | rotate-keys   # production (see docs/deploy.md)
```

API integration tests use `DATABASE_URL_TEST`. Parallel runners must each use their own
database (`expensewise_test_<name>`); the harness truncates every table.

## Running the app as an agent

Ports 3100/4100 belong to the developer's own `pnpm dev`. Agents never start servers on them.

- If http://localhost:3100 already answers, use that instance and start nothing.
- Otherwise run a private instance on free ports. Don't run a second `nest start --watch`
  (`deleteOutDir` wipes the shared `apps/api/dist`); Next allows one dev server per build
  directory, so give yours its own:

  ```
  cd apps/api && DATABASE_URL=<your own db> API_PORT=<api> APP_URL=http://localhost:<web> pnpm exec tsx src/main.ts
  cd apps/web && NEXT_DIST_DIR=.next/port-<web> API_INTERNAL_URL=http://localhost:<api> \
    APP_URL=http://localhost:<web> pnpm exec next dev --port <web>
  ```

- Stop both before you finish, as a whole process tree on Windows (`taskkill /F /T /PID <pid>`).
  Servers outlive the session that started them, and leftovers make `pnpm dev` fail.

## Money, dates, amounts

- Money is **integer minor units** (`bigint` mode number). Never floats in arithmetic.
- Every transaction keeps: original `amount` + `currency`, `accountAmount` (account currency),
  `baseAmount` + `baseCurrency`, and the `fxRate` used. Never overwrite the original currency.
- Financial dates are days: `"YYYY-MM-DD"` strings. Use `@expensewise/core` date helpers.
- Transfers, investments, asset purchases, loans, debt payments and equity are **not**
  income or expense. `pnlEffect`/`incomeStatement` in core define P&L; use them.

## API conventions (apps/api)

- A domain area is a Nest module in `src/modules/<area>/`: thin controllers, `@Injectable()`
  services. **Constructor injection uses explicit `@Inject(Class)`** (works under SWC, tsx and
  Vitest alike).
- Imports are ESM: relative paths end in `.js`.
- Workspace-scoped controllers use `@WorkspaceScoped()` and read `@Ctx() ctx: WorkspaceContext`.
  The context comes from the session + verified membership, never from request input.
  Owner/admin-only routes add `@RequireManage()`; platform admin routes use `AdminGuard`.
  Viewers may only GET; a POST that changes nothing in the books (asking the copilot) adds
  `@AllowViewer()`.
- The copilot reads the ledger only through `CopilotQueries` (read-only, workspace-scoped).
  A new question type means a new query there and a tool in `copilot.tools.ts`, never raw SQL
  from the model.
- The copilot writes only through `CopilotActions` (`copilot.actions.ts`): each action
  `prepare`s (validates against the service's own contract, resolves names to ids, changes
  nothing) and `apply`s through the domain service. In chat an action is a proposal stored on
  the message and applied only when a member confirms (card or "yes"); viewers get no write
  tools. MCP (`/api/mcp`, workspace API keys) applies directly for write-scope keys. A new
  capability means a new action spec there, never a direct insert.
- **Every query filters by `ctx.workspaceId`.** Any id arriving in a request (account, category,
  project, counterparty, linked record, file) must be checked with
  `assertInWorkspace(exec, table, ctx.workspaceId, ids, "Entity")` before use.
- Validate bodies/queries with Zod contracts from `@expensewise/core` via `@Body(zod(schema))`.
  Put new request schemas in `packages/core/src/contracts/`.
- Throw `DomainError` helpers from `src/common/errors.ts` (`notFound`, `badRequest`,
  `unprocessable`, `conflict`, `forbidden`). The global filter maps them to JSON.
- Financial mutations run in `db.transaction(...)` and, in the same transaction:
  `AuditService.record(tx, ctx, { action, entityType, entityId, before, after })` and, where
  useful, `EventsService.publish(tx, ctx, "type", payload)`.
- Money movement always goes through `TransactionsService.create/update/confirm/void`
  (pass `{ exec: tx }` to join an outer transaction). Never insert into `transaction` or
  `ledger_entry` directly.
- Imports/integrations are idempotent: pass `externalId` (+ `connectionId`) to
  `TransactionsService.create`; a duplicate returns `{ duplicate: true }`.
- Long work (syncs, AI, reports, scans) runs as jobs: `JobsService.register(type, handler)` in
  `onModuleInit`, `enqueue(type, payload, { workspaceId, dedupeKey })`. Periodic work:
  `SchedulerService.register(name, cron, description, fn)` — fan out one job per workspace.
- Things needing a decision go to the AI Inbox via `InboxService.upsert({ dedupeKey, ... })`;
  user alerts via `NotificationsService.notify({ dedupeKey, ... })`. Dedupe keys make both
  idempotent: never notify twice for the same event.
- Files: `StorageService.save/read` (object storage + metadata row). Never store blobs in PG.
  Each row records its `storage_backend`; the bucket saved in Admin → Storage (Cloudflare R2
  or S3-compatible, `platform_setting` "storage") wins over `.env` for new files. Records link
  files by id (`attachmentFileIds`); the web uploads with `AttachmentField` + `lib/api/files.ts`.
- Never expose credentials: integration secrets are AES-256-GCM encrypted, never returned.
  Admin-level config (AI, storage, billing) lives in `platform_setting` with its secrets
  encrypted under a per-area AAD; add any new encrypted field to `src/scripts/rotate-keys.ts`.

## Hosted service (plans, teams, email, operations)

- **Plan limits:** call `EntitlementsService.assert…` before creating a workspace, inviting
  someone, saving a file, or using API keys/MCP/integrations. Limits follow the workspace
  owner's plan; with billing off (self-hosted) everything is allowed. Over a limit throw
  `planLimit()` (HTTP 402, code `plan_limit`); the web shows an upgrade dialog for it.
- **AI costs credits:** every model call goes through `AiGateway`, which checks and charges
  the owner's credits (allowance first, then purchased balance). Never call a provider
  directly.
- **Teams:** people join only through emailed invitations accepted by the verified owner of
  the invited address (`TeamsService`). Role rules are `assignableRolesFor`/`canManageMember`
  in core; nobody changes the owner's role (ownership moves by transfer).
- **Deleting:** workspaces through `WorkspaceDeletionService`, users through `AccountService`
  (stops a card subscription, deletes workspaces they own alone). Better Auth's bare
  `/admin/remove-user` is blocked.
- **Email:** `sendEmail`/`EmailService` (HTML template, logs instead of sending without
  `RESEND_API_KEY`). **Installation-level audit** (admin actions, deletions, billing changes):
  `PlatformAuditService.record`.
- **Callbacks from third parties** (payment providers, webhooks) must be added to
  `EXEMPT_PREFIXES` in `src/common/origin-check.ts` (cookie-authenticated writes need a
  same-site Origin) and `DEFAULT_EXEMPT` in `src/modules/system/rate-limit.ts`.
- Scheduled tasks run once across all instances (a `scheduler_run` slot claim); "run now"
  from Admin always runs. Error responses carry `requestId`; logs are JSON with
  `LOG_FORMAT=json`; errors go to `SENTRY_DSN` when set. Health: `/api/health`,
  `/api/health/ready` (fails while migrations are pending).

## Schema

`apps/api/src/db/schema/*`. Enum values come from `@expensewise/core` constants. Changing the
schema requires a generated migration (`pnpm db:generate`), reviewed SQL, and applying it to
every database. Prefer existing JSONB `metadata`/`config`/`data` columns for flexible data.

## Web conventions (apps/web)

- Server Components fetch through `src/lib/api/server.ts` (forwards the session cookie);
  mutations are Server Actions in `app/**/actions.ts` calling the API, then `revalidatePath`.
- Use the ported UI kit in `src/components/ui` and the shell/page primitives in
  `src/components/app`. Match the TeamOS look: neutral tokens, Geist, dense 40px header,
  rounded-xl cards with `border-border`, tone-tinted icon tiles, `tabular-nums` for money.
- Every page has loading (`loading.tsx`), empty (contextual action, never "No data found"),
  and error states. Every important number links to the records behind it.
- Format money with `formatMoney` from core; never hand-format.
- The public site (landing, pricing, legal, contact) lives in `app/(public)`; sign-in flows in
  `app/(auth)`. Paths reachable without a session are listed in `src/proxy.ts`
  (`AUTH_PATHS` for signed-out-only pages, `OPEN_PATHS` for everyone).

## Safety

- The ledger is the source of truth; AI output is a draft until a person (or a trusted rule)
  confirms it. Ask before posting uncertain amounts, deleting, or changing balances.
- Do not commit, push, or run destructive database commands against the dev database.
- Track processes you start and stop only those.
