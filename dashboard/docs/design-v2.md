# Dashboard v2: launcher, flows, Cloudflare monitoring

Current outcome observations, per-service controls and exact account registration are described in
[Dashboard state and operations](../../docs/dashboard-state.md). They replace the original global guard action
and Analytics-only live resource discovery below.

What v2 changes relative to [`design.md`](design.md) (which stays authoritative for storage, the tick,
guard, canary, digest, Access/CSRF and the usage query). It condenses the owner-approved redesign
proposal of 2026-09-29 (steps 1 and 2; every open question takes its recommended default, §8). Status:
the registry, the views and every route of the owner API are implemented in the Worker (evaluation in
`worker/src/evaluate.ts`, discovery in `discovery.ts`, the probe in `probe.ts`, view assembly and ETags
in `views.ts`, storage in `state.ts`), with unit tests and workerd tests for each endpoint. Since
2026-10-02 the API is `dashboard.ui.v1` ([`proto/dashboard/ui/v1`](../../proto/dashboard/ui/v1), §5): the
UI (`web/`) renders the four views through its generated client, and the `/api/v2` routes answer 410 for
one release. The built UI was
driven end to end against the real Worker in workerd (stub apps, fake GraphQL; desktop and a 390 px
phone, light and dark): [`verification.md`](verification.md) §1d.

## 1. Views

Four hash-routed views; hash routing needs no Worker change behind Access. Page title 个人控制台
(was 运维面板), no subtitle.

| View | Route | Content | Endpoint |
| --- | --- | --- | --- |
| 首页 | `#/` | attention strip; launcher tiles grouped 应用 / 站点 / 后台服务 (registry order, never reordered by status); one line per flow; four mini quota bars (Workers 请求, D1 读取行数, Workers AI neurons with 剩余, R2 存储; `HOME_QUOTA_IDS`) + "N 个 Worker · 今日错误 N · 降载状态" | `GetHomeView` |
| 业务流程 | `#/flows`, `#/flows/<flow>` | flow cards by business group (邮件与任务 / 内容与发布 / 平台), stage chains; the mail flow owns the canary (14-day strip, today's timeline, scope note verbatim) | `GetFlowsView` |
| Cloudflare 监控 | `#/cloudflare`, `#/cloudflare/worker/<script>` | the 14 quota rows (daily / monthly / storage; Workers AI neurons among the daily ones, with the neurons left), the auto-discovered Worker table, D1 / DO / R2 resources, read-only guard | `GetCloudflareView` |
| 操作与记录 | `#/ops` | guard and canary actions (confirmation texts and CSRF flow unchanged), digest, full ops-v1 details per app (the old `AppCard` body), build, time zone, registry list | `GetOpsView` |

v1 anchors map to routes (`web/src/router.ts`): `#apps` → `#/`, `#quota` → `#/cloudflare`, `#canary` →
`#/flows/mail-to-task`, `#actions`/`#digest`/`#app-*` → `#/ops`. Phones get a fixed bottom tab bar
(64 px incl. safe area, content padded ~88 px), desktop a tab row under the title; the selected tab
has colour + weight + underline and `aria-current="page"`. Tab badges count warning, critical and
unknown items whose target is that view; held and info items never count.

The attention strip is on every view: one quiet line "● 全部正常 · 下次巡检 HH:MM" when fine, else
"■ N 项故障 · ◆ N 项未知 · ▲ N 项需关注" with at most 3 items (worst first: critical > unknown >
warning) and "还有 N 项"; each item links to its target (a flow stage opens with that stage selected).
Held switches show as a small ‖ 已暂停 tag (`attention.held`), outside the level and the badges: every
stage `hold_signals` code of an app's current status (force-paused or owner-paused delivery, forwarding
off, paused processing, paused Todoist, reminder off) and an owner's forced shed (`home:owner_shed`,
which then replaces the `dashboard:guard_shed` item); an automatic shed stays an item, and
`maintenance_mode` stays critical. The item set is otherwise v1's (digest items, `tick_stale`, usage and
canary items, `canary_disabled` info); v2 only adds a `target`, so the digest sent to Todofy does not
change. On the page only, the strip also lists **observed** items (`observed: level`, `since: null`)
so it never says 全部正常 while a tile, a stage or a Worker is worse: one per cause, skipped when an
item already explains it — a tile at warning/critical/unknown (unless a digest item of that entry has
the same code; `unreachable` ≡ `app_unreachable`) → the tile; a flow stage whose cause is not already
listed (same entry and code, or an item targeting that stage) → the stage; a Worker whose error rate is
warning/critical and whose entry has no `error_rate` item → its Cloudflare row. This dashboard's own
tile is left to `tick_stale`; nothing observed is listed before the first tick.

Targets (`evaluate.ts` `targetOf`): an app code → the first flow stage (display order) claiming it, else
the app on 操作与记录; `app_unreachable`/`app_down`/`status_unavailable` → the tile on 首页; quota and
usage items → Cloudflare; canary items → the mail flow (not delivered and start failures at 投递,
consumer failures at 摘要); `tick_stale` → 运维摘要 › 巡检; everything else → 操作与记录.

## 2. Levels

