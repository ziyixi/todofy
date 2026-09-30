# Home dashboard (`home`)

The owner's single ops view for Mail Hero and Todofy on `home.ziyixi.science`, behind the Cloudflare
Access application "Home". It reads both apps only through their `Ops` entrypoints
([`contracts/ops-v1`](../contracts/ops-v1/README.md)) and never imports `mail-hero/` or `todofy/` code.
Besides the page it runs three jobs:

- **Canary and digest.** A daily end-to-end canary (one synthetic `mail.received.v1` event from Mail
  Hero to Todofy, no Todoist side effects) and one unified ops digest that Todofy's daily reminder
  carries.
- **Quota guardrails.** Account-wide Workers Free usage from the GraphQL Analytics API; at ≥ 80 % of a
  daily allowance (or a monthly R2 operation class) both apps defer their non-critical jobs (`shed`).
- **Cross-app contract tests.** The caller side of ops-v1: only declared methods, every declared error
  code, schema-valid inputs, and the real `HomeState` against stub apps that answer with the contract
  fixtures.

Workers Free only: the fetch and cron handlers authenticate, route and make one RPC; all work runs in
the SQLite Durable Object `HomeState`, every read, call and table is bounded, and nothing holds mail
content.

| Path | What |
| --- | --- |
| `worker/` | TypeScript Worker `home` + Durable Object `HomeState` (`wrangler.toml` is the local/base config) |
| `web/` | React + Vite UI (Chinese, mobile-first, light/dark), built to `web/dist` and served by the Worker |
| `deploy/` | `generate-ci-config.mjs` (production config and secrets file) and its tests |
| [`docs/design.md`](docs/design.md) | layout, storage, the tick (status, usage, guard, canary, digest), owner API, the usage query, UI, tests, CI |
| [`docs/setup.md`](docs/setup.md) | resources, Access, GitHub variables and secrets, the analytics token, local dev, rollback |
| [`docs/limits.md`](docs/limits.md) | every Free allowance and platform limit used, with Cloudflare sources |
| [`docs/verification.md`](docs/verification.md) | what was checked locally and what is still open in production |

## Checks (as CI's `Dashboard checks` runs them)

```sh
cd dashboard
npm ci --prefix worker && npm ci --prefix web
node --test deploy/test/*.test.mjs                      # needs worker/node_modules (reads wrangler.toml with wrangler)
(cd worker && npm run lint && npm run typecheck && npm test && npm run test:runtime)
(cd web && npm run lint && npm run typecheck && npm test && npm run build)
```

The job also refuses any import from `mail-hero/` or `todofy/` and dry-runs a generated placeholder
production config. `Contracts` runs the host-side ops-v1 caller tests
(`worker/test/ops-client.test.ts`, `guard`, `canary`, `digest`). `Dashboard deploy` runs on `main`
only, after `CI gate` and after both app deploys, and finishes with a probe that an unauthenticated
request is answered by Access, never by the app. See the root [`README.md`](../README.md) "CI".

Status: implemented and tested locally with synthetic data; not yet deployed
([`docs/verification.md`](docs/verification.md)).
