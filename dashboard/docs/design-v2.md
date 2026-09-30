# Dashboard v2: launcher, flows, Cloudflare monitoring

What v2 changes relative to [`design.md`](design.md) (which stays authoritative for storage, the tick,
guard, canary, digest, Access/CSRF and the usage query). It condenses the owner-approved redesign
proposal of 2026-09-29 (steps 1 and 2; every open question takes its recommended default, §8). Status:
the registry, the v2 types and every `/api/v2` route are implemented in the Worker (evaluation in
`worker/src/evaluate.ts`, discovery in `discovery.ts`, the probe in `probe.ts`, view assembly and ETags
in `views-v2.ts`, storage in `state.ts`), with unit tests and workerd tests for each endpoint.

## 1. Views

Four hash-routed views; hash routing needs no Worker change behind Access. Page title 个人控制台
(was 运维面板), no subtitle.

| View | Route | Content | Endpoint |
| --- | --- | --- | --- |
| 首页 | `#/` | attention strip; launcher tiles grouped 应用 / 站点 / 后台服务 (registry order, never reordered by status); one line per flow; four mini quota bars + "N 个 Worker · 今日错误 N · 降载状态" | `/api/v2/home` |
| 业务流程 | `#/flows`, `#/flows/<flow>` | flow cards by business group (邮件与任务 / 内容与发布 / 平台), stage chains; the mail flow owns the canary (14-day strip, today's timeline, scope note verbatim) | `/api/v2/flows` |
| Cloudflare 监控 | `#/cloudflare`, `#/cloudflare/worker/<script>` | the 13 quota rows (daily / monthly / storage), the auto-discovered Worker table, D1 / DO / R2 resources, read-only guard | `/api/v2/cloudflare` |
| 操作与记录 | `#/ops` | guard and canary actions (confirmation texts and CSRF flow unchanged), digest, full ops-v1 details per app (the old `AppCard` body), build, time zone, registry list | `/api/v2/ops` |

v1 anchors map to routes (`web/src/router.ts`): `#apps` → `#/`, `#quota` → `#/cloudflare`, `#canary` →
`#/flows/mail-to-task`, `#actions`/`#digest`/`#app-*` → `#/ops`. Phones get a fixed bottom tab bar
(64 px incl. safe area, content padded ~88 px), desktop a tab row under the title; the selected tab
has colour + weight + underline and `aria-current="page"`. Tab badges count warning + critical items
whose target is that view; held and info items never count.

The attention strip is on every view: one quiet line "● 全部正常 · 下次巡检 HH:MM" when fine, else
"▲ N 项需关注" with at most 3 items (worst first) and "还有 N 项"; each item links to its target.
Held switches show as a small ‖ 已暂停 tag (`attention.held`), outside the level and the badges: every
stage `hold_signals` code of an app's current status (force-paused or owner-paused delivery, forwarding
off, paused processing, paused Todoist, reminder off) and an owner's forced shed (`home:owner_shed`,
which then replaces the `dashboard:guard_shed` item); an automatic shed stays an item, and
`maintenance_mode` stays critical. The item set is otherwise v1's (digest items, `tick_stale`, usage and
canary items, `canary_disabled` info); v2 only adds a `target`, so the digest sent to Todofy does not
change. Probe and Worker-analytics problems therefore show on tiles, stages and the Worker table only.

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

## 3. Registry (`worker/src/registry.ts`, types in `worker/src/api-v2-types.ts`)

Three lists joined by id, compiled into the Worker; the UI gets the public view from
`GET /api/v2/registry` (no binding names or probe URLs), so no hostname enters the bundle and
`no-external.test.ts` / `check-dist.mjs` stay as they are.

- **Entries** (tiles): id, name, description, group, icon (closed `ICON_KEYS`, bundled lucide), accent,
  URL, Access lock, status source, tile metric, app-only signals, order.
- **Workers**: script → one entry. **Resources**: D1 / DO / R2 → entry; `match` is the GraphQL
  identifier. IDs kept in GitHub variables are `match: null` TODO placeholders (with a `todo` note):
  they match nothing, so the account's rows stay 未登记 + first 8 characters of the raw ID. Known today:
  R2 `mail-hero-store` (the default name) and `todofy-backups`. TODO: both D1 IDs, the three DO
  namespace IDs, the Mail Hero backup bucket name.
- **Flows**: ordered stages; a stage names an entry (or null = outside the dashboard, with a note),
  optionally the entry's workers it runs on, the entry's signals it claims (hold signals among them),
  display counters and `analytics`. Worker ↔ flow is many-to-many through stages.

