# Expense Wise

An AI-powered personal **and** business financial operating system. It captures money from screenshots, receipts, text, voice, imports and connected apps; keeps a double-entry ledger as the single source of truth; and turns it into budgets, project economics, net worth, forecasts and reports you can trace back to individual transactions.

```
Capture → Connect → Understand → Act
```

The ledger decides; AI suggests. Every AI extraction is a draft until you (or a rule you wrote) confirm it, and every number on every screen links to the records behind it.

## What's inside

| | |
|---|---|
| **Money** | Accounts (banks, bKash/Nagad/Rocket, cards, cash, Wise, Payoneer, Stripe), transactions of every type (expense, income, transfer, refund, adjustment, investment, asset purchase, debt payment, loan, owner equity), multi-currency with original/account/base amounts and the rate used, reconciliation |
| **Commitments** | Subscriptions with purchase/expiry/renewal/cancellation dates, renewal history and price-change detection, rent/salary/loan/insurance/tax schedules, a payment calendar, "mark as paid" with duplicate protection, reminders at 30/14/7/3/1/0 days |
| **Business** | Projects with revenue, cost by group, burn, budget use, runway (only when the data supports it), capital invested; revenue analytics; payroll runs |
| **Wealth** | Assets with valuations, investments (realised/unrealised gains, ROI), liabilities and payables, receivables with ageing, net worth with history and explicit completeness warnings |
| **Goals** | Savings goals, dream assets, savings plans with required monthly contribution |
| **AI** | Screenshot/receipt/PDF extraction with per-field confidence, Bangla + English natural-language entry, voice (browser speech-to-text), subscription detection, duplicate detection, AI Inbox, recurring-charge and anomaly detection with evidence, a Copilot that answers only from your data |
| **Integrations** | A provider-neutral connector framework: Stripe, a custom REST connector for your own apps, signed inbound webhooks, demo bank/payment feeds, CSV/Excel imports with column mapping and preview; sync history; API keys and a public API |
| **Reports** | Summary, cash-flow statement, 30/60/90-day forecast, weekly/monthly/quarterly reports with narratives that only restate computed figures |
| **Admin** | Platform panel: users (suspend, roles, sign-out), workspaces, job queue and schedules, AI spend, integration health, audit |

## Architecture

```
packages/core   Pure TypeScript finance engine and shared Zod contracts. No IO.
                Money/dates, ledger entries, P&L and cash-flow statements, schedules,
                subscriptions, budgets, net worth, investments, forecasting, duplicate
                and recurring detection, anomalies, rules, the Bangla/English parser.
apps/api        NestJS 12 (ESM, SWC) · Drizzle + PostgreSQL · Better Auth
                Modules: ledger, planning, wealth, business, analytics, ai, copilot,
                integrations, storage, jobs, admin, workspaces, system.
apps/web        Next.js 16 App Router · React 19 · Tailwind v4 · Base UI (coss) —
                the design system of the TeamOS dashboard, ported.
```

- The web app proxies `/api/*` to the API, so the Better Auth session cookie is first-party.
- Every workspace-scoped request resolves the workspace from the session and a verified membership; every query filters by it, and every id a request supplies is checked to belong to it.
- Money is integer minor units; financial dates are `YYYY-MM-DD` days.
- Posted transactions produce signed double-entry lines; balances, cash flow and net worth read those lines. Transfers, investments, loans and equity never count as income or expense.
- Long work runs on a PostgreSQL job queue (`FOR UPDATE SKIP LOCKED`) with a transactional outbox for domain events; schedules fan out one job per workspace.
- Every financial mutation writes an audit record (before/after) in the same database transaction.

## Getting started

Requirements: Node 24+, pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env            # then fill BETTER_AUTH_SECRET and ENCRYPTION_KEY:
                                #   openssl rand -base64 32   (each)
