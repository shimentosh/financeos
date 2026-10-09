## What and why

<!-- What does this change, and why is it needed? Link the issue: Closes #123 -->

## How I tested it

<!-- Commands run, scenarios checked, screenshots for UI changes -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] Tests added or updated for changed behaviour
- [ ] Queries are workspace-scoped and request ids are checked with `assertInWorkspace`
- [ ] Money stays in integer minor units; financial mutations write an audit record
- [ ] Schema changes include a generated, reviewed migration
- [ ] No secrets, real financial data or personal information included
