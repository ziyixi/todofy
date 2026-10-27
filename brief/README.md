# brief

A daily research-and-world briefing in Chinese for the owner, written as the newsletter's successor: a short weekday email
(研究前沿 and the day's 2-3 most important 世界与经济 stories) and a Saturday deep read. The Worker fetches its sources
itself, the configured Haiku route screens them, the configured Opus route picks the day's items side by side and writes them, and code
checks every quote, name and number. One Worker and one SQLite Durable Object on Workers Free. Inference and embeddings use the private shared Model Router; all Claude callers share Router's single key in the existing US$80/month workspace. Design: [`docs/design.md`](docs/design.md). Rules: [`AGENTS.md`](AGENTS.md).

**Status: stopped** (2026-10-18). Production `MODE` and the GitHub variable `BRIEF_MODE` are `off`: sources are still
fetched, but no Claude call starts, no issue is made and no email is sent. The code is kept for possible later use;
resuming is setting `BRIEF_MODE` and redeploying (Deploy below). Newsletter is the active daily briefing. Brief ran in
archive mode from its first deployment, `7bea3ec` on 2026-10-11
([CI](https://github.com/ziyixi/todofy/actions/runs/38128504001)), until the stop.

The owner has saved a monthly budget of **$80** in 设置, confirmed on the production settings page on 2026-10-11.
Deployments must preserve this stored setting. The code's initial default remains $40; the Claude Console workspace limit was separately set and verified at $80/month on 2026-10-27 for the shared Router connection. Both provider secret
names are configured in production; that confirms configuration, not successful model calls or email delivery.

| Path | What it is |
| --- | --- |
| [`docs/design.md`](docs/design.md) | The design: pipeline, selection, budgets, grounding check, ledger, costs, shadow run, owner steps |
| [`content-config/sources.yaml`](content-config/sources.yaml) | The source registry (owner-editable, public), bundled into the Worker |
| [`content-config/profile.md`](content-config/profile.md) | The interest profile and each topic's writing density, for the gate, the pick and the writer |
| [`content-config/policy.md`](content-config/policy.md) | The writing policy the writer reads |
| `worker/` | The Worker `brief`: the fetch handler (Access, CSRF, the feedback token) and `BriefState` (the alarm chain, the fetchers, dedup and clusters, the model calls, the grounding check, the render, the send ledger, the owner API, ops-v1) |
| `web/` | The archive UI (Chinese, mobile first, no framework, over `brief.ui.v1`): 期刊 (the issues; an issue with its quotes, votes and costs), 来源, 偏好, 设置 (暂停, 恢复调用, the monthly budget); built into `web/dist`, the Worker's static assets |
| `deploy/` | The deploy wrapper `deploy-vars.mjs` and the bundle budget `bundle-size.mjs`, with their tests |
| `wrangler.toml` | The production config (top level = production); `wrangler.test.toml` is for local development |
| `../proto/brief/ui/v1/` | The owner API `brief.ui.v1` (issues, items and votes, sources, profile, settings, service status, 恢复调用) |

## How a day runs

Fetch rounds at 12:30, 18:30 and 23:30, and the cutoff round at 03:30 (Monday to Saturday; America/Los_Angeles): each
polls the due feeds (per-host pacing, conditional GETs, arXiv one request every 3 s), keeps new items, embeds them with
Workers AI (bge-m3), clusters the world ones, and screens the candidates with Haiku in groups of 12. After the cutoff
round the day's issue runs one step per alarm: pick (Opus, side by side) → shortlist → read (full text where it is
public) → write (Opus, structured output) → check (every quote aligned to the fetched text, every number classified)
→ repair → render → entail (a Haiku log) → send (06:30 on weekdays, 07:30 on Saturday; one Resend request a day with
an idempotency key, never replayed after an unknown outcome). Saturday's deep read takes a thread of the week instead.
Every step is resumable after a deploy or a crash, and a step that cannot go on sends a two-line note instead of
silence. Each model call reserves Brief's own worst-case rates (`worker/src/limits.ts`) against the monthly budget (设置), then settles the Router's actual API cost. Unknown or interrupted consumption keeps the reservation. A rejected call stops every call until a new build deploys or the owner presses 恢复调用.

## Develop

From the repository root (Node 26; the toolchain uses the shared lockfile):

```sh
pnpm install --frozen-lockfile
cd brief/worker
npm run lint && npm run typecheck && npm test   # unit tests: registry, schedule, feeds, grounding, the common Model Router over a synthetic service binding, render, ledger, ops-v1 golden bytes
npm run test:runtime                            # workerd: a real BriefState, a synthetic web, fake Model Router and Resend; CPU and rows at the bounds
node --test ../deploy/test/*.test.mjs
```

`test/runtime/dry-run.test.ts` is the end-to-end dry run: a shadow weekday from the synthetic feeds to the fake
Resend, with a fake Opus that writes plausible Chinese items from the packets it gets (`test/fakes/plausible.ts`), one
overstated number for the repair, and exactly one send. `UPDATE_GOLDEN=1 npx vitest run test/render.test.ts` rewrites
the golden emails (`test/golden/`), only for an intended change of the render.

From `web/`, using the same workspace installation: `npm run lint && npm run typecheck && npm test` (the views against a fake of the owner API
on the shared transcoder, the layout rules a phone depends on, no request but to its own origin) and `npm run build`
(the JavaScript budget in `scripts/js-budget.mjs`). `npm run dev` serves the UI with Vite and proxies `/api` to the
Worker's `npm run dev`.

No test holds a real key or reaches the network: the Claude API, Resend, Workers AI and every feed and page are fakes
in the test process (`worker/test/fakes/`), and all content is synthetic. Local development (`npm run dev`, with
`../wrangler.test.toml` and a copy of `.dev.vars.example` as `brief/.dev.vars`) points every external request at a
loopback fake named by `DEV_FAKE_UPSTREAM`.

## Deploy

Only from GitHub Actions: `Brief deploy` (`.github/workflows/ci.yml`, the recipe in `worker-release.yml`) on `main`
after `CI gate`, in the `production` environment, through `deploy/deploy-vars.mjs` (never a plain `wrangler deploy`).
The recipe builds `web/` and ships that build. Home's `BRIEF` Ops binding is part of the follow-up integration;
its deployment must follow Brief's deployment of the same commit. See [`HANDOFF.md`](../HANDOFF.md) for release evidence.

The wrapper sets `MODE` (the GitHub variable `BRIEF_MODE`: `off`, `archive`, `shadow` or `live`) and `BUILD_SHA`, and
writes the Worker secrets `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` (from the dashboard's secrets: one owner),
`FEEDBACK_SIGNING_KEY`, `MAIL_FROM` and `MAIL_TO` (from `BRIEF_*` secrets). It never writes, needs or deletes `RESEND_API_KEY`; the owner manages that secret locally. Model credentials
belong to Model Router, with one shared Claude connection. The `MODEL_ROUTER` service binding carries the
Brief caller identity. Provider credentials and native request payloads do not enter this Worker. Never paste a key
into chat, an issue or GitHub.

The release checks that production runs the commit, that Access answers the archive and the owner API with its login
page, and that exactly `/feedback` reaches the Worker without it (a 404 for an invalid token).

### Emergency stops

Fastest first: 设置 → 暂停 (no model call, no send); `BRIEF_MODE=off` and a redeploy; disable the key in the Console. The
first two stop an issue already running before its next model call: it waits, and resumes when the stop lifts or ends
at 12:00, only archived. A deleted Worker deletes `BriefState` (the archive, the ledger, the weights) for good.
