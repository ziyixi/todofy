# watch

The owner's web watches on `watch.ziyixi.science` (not deployed yet): pages, RSS/Atom/JSON feeds, JSON APIs and data
embedded in pages, checked on a schedule by one SQLite Durable Object, with a deterministic noise pipeline and a
change inbox. Chinese, mobile first. Design: [`docs/design.md`](docs/design.md). Rules: [`AGENTS.md`](AGENTS.md).

| Path | What it is |
| --- | --- |
| `worker/` | The Worker `watch`: the fetch handler (Access, CSRF), `WatchState` (storage, scheduler, pipeline, owner API) |
| `web/` | The UI, built into `web/dist` and served by the Worker |
| `wrangler.toml` | The production config (top level = production; not deployed before step W2) |
| `deploy/` | The deploy wrapper `deploy-vars.mjs` (only `--dry-run` before W2) and the bundle budget |
| `../proto/watch/ui/v1/` | The owner API `watch.ui.v1` |

## Use

- **Add a watch**: 添加, paste the URL, 预览. Tap blocks to keep only them (只看这些) or to drop them (排除这些) and
  watch "将比较的内容" change; pick the trigger (任何变化, 出现/消失某段文字, 新条目, 数值, 供货状态) and the interval,
  then 保存. The first check runs within a minute and sets the notified state; it never reports a change.
- **From the phone**: share a page to `https://watch.ziyixi.science/new#u=<the URL, encoded>`. A bookmarklet does
  it from any page: `javascript:location.href='https://watch.ziyixi.science/new#u='+encodeURIComponent(location.href)`.
  The URL travels in the fragment, which the browser never sends to a server.
- **Changes**: 变化 lists the new ones; 已读 acknowledges. 被过滤的变化 shows what the rules dropped and why; "忽略这一行"
  drops that line from now on (undo from the toast). Turn on 影子模式 for a week to see what a rule would drop.
- **Health**: 健康 groups the watches that are not well: 失效 (3 failed checks in a row; 14 days of it pauses the
  watch), 被拦截 (a bot challenge, never worked around), robots.txt, 网站要求放慢, 今日 JS 配额已用完. A failure is never
  reported as "no change".

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

Not before step W2 ([`docs/design.md`](docs/design.md) §11). CI's `Watch checks` runs everything above and a
`wrangler deploy --dry-run` of the committed config through `deploy/deploy-vars.mjs` with placeholder values; the
wrapper refuses a real deploy while `ACCESS_AUDIENCE` is the all-zeros placeholder. Never run a plain
`wrangler deploy`.
