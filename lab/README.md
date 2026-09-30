# Lab / Paper Radar

Worker `lab` on `lab.ziyixi.science` (Cloudflare Access app "Lab"): once a day it reads the arXiv
cs.IR + cs.CL + cs.LG feed, embeds each new paper with Workers AI (`@cf/baai/bge-m3`), ranks it
against the owner's seeds and likes, writes a 2–4 sentence Chinese 简介 for the top 20, and shows them
as a daily deck, one card at a time: swipe right 喜欢 / left 不喜欢, undo, 重来, then confirm whether to
send the likes to Todofy, which creates the Todoist tasks (`contracts/task-intent-v1`). Workers
Free; a SQLite Durable Object `LabState` schedules itself with alarms (no cron); D1 `lab` holds the
records; a hard daily neuron ceiling (`LAB_DAILY_NEURONS`, typical use ≈340 of the account's 10,000)
keeps AI use bounded.

Status: **implemented, not deployed** (2026-09-30). `worker/` implements the pipeline, the neuron ledger, the
deck/decision/undo/重来 API, the send to Todofy with polling, ops-v1 and Access + CSRF; `web/` implements the
deck UI (`docs/ux.md`). Both run in CI (`Lab checks`), and `Lab deploy` releases them from `main` after
`Todofy deploy`. Design: [`docs/design.md`](docs/design.md); deck UX: [`docs/ux.md`](docs/ux.md).
Before the first deploy: the GitHub environment secrets `LAB_ACCESS_OWNER`, `LAB_ACCESS_OWNER_ALIASES` and
`LAB_CSRF_SIGNING_KEY` (a fresh `openssl rand -hex 32`), and Todofy's release with `proposeTasks`.

| Path | Contents |
| --- | --- |
| `wrangler.toml` | production config (real D1 id and Access AUD; `TODOFY` service binding to Todofy's `Ops`) |
| `worker/` | TypeScript Worker, `LabState`, `Ops` entrypoint, tests |
| `web/` | React UI (Chinese), built into `web/dist` |
| `migrations/` | D1 migrations |
| `deploy/` | `deploy-vars.mjs` (BUILD_SHA and the owner secrets at deploy; refuses a placeholder D1 id or AUD) and its tests |
| `docs/` | design, deck UX |

Commands (each in its folder, after `npm ci`):

```sh
cd lab && node --test deploy/test/*.test.mjs        # after npm ci in worker/ (reads the config with its wrangler)
cd lab/worker && npm run lint && npm run typecheck && npm test && npm run test:runtime
cd lab/web && npm run lint && npm run typecheck && npm test && npm run build
```

The workerd suite (`worker/test/runtime/`) runs the real `LabState` and D1 (migrations applied) next to a
fake AI binding (`test/stubs/fake-ai.ts`), a stub Todofy whose `Ops` validates every task-intent-v1 input
(`test/stubs/todofy-stub.ts`) and an outbound handler that plays rss.arxiv.org and export.arxiv.org; the
pipeline is driven with explicit clocks through `LabState.step(now)` (`DEV_MANUAL_ALARMS=true`, a test-only
binding like `DEV_AUTH_BYPASS`; never in the production config).

Local dev: copy `.dev.vars.example` to `.dev.vars`, apply migrations with
`npx --no-install wrangler d1 migrations apply DB --local --config ../wrangler.toml` from `worker/`,
then `npm run dev` in `worker/` and `npm run dev` in `web/`. Never `--remote`; deploys run only from
GitHub Actions.
