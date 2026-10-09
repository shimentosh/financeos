# Contributing to FinanceOS

Thanks for helping make FinanceOS better! This guide gets you from clone to pull request.

## Ground rules

- **The ledger is the source of truth.** AI may extract, classify and suggest, but it never writes to the books without a confirmation step. Changes that blur this line won't be merged.
- **Money is integer minor units** and dates are `YYYY-MM-DD` strings. No floats in arithmetic.
- **Every query is scoped to a workspace**, and every id that arrives in a request is checked to belong to it.
- Read [AGENTS.md](./AGENTS.md) — it is the engineering guide for the whole codebase (module layout, API conventions, audit, jobs, plan limits, web conventions).

## Set up

```bash
pnpm install
cp .env.example .env            # set BETTER_AUTH_SECRET and ENCRYPTION_KEY (openssl rand -base64 32)
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev                        # web :3100 · API :4100
```

Integration tests need `DATABASE_URL_TEST` pointing at a **separate** database — the test harness truncates every table.

## Before you open a pull request

```bash
pnpm lint          # Biome
pnpm typecheck
pnpm test
```

- Add or update tests for behaviour you change. Finance logic belongs in `packages/core` with unit tests.
- Schema changes need a generated migration (`pnpm db:generate`) with reviewed SQL.
- New request bodies get a Zod contract in `packages/core/src/contracts/`.
- Financial mutations run in a database transaction and record an audit entry.
- UI changes: include a screenshot, and give the page loading, empty and error states.

## Pull requests

1. Fork and create a branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep each PR focused on one change; describe *why*, not only *what*.
3. Link the issue it closes.
4. CI must pass.

## Good first contributions

- Bank, wallet or payment-provider connectors
- CSV import presets for your bank's statement format
- Translations and better Bangla/English parsing
- Docs, deployment guides and examples
- Bug reports with clear reproduction steps

## Reporting bugs and ideas

Use the [issue templates](https://github.com/shimentosh/financeos/issues/new/choose). For security problems, follow [SECURITY.md](./SECURITY.md) — please don't open a public issue.

## Code of conduct

By taking part you agree to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](./LICENSE).
