# watch

The owner's web watches on `watch.ziyixi.science`: pages, RSS/Atom/JSON feeds, JSON APIs and data
embedded in pages, checked on a schedule by one SQLite Durable Object, with a deterministic noise pipeline and a
change inbox. Chinese, mobile first. Design: [`docs/design.md`](docs/design.md). Rules: [`AGENTS.md`](AGENTS.md).

| Path | What it is |
| --- | --- |
| `worker/` | The Worker `watch`: the fetch handler (Access, CSRF), `WatchState` (storage, scheduler, pipeline, owner API) |
| `web/` | The UI, built into `web/dist` and served by the Worker |
| `wrangler.toml` | The production config (top level = production), deployed by CI's `Watch deploy` |
| `deploy/` | The deploy wrapper `deploy-vars.mjs` and the bundle budget |
| `../proto/watch/ui/v1/` | The owner API `watch.ui.v1` |

## Use

- **Add a watch**: 添加, paste the URL, 预览. Tap blocks to keep only them (只看这些) or to drop them (排除这些) and
  watch "将比较的内容" change; pick the trigger (任何变化, 出现/消失某段文字, 新条目, 数值, 供货状态) and the interval,
  then 保存. The first check runs within a minute (15 minutes after the preview's fetch: the same URL is never fetched
  twice within 15 minutes) and sets the notified state; it never reports a change. 设置 also offers the masks (数字也
  遮盖, 关闭默认遮盖) and whether a page's navigation, header and footer count.
- **From the phone**: share a page to `https://watch.ziyixi.science/new#u=<the URL, encoded>`. A bookmarklet does
  it from any page: `javascript:location.href='https://watch.ziyixi.science/new#u='+encodeURIComponent(location.href)`.
  The URL travels in the fragment, which the browser never sends to a server. Opening such a link only fills the box
  and shows the host; nothing is fetched until you tap 预览.
- **Changes**: 变化 lists the new ones; 已读 acknowledges. 被过滤的变化 shows what the rules dropped and why; "忽略这一行"
  leaves that exact line out of every comparison from now on (the notified state stays). The toast offers 撤销 at
  once; the watch's page lists every ignored line with 取消忽略. Turn on 影子模式 for a week to see what a rule would
  drop.
- **Health**: 健康 groups the watches that are not well: 失效 (3 failed checks in a row; 14 days of it pauses the
  watch), 被拦截 (a bot challenge, never worked around), robots.txt, 网站要求放慢, 今日 JS 配额已用完. A failure is never
  reported as "no change".
- **Todoist**: one task a day (from 14:00 UTC) lists every watch with something new: its name, the trigger type and a
  count, or 检查失效 / 已自动暂停, each linking to the watch here. A watch set to 紧急 (URGENT) sends its confirmed
  changes at once, as long as Todofy's 10 task intents a day leave room for that day's digest (nine on a normal day). Tasks never carry page text or a watched URL: open the link to see the change.
  Todofy creates them (task-intent-v1, `docs/design.md` §7).

## Develop

