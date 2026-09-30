# GTD features: a morning brief that remembers, and a GTD ledger with a Sunday review

Status: implemented on branch `gtd-features` (2026-09-30), tested locally, not deployed (see
[verification.md](verification.md) "GTD ledger" and §14 below for what differs from this design). Two
features share one daily, read-only Todoist snapshot taken inside `TodofyCore`:

1. **Morning brief remembers** — the recommendation report also sees mail tasks from the last 14 days
   that are still open in Todoist, and system reminders can go to their own Todoist project.
2. **GTD ledger + Sunday review** — daily metadata-only snapshots and aggregates of open tasks, one
   review task per ISO week, ops-v1 counters, a dashboard "GTD" flow and a trends view.

Rules that hold throughout (they restate `dev-notes.md` and `contracts/ops-v1` for this feature):

- **No task text is stored or logged.** Titles and descriptions are read into memory by the list
  calls (the API returns them) and dropped at once. D1, DO storage, logs, ops-v1, the owner API and
  the review task only ever hold IDs, project IDs, label names, priorities, dates, counts and a keyed
  content hash. Tests use synthetic tasks only.
- **Todoist is read-only except for** the one review task per ISO week (and the existing mail tasks and
  daily reminder). Every Todoist call runs in the DO alarm path, never in a 10 ms Worker handler.
- **Workers Free, no new cron trigger, no new app, no new Todoist token.** A few Todoist GETs a day,
  small D1 writes (one snapshot and two aggregate rows a day, not a mirror every 15 minutes).
- **Any Todoist failure falls back exactly to today's behaviour.** Without a usable snapshot the
  recommendation input, prompt and payload are byte-for-byte today's 24 h report, plus the two new
  counts at 0.

## 1. Todoist API v1 facts this design relies on

Checked on 2026-09-30 against the OpenAPI document embedded in https://developer.todoist.com/api/v1/
(spec version 3.1.0).

| Fact | Consequence here |
| --- | --- |
| `GET /api/v1/tasks` lists **active** tasks; filters `project_id`, `section_id`, `parent_id`, `label`, `ids` (comma-separated); cursor pagination, `limit` default 50, **max 200**; envelope `{results, next_cursor}` (`null` on the last page). | The snapshot lists all projects at `limit=200`; `parse_task_page` already reads this envelope. |
| Task fields: `id`, `project_id`, `section_id`, `parent_id`, `labels` (names), `priority` (1 normal … 4 urgent), `due` (`date`, optional `datetime`, `is_recurring`, `string`, `timezone`) or null, `deadline` or null, `added_at`, `checked`, `is_deleted`, `completed_at`, `updated_at`, `postponed_count`, `content`, `description`. | Snapshot keeps a whitelist; `content`/`description` only feed the keyed hash. |
| `GET /api/v1/tasks/completed/by_completion_date?since&until` (since inclusive, until exclusive, RFC 3339), optional `project_id`, `filter_query`, `cursor`, `limit` (default 50); range **at most 3 months**; envelope **`{items, next_cursor}`**, `next_cursor` **omitted** on the last page. | `completed_7d` comes from the API with a 7-day window, not from guesses. A second page parser is needed (`items`, not `results`). |
| `GET /api/v1/tasks/completed/stats` returns 7 days of per-project completion counts (no task text). | Not used: its day boundaries follow the user's Todoist time zone and it cannot be windowed; kept as a fallback idea only. |
| Request limits: 1 MiB POST body, 65 KiB headers, standard request processing timeout **15 s**. Rate limits are documented per user as **1000 partial sync requests / 15 min** and 100 full syncs / 15 min; no separate REST-endpoint number is published. | Todofy already caps itself at 1000 calls / 15 min (`TODOIST_WINDOW_LIMIT`); GTD reads count against that window. Our use is < 20 calls a day. |
| Creating projects is not needed. | The owner creates the Ops and Review projects by hand and stores their IDs as GitHub secrets. |

Completions: the API endpoint is the source. As a cross-check (and the fallback when that call fails),
`closed_1d` counts tasks that were in yesterday's snapshot and are missing from today's; that number is
completions **plus deletions** (and a recurring task that was completed never disappears), so it is
reported as "closed", never as "completed". When the completed call fails, `completed_7d` is stored as
NULL with `completed_source = 'none'`; it is never estimated from disappearance.