| Level | 中文 | Shape | Roll-up |
| --- | --- | --- | --- |
| `ok` | 正常 | ● | yes |
| `held` | 已暂停 | ‖ | yes |
| `warning` | 需关注 | ▲ | yes |
| `critical` | 故障 | ■ | yes |
| `unknown` | 未知 | ◆ | yes |
| `link` | 仅链接 | none; the host is shown | no |
| `unmonitored` | 未接入 | ○ | no |

Worst wins: critical > unknown > warning > held > ok (`LEVEL_RANK`); a silent check never looks
healthy. Status is always shape + word. A link-only entry never shows a dot: its tile shows the host
and its accessible name says 未接入监控（仅链接）. `maintenance_mode` stays a critical signal (as in
ops-v1 and the digest), not a hold.

## 3. Registry (`worker/src/registry.ts`, definitions in `worker/src/registry-types.ts`)

Three lists joined by id, compiled into the Worker; the UI gets the public view from
GetRegistry (`GET /api/v1/registry`; no binding names or probe URLs), so no hostname enters the bundle and
`no-external.test.ts` / `check-dist.mjs` stay as they are.

- **Entries** (tiles): id, name, description, group, icon (closed `ICON_KEYS`, bundled lucide), accent,
  URL, Access lock, status source, tile metric, app-only signals, order.
- **Workers**: script → one entry. **Resources**: D1 / DO / R2 → entry; `match` is the GraphQL
  identifier. IDs kept in GitHub variables are `match: null` TODO placeholders (with a `todo` note):
  they match nothing, so the account's rows stay 未登记 + the first 8 characters of an opaque D1/DO ID
  (an R2 bucket shows its full name). Filling one in is allowed: a D1 UUID or DO namespace ID in
  `match` is format-checked and exempt from the privacy scan (never served). Known today:
  R2 `mail-hero-store` (the default name) and `todofy-backups`. TODO: both D1 IDs, the three DO
  namespace IDs, the Mail Hero backup bucket name.
- **Flows**: ordered stages; a stage names an entry (or null = outside the dashboard, with a note),
  optionally the entry's workers it runs on, the entry's signals it claims (hold signals among them),
  display counters and `analytics`. Worker ↔ flow is many-to-many through stages.

