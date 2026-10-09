# Security policy

FinanceOS handles financial data, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through [GitHub Security Advisories](https://github.com/shimentosh/financeos/security/advisories/new). Include:

- what is affected (component, endpoint, version or commit),
- steps to reproduce or a proof of concept,
- the impact you expect (data exposure, cross-workspace access, privilege escalation, …).

We aim to acknowledge reports within **3 working days** and to agree on a disclosure timeline with you. We'll credit you in the advisory unless you prefer otherwise.

## Scope

Of particular interest:

- access to another workspace's data (workspace isolation),
- authentication, session, invitation or 2FA bypasses,
- exposure of encrypted credentials or API keys,
- the Copilot / MCP writing to the ledger without confirmation or outside its key's scope,
- server-side request forgery through integrations or webhooks.

## Supported versions

Security fixes land on `main`. Self-hosters should stay on the latest release.

## Hardening tips for self-hosters

- Generate strong, unique `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` values and keep `.env` out of version control.
- Serve FinanceOS only over HTTPS behind a reverse proxy.
- Restrict platform admins with `ADMIN_EMAILS`.
- Back up PostgreSQL and test restores (see [docs/deploy.md](./docs/deploy.md)).
- Rotate keys with `pnpm --filter @financeos/api rotate-keys`.