## 2. Data flow

```
13:00 UTC  gtd.collect (DO alarm, read-only)
           ├─ phase snapshot:  GET /api/v1/tasks?limit=200 (all projects), ≤ 5 pages per alarm, ≤ 10 pages total
           │                   → D1 gtd_snapshot_tasks (day, whitelisted metadata, HMAC of content)
           ├─ phase completed: GET /api/v1/tasks/completed/by_completion_date since=now-7d until=now, ≤ 5 pages
           │                   → counts only (+ review-task completion)
           └─ phase aggregate: compute in Python → D1 gtd_daily (scope all, scope inbox), gtd_snapshots.status;
                               DO gtd_state (latest counters for ops-v1 status)
13:30 UTC  reports.tick (existing) — recommendation input = 24 h window ∪ carryover
           carryover = summaries of the last 14 days (before the 24 h window) whose task_id is in today's
           ok snapshot, newest first, ≤ 30 rows, each tagged "[N 天前]"
Sun 17:00  gtd.review — one Todoist task per ISO week (counts, trends, links) into the Review project
~16–17 PT  reminder.tick (existing) — the [Todofy System] task now goes to the Ops project when set
```

Why carryover uses the snapshot instead of its own Todoist call: one paginated read a day serves both
features, it covers tasks the owner moved to another project (a project-filtered list would call them
"closed"), and the report path (on demand, 40 s budget) gains no Todoist latency.

## 3. Feature ①: morning brief remembers

**Input.** `reports.compute` for `recommendation` (the `summary` report is unchanged):

- `new` = today's query (`REPORT_WINDOW`, `(now-24h, now]`, ≤ 1000 rows), unchanged.
- `carry` = only when a usable snapshot exists: the newest `gtd_snapshots` row with `status = 'ok'`
  and `finished_at >= now - 26 h` (covers the 13:30 precompute, the newsletter's on-demand call and an
  owner recompute on the same day). Query `CARRYOVER` (new, in `core/sql/reports.py`):
  `SELECT summary, created_at FROM summaries WHERE created_at > ?(now-14d) AND created_at <= ?(now-24h)
  AND task_id <> '' AND EXISTS (SELECT 1 FROM gtd_snapshot_tasks g WHERE g.day = ? AND g.task_id =
  summaries.task_id) ORDER BY created_at DESC LIMIT 30` — walks `summaries_created` (≤ ~1400 rows at
  100 mails/day) plus one primary-key probe each.
- Each carried row is rendered `"[{N} 天前] {summary}"` with `N = (now - created_at) // DAY` (≥ 1), and the
  carried block follows the new rows (oldest carried last) inside the same `report_input` fences.
- `partial`, `failed`, missing or stale snapshot, `REPORT_CARRYOVER_DAYS = 0`, or any exception in the
  carryover read → `carry = []`, and the prompt, input and `task_count` are exactly today's.

**Prompt.** `prompts.recommend_prompt(top_n, carryover=False)` returns today's bytes; with
`carryover=True` the "last 24 hours" sentence becomes "the last 24 hours, plus older tasks that are still
open" and one rule is added: items prefixed `[N 天前]` arrived N days ago and are still open in Todoist;
age alone is neither urgency nor a reason to skip; never claim they are overdue unless the summary states
a date. `tests/unit/test_prompts.py` pins both variants.

**recommendation-v1 (additive).** Two optional properties in `api/recommendation-v1.schema.json`:
`new_count` and `carryover_count` (integers, 0 … 1 000 000). `task_count = new_count + carryover_count`
(documented; JSON Schema cannot express the sum). `empty_window` now means both are 0; a day with no new
mail but open carried tasks is `ok`. `window_start`/`window_end` keep describing the 24 h window. The
properties stay out of `required`, so stored payloads from before the change still validate and the
owner API's `ReportsLatest` keeps working. The newsletter (separate repository) ignores unknown fields
per the schema's contract; confirm `_decode_recommendation` there before the deploy (see §11), and its
optional "今天 N 件需要你（M 件来自前几天）" line is a later newsletter change.

**Ops project.** `reminder._request` uses `TODOIST_OPS_PROJECT_ID` when set, else
`TODOIST_DEFAULT_PROJECT_ID` (today). The project is frozen with the claim (new column
`mail_reminders.project_id`), so a retry after a config change sends the same bytes and `X-Request-Id`.