| Entry | Group | Status source | Tile |
| --- | --- | --- | --- |
| Mail Hero | 应用 | `ops_v1` (MAIL_HERO, guard) | 今日收件 |
| Todofy (`todofy`, `todofy-core`) | 应用 | `ops_v1` (TODOFY, guard) | 24 小时收到 |
| Flowday, 思源笔记 | 应用 | `link_only` (never probed) | host |
| 个人网站 | 站点 | `public_http`: one GET per tick to `www…/build-info.json` (the apex 308s to www), status + latency only, `redirect: 'manual'`, body unread, `enabled` flag | latency |
| Notion 发布 (`ziyixi-notion-publish`) | 后台服务 | `analytics`: error rate + 26 h idle rule | last request hour |
| Newsletter | 后台服务 | `none` → 未接入 | — |
| 个人控制台 (`home`) | hidden | `self` (`tick_stale`) | no tile; Cloudflare row only |

Flows: 邮件 → 任务 (来源转发 ○ → 收件与保存 → 解析 → Webhook 投递 → Todofy 摘要 → Todoist 与提醒; canary
`mail-todofy` verifies 投递 and 摘要 only), 网站发布 (Notion ○ → 发布 → 网站可用), 每日 Newsletter
(Todofy 报告 → 读取报告 ○ → 写入 Notion ○; partial), 运维摘要 (巡检 → 提交摘要 → 每日提醒).

`validateRegistry` (test/registry.test.ts) checks ids and references, https URLs inside
`ziyixi.science` (path `/`, no query/port/userinfo), one entry per script, status/kind consistency
(no public probe of an Access host), each `(entry, code)` once per flow, that every signal code of the
ops-v1 README table is placed (a stage, `app_only_signals`, or the platform codes `status_unavailable`
and `guard_shed`), the outbound budget (§5), and a privacy scan (no email, IP, `localhost`, credential
words or account-like IDs).

**Adding a Worker:** nothing — it appears in the Cloudflare table on its first request as 未登记. To name
it: add a `WORKERS` row (and an `ENTRIES` row if it is a new tile), optionally a flow stage and its
resources, run `npm test`, merge. No UI or API type change.

## 4. Evaluation (`worker/src/evaluate.ts`; page requests only read)

Pure functions of the stored documents and `now`; nothing is precomputed, so a level that depends on
time (a stale status, stopped ticks) is right at every read.

- **Entry level** (the tile, Q2 — never the worst of its flows):
  - ops_v1: never polled → unknown `never_checked`; 1 failed poll → warning `unreachable`, ≥ 2 →
    critical; a status older than 75 min → unknown `stale`; health `down` → critical (its critical
    signal, e.g. `status_unavailable`); then the worst signal, a stage hold code of that app giving
    `held` (any severity) and other info signals nothing; `degraded` without any shown signal →
    warning `app_degraded`. Tile metric: the counter named by `tile_metric`.
  - public_http: not yet probed → unknown; last probe older than 75 min → unknown `stale`; ok; one
    failure → warning, ≥ 2 → critical, reason `http_status`/`timeout`/`network_error`; `enabled: false`
    → unmonitored. Metric: latency of the last ok probe.
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
  monitored (the UI shows ○ 部分接入, never green); `first_issue` = the first monitored stage that is not
  ok, with its reason. Freshness: the canary's last ok run and ok/finished counts of the 14 recent runs
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
  joined with the registry by `match`; unmatched rows keep `resource: null` (未登记 + raw ID). A mapped
  namespace's `requests` are its defining script's `doInv` count.

## 5. API v2 and budgets

All under `/api/v2/`, same Access + owner check, error envelope, CSRF + Origin on mutations,
`Cache-Control: no-store`. Responses carry only ids, codes, numbers, timestamps and registry strings.

| Route | Served by | Budget |
| --- | --- | --- |
| `GET registry` | Worker, serialized once per isolate; `ETag: "<build>"` → 304 | 0 DO; ≤ 12 KiB |
| `GET csrf` | Worker (as v1) | — |
| `GET home[?refresh=1]` | DO `v2View('home')` | 1 DO call; ≤ 1 + N rows; ≤ 10 KiB |
| `GET flows` | DO | ≤ 20 rows; ≤ 16 KiB |
| `GET cloudflare[?refresh=1]` | DO | 3–4 rows; ≤ 16 KiB |
| `GET ops` | DO | ≤ 10 rows; ≤ 24 KiB |
| `POST guard {level}`, `POST canary {canary_id}` | DO (v1 methods) | as v1 |