From `worker/` (Node 26; the pinned toolchains are in each package's lockfile):

```sh
npm ci && (cd ../web && npm ci)
npm run lint && npm run typecheck && npm test   # unit tests (Node)
npm run test:runtime                            # workerd: real WatchState, synthetic sites, CPU
(cd ../web && npm run lint && npm run typecheck && npm test && npm run build)
node --test ../deploy/test/*.test.mjs
```

Trying the UI against synthetic sites (never the internet): copy `.dev.vars.example` to `.dev.vars` (it sets
`DEV_FAKE_UPSTREAM`; add `DEV_MANUAL_ALARMS=true` to drive the scheduler by hand), build the UI, then in two
terminals from `worker/`:

```sh
node test/runtime/serve-fake-sites.ts 8792        # the synthetic sites (see the file for their URLs)
npm run dev                                       # wrangler dev on http://127.0.0.1:8791 (local bindings only)
```

Open `http://127.0.0.1:8791/new#u=https%3A%2F%2Fshop.example.com%2Fkettle`. With manual alarms,
`curl -X POST 'http://127.0.0.1:8791/__dev/step?now=<epoch ms>'` runs a scheduler pass at that time and
`/__dev/clock?now=` sets the API's clock; `curl -X POST http://127.0.0.1:8792/__next` moves every synthetic site to
its next version. Local state is in `watch/.wrangler/` (delete it after a schema change).

## Deploy

Only from GitHub Actions: `Watch deploy` (`.github/workflows/ci.yml`) runs on `main` after `CI gate` and `Todofy deploy`
(its `TODOFY` binding names Todofy's `Intents` entrypoint, which must exist and accept `SOURCE_WATCH`) when `watch/`, `packages/edge-auth/`,
`contracts/ops-v1/ops-v1.ts`, `contracts/task-intent-v1/task-intent-v1.ts` or a `proto/` path the app bundles changed,
or on a dispatch with `watch` or `all`, in the `production` environment and the group `watch-production`. It builds the
UI, writes the secrets file, dry-runs (the bundle held to its budget), runs the hostname guard (`tools/cf-guard`, no
allowance: `watch.ziyixi.science` had no DNS record before W2), deploys through `deploy/deploy-vars.mjs` (no D1), and
then checks production:

- through the API with the deploy token (nothing anonymous shows the build): the Worker serves exactly one version at
  100% and its `BUILD_SHA` is the commit;
- anonymously: `GET /`, `/api/v1/watches` and `/new` are answered by Access with a 302 to its login page for this host
  (the dashboard's probe). The whole host is behind the Access application "watch" (`infra/access.tf`), `/health`
  included.

Those probes pass whatever the committed AUD is (Access answers before the Worker runs; a wrong AUD only shows as a 403
for the owner). The check of the AUD is "Infra drift", which the W2 push runs because it changes `infra/`
(`infra/ids.tf`): it must be green, `no-op: 19` and `output changes: 0` with no outputs problem. Red with
`vars.ACCESS_AUDIENCE differs from access_aud` means the AUD is wrong: read it again (`infra/README.md` "Adding an
app" step 4), fix it here and push; this job then ships the fix.

The deploy token is `CF_API_TOKEN`, as for FlowDay and the links app. The wrapper writes three Worker secrets:

| Worker secret | From the `production` environment secret | Why |
| --- | --- | --- |
| `ACCESS_OWNER` | `DASHBOARD_ACCESS_OWNER` | the watch app's owner is the dashboard's owner: one person with the same Access identities, so it reuses the dashboard's secret (as FlowDay and the links app do) |
| `ACCESS_OWNER_ALIASES` | `DASHBOARD_ACCESS_OWNER_ALIASES` | as above |
| `CSRF_SIGNING_KEY` | `WATCH_CSRF_SIGNING_KEY` (the watch app's own) | a separate key per app: a token of one app never verifies at another |

The CSRF key is 64 hex characters, made where `gh` is logged in and never pasted anywhere; rotating it is the same
command followed by a watch deploy (an open tab then fetches a new token):

```sh
openssl rand -hex 32 | gh secret set WATCH_CSRF_SIGNING_KEY -R ziyixi/todofy --env production
```

**After the first deploy** (and after any deploy that changed the scheduler), check by hand that `WatchState`
schedules itself: CI cannot, since every anonymous request stops at Access and the alarm is armed by the object
itself. Open `https://watch.ziyixi.science/status` signed in (the page calls `serviceStatus`, and every API call arms
an alarm when none is set): it must show a 下次调度 time (never 未设定) within six hours, and after a minute a 上次调度 time. The
dashboard's next tick (every 30 minutes) calls `status()`, which arms a missing alarm too, and shows `scheduler_stale`
if passes stop. Then add a watch of a page the owner controls (W2 step 8 in `docs/design.md` §11) and see its first
check within a minute.

The dashboard's daily drift check compares the live Worker with `dashboard/worker/src/drift-desired.json` (these three
secrets, `BUILD_SHA`, the bindings and the Custom Domain); its registry shows the 网页监视 tile (ops-v1 through the
`WATCH` binding) and the Worker. The Access application "watch" is managed by `infra/` (`infra/README.md` "Adding an
app"): change it there, not by hand, and "Infra drift" checks every day that `ACCESS_AUDIENCE` here equals its AUD.
Notifications go to Todoist through Todofy (`docs/design.md` §7). The switch that stops only this app's tasks is
Todofy's `TASK_INTENT_SOURCES` (below); Todofy's pause switches (`MAINTENANCE_MODE`, `PROCESSING_PAUSED`,
`FORCE_PAUSE_TODOIST`) would hold Mail Hero's mail tasks too.

### Rollback

**The normal path is a code-only revert:** revert the commit that broke it and push; the next `Watch deploy` ships the
revert and keeps the host, the dashboard's view and the object's data. Never run a plain `wrangler deploy`.

**Taking the app out of production is a separate decision**, in this order. A Worker without a route keeps running:
its Durable Object keeps its alarm, so WatchState keeps checking the watched sites and proposing tasks until step 1
stops it, whatever happens to the host.

1. Stop the side effects first.
   - Tasks: set `TASK_INTENT_SOURCES = ""` in the `[vars]` of `todofy/wrangler.toml` (and add it to `CORE_VARS` in
     `todofy/deploy/test_wrangler_configs.py`) and let `Todofy deploy` ship it (`todofy/docs/cloudflare-setup.md`
     "Task intents"). Every watch proposal then answers `source_not_allowed` and nothing reaches Todoist; mail is not
     affected. Or, while the app is still in production, ship a watch commit without the `TODOFY` binding through
     `Watch deploy`: the outbox then only fills.
   - Fetches: pause every watch in the UI (暂停, or the owner API's `pauseWatch`). A paused watch is never checked; the
     alarm then only wakes every six hours to find nothing due.
2. Detach the Custom Domain by hand: Cloudflare dashboard → Workers & Pages → watch → Settings → Domains & Routes →
   `watch.ziyixi.science`. A deploy without `routes` would leave it attached. The Access application can stay.
3. Keep the dashboard's `WATCH` binding, its registry entry and `watch` in `drift-desired.json` while the Worker
   exists: `Ops` keeps answering over the binding without any route, so the tile goes on showing the (paused) app.
   Do not revert the W2 commit for this: it would drop the binding while the registry entry stays (from the Ops
   commit), and the dashboard would mark the tile unreachable after two ticks and send `app_unreachable` (critical)
   in every daily digest, while the drift check reported the live Worker as an extra script.
4. Deleting the Worker deletes `WatchState` and all its data (the watches, snapshots and changes) for good. If the
   owner decides that, one commit then reverts W2 and the dashboard part of the Ops commit together (the `WATCH`
   binding, the registry entry and flow, the drift entry), and the Worker is deleted after that commit's
   `Dashboard deploy`; until it is deleted the drift check reports it as an extra script.