## 4. Feature ③: GTD ledger

**Snapshot row (whitelist).** `task_id`, `project_id`, `parent_id`, `labels` (JSON array of names, ≤ 2 KiB),
`priority`, `due_date` (`YYYY-MM-DD`), `due_at` (Unix seconds when `due.datetime` carries a zone, else
NULL), `due_recurring`, `deadline_date`, `added_at` (Unix seconds), `checked`, `content_hmac`. Malformed
tasks (no string `id`, unparsable dates) are skipped and counted in `gtd_snapshots.skipped`.

`content_hmac = HMAC-SHA256(key, content + "\0" + description)`, hex. The spec asked for a plain
SHA-256 of the content; a plain hash of a short title ("Pay rent") is reversible by dictionary, so the key
is 32 random bytes generated once in the DO's own SQLite (`gtd_state.hmac_key`). It never leaves the
object (not in D1, backups, logs or ops). Losing it only makes every task look edited once.

**Aggregates** (`core/gtd.py`, pure, host-tested), per scope `all` and `inbox`
(`project_id = TODOIST_DEFAULT_PROJECT_ID`; the inbox row is skipped when that var is unset):

| Column | Definition |
| --- | --- |
| `open` | active tasks in the scope (sub-tasks included) |
| `age_0_7`, `age_8_14`, `age_15_30`, `age_31_plus` | by `floor((now - added_at) / day)`; unknown `added_at` counts in none (so buckets may sum below `open`) |
| `oldest_days` | max age, 0 when empty |
| `overdue` | `due_at < now`, or date-only `due_date <` the UTC date of the snapshot (13:00 UTC is the same calendar day in all Americas time zones; no time-zone setting is needed) |
| `undated` | `due` is null (a deadline alone does not date a task) |
| `created_7d` | open tasks with `added_at` in the last 7 days + completed items (7-day window) with such `added_at` |
| `completed_7d` | items of the 7-day completed window in the scope; NULL when that call failed |
| `closed_1d` | ids in yesterday's ok snapshot missing from today's (completions + deletions); NULL without both |
| `mail_open` | (scope `all` only) summaries of the last 14 days whose task is in the snapshot: the ops counter `carryover_open` |

`completed_source` is `api` or `none`. A snapshot that hit the 10-page cap (> 2000 active tasks) is
`partial`: its aggregates are stored with `complete = 0`, ops counters are left out, and carryover falls
back.

## 5. Migration `0004_gtd.sql` (additive)

The previous release never reads or writes these tables or the new column, so the migration can run
before the deploy and survive a code rollback.

```sql
ALTER TABLE mail_reminders ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
CREATE TABLE gtd_snapshots (            -- one per UTC day; a rerun the same day replaces it
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('collecting', 'ok', 'partial', 'failed')),
  task_count INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE gtd_snapshot_tasks (       -- raw metadata, kept 14 days
  day TEXT NOT NULL, task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 64),
  project_id TEXT NOT NULL, parent_id TEXT, labels TEXT NOT NULL DEFAULT '[]' CHECK (length(labels) <= 2048),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4), due_date TEXT, due_at INTEGER,
  due_recurring INTEGER NOT NULL DEFAULT 0, deadline_date TEXT, added_at INTEGER,
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  content_hmac TEXT NOT NULL CHECK (length(content_hmac) = 64 AND content_hmac NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (day, task_id));
CREATE TABLE gtd_daily (                -- aggregates, kept 120 days
  day TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('all', 'inbox')),
  open INTEGER NOT NULL, age_0_7 INTEGER NOT NULL, age_8_14 INTEGER NOT NULL, age_15_30 INTEGER NOT NULL,
  age_31_plus INTEGER NOT NULL, oldest_days INTEGER NOT NULL, overdue INTEGER NOT NULL, undated INTEGER NOT NULL,
  created_7d INTEGER, completed_7d INTEGER, completed_source TEXT NOT NULL CHECK (completed_source IN ('api', 'none')),
  closed_1d INTEGER, mail_open INTEGER, complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  computed_at INTEGER NOT NULL, PRIMARY KEY (day, scope));
CREATE TABLE gtd_reviews (              -- one per ISO week, claimed before Todoist is called
  week TEXT PRIMARY KEY CHECK (week GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]'),
  state TEXT NOT NULL CHECK (state IN ('sending', 'created', 'unknown', 'failed')),
  project_id TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '', completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX gtd_reviews_sending ON gtd_reviews (week) WHERE state = 'sending';
```