Every dynamic response shares the shell (attention, badges, refresh/tick times, `rev`) and carries
`ETag: "<rev>-<hash>"`: `rev` is bumped by each tick, refresh that fetched, guard override and manual
canary start, and the hash (FNV-1a) covers the body without `generated_at` — levels also change with
time alone, so `rev` by itself could serve a stale 304. Time-derived fields are minute-rounded, so an
unchanged state keeps its ETag. The DO returns the serialized string (or null for a matching
If-None-Match → 304) so the plain handler stays ~1–3 ms CPU. Responses
are `no-store`, so the client keeps the last body + ETag itself (`apiV2` in `web/src/api/client.ts`).
Only the visible view polls, every 5 minutes; the registry is fetched once per load. Refresh scopes
(each at most once a minute, `meta.last_refresh_{home,cloudflare}_at`): `home` re-polls due statuses
(≥ 10 min each, the contract) and the due probe (≥ 10 min); `cloudflare` re-queries GraphQL (≥ 60 s
since the last attempt) and updates discovery. Both rebuild the digest items without sending them, as
a v1 refresh does. `refresh.next_refresh_at` is the earliest time the scope would fetch again.

Measured (unit suite for bytes, workerd suite for rows; a full 14-run canary history, 20 Workers):

| View | Mockup day | Bad day (20 items, 16 signals/app, 14 failed runs) | Rows read |
| --- | --- | --- | --- |
| home | ≤ 10 KiB (budget) | 8.3 KB | 22 (≤ 24) |
| flows | 12.7 KB | 20.1 KB | 22 (≤ 24) |
| cloudflare | ≤ 16 KiB, also with 20 Workers | 17.1 KB | 7 (≤ 10) |
| ops | ≤ 24 KiB | 24.1 KB | 20 (≤ 24) |

`V2_BODY_BUDGET` holds for a normal day; `V2_BODY_MAX` (32 KiB) bounds the bad day; HomeState logs
`over_budget` per response. The design's row estimates (1 + N, ≤ 20, 3–4, ≤ 10) did not count the shell
every view shares (six documents for the attention strip and badges) or the 14 canary rows, so the
measured counts replace them; they are ~0.01 % of the DO's 5 M free rows a day at a few hundred views.
A partial index (`canary_runs_active`) keeps the "run in progress" lookup at one row for ticks and views.

Per tick: 2 `status()` + 1 probe + 1 GraphQL + ≤ 2 `setGuard` + ≤ 2 canary calls + ≤ 1 `reportOps` = 9
outbound calls (`outboundPerTick`, tested ≤ 30 and asserted per tick in workerd; Free allows 50). The
probe runs in parallel with the status polls. GraphQL stays one query per tick (48/day) plus refreshes
≤ 1/min. DO rows written grow by ~2 per tick (`cf_scripts`, `probe:website`). Everything else as in
[`limits.md`](limits.md).

**v1 removal:** once the UI calls only v2, delete `/api/v1/*` (routes, `overview()`/`buildOverview`,
`OverviewResponse`, v1 tests and fixtures) in the same change, and change the one path in
`.github/workflows/ci.yml` (`Dashboard deploy` probes `/api/v1/overview` for the Access redirect) to
`/api/v2/home`. `MAIL_HERO_URL`/`TODOFY_URL` remain until v1 goes (v1 `AppCard.url`), then the registry
is the only URL source; the generator and `wrangler.toml` are otherwise unchanged.

## 6. DO storage changes (step 2)

`state` docs `cf_scripts` (≤ 100 records, under 40 KB; the row cap is 64 KiB), `probe:<entry>`
(`checked_at`, `ok`, `http_status`, `latency_ms`, `error`, `consecutive_failures`; a probe document of
an entry no longer probed is deleted by the tick), `usage.resources` (per-resource rows), and `meta.rev`,
`meta.last_refresh_home_at`, `meta.last_refresh_cloudflare_at`. `canary_runs` gains `canary_id TEXT NOT
NULL DEFAULT 'mail-todofy'` (one `ALTER TABLE` when `pragma_table_info` lacks it; existing rows are
mail-todofy) and the partial index `canary_runs_active`. No other table changes; `guard_applied` keeps
its CHECK while the ops-v1 apps are the two. Everything is additive: the v1 overview reads the same
tables, and a rollback to the previous build ignores the new documents and column.

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
Q4 home grouped by kind, flows by business · Q5 Flowday/思源 link-only · Q6 probe the website every tick
· Q7 Newsletter 未接入 for now · Q8 24 h sparkline later (step 3, not in scope) · Q9 registry in repo TS
· Q10 four tabs · Q11 no tile for this dashboard · Q12 unregistered Workers never alarm · Q13
notion-publish idle limit 26 h.

## 9. Still to verify in production (read-only)

Whether `durableObjectsInvocationsAdaptiveGroups.scriptName` is the defining or the calling script;
whether `cpuTimeP99` includes DO time; the website probe from a same-zone Worker; notion-publish's
real schedule; the TODO resource identifiers of §3.