| Entry | Group | Status source | Tile |
| --- | --- | --- | --- |
| Mail Hero | 应用 | `ops_v1` (MAIL_HERO, guard) | 今日收件 |
| Todofy (`todofy`, `todofy-core`) | 应用 | `ops_v1` (TODOFY, guard) | 24 小时收到 |
| 论文雷达 (`lab`) | 应用 | `ops_v1` (LAB, guard) | 7 天喜欢 |
| FlowDay (`flowday`, D1 `flowday`) | 应用 | `public_http` outside Access: one GET per tick to `flowday…/pwa/manifest.webmanifest`, expecting 200 and `application/manifest+json`. The host is behind the Access app "flowday", but "flowday-bypass" covers `/pwa/*` and the Worker serves the manifest itself (a static asset, no D1 read), so Access's login redirect can never pass; plus the Worker's error rate (`error_rate`). No Ops entrypoint. F6 may remove the bypass (`flowday/docs/design.md` §11): that change must move this probe first (`test_infra_config.py` fails otherwise) | latency |
| 短链接 (`links`, D1 `links`) | 应用 | `public_http` outside Access: one GET per tick to `s…/robots.txt`, expecting 200 and `text/plain` (the Worker's constant, before any D1 read); plus the Worker's error rate. The tile opens the launcher `https://s.ziyixi.science/_/` behind the path-scoped Access app "links". No Ops entrypoint, and a short link may go unused for days, so no idle rule | latency |
| 网页监视 (`watch`, DO `WatchState`) | 应用 | `ops_v1` (WATCH, guard): counts and codes only, never a watch's name, URL or page text; its `status()` re-arms a missing alarm, so each tick restarts a lost scheduler | 新变化 |
| 个人网站 (`ziyixi-website`, assets only) | 站点 | `public_http`: one GET per tick to `www…/build-info.json` (www is canonical; the apex serves the same site), status + latency only, `redirect: 'manual'`, body unread, `enabled` flag. The site's Worker (`website/`) serves static assets only, which are not Worker invocations, so analytics cannot judge it; the file is part of its static export, so the probe survives the cutover | latency |
| Notion 发布 (`ziyixi-notion-publish`) | 后台服务 | `analytics`: error rate + 26 h idle rule | last request hour |
| Newsletter | 后台服务 | `none` → 未接入 | — |
| 个人控制台 (`home`) | hidden | `self` (`tick_stale`) | no tile; Cloudflare row only |
| 自托管服务器 (`self-hosted`, no Worker) | hidden | `none` | no tile; exists only to name the R2 bucket `vultr-backup` (VPS 备份: the self-hosted VPS and home server's backups, not a monorepo app), since a resource must belong to an entry |

Flows: 邮件 → 任务 (来源转发 ○ → 收件与保存 → 解析 → Webhook 投递 → Todofy 摘要 → Todoist 与提醒; canary
`mail-todofy` verifies 投递 and 摘要 only), 网站发布 (Notion ○ → 发布 → 网站可用), 每日 Newsletter
(Todofy 报告 → 读取报告 ○ → 写入 Notion ○; partial), 网页监视 (网站 ○ → 检查 → 变化收件箱 → 交给 Todofy: the watch app's
`scheduler_stale` and `watches_broken` at 检查, `notify_unsettled` at 交给 Todofy; `maintenance_mode` is app-only, as for
Lab), 运维摘要 (巡检 → 提交摘要 → 每日提醒), and GTD 循环
(收集 → 理清 → 组织 → 回顾 → 执行 ○: Todofy's `received_24h`, then the counters of its daily read-only
Todoist snapshot, `review_overdue` (info) and `gtd_snapshot_stale` at 回顾; 执行 is done in Todoist, outside the dashboard (FlowDay has its own tile but no stage: the work itself is not something the dashboard can see);
todofy/docs/gtd-features.md §9).

`validateRegistry` (`src/registry-check.ts`, run by test/registry.test.ts; apart from the registry's data, which the
UI's tests import) checks ids and references, ops-v1 codes with the contract's own `Code` format (the IDL), https URLs inside
`ziyixi.science` (path `/` or a directory ending in `/`, such as the links launcher `/_/`; no query/port/userinfo),
one entry per script, status/kind consistency (no public probe of an Access host, unless the entry declares the
probe path `outside_access`: then on the entry's own host, not its URL, with a `content_type` and 2xx only, so
Access's login redirect can never pass; `.github/scripts/test_infra_config.py` checks every probe path against the
Access applications in `infra/access.tf`, only a `*-bypass` application may cover one), each `(entry, code)` once per flow, that every signal code of the
ops-v1 README table is placed (a stage, `app_only_signals`, or the platform codes `status_unavailable`
and `guard_shed`), the outbound budget (§5), and a privacy scan (no email, IP, `localhost`, credential
words or account-like IDs, except a D1/DO `match`).

**Adding a Worker:** nothing — it appears in the Cloudflare table on its first request as 未登记. To name
it: add a `WORKERS` row (and an `ENTRIES` row if it is a new tile), optionally a flow stage and its
resources, run `npm test`, merge. No UI or API type change. A deployed app cannot be forgotten:
`.github/scripts/test_wrangler_configs.py` fails until every Worker of a production `wrangler.toml` has a
`WORKERS` row and each of its D1 databases a resource whose `match` is the `database_id`, and until every
production Worker with a Custom Domain maps through its `WORKERS` row to a visible `ENTRIES` row (group
`apps` or `sites`) whose `url` is on one of that Worker's Custom Domains. The only exemption is `home`, this
dashboard (Q11); Workers without a route (`todofy-core`, `ziyixi-notion-publish`) need no tile. A hidden entry,
as the links app had until 2026-10-02, therefore fails CI.

**Adding an app's tile** (as FlowDay and the links app were on 2026-10-02): an `ENTRIES` row in `apps` with its
URL and Access lock, plus its Workers and resources. The status source is `ops_v1` when the app has an Ops
entrypoint (a service binding in `env.ts` and `wrangler.toml`, the binding type in `StatusSource`, its signal
codes placed by stages or `app_only_signals`; the watch app's W3 is that case), else a `public_http` probe of a
path its own Worker answers anonymously (`outside_access` + `content_type` when the host is behind Access, and
`error_rate` to add the Worker's error rate). Each such entry adds one outbound call per tick and one row to
every view (`VIEW_ROWS_READ`).

## 4. Evaluation (`worker/src/evaluate.ts`; page requests only read)

Pure functions of the stored documents and `now`; nothing is precomputed, so a level that depends on
time (a stale status, stopped ticks) is right at every read.

- **Entry level** (the tile, Q2 — never the worst of its flows):
  - ops_v1: never polled → unknown `never_checked`; 1 failed poll → warning `unreachable`, ≥ 2 →
    critical; no status of the last 75 min → unknown, reason `unreachable` when the last poll failed
    (e.g. an app never read successfully) else `stale`; health `down` → critical (its critical
    signal, e.g. `status_unavailable`); then the worst signal, a stage hold code of that app giving
    `held` (any severity) and other info signals nothing; `degraded` without any shown signal →
    warning `app_degraded`. Tile metric: the counter named by `tile_metric`.
  - public_http: not yet probed → unknown; last probe older than 75 min → unknown `stale`; ok; one
    failure → warning, ≥ 2 → critical, reason `http_status`/`timeout`/`network_error`, or `content_type`
    when the status was right but the media type was not the registry's `content_type` (another answerer
    than the app's Worker); `enabled: false` → unmonitored. With `error_rate`, the entry's Workers' error
    rate today (the rule of the Worker table, fresh GraphQL only; stale analytics never make the tile
    unknown) adds `error_rate`. While the error rate decides the tile, the strip lists it once, on the tile;
    when the probe failure is at least as severe (a tie keeps the probe's reason), the tile keeps the probe's
    reason and the Worker row on the Cloudflare view lists the error rate, two causes and two items as for
    any other entry. Metric: latency of the last ok probe while the tile is ok.
  - analytics: no GraphQL data → unknown `never_checked`; data older than 90 min or of another day →
    unknown `stale`; the error-rate rule over the entry's scripts → `error_rate`; the last active hour
    more than `max_idle_hours` ago → warning `idle`; never seen → unknown `never_seen` until discovery
    has watched for `max_idle_hours`, then `idle`. Metric: the last active hour.
  - self: never ticked → unknown; `tick_stale` → critical. link_only → `link`; none → `unmonitored`.
- **Stage level** = worst of: the entry's reachability (ops_v1: as above without the other stages'
  signals; other types: the entry level), the stage's claimed signals (a hold signal → `held`, and
  `held: true` when nothing worse applies), with `analytics` its scripts' error rate (fresh data only),
  and a canary failure at that stage → critical `canary_failed`. `reason` names the winning code.
  Counters are display only (the fresh status's values). Stages with entry null, link_only, none or a
  disabled probe are 未接入 and excluded.
- **Canary badges** (only the stages of `stage_map`): the latest finished run within `fresh_hours` (30):
  ok → both 已验证; skipped → both 未验证（已暂停）; failed at delivery or at the start (Mail Hero could not
  create the event) → 投递 failed + critical, 摘要 未验证; failed at the consumer → 投递 已验证, 摘要 failed;
  no run in the window → 未验证. A success never lowers a worse level.
- **Flow**: level = worst monitored stage (`unmonitored` when none); `partial` when fewer than half are
  monitored (the UI shows ○ 部分接入, never green); `first_issue` = the first monitored stage at the flow's
  (worst) level, with its reason, so a 故障 row never names a lesser stage (the card opens on it too). Freshness: the canary's last ok run and ok/finished counts of the 14 recent runs
  (mail flow); the digest's last send and receipt (a flow with the dashboard's own stage); the latest
  active hour of its analytics stages (网站发布); else none. A signal code no stage, `app_only_signals` or
  the platform places is listed once as 未归类的信号 on the first flow (display order) with that app.
- **Workers** (`discovery.ts`): the error rate is judged only with ≥ 20 requests today (≥ 5 % warning,
  ≥ 20 % critical; fewer → `error_percent: null`, 样本太少，不判定). CPU p99 > 8 ms is a UI hint only.
  Unregistered Workers never raise an item (Q12). Rows sort errors first, then requests.
- **Discovery**: the tick's GraphQL query (`workers` limit 20 → 50, nothing else changed) is parsed per
  script — requests, errors, subrequests, CPU p50/p99 (µs, null when not reported) and `doInv`
  requests/errors by scriptName (a script only in `doInv`, like `todofy-core`, is kept with 0 Worker
  requests). One `cf_scripts` document remembers every script seen in the last 30 UTC days (≤ 100,
  most recently seen kept): an idle cron Worker stays in the table with 0 today. `last_active_hour`
  moves to the hour of the answer (minus 1 ms) when the day's Worker + DO count grew since the previous
  answer — tick precision, shown as "今天 06 时", never "N 分钟前". DO requests count on the script that
  defines the class; DO storage is account-wide only (`do_storage_bytes`).
- **Resources**: D1 by `databaseId` (analytics ∪ storage), DO by `namespaceId` (`doPer` rows), R2 by
  `bucketName` (operations ∪ storage, classes as the quota rows; no bucket → `unclassified`), each
  joined with the registry by `match`; unmatched rows keep `resource: null` (shown "未登记 · <first 8
  characters>", a bucket in full, the ID as the tooltip; `unclassified` reads 未归类操作). A mapped
  namespace's `requests` are its defining script's `doInv` count.
- **Quota 主要来源**: the stored rows keep the raw GraphQL keys. When the Cloudflare view is built, each
  breakdown item keyed by a D1 `databaseId`, DO `namespaceId` or R2 `bucketName` gets `kind`, and
  `resource` when the same `match` join finds one (left out for an unregistered item) (additive fields, so snapshots stored earlier get them too;
  no extra request). The page names it from the registry, "MailCoordinator · Mail Hero", or
  "未登记 · <first 8 characters>" (a bucket: its full name) worded exactly as in the resource table
  (one helper), the key as the tooltip. An item measured without the dimension (key `unknown`,
  `BREAKDOWN_UNCLASSIFIED`) also gets `kind` without `resource` and reads 未归类 (R2: 未归类操作,
  like the table), never "unknown". Script items (Workers and DO requests) stay "script（entry）";
  model items stay raw. Only the name wraps; the value never does.

## 5. The owner API (`dashboard.ui.v1`) and budgets

Since 2026-10-02 the API is the proto service `DashboardUiService`
([`proto/dashboard/ui/v1/dashboard_ui_service.proto`](../../proto/dashboard/ui/v1/dashboard_ui_service.proto), the one
description of its routes, messages and errors), served by the shared transcoder (`proto/ts/http-transcoder.ts`) and
called by the UI through the shared client (`web/src/api/client.ts`), as Lab's owner API is (`proto/README.md`, HTTP
APIs). Resources follow the AIPs: the registry and the four views are singletons (AIP-156) read with standard Gets
(AIP-131), the refreshes and the two actions are custom methods (AIP-136) on them, on the guard singleton and on the
canary resource `canaries/mail-todofy`; OverrideGuard and RunCanary take an AIP-155 `request_id` (HomeState answers a
repeat with the first answer for 24 hours). Same Access + owner check in front of the transcoder, CSRF + Origin on every
POST (the refreshes too: they call the apps), `Cache-Control: no-store`, errors as google.rpc.Status with the reasons of
`errors.proto` and `common/errors/v1`; `GET /api/csrf` and `/health` are transport outside the service. Responses carry
only ids, codes, numbers, timestamps and registry strings. The view JSON kept its field names and its
string timestamps (it embeds ops-v1's answers as the apps wrote them); each view gained `name` (its resource name) and
lost `version`.

| Route | Served by | Budget |
| --- | --- | --- |
| `GET /api/v1/registry` (GetRegistry) | Worker, serialized once per isolate; `ETag: "<build>"` → 304 | 0 DO; ≤ 15 KiB |
| `GET /api/csrf` | Worker (signed token + `home_csrf` cookie, design.md §6) | — |
| `GET /api/v1/homeView` (GetHomeView) | DO `view('home')` | 1 DO call; ordinary fixture ≤ 40 rows read; ≤ 10 KiB |
| `GET /api/v1/flowsView` (GetFlowsView) | DO | ordinary fixture ≤ 40 rows read; ≤ 20 KiB |
| `GET /api/v1/cloudflareView` (GetCloudflareView) | DO | ordinary fixture ≤ 40 rows read; ≤ 24 KiB |
| `GET /api/v1/opsView` (GetOpsView) | DO | ordinary fixture ≤ 40 rows read; ≤ 24 KiB |
| `POST /api/v1/homeView:refresh`, `POST /api/v1/cloudflareView:refresh` (RefreshHomeView, RefreshCloudflareView; were `?refresh=1`) | DO `view(..., refresh)` | Origin + CSRF; each scope fetches at most once a minute |
| `POST /api/v1/guard:override {level, request_id}` (OverrideGuard), `POST /api/v1/canaries/mail-todofy:run {request_id}` (RunCanary) | DO (`setGuardOverride`, `startCanary`) | Origin + CSRF; ≤ 1 KiB body |
| `POST /api/v1/attentionItems/{id}:dismiss`, `:restore` | DO reminder disposition | Access + Origin + CSRF; occurrence etag + UUID request_id; ≤ 1 KiB body |
| `POST /api/v1/websiteSync:request` (RequestWebsiteSync) | DO permanent request receipt; relay dispatch or lookup | Origin + CSRF; UUID request_id; replay only looks up the same request |

The old paths (`/api/v2/*`) answer 410 with the message 个人控制台已更新，请刷新页面 in the old error envelope until
2026-11-02 (one release); then they answer NOT_FOUND like any unknown path. The code is `not_found`, not Lab's
`reload_required`: the old UI shows the envelope's message only for the error codes it knows and turns any other code
into its generic "unrecognized response (HTTP 410)" error, so only a known code lets a tab still running it ask the
owner to reload (`worker/test/http.test.ts` runs that client's error handling on every legacy answer). An
authentication failure on those paths keeps the old codes (`unauthorized`, ...; a bug is `unavailable`).

**Pre-serialized views.** HomeState builds each view as the generated wire type of its message (`worker/src/api-types.ts`
names them) and serializes it once; the Worker hands those bytes to the transcoder as a `PreEncoded` answer with the ETag
(or 304), never decoding them, so a view costs the handler no codec CPU. The proof that the bytes are what the wire
profile writes is in the tests: `worker/test/wire-conformance.ts` reads every view the unit suite builds and every answer
of the real Worker in workerd as the client does, refusing anything unrecognized, and requires the message read back to
serialize to the same bytes (fields in numbered order, nulls and omissions where the profile puts them). Since the
Worker never reads a view, HomeState cuts each list at the IDL's own bound: `worker/src/idl.ts` reads every `max_items`
the views use from the descriptors (`CANARY_RECENT_RUNS`, `CF_VIEW_WORKERS_MAX`, `DRIFT_VIEW_FINDINGS_MAX`, the top
signals, quota breakdown, flow stages and digest items), and `worker/test/idl.test.ts` holds them at the values the body
budgets were measured with and `HOME_QUOTA_IDS` (which the UI imports, so it stays a plain list) at its bound.

**Cost of the move** (measured 2026-10-02 on the reference machine of `tools/workerd-cpu`, three runs each, before on
the hand-written `/api/v2` routes and after). Bundles, gzip as `tools/bundle-size` counts them: the Worker 92.2 →
116.7 KiB (the transcoder and the descriptors its routes are read from; budget 108 → 140 KiB in
`deploy/bundle-size.mjs`), the UI's JavaScript 112.7 → 157.9 KiB (the protobuf-es runtime, the codec, the client and
the descriptors; a new budget of 192 KiB in `web/scripts/js-budget.mjs`). CPU (`worker/test/runtime/api-cpu.test.ts`,
medians of three isolates, HomeState's share included): the isolate's first API request (the ops view) 4.4-4.7 →
5.1-5.2 ms, the views' warm medians 1.0-1.3 → 1.3 ms, a 304 1.0-1.1 → 1.2 ms, a guard override warm 0.8 → 1.2 ms;
the cron tick unchanged (first 8.9, warm 2.5). The test holds the first API request below 9 ms, every other first run
below 7 and every warm median below 3, against Free's 10.

Every dynamic response shares the shell (attention, badges, refresh/tick times, `rev`) and carries
`ETag: "<rev>-<hash>"`: `rev` is bumped by each tick, refresh that fetched, guard override and manual
canary start, and the hash (FNV-1a) covers the body without `generated_at` — levels also change with
time alone, so `rev` by itself could serve a stale 304. Time-derived fields are minute-rounded, so an
unchanged state keeps its ETag. The DO returns the serialized string (or null for a matching
If-None-Match → 304) so the plain handler stays ~1–3 ms CPU. Responses
are `no-store`, so the client keeps the last body + ETag itself (its transport in `web/src/api/client.ts`).
Only the visible view polls, every 5 minutes; the registry is fetched once per load. Refresh scopes
(each at most once a minute, `meta.last_refresh_{home,cloudflare}_at`): `home` re-polls due statuses
(≥ 10 min each, the contract) and the due probe (≥ 10 min); `cloudflare` re-queries GraphQL (≥ 60 s
since the last attempt) and updates discovery. Both rebuild the digest items without sending them
(only a tick sends a report). `refresh.next_refresh_at` is the earliest time the scope would fetch again.

Regression budgets (bytes and actual cursor reads in unit/workerd tests; ordinary fixtures retain a full
14-run canary history and 20 Workers):

| View | Mockup day | Representative bad day | Ordinary rows read |
| --- | --- | --- | --- |
| home | ≤ 10 KiB | ≤ 64 KiB | 36 (≤ 40) |
| flows | ≤ 20 KiB | ≤ 64 KiB | 37 (≤ 40) |
| cloudflare | ≤ 16 KiB, also with 20 Workers | ≤ 64 KiB | 36 (≤ 40) |
| ops | ≤ 24 KiB | ≤ 64 KiB | 37 (≤ 40) |

`VIEW_BODY_BUDGET` holds for the ordinary fixtures. Complete reminders now include `name` and `etag`;
they cannot be cut to the outbound report's 20 entries before applying dismissals. A synthetic case with
six valid sources, 16 short warnings and one metric per source has 101 attention items: Home/Flows/Cloudflare/Ops
measured 34,347/42,803/32,054/44,517 bytes and 110–111 reads. The 64 KiB bad-day regression budget leaves
room for the defined stress fixtures; it is not a proof of every legal IDL value or every combined maximum.
`VIEW_ROWS_READ_MAX` (320) separately guards larger retained-decision stress cases. These thresholds are
test/logging budgets, not platform billing limits. The Cloudflare view
lists at most `CF_VIEW_WORKERS_MAX` (50) of the up to `CF_SCRIPTS_MAX` (100) remembered scripts —
every script active today first, then the most recently seen — and counts the rest in
`workers_omitted` (shown as a note); the remembered-script scenario is tested separately. HomeState logs
`over_budget` per response. The design's row estimates (1 + N, ≤ 20, 3–4, ≤ 10) did not count the shell
every view shares (six documents for the attention strip and badges, plus what the evaluation reads for
the strip's observed items, §4), the canary rows or the reminder ledger. The measured counts replace those
older estimates; reads grow with retained decisions while views continue to poll every five minutes.
A partial index (`canary_runs_active`) keeps the "run in progress" lookup at one row for ticks and views.

Per tick: 6 `status()` (Mail Hero, Todofy, Lab, the watch app, Fleet and Newsletter) + 3 probes (website, FlowDay, links) + 1 GraphQL +
≤ 4 `setGuard` + ≤ 2 canary calls + ≤ 1 `reportOps` + ≤ 12 read-only drift calls (§10) = 29 outbound calls
(`outboundPerTick`, tested ≤ 30 and asserted per tick in workerd; Free allows 50). The probes run in parallel with the
status polls. GraphQL stays one query per tick (48/day) plus refreshes ≤ 1/min. DO rows written grow by ~4 per tick
(`cf_scripts` and one `probe:<entry>` per probe). The FlowDay and links probes are each one request of that app's Worker per tick (≤ 144 a day with refreshes, no D1 query); the website's is a static asset. Everything else as in
[`limits.md`](limits.md).

**v1 removal (done 2026-09-29):** the hand-written v1 API (`/api/v1/overview`, `OverviewResponse`, `AppCard`) was
removed when the UI moved to v2; the prefix `/api/v1/` now belongs to `dashboard.ui.v1`. The workerd flow tests read
the ops and cloudflare views (`snapshot()` in `test/runtime/flows.ts`). `Dashboard deploy` probes `/` and
`/api/v1/homeView` for the Access redirect. The vars `MAIL_HERO_URL`/`TODOFY_URL` are dropped: the registry is the only
URL source.

## 6. DO storage changes (step 2)

`state` docs `cf_scripts` (≤ 100 records, under 40 KB; the row cap is 64 KiB), `probe:<entry>`
(`checked_at`, `ok`, `http_status`, `latency_ms`, `error`, `consecutive_failures`; a probe document of
an entry no longer probed is deleted by the tick), `usage.resources` (per-resource rows), and `meta.rev`,
`meta.last_refresh_home_at`, `meta.last_refresh_cloudflare_at`. `canary_runs` gains the partial index
`canary_runs_active`. Stores created before 2026-10-05 also have an unused `canary_runs.canary_id`
column (v2 added it; nothing reads it, and new stores no longer create it). `guard_applied` has no CHECK
on `app` since 2026-10-05 (a store with the old CHECK is rebuilt once, rows kept), so a new ops-v1 app
needs no table change. Everything is additive: a rollback to the previous build ignores the new
documents and restores its own CHECK.

## 7. UI

Look "暖纸墨蓝": paper `#F3F1EC`, cards `#FCFBF8`, ink `#1D2126`, secondary text `#5A5F66`, lines
`#DCD7CC`, one accent ink-blue `#2B5C8A`; status colours only inside shape + word marks (ok
`#2E8A57`/text `#1E6B43`, warn `#B07512`/text `#7A4B00`, danger, info blue-grey, neutral). No
gradients, no side-stripe cards, no emoji; inline lucide-style stroke SVGs (lock = `role="img"`
`aria-label="受 Access 保护"`); system CJK font stack; tabular numerals. Light and dark tokens, text
≥ 4.5:1, non-text ≥ 3:1. Mobile first (390 px: 3-column tiles, 应用 and 站点 merged into one grid,
后台服务 as ≥ 44 px rows, Worker table as two-line cards). Tiles: the icon+name area is a real
`<a target="_blank" rel="noreferrer noopener">` named "打开 <name>（新标签页）"; the status line is a
separate button ("<name> 状态：<level>，查看详情") opening a detail sheet; skeletons of the same size
while loading; one failing source greys only its own tile. Times in the browser time zone.

## 8. Decisions taken (owner-approved defaults)

Q1 title 个人控制台 · Q2 tile = entry's own health · Q3 home keeps one line per flow and 4 mini bars ·
Q4 home grouped by kind, flows by business · Q5 Flowday link-only (思源笔记 was too until the owner retired it on 2026-09-30; the owner removed Flowday's entry from the dashboard the same day, so the registry has no link-only entry now and the kind stays supported; on 2026-10-02 the owner asked for the new services on 首页, and FlowDay, now a Workers app, came back as a probed tile next to the links app; `test/registry.test.ts` no longer records a FlowDay exclusion, so the pointer to it in `links/docs/design.md` §11 (L2, the registry step) is stale until the next links change rewords that step to the rule of §3: a `WORKERS` row plus a visible entry, enforced by `test_wrangler_configs.py`; it is not edited here because any change under `links/` redeploys the links app) · Q6 probe the website every tick
· Q7 Newsletter 未接入 for now · Q8 24 h sparkline later (step 3, not in scope) · Q9 registry in repo TS
· Q10 four tabs · Q11 no tile for this dashboard · Q12 unregistered Workers never alarm · Q13
notion-publish idle limit 26 h.

## 9. Still to verify in production (read-only)

Whether `durableObjectsInvocationsAdaptiveGroups.scriptName` is the defining or the calling script;
whether `cpuTimeP99` includes DO time; the website, FlowDay and links probes from a same-zone Worker; notion-publish's
real schedule; the TODO resource identifiers of §3. The full list of pending production checks is in
[`verification.md`](verification.md) §2.

## 10. Configuration drift (配置漂移)

A private check, inside this Worker and never on GitHub, that the live Cloudflare account still matches
what the repository commits. Nothing about it is published: the result lives in `HomeState`, is shown
only on the Access-protected Cloudflare view, and reaches Todoist only as counts in the ops digest.

**Desired state.** [`.github/scripts/drift_desired.py`](../../.github/scripts/drift_desired.py) writes
`worker/src/drift-desired.json` from every production `wrangler.toml` (Worker names, Custom Domains,
zone routes, cron schedules, binding names with their API types, `workers_dev` / `preview_urls`), from
each app's deploy-vars wrapper (the vars it adds with `--var` as `plain_text`, the secrets it writes with
`--secrets-file` as `secret_text`, and which of them are personal values; the wrapper is imported, never
run, with placeholder inputs) and from its `MANUAL_SECRETS` list (the secrets set by hand, names only).
The JSON holds names, types and flags only: no id, address, value or secret. The generator lives under
`.github/scripts` because it reads every app's folder (root AGENTS.md); the dashboard bundles only its
own copy. `test_drift_desired.py` (run by the `Changes` job on every CI run) fails until the committed
JSON equals a fresh generation, so a config or wrapper change regenerates it in the same commit, which
also redeploys the dashboard with the new desired state.

**Live state.** Once per UTC day, starting with the first tick at or after `DRIFT_UTC_HOUR` (02:00 UTC),
`HomeState` reads with `CF_ANALYTICS_TOKEN` (GETs only, fixed paths under
`https://api.cloudflare.com/client/v4`):

| Step | Calls |
| --- | --- |
| account | `GET /accounts/{a}/workers/scripts`, `GET /accounts/{a}/workers/domains` (in parallel), then `GET /zones/{z}/workers/routes` for each zone of the desired state, its id taken from a Custom Domain in that zone (never stored) |
| each desired Worker that exists | `GET .../workers/scripts/{s}/schedules`, `.../settings`, `.../subdomain` (in parallel) |

At most `DRIFT_CALLS_PER_TICK` (12) calls per tick: the account step and three Workers on the first tick,
four Workers on the next, then the rest, so a check of the 10 Workers takes three ticks, 3 + 4 + 3 (a tick then
makes at most 27 outbound calls in all, §5). A failed step is retried by the next tick; after `DRIFT_MAX_ATTEMPTS` (3)
failed attempts the day is given up (`consecutive_failed_days` + 1), and a run left unfinished at the end
of its UTC day counts as a failed day too, as does a `drift_run` document that would pass
`DRIFT_RUN_MAX_BYTES` (60,000 bytes, under the 64 KiB row limit; this account's is about 6 KB). Every answer is reduced at once to names, types and flags:
a binding keeps only `name` and `type`, so a `plain_text` value (and every id) never leaves the parser;
remote text never leaves `drift.ts` (failures become `http_<n>`, `timeout`, `network_error`,
`invalid_response`, `api_error`). Logs carry the outcome code and counts only.

**Comparison** (pure, `compareDrift`), by category:

| Category | Finding |
| --- | --- |
| `scripts` | a desired Worker missing live, or a live Worker no config names |
| `custom_domains` | per Worker, a hostname missing or extra (a live domain of an unknown Worker is extra) |
| `routes` | per Worker, a zone route pattern missing or extra (no production config has a zone route today) |
| `crons` | per Worker, a schedule missing or extra |
| `bindings` | per Worker, a binding or secret name missing (unless optional) or extra, or of another type |
| `workers_dev` | `workers_dev` or `preview_urls` other than the config's |
| `personal` | a personal value (wrapper kind `personal`/`optional`) whose live binding is not `secret_text` |

A personal value is reported whatever way its wrapper sends it today; a known difference is a finding
until the live account or the committed state changes, never a special case. A personal value a wrapper
writes with `--secrets-file` (the owner addresses of Mail Hero, Todofy, the dashboard and Lab, Mail Hero's
receive address and Todofy's Todoist projects; since 2026-10 every personal value) is wanted as a
`secret_text` binding, so a live `plain_text` one is a `bindings` change and no Worker lists a `personal`
value.

**Storage and views.** `state` documents `drift_run` (today's run across ticks: the live names and
types read so far; deleted when the run ends) and `drift` (the last completed check: counts per
category, at most `DRIFT_FINDINGS_MAX` (50) findings, and the latest error code, step and failed-day
count). The Cloudflare view (GetCloudflareView) carries `drift` (`Drift`: status `ok` / `drift` / `never_checked` /
`not_configured` / `failing`, counts, at most `DRIFT_VIEW_FINDINGS_MAX` (20) findings) and the page shows
it as the 配置漂移 panel. The digest adds `config_drift` (warning; metrics `total` and the non-zero
category counts) while the last completed check has findings, and `drift_unavailable` (warning) after
`DRIFT_UNAVAILABLE_AFTER_DAYS` (2) failed days in a row; both point at the Cloudflare view.

**Token.** The same `CF_ANALYTICS_TOKEN` as the GraphQL query ([`setup.md`](setup.md) §4). A read-only
replacement needs Account Analytics Read, Workers Scripts Read and, on the zone, Workers Routes Read;
without them the check reports `http_403` and, after two days, `drift_unavailable`.

## 11. 可关闭的提醒

每条待处理提醒都有“关闭本次提醒”；Newsletter 显示“不再提醒这批 N 条记录”。关闭后从顶部待处理列表、
页签数字和后续运维摘要中移除，首页与流程卡片改为中性的“本批提醒已关闭”。“已忽略”折叠列表仍可查看和恢复。
刷新、重新登录和 Worker 重启不会丢失已保存的关闭状态。写入成功后页面先应用服务端返回的结果，再重新读取；
重新读取失败会提示数据更新失败，不会把已经关闭的提醒重新显示为待处理。

关闭提醒不改变来源服务的健康、计数或业务账本，也不代表异常已修复。Newsletter 的 32 是多类未确认完成记录
的合计，可能重叠，不是 32 封失败邮件；关闭不会重跑邮件、Notion 操作或工作流。Fleet 继续提供原始状态，
通过自身公开 `HOME_URL` 链接到 Home 管理提醒，不获得 VPS 写入或额外凭据。

Home 使用已有 SQLite DO 的 `attention_occurrences` 保存当前条件与关闭决定。`name` 由 source、code 和
稳定 target 定位条件；`etag` 标识本次条件及管理状态，数量/严重性等有效变化、确认恢复后再次出现，或关闭/恢复
操作都会换版本。旧页面的操作返回 `ATTENTION_CHANGED`（409），要求重新查看当前提醒。同 UUID 在有限回执窗口
内重复同一操作返回原答案；换正文或动作拒绝。窗口外的旧 etag 不能覆盖后来的恢复状态。

有效数量变化包括 Newsletter `unknown_count`、Mail Hero 解析/投递/策略错误的 `count`、Lab 未确认发送的
`count`、Watch 未确认通知的 `open`/`failed` 和失效监视的 `count`；新的金丝雀失败使用运行身份。年龄、心跳、
用量百分比的持续增加或抖动不会把同一问题当作新的提醒。其他条件按严重性及确认恢复后的再次出现区分。
来源失联、状态过期或 Fleet 底层 `host_stale` 不构成恢复；drift 恢复依据自身观测，与用量 GraphQL 是否成功独立。

管理动作只写 Home，并记录需要同步摘要；不即时发送外部消息。下一次正常 scheduled tick 应用关闭决定后再裁剪
到报告的 20 项，避免已关闭的前 20 项挤掉后面的未处理项。UI 先保留完整的原始解释，再过滤关闭项，避免
“已关闭业务信号”被重新生成为另一条 observed 警告。

最多保留 256 条控制记录。容量紧张时先退休当前原始列表中缺席且未关闭的旧记录；尚未确认恢复的关闭决定保留。
全部槽位仍被占用时，新异常的事实继续显示，`control_unavailable_count` 明确提示部分提醒暂不能管理，不令整个
Home 返回 500。处理异常或精简监控范围释放条件后可再次尝试；容量回收不把来源服务描述为已经恢复。
