# brief

A daily research-and-world briefing in Chinese for the owner, to replace the newsletter: a short weekday email
(研究前沿 and the day's 2-3 most important 世界与经济 stories) and a Saturday deep read. The Worker fetches its sources
itself, Claude Haiku 5.5 screens them, Claude Opus 5.5 picks the day's items side by side and writes them, and code
checks every quote, name and number. One Worker and one SQLite Durable Object on Workers Free; the Claude API is its
only paid product. Design: [`docs/design.md`](docs/design.md). Rules: [`AGENTS.md`](AGENTS.md).

**Status: deployed in archive mode** (2026-10-11). The first deployment, `7bea3ec`, passed
[CI](https://github.com/ziyixi/todofy/actions/runs/38128504001). Production `MODE` and the GitHub variable `BRIEF_MODE`
are both `archive`: sources are fetched and paid Claude API calls can run, but no email is sent. The follow-up
resource registration and Home monitoring are implemented; their release and production checks are tracked in
[`HANDOFF.md`](../HANDOFF.md). Newsletter continues unchanged, and its retirement remains a separate decision.

The owner has saved a monthly budget of **$80** in 设置, confirmed on the production settings page on 2026-10-11.
Deployments must preserve this stored setting. The code's initial default remains $40; the separate Claude Console
spend limit has not been verified. Both provider secret
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
silence. Each model call is costed from its usage against the monthly budget (设置).

## Develop

From the repository root (Node 26; the toolchain uses the shared lockfile):

```sh
pnpm install --frozen-lockfile
cd brief/worker
npm run lint && npm run typecheck && npm test   # unit tests: registry, schedule, feeds, grounding, the SDK over a fake stream, render, ledger, ops-v1 golden bytes
npm run test:runtime                            # workerd: a real BriefState, a synthetic web, fake Claude, Workers AI and Resend; CPU and rows at the bounds
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
`CSRF_SIGNING_KEY`, `FEEDBACK_SIGNING_KEY`, `MAIL_FROM` and `MAIL_TO` (from `BRIEF_*` secrets). It never writes, needs
or deletes `ANTHROPIC_API_KEY` or `RESEND_API_KEY`: the owner manages them in the Cloudflare dashboard or from their
own machine (`npx wrangler secret put ANTHROPIC_API_KEY --config ../wrangler.toml` from `worker/`), and `wrangler deploy
--secrets-file` keeps them (`deploy/test/secrets-kept.test.mjs`). Never paste a key into a chat, an issue or GitHub.

The release checks that production runs the commit, that Access answers the archive and the owner API with its login
page, and that exactly `/feedback` reaches the Worker without it (a 404 for an invalid token).

### Emergency stops

Fastest first: 设置 → 暂停 (no model call, no send); `BRIEF_MODE=off` and a redeploy; disable the key in the Console. The
first two stop an issue already running before its next model call: it waits, and resumes when the stop lifts or ends
at 12:00, only archived. A deleted Worker deletes `BriefState` (the archive, the ledger, the weights) for good.