All four tables are rowid tables and join `core/sql/backup.py` `TABLES` (`test_backup.py` requires every
table there). Snapshot rows are written one statement per page with `INSERT … SELECT … FROM json_each(?)`
(≤ 200 rows, ≈ 50 KB bound value), like `metrics.WRITE_DAY`. Every new statement is a `Query` naming its
index for `test_schema_sql.py`. Retention adds three bounded deletes to `retention.tick`:
`gtd_snapshot_tasks` older than 14 days (batch 1000, ≈ 300 rows expire a day), `gtd_daily` and
`gtd_snapshots` older than 120 days; `gtd_reviews` is kept 400 days (≈ 57 rows).

## 6. Alarm schedule and budgets

A new DO table `gtd_state` (id = 1; `next_collect`, `collect_phase`, `collect_cursor`, `collect_day`,
`collect_attempts`, `next_review`, latest counters, `last_review_at`, `hmac_key`) keeps the schedule, like
`metric_flush`; it is lossable (everything defaults to "due now" and D1 stays the record). The coordinator
runs `_gtd_tick()` after `_ticks()` and adds its next time to `_next_alarm_ms`.

| Job | When | Gate | Per alarm | Per day |
| --- | --- | --- | --- | --- |
| collect | `GTD_COLLECT_UTC` (default `13:00`, `off` in test configs); a failed attempt retries in 10 min, ≤ 3 attempts a UTC day | skipped while `PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST`, a Todoist auth block or a full call window (`_todoist_wait`); `MAINTENANCE_MODE` stops the whole alarm; deferrable under an ops `shed` guard as job `gtd_snapshot` (bound 48 h) | ≤ 5 Todoist GETs and ≤ 8 D1 statements, continuing 1 s later | 2–4 GETs typical, ≤ 15 max; ≈ 300 rows written + 300 deleted |
| review | Sunday 17:00 UTC (09:00 PST / 10:00 PDT); failed create retried hourly, ≤ 5 attempts, only until the ISO week ends | `GTD_REVIEW_ENABLED` and the same Todoist gates; never deferred by `shed` (owner-facing, like the reminder) | 1 POST, ≤ 6 D1 statements | 1 POST a week |

The report precompute (13:30) runs after the collect window, so the brief uses a same-day snapshot
when collection succeeded. A 401/403 on a GTD read sets `todoist_blocked_until` (6 h) exactly as the
footer lookup does (`classify_lookup`); 429 honours `Retry-After` inside the 10-minute retry. Each call
counts in `_count_todoist_calls` and writes a `Step.GTD` Analytics Engine point (step, outcome, code,
latency only). D1 stays far under the Free 50-queries-per-invocation limit.

## 7. Sunday review task

