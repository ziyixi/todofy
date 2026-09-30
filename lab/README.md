# Lab / Paper Radar

Worker `lab` on `lab.ziyixi.science` (Cloudflare Access app "Lab"): once a day it reads the arXiv
cs.IR + cs.CL + cs.LG feed, embeds each new paper with Workers AI (`@cf/baai/bge-m3`), ranks it
against the owner's seeds and likes, writes a 2–4 sentence Chinese 简介 for the top 20, and shows them
as a daily deck, one card at a time: swipe right 喜欢 / left 不喜欢, undo, 重来, then confirm whether to
send the likes to Todofy, which creates the Todoist tasks (`contracts/task-intent-v1`). Workers
Free; a SQLite Durable Object `LabState` schedules itself with alarms (no cron); D1 `lab` holds the
records; a hard daily neuron ceiling (`LAB_DAILY_NEURONS`, typical use ≈340 of the account's 10,000)
keeps AI use bounded.

Status: **in progress, not deployed**. `web/` implements the deck UI (`docs/ux.md`) against the owner API
types and is tested against an in-memory fake of that API. Design: [`docs/design.md`](docs/design.md); deck UX:
[`docs/ux.md`](docs/ux.md).

| Path | Contents |
| --- | --- |
| `wrangler.toml` | production config (real D1 id and Access AUD; `TODOFY` service binding to Todofy's `Ops`) |
| `worker/` | TypeScript Worker, `LabState`, `Ops` entrypoint, tests |
| `web/` | React UI (Chinese), built into `web/dist` |
| `migrations/` | D1 migrations |
| `docs/` | design, deck UX |

Commands (each in its folder, after `npm ci`):

```sh
cd lab/worker && npm run lint && npm run typecheck && npm test && npm run test:runtime
cd lab/web && npm run lint && npm run typecheck && npm test && npm run build
```

Local dev: copy `.dev.vars.example` to `.dev.vars`, apply migrations with
`npx --no-install wrangler d1 migrations apply DB --local --config ../wrangler.toml` from `worker/`,
then `npm run dev` in `worker/` and `npm run dev` in `web/`. Never `--remote`; deploys run only from
GitHub Actions.
