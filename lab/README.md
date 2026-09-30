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
Before the first deploy: the GitHub environment secret `LAB_CSRF_SIGNING_KEY` (below) and Todofy's release
with `proposeTasks`.

### Deploy secrets

`Lab deploy` (`.github/workflows/ci.yml`) writes three Worker secrets through `deploy/deploy-vars.mjs`:

| Worker secret | From the `production` environment secret | Why |
| --- | --- | --- |
| `ACCESS_OWNER` | `DASHBOARD_ACCESS_OWNER` (existing) | Lab's owner is the dashboard's owner: one person with the same Access identities, so Lab reuses the dashboard's secrets instead of a copy that could drift |
| `ACCESS_OWNER_ALIASES` | `DASHBOARD_ACCESS_OWNER_ALIASES` (existing) | as above; changing the dashboard's aliases changes Lab's at its next deploy |
| `CSRF_SIGNING_KEY` | `LAB_CSRF_SIGNING_KEY` (new, Lab's own) | a separate key per app: a token of one app never verifies at another |

Inside the job (and in `deploy-vars.mjs`) the inputs keep their `LAB_*` names; only the job's `env:` maps them
to the dashboard's secrets, and `.github/scripts/test_wrangler_configs.py` checks that mapping. The one owner
step before the first deploy (64 hex characters, never pasted anywhere; run where `gh` is logged in):

```sh
openssl rand -hex 32 | gh secret set LAB_CSRF_SIGNING_KEY -R ziyixi/todofy --env production
```

Rotating it later is the same command followed by a Lab deploy. The Access app "Lab" must allow the same
identities as the dashboard's app.

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
binding like `DEV_AUTH_BYPASS`; never in the production config). One test runs without it: ops-v1 `status()` on
a fresh object must leave an alarm armed, the bootstrap after a deploy (`docs/design.md` §4).

Local dev: copy `.dev.vars.example` to `.dev.vars`, apply migrations with
`npx --no-install wrangler d1 migrations apply DB --local --config ../wrangler.toml` from `worker/`,
then `npm run dev` in `worker/` and `npm run dev` in `web/`. Never `--remote`; deploys run only from
GitHub Actions.

### Rollback and removal

- **The first release is different.** `wrangler deploy` makes the Worker `lab`, its Custom Domain
  `lab.ziyixi.science` and the `LabState` namespace live as soon as it uploads, before "Check that Access
  answers unauthenticated requests", and the D1 `lab` already has migration 0001. So if `Lab deploy` fails
  at or after "Apply D1 migrations, then deploy the Worker lab" (the probe, a Custom Domain or certificate
  timeout), everything stays live and there is no earlier version to roll back to. The dashboard's next
  30-minute `status()` call arms the pipeline alarm (`docs/design.md` §4), which then re-arms itself: a daily
  arXiv fetch and up to `LAB_DAILY_NEURONS` (5000) neurons a day. **Reverting the merge commit does not
  undo the deploy**: the revert also removes the `Lab deploy` job, so CI never touches the live Worker
  again. Stop it first (below), then revert or fix on `main`.
- **Stop background work** (fetch, embeddings, 简介): 设置 → 暂停抓取新论文 → 保存 (`ingest_paused`). The
  alarm then only runs the hourly retention; decks, decisions and sends keep working. A dashboard `shed`
  guard is not a stop switch: it defers work for at most 48 h, then Lab catches up. Without the UI, delete
  the Worker (below).
- **Worker code** (after the first release). Revert the commit on `main` and push: CI redeploys the previous
  code. For an immediate rollback, Cloudflare dashboard → Workers → `lab` → Deployments → roll back to the
  previous version; the next deploy from `main` replaces it again, so revert the commit too. D1 migrations
  are additive and the `LabState` tables are created with `IF NOT EXISTS`, so older code reads the same data.
- **Remove Lab.** In one commit, remove the dashboard's `LAB` service binding (`dashboard/wrangler.toml`),
  its `lab` registry entry, flow and resources, and Lab's CI jobs, and deploy the dashboard; a binding to a
  missing Worker fails `Dashboard deploy`, so this goes first. Then delete the Worker `lab` in the
  Cloudflare dashboard and check that its Custom Domain and Durable Object namespace are gone too. Delete
  the D1 `lab` only on purpose (it holds the owner's likes and seeds; export it first with
  `wrangler d1 export`), and delete the environment secret `LAB_CSRF_SIGNING_KEY`
  (`gh secret delete LAB_CSRF_SIGNING_KEY -R ziyixi/todofy --env production`). The dashboard's
  `DASHBOARD_ACCESS_OWNER*` secrets stay: the dashboard still uses them. Delete the Access app "Lab".
- **Todofy** needs no change. Intents it has already recorded keep going to Todoist (a created task is never
  withdrawn); its migration `0005_task_intents.sql` is additive. To stop accepting new ones, add
  `TASK_INTENT_SOURCES = ""` to the `[vars]` of `todofy/wrangler.toml` and deploy Todofy
  (`todofy/docs/cloudflare-setup.md` §5).