- Key: ISO week of the Sunday (`2026-W40`). Claimed in `gtd_reviews` before the POST; title and body are
  frozen; `X-Request-Id = todoist_request_id(subject, body, "todofy-review:" + week)`. `unknown` is never
  resent; `sending` found by the next alarm becomes `unknown` (the reminder's rule). Exactly one task per
  week.
- Project: `TODOIST_REVIEW_PROJECT_ID`, else `TODOIST_DEFAULT_PROJECT_ID`; frozen in the row.
- Title: `每周回顾 2026-W40`. Body: counts, trends and links only — never a task title:

  ```
  快照 2026-10-04 13:00 UTC（Todoist 元数据，只含计数）
  收件箱：开放 23（上周 31，-8）；最老 41 天；0–7 天 12 · 8–14 天 5 · 15–30 天 4 · >30 天 2
  全部项目：开放 57 · 逾期 3 · 无日期 40
  近 7 天：新建 35 · 完成 42
  邮件任务：14 天内仍开着 9
  Todofy：需处理事件 0；运维（仪表盘报告 2026-10-03 23:40 UTC）：mail-hero parse_failed count=1
  上次回顾：2026-09-27 完成（7 天前）
  步骤：清空收件箱 → 看逾期与无日期 → 看项目与等待 → 想想下周
  面板：https://home.ziyixi.science/   Todofy GTD：https://todofy.ziyixi.science/gtd
  ```

  "上周" compares with the `gtd_daily` row 7 days earlier (omitted when absent). Mail Hero has no
  `needs_review` counter in ops-v1 today; the review lists the Mail Hero items of the stored dashboard
  report (`parse_failed`, `delivery_failed`, `pending_stale`, …, with their numeric metrics), which is the
  existing data Todofy may read. A Mail Hero `needs_review` counter plus a dashboard digest item is a
  separate, additive ops-v1 change (§11). The dashboard link comes from the stored report's
  `dashboard_url`; without one the line is left out.
- Completion: the daily completed window lists the review task's id → `gtd_reviews.completed_at`, mirrored
  to `gtd_state.last_review_at`. A deleted review task never counts as a review.

## 8. ops-v1 status

The limits are 32 counters per status and 12 metrics per signal (`OPS_LIMITS`); "12 keys" applies to a
signal's metrics. Todofy reports 11 counters today, so the new ones are added without replacing any:

| Counter | Source |
| --- | --- |
| `inbox_open` | latest complete aggregate, scope `inbox` |
| `inbox_oldest_days` | same |
| `overdue` | scope `all` |
| `carryover_open` | `mail_open` (open mail tasks of the last 14 days) |
| `completed_7d` | scope `all`, when `completed_source = 'api'` |
| `review_age_days` | days since `last_review_at` (or since the first review task when none was completed) |

Signals: `gtd_snapshot_stale` (warning; collection is allowed by the switches and the last ok snapshot is
older than 48 h, or none 48 h after the first attempt; metric `age_hours`) and `review_overdue` (**info**;
`GTD_REVIEW_ENABLED` and `review_age_days > 10`; metric `days`). `review_overdue` is info on purpose: a
skipped personal review should not turn the Todofy tile `degraded` or enter the ops digest; the Sunday
task is the nudge. Values come from `gtd_state` in the object's storage, so `status()` keeps its budget of
five D1 statements. Counters are left out while unknown (lost storage, partial snapshot, inbox unset).
Update `contracts/ops-v1/README.md` (Todofy signal row — the dashboard test derives `knownSignals` from
it), `IMPLEMENTATION.md` §3 (counters, `GuardState.deferred` gains `gtd_snapshot`) and an `OpsStatus`
fixture carrying the new counters.

## 9. Dashboard

- `dashboard/worker/src/registry.ts`, new flow (group `mail`, order 2), all names within the validator's
  limits:

  | Stage | Name | Entry | Signals | Counters | Note |
  | --- | --- | --- | --- | --- | --- |
  | `capture` | 收集 | todofy | – | `received_24h` | |
  | `clarify` | 理清 | todofy | – | `inbox_open`, `inbox_oldest_days` | 标题仍是邮件主题；理清靠人工 |
  | `organize` | 组织 | todofy | – | `overdue`, `carryover_open` | 在 Todoist 中手动整理 |
  | `reflect` | 回顾 | todofy | `review_overdue`, `gtd_snapshot_stale` | `review_age_days`, `completed_7d` | |
  | `engage` | 执行 | flowday | – | – | FlowDay 只读 Todoist，面板只给链接 |

  `registry.test.ts`: `flowsOfScript('todofy')` gains `gtd`; the known-signal check passes once the
  README row lists the two signals. `web/src/lib/labels.ts` gets labels (`收件箱开放`, `最老天数`, `逾期`,
  `多日未完成`, `近 7 天完成`, `距上次回顾`, kind `count`/`days`).
- Trends: the dashboard keeps no counter history, so a trends view there would need new `HomeState`
  storage. The cheap place is Todofy's owner UI, which already draws 30-day charts (`TrendChart`):
  `GET /api/v1/gtd/daily?days=1..120` (OpenAPI, both scopes, oldest first, plus the latest review week and
  state; numbers only) and a `/gtd` page with inbox open, overdue, created vs completed. The dashboard
  flow links to it.

## 10. Configuration

| Name | Where | Default / unset | Purpose |
| --- | --- | --- | --- |
| `TODOIST_OPS_PROJECT_ID` | GitHub secret `TODOFY_TODOIST_OPS_PROJECT_ID` → `deploy_vars.py` | unset = default project (today) | `[Todofy System]` reminder project |
| `TODOIST_REVIEW_PROJECT_ID` | GitHub secret `TODOFY_TODOIST_REVIEW_PROJECT_ID` | unset = default project | Sunday review project |
| `GTD_REVIEW_ENABLED` | GitHub variable `TODOFY_GTD_REVIEW_ENABLED` (toggle, required like the others) | – | stops the weekly task without a code change |
| `GTD_COLLECT_UTC` | `wrangler.toml` `[vars]` | `13:00`; `off` in `wrangler.test.toml` | snapshot time |
| `REPORT_CARRYOVER_DAYS` | `wrangler.toml` `[vars]` | `14`; `0` turns carryover off | rollback knob by commit |

`deploy_vars.py` gains an `optional` kind: the pattern allows empty, and an empty value adds no `--var`
(so the Worker sees it unset). Update the `deploy-vars-inputs core:` lines,
`.github/scripts/test_wrangler_configs.py`, both deploy steps in `ci.yml` (the dry-run step sets one
optional value empty and one to a placeholder) and `docs/ci-cd.md`. Carryover itself has no toggle: its
fallback is automatic and `REPORT_CARRYOVER_DAYS=0` is the committed kill switch.

## 11. Fallbacks and failure modes

| Failure | Behaviour |
| --- | --- |
| Todoist list fails, times out, returns malformed pages, or > 10 pages | snapshot `failed`/`partial`; recommendation = today's 24 h report; counters left out; retried ≤ 3 times that day |
| Completed call fails | `completed_7d` NULL, `completed_source = 'none'`, review says "完成：不可用"; review completion is picked up the next day |
| Auth 401/403 | the shared 6 h Todoist block (also pauses mail tasks, as today); `todoist_blocked` signal |
| DO storage lost | new HMAC key (hashes change once), schedule due now, counters absent until the next collect |
| Review POST unknown | never resent that week (at most one task) |
| Newsletter rejects unknown fields | verify before deploy in the newsletter repo; if strict, ship its decoder change first |

## 12. Test plan (synthetic data only)

**Unit (host pytest, `tests/unit/`)**: `core/gtd.py` aggregates — age boundaries 7/8, 14/15, 30/31, unknown
`added_at`, overdue for date-only vs zoned datetime vs floating time, recurring, undated vs deadline-only,
inbox scope, `created_7d` merge, completed window edges; snapshot row whitelist (the output never contains
sentinel titles/descriptions); HMAC stability; both page parsers (`results`/`items`, `null` vs omitted
cursor); ISO week keys across 2026-W53 → 2027-W01 and the Sunday 17:00 schedule; review body golden text
(counts only, byte limit); carryover rendering (`[N 天前]`, order, cap 30, disjoint from the 24 h window);
both prompt variants pinned; recommendation-v1 old and new payloads validate; ops status with the new
counters/signals validates against the schema and stays ≤ 32 counters; `review_overdue` at 10/11 days;
`deploy_vars` optional kind; `test_schema_sql` (every new `Query` uses its index), `test_backup` (TABLES).

**Runtime (workerd with real D1/DO, `tests/runtime/`, fake Todoist extended with
`/api/v1/tasks/completed/by_completion_date` and fault injection)**:
collect across alarms (5-page slices, cursor continuation, 10-page cap → partial); precompute with an ok
snapshot (the Gemini fake records the input: carried rows tagged, closed tasks excluded, ≤ 30, counts in
the payload) and with failed/partial/stale/no snapshot (input byte-identical to today, counts 0); empty
24 h window with open carried tasks → `ok`; on-demand newsletter path; reminder into the Ops project and a
retry after the var changed keeps the frozen project; review exactly once per ISO week across repeated
alarms, crash between claim and POST, `unknown` not resent, `failed` retried ≤ 5, project fallback,
`GTD_REVIEW_ENABLED=false`, completion detection and `review_overdue`; switches and auth block → no GTD
GETs; `shed` defers collection within its 48 h bound; retention of snapshot rows and aggregates; migration
0004 on a populated 0003 database with the previous release's SQL still working. **Privacy sweep**: seed
tasks whose titles and descriptions are sentinels, then assert no sentinel appears in any D1 table, DO
table, captured log line, ops status, owner API response, review body or backup part. New runtime files
must be placed by the shard plan (`pytest_shards.py`), or "Todofy checks" fails the completeness check.

**Dashboard / contracts**: `registry.test.ts` (flow valid, known signals placed), labels, ops-v1
fixtures and `validate.mjs`/`jsonschema` verdicts.

## 13. Delivery order

1. Shared: migration 0004, `core/gtd.py`, snapshot collection, `gtd_state`, retention, backup tables.
2. Feature ①: carryover in reports, prompt variant, recommendation-v1 fields, Ops project + frozen column,
   optional deploy vars. Shippable alone (reviews off).
3. Feature ③: aggregates, completed window, review task, ops counters/signals, owner API + `/gtd` page,
   dashboard flow and labels, contract docs.

Owner actions (outside the code): create Todoist projects "Ops" and "Review" and store their IDs as the
GitHub environment secrets above (optional); set `TODOFY_GTD_REVIEW_ENABLED` (`false` for the first deploy,
`true` when ready); check the newsletter decoder tolerates unknown fields.

## 14. As built (2026-09-30)

What the code does where it differs from, or adds to, the sections above:

- **Object state** is one JSON document in the DO table `gtd_state` (`runtime/gtd.State`: schedule,
  collection cursor and tally, ops facts, `last_review_at`, `first_review_at`, HMAC key), like
  `backup_state`, so later fields need no DO schema change.
- **Collection** runs as one loop per alarm: task pages, then completed pages, then the aggregate, at most
  5 Todoist GETs per invocation, continuing 1 s later. A page write is one `WRITE_PAGE` statement; the
  aggregate reads the day back once (≤ 2,000 rows) together with yesterday's snapshot row, `CLOSED_SINCE`,
  `MAIL_OPEN` and the recent reviews in one batch, then writes both `gtd_daily` rows, the snapshot's final
  row and any review completions in one batch. A new attempt on the same day clears that day's rows first.
  A collection still unfinished when the UTC day changes is recorded `failed` / `interrupted`. A pause
  (`PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST`) or a Todoist block mid-way resumes later from the stored
  cursor. `GTD_PAGE_TIMEOUT_MS` (default 20 s) exists for the tests only.
- **Review completion**: the completed list is matched against created reviews of the last 3 ISO weeks
  (`OPEN_REVIEWS`), and `last_review_at` / `first_review_at` are refreshed from `gtd_reviews` at every
  collection and review, so a lost object storage heals within a day.
- **Review schedule**: outside Sunday 17:00 UTC – Monday 00:00 UTC nothing runs; inside it, a disabled or
  paused review is looked at again every 10 minutes (switching it on during the window still makes that
  week's task). `review_age_days` is reported only while `GTD_REVIEW_ENABLED`.
- **Carryover**: `REPORT_CARRYOVER_DAYS` is capped at 14 (snapshot rows are kept 14 days). The owner UI's
  日报 page shows "（其中 M 条是前几天仍未完成的任务）" next to the summary count.
- **Owner API and UI**: `GET /api/v1/gtd/daily?days=1..120` (OpenAPI `GtdDaily`, days up to today, oldest
  first, plus the latest review) and the page 更多 → GTD (latest snapshot facts, the latest review, three
  30-day charts).
- **Dashboard**: the GTD stages name `workers: ['todofy-core']`, so `flowsOfScript('todofy-core')` gains
  `gtd` (the gateway `todofy` is unchanged). A stage `note` is shown only while the stage is unmonitored,
  so only 执行's note reaches the page.
- **Tests** (synthetic tasks, sentinel titles): `tests/unit/test_gtd.py`, `test_gtd_sql.py` (including the
  previous release's reminder SQL on a migrated database), prompt goldens, schema and ops-core cases;
  runtime `test_gtd_ledger.py` (the probe's Durable Object `GtdProbe` runs `runtime/gtd.py` at any time),
  `test_reports_carryover.py`, `test_gtd_alarm.py` (the shipped stack, ops-v1 status validated against
  the schema); a failed D1 read inside the carryover is injected by the probe (`fail_sql`). Not covered: a
  backup part in the privacy sweep (backups copy the D1 tables the sweep checks).
