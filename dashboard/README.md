# Home dashboard (`home`)

The owner's ops view for Mail Hero and Todofy on `home.ziyixi.science`: both apps' health through
their `Ops` entrypoints (`contracts/ops-v1`), account-wide Workers Free usage with quota guardrails, a
daily end-to-end canary and the unified ops digest that Todofy's daily reminder carries. It never
imports `mail-hero/` or `todofy/` code.

| Directory | What |
| --- | --- |
| `worker/` | TypeScript Worker `home` + SQLite Durable Object `HomeState` (`wrangler.toml`) |
| `web/` | React + Vite UI (Chinese), built to `web/dist` and served by the Worker |
| `deploy/` | production config generator and its tests |
| `docs/` | [`design.md`](docs/design.md): layout, storage, tick algorithm, API, limits with sources, tests, CI |

```sh
cd dashboard/worker && npm ci && npm run lint && npm run typecheck && npm test && npm run test:runtime
cd dashboard/web && npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

Status: scaffold and design only; nothing is deployed.