pnpm db:up                      # PostgreSQL on :5436
pnpm db:migrate
pnpm db:seed                    # optional: a realistic demo user and data
pnpm dev                        # web http://localhost:3100 · API http://localhost:4100/api
```

In development the first account created becomes the platform admin; in production only the emails in `ADMIN_EMAILS` do.

### Demo data

`pnpm db:seed` signs up **demo@expensewise.app** / **demo-expense-wise** (override with `SEED_EMAIL`, `SEED_PASSWORD`) with a year of activity through the real services:

- **Personal workspace:** salary and freelance income, bKash/Nagad/card/cash spending, subscriptions with renewal history and a real price change, rent and school fees, budgets, assets, investments with monthly valuations, a car loan, money lent and borrowed, and goals.
- **Business workspace "Shimanto Labs":** Stripe and Payoneer revenue, three projects, payroll, AI and hosting costs, an annual Figma renewal, invoices, a payable and an SME loan.

The daily checks then fill the AI Inbox. `pnpm db:seed --reset` replaces only the demo account and the workspaces it owns.

### AI

Choose the AI provider in the app: **Admin → AI** (platform admins). Paste a key, pick a model, press **Test connection**, save; every workspace uses it at once, and keys are stored encrypted and never shown again. Supported:

- **Anthropic Claude** (native SDK, with Anthropic's server-side model fallback, `fallbacks: "default"`)
- **DeepSeek**, **OpenAI**, **Google Gemini**, **OpenRouter**, **Groq**, **Mistral**, **xAI Grok**, **Qwen**, **Kimi**, **Together AI**
- **Local models** through **Ollama** or **LM Studio** (free, private)
- **Any OpenAI-compatible endpoint** (vLLM, LiteLLM, Azure, a company gateway)

DeepSeek and some other models can't read images; add a second **image model** (Gemini Flash, GPT or Claude) for screenshots, receipts and PDFs, and everything else stays on the main model. The server's `.env` (`AI_PROVIDER`, `AI_MODEL`, `DEEPSEEK_API_KEY`, …, see `.env.example`) is the default until an admin saves settings. Prices for known models are built in and can be overridden, so budgets stay accurate.

Without a key the app still works:

- text and voice entries use the built-in Bangla/English parser;
- rules and merchant memory categorise known merchants;
- screenshots are attached for manual review;
- the Copilot answers from its built-in reading of the question.

Every model call is metered in `ai_usage`, with a monthly budget per workspace (`AI_MONTHLY_BUDGET_USD` or the workspace setting). A refusal, error or exhausted budget falls back to the deterministic path, and AI never posts to the ledger on its own unless you enable high-confidence auto-posting.

The Copilot (`/ai/copilot`, or ⌘K and type a question) reads the ledger only through a fixed set of read-only queries scoped to the workspace. The figures shown beside every answer come from those queries, each linked to its records, never from the model's text.

### Storage

`STORAGE_DRIVER=local` stores uploads under `STORAGE_LOCAL_DIR`; `s3` works with any S3-compatible store (AWS, R2, MinIO). PostgreSQL holds only metadata; files are served only to members of their workspace.

### Background work

By default the API process also runs the worker (`RUN_WORKER_IN_PROCESS=true`). To scale out, set it to `false` and run `pnpm worker` separately; any number of workers can share the queue, and each scheduled task runs once per slot however many processes run it. Hosts without long-running processes can call `POST /api/system/tick` with `x-cron-secret`.

## Commands

```bash
pnpm dev | build | start | worker
pnpm typecheck                  # all packages
pnpm test                       # core unit + API unit/integration (needs DATABASE_URL_TEST)
pnpm lint
pnpm db:generate | db:migrate | db:seed
```

See [AGENTS.md](./AGENTS.md) for engineering conventions.

## Deploy

Two Docker images (`apps/api/Dockerfile` for the API, worker and migrations; `apps/web/Dockerfile` for the Next.js standalone server) and a one-server stack:

```bash
cp .env.example .env            # production values: APP_URL, secrets, POSTGRES_PASSWORD, DATABASE_URL, ADMIN_EMAILS
docker compose -f compose.prod.yml up -d --build   # postgres → migrate → api + worker → web on 127.0.0.1:3100
```

Put a TLS reverse proxy in front of the web container. Health: `GET /api/health` (liveness), `GET /api/health/ready` (database reachable, no pending migrations). CI (`.github/workflows/ci.yml`) lints, typechecks, runs every test suite against PostgreSQL and builds both images.

[docs/deploy.md](./docs/deploy.md) covers the environment, managed PostgreSQL, backups and restore drills, R2 storage, email (SPF/DKIM), payment webhook URLs, scaling, upgrades, key rotation and monitoring.

## Desktop app (Windows MSI)

`apps/desktop` is a Tauri 2 shell around the web app. The ledger, API and database stay on the server; the desktop app connects to a running Expense Wise web server (default `http://localhost:3100`) and remembers the address. Use **File → Change server…** to point it somewhere else.

Requirements: Rust (MSVC toolchain) and WebView2 (built into Windows 10/11). WiX is downloaded automatically by the Tauri CLI.

```bash
pnpm desktop:dev                # run the shell against your running server
pnpm desktop:build              # → apps/desktop/src-tauri/target/release/bundle/msi/*.msi
EXPENSEWISE_SERVER_URL=https://books.example.com pnpm desktop:build   # bake in a default server
```

The server's `APP_URL` must match the address the desktop app connects to (Better Auth checks the origin).
