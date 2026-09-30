# Lab / Paper Radar

Worker `lab` on `lab.ziyixi.science` (Cloudflare Access app "Lab"): once a day it reads the arXiv
cs.IR + cs.CL + cs.LG feed, embeds each new paper with Workers AI (`@cf/baai/bge-m3`), ranks it
against the owner's seeds and saves, writes a one-line Chinese TL;DR for the top 10, and shows a
top-20 list with keyboard triage. Workers Free; a SQLite Durable Object `LabState` schedules itself
with alarms (no cron); D1 `lab` holds the records; a hard daily neuron ceiling (`LAB_DAILY_NEURONS`,
typical use ≈270 of the account's 10,000) keeps AI use bounded.

Status: **scaffold**. Design: [`docs/design.md`](docs/design.md). Nothing is implemented or deployed.

| Path | Contents |
| --- | --- |
| `wrangler.toml` | production config (D1 id and Access AUD are placeholders until the lead fills them in) |
| `worker/` | TypeScript Worker, `LabState`, `Ops` entrypoint, tests |
| `web/` | React UI (Chinese), built into `web/dist` |
| `migrations/` | D1 migrations |
| `docs/` | design |

Commands (each in its folder, after `npm ci`):

```sh
cd lab/worker && npm run lint && npm run typecheck && npm test && npm run test:runtime
cd lab/web && npm run lint && npm run typecheck && npm test && npm run build
```

Local dev: copy `.dev.vars.example` to `.dev.vars`, apply migrations with
`npx --no-install wrangler d1 migrations apply DB --local --config ../wrangler.toml` from `worker/`,
then `npm run dev` in `worker/` and `npm run dev` in `web/`. Never `--remote`; deploys run only from
GitHub Actions.
