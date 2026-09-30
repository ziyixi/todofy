# Dashboard v2: launcher, flows, Cloudflare monitoring

What v2 changes relative to [`design.md`](design.md) (which stays authoritative for storage, the tick,
guard, canary, digest, Access/CSRF and the usage query). It condenses the owner-approved redesign
proposal of 2026-09-29 (steps 1 and 2; every open question takes its recommended default, §8). Status:
the registry, the v2 types, `GET /api/v2/registry`, `GET /api/v2/csrf`, `POST /api/v2/{guard,canary}`
and the client/router scaffolding are implemented; the four dynamic views are scaffolds
(`HomeState.v2View` answers 503) until the builders fill them in.

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
Held switches (maintenance-like modes, force-paused delivery, owner shed) show as a small ‖ 已暂停 tag.
The item set is v1's (digest items, `tick_stale`, usage and canary items, `canary_disabled` info);
v2 only adds a `target`, so the digest sent to Todofy does not change.

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

## 4. Evaluation (in the DO tick; page requests only read)

- Entry level: ops_v1 → last status health (`down` or 2 consecutive failures → critical, 1 failure →
  warning, never read → unknown); public_http → code ∈ expect ok, 1 failure warning, ≥ 2 critical;
  analytics → error-rate rule, idle > `max_idle_hours` → warning; self → `tick_stale` critical;
  link_only → `link`; none or a disabled probe → `unmonitored`. The tile shows the entry's own health,
  not the worst of its flows (Q2).
- Stage level = worst of the entry's reachability, the claimed signals (a hold signal gives `held`)
  and, with `analytics`, its workers' error rate. A canary failure marks its stage critical; a success
  only adds the 已验证 badge (never lowers a worse level); held/skipped runs → 未验证（已暂停）; no run
  within `fresh_hours` → 未验证. Stages with entry null (or link/none entries) are 未接入 and excluded.
- Flow level = worst monitored stage; fewer than half monitored → `partial` (○ 部分接入, never green).
  Unclaimed codes of a flow's entries are listed as 未归类的信号, never dropped.
- Worker error rate is judged only with ≥ 20 requests today: ≥ 5 % warning, ≥ 20 % critical; fewer →
  "样本太少，不判定". CPU p99 > 8 ms shows "接近 Free 10 ms" (hint, never an alarm). Unregistered Workers
  never alarm by themselves (Q12).
- Discovery: the tick's existing GraphQL query (`limit` 20 → 50) now keeps per-script errors,
  subrequests, CPU p50/p99 and DO requests/errors; one `cf_scripts` state doc remembers scripts seen in
  the last 30 days (≤ 100), because an idle cron Worker disappears from the day's data. "最近有请求" is
  hour precision (a tick sees the count grow), never "N 分钟前". DO requests count on the script that
  defines the class. DO storage is account-wide only.

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
`ETag: "<rev>"`; `rev` is bumped by each tick/refresh write, and the DO returns the pre-serialized
string (or null for a matching If-None-Match → 304) so the plain handler stays ~1–3 ms CPU. Responses
are `no-store`, so the client keeps the last body + ETag itself (`apiV2` in `web/src/api/client.ts`).
Only the visible view polls, every 5 minutes; the registry is fetched once per load. Refresh scopes:
`home` re-polls due statuses (≥ 10 min each, the contract) and probes (≥ 10 min); `cloudflare`
re-queries GraphQL (≥ 60 s).

Per tick: 2 `status()` + 1 probe + 1 GraphQL + ≤ 2 `setGuard` + ≤ 2 canary calls + ≤ 1 `reportOps` = 9
outbound calls (`outboundPerTick`, tested ≤ 30; Free allows 50). GraphQL stays one query per tick
(48/day) plus refreshes ≤ 1/min. DO rows written grow by ~2 per tick (`cf_scripts`, `probe:website`).
Everything else as in [`limits.md`](limits.md).

**v1 removal:** once the UI calls only v2, delete `/api/v1/*` (routes, `overview()`/`buildOverview`,
`OverviewResponse`, v1 tests and fixtures) in the same change, and change the one path in
`.github/workflows/ci.yml` (`Dashboard deploy` probes `/api/v1/overview` for the Access redirect) to
`/api/v2/home`. `MAIL_HERO_URL`/`TODOFY_URL` remain until v1 goes (v1 `AppCard.url`), then the registry
is the only URL source; the generator and `wrangler.toml` are otherwise unchanged.

## 6. DO storage changes (step 2)

`state` docs `cf_scripts` (≤ 12 KiB), `probe:<entry>` (`checked_at`, `ok`, `http_status`,
`latency_ms`, `consecutive_failures`), `meta.rev`; `canary_runs` gains `canary_id TEXT NOT NULL
DEFAULT 'mail-todofy'` (one `ALTER TABLE`, guarded by `PRAGMA user_version`). No other table changes;
`guard_applied` keeps its CHECK while the ops-v1 apps are the two.

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
