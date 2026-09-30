# Lab / Paper Radar: design

The Worker `lab` on `lab.ziyixi.science` (Cloudflare Access app "Lab") ranks each day's arXiv
cs.IR + cs.CL + cs.LG announcements against the owner's own saves, writes a one-line Chinese TL;DR for
the top 10, and offers keyboard triage. It runs on Workers Free, is fully deferrable under the
dashboard's guard, and reports to the dashboard through `contracts/ops-v1`. Owner-approved scope:
the brainstorm "MLE" note §1 and REPORT §3 ⑤ (2026-09-30); the newsletter seed contract, HF Daily
Papers, v2 learned ranking and citation follow-up are **not** in this version.

Status: design + scaffold. Nothing is implemented or deployed. Facts below were checked on
2026-09-30 against the linked public docs and one request to the public feed.

## 1. Workers AI quota: the answer first

The whole account gets **10,000 neurons per UTC day** (Free and Paid; reset 00:00 UTC). On Free, a
call past that "will fail with an error"; nothing is billed. Nothing else on the account uses
Workers AI today (Todofy uses Gemini), so Lab would be the only consumer.
[pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

| Model (verified id) | Neurons per M tokens | Use |
| --- | --- | --- |
| `@cf/baai/bge-m3` | 1,075 input (embeddings) | title + abstract, multilingual, 60k context |
| `@cf/ibm-granite/granite-4.0-h-micro` | 1,542 in / 10,158 out | TL;DR (cheapest text model on the page) |
| `@cf/meta/llama-3.2-1b-instruct` | 2,457 / 18,252 | alternative |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 4,625 / 30,475 | alternative if granite's Chinese is poor |

Measured feed (2026-09-30, `rss.arxiv.org/rss/cs.IR+cs.CL+cs.LG`): 1.99 MB, 932 items = 456 `new`,
176 `cross`, 218 `replace`, 82 `replace-cross`; the combined feed already lists a cross-listed paper
once (932 unique IDs). Description (abstract) ≈ 1,490 characters on average, ≤ 1,978.

| Daily work | Tokens | Neurons |
| --- | --- | --- |
| Embed `new` + `cross` (≈632 × ≈370 tokens) | ≈234k | **≈250** |
| TL;DR, 10 calls × (≈600 in, ≤120 out) on granite | 6k in + 1.2k out | **≈22** |
| Seeds, one-off (20 × 370) | 7.4k | ≈8 |
| **Typical day** | | **≈270 (2.7 % of the account)** |
| Worst case: all 932 items at the 2,000-char cap, estimate at 3 chars/token | ≈650k | ≈720 (7.2 %) |

So yes, the quota is ample: a normal day uses under 3 % of the account budget. `LAB_DAILY_NEURONS`
is a **ceiling**, not a forecast: the approved value is 5,000 (half the account). A ceiling of
1,500 would already be 2× the worst case and leave 85 % to other jobs; the owner may lower it in
`wrangler.toml` (or in the UI, which can only go lower, §6). Workers AI has no alerting of its own,
which is why Lab keeps its own ledger and the dashboard shows `neurons_today`.

Rate limits (not a concern at this volume): embeddings 3,000 req/min, text generation 300 req/min
([limits](https://developers.cloudflare.com/workers-ai/platform/limits/)).

## 2. Layout

| Path | Contents |
| --- | --- |
| `lab/wrangler.toml` | the production config (top level = production; run wrangler from `worker/` with `--config ../wrangler.toml`) |
| `lab/worker/` | TypeScript Worker + SQLite DO `LabState` + `Ops` entrypoint; same toolchain and pins as `dashboard/worker` |
| `lab/worker/src/api-types.ts` | owner API types shared with the UI (the UI imports it by relative path) |
| `lab/worker/test/`, `test/runtime/` | Node unit tests (fake bindings); workerd suite (Miniflare, fake AI + fake arXiv) |
| `lab/migrations/` | D1 migrations (`migrations_dir`) |
| `lab/web/` | React 19 + Vite 7 UI (Chinese), same toolchain as `dashboard/web`, builds `web/dist` |
| `lab/deploy/` | `deploy-vars.mjs` (BUILD_SHA + owner secrets), `test/*.test.mjs` |
| `lab/docs/` | this file; later `setup.md`, `verification.md` |

Toolchain = dashboard's (Node 26, TypeScript 5.9.3, vitest 4.1.11, eslint 10.11.0, typescript-eslint
8.71.0, workers-types 5.20260929.1, wrangler 4.142.0, miniflare 5.20260926.0-alpha, esbuild 0.28.1,
React 19.3.0, Vite 7.3.6, react-query 5.104.0, lucide-react 1.48.0). `@ziyixi/edge-auth` is
`file:../../packages/edge-auth`.

## 3. Configuration (`lab/wrangler.toml`)

- `name = "lab"`, committed `account_id`, `workers_dev = false`, `preview_urls = false`, route
  `lab.ziyixi.science` as a Custom Domain.
- Bindings: `DB` (D1 `lab`), `LAB` (DO `LabState`, migration `v1` `new_sqlite_classes`), `AI`
  (`[ai]`), `ASSETS` (`web/dist`, `run_worker_first = true`, SPA fallback). No cron trigger (3/5
  used): the DO schedules itself with `setAlarm()`.
- Committed vars: `PUBLIC_HOST`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `LAB_DAILY_NEURONS=5000`,
  `LAB_FETCH_UTC_HOUR=6`. Model ids are **not** vars: `worker/src/models.ts` holds the allow-list with
  each model's neuron rates and doc URL (embeddings `@cf/baai/bge-m3`; TL;DR default
  `@cf/ibm-granite/granite-4.0-h-micro`, alternatives `@cf/meta/llama-3.2-1b-instruct`,
  `@cf/qwen/qwen3-30b-a3b-fp8`), and the settings page picks the TL;DR model from that list. (This also
  keeps `@` out of the committed config, which `test_wrangler_configs.py` refuses for wrapped apps.)
- **Placeholders the lead replaces** before the first deploy: D1 `database_id`
  `00000000-0000-0000-0000-000000000000` and `ACCESS_AUDIENCE` = 64 zeros. `deploy/deploy-vars.mjs`
  must refuse to deploy while either is all zeros.
- Injected at deploy by `deploy/deploy-vars.mjs` (like the dashboard): `--var BUILD_SHA`; Worker
  secrets `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES`, `CSRF_SIGNING_KEY` from GitHub environment secrets
  `LAB_ACCESS_OWNER`, `LAB_ACCESS_OWNER_ALIASES`, `LAB_CSRF_SIGNING_KEY`. No GitHub variable toggles.
- Local dev: `lab/.dev.vars` (gitignored) with `DEV_AUTH_BYPASS=true`, loopback only; `npm run dev`
  pins `--local-upstream 127.0.0.1:8788`. D1 only `--local`.

## 4. Pipeline (all in `LabState`, alarm-driven)

One object `lab-v1`. Every step is idempotent, keyed by the feed's announce date, with a cursor in
DO SQLite; each alarm invocation does a bounded slice and re-arms the alarm (2 s) while work
remains, else at the next fetch time (daily `LAB_FETCH_UTC_HOUR`:30 UTC). Bootstrap: the first
request to the Worker (or the deploy probe) calls `LAB.ensureAlarm()`; the alarm handler always
re-arms before returning, and a failed step re-arms with backoff (5 min, 30 min, next day).

1. **Fetch** (`feed_fetch`): one `GET https://rss.arxiv.org/rss/<cats joined by +>` per UTC day,
   every day (weekends/holidays return the unchanged feed: harmless, deduped), with
   `If-None-Match`/`If-Modified-Since` from the last response, `User-Agent: ziyixi-lab/1.0
   (+https://github.com/ziyixi/todofy)`, `redirect: 'manual'`, 20 s timeout, body read as a stream
   and aborted past **5 MB**. The feed updates at midnight US Eastern (channel `pubDate` e.g.
   `Wed, 30 Sep 2026 00:00:00 -0400`, `skipDays` Sat/Sun), i.e. 04:00–05:00 UTC, hence 06:30 UTC.
   The host is fixed; no URL from content is ever fetched. Categories come from settings, validated
   `^[a-z-]+\.[A-Za-z-]+$`, ≤ 6.
   [arXiv RSS](https://info.arxiv.org/help/rss.html), [API terms](https://info.arxiv.org/help/api/tou.html)
   (≤ 1 request / 3 s, one connection).
2. **Parse + dedupe**: bounded string scan of `<item>` (no DOM in Workers), ≤ 2,000 items. Per item:
   `id = arxiv:<id>` from `arXiv:<id>v<n>` in the description (version stripped), title, `dc:creator`
   (trimmed to 1,000 chars), `category` list, `arxiv:announce_type`, abstract after `Abstract:`,
   `dc:rights`. Keep `new` and `cross`; drop `replace`/`replace-cross` unless the ID is saved (then set
   `new_version` on the saved row). A repeated ID keeps the first. Items are written to D1 in
   `INSERT … SELECT … FROM json_each(?)` chunks (≤ 100 items, ≤ 500 KB per statement: D1 Free allows
   50 queries per invocation and 100 bound parameters per query).
   [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
3. **Embed** (`embed`): `AI.run('@cf/baai/bge-m3', {text: [...≤50], truncate_inputs: true})`, text =
   `title + "\n\n" + abstract` cut to 2,000 characters; ≤ 8 calls per invocation. Vectors are
   L2-normalised and stored as Float32 BLOBs (1024 × 4 B) in DO SQLite.
4. **Rank** (`rank`): positives = seed + saved vectors; if ≤ 16, each is a centroid, else spherical
   k-means with k = 16 (deterministic init, ≤ 10 iterations; cached until labels change). Negative
   centroid = mean of skipped vectors (latest 500). `score = max_i cos(x, c_i) − λ·cos(x, n)`,
   λ = 0.3 (setting, 0–1), no negative term without skips. Candidates: the day's items with no label.
   Top 20 → D1 `picks`. Cold start (no positive vectors): no picks, UI asks for seeds.
5. **TL;DR** (`tldr`): top 10 picks without a TL;DR, one call each, `max_tokens` 120, temperature
   0.2; prompt asks for one Chinese sentence ≤ 60 characters from title + abstract. Output is untrusted
   text: first line only, control characters stripped, ≤ 200 chars, shown as plain text.
6. **Seed resolve** (`seed_resolve`): seed IDs not yet in D1 are fetched with **one**
   `GET https://export.arxiv.org/api/query?id_list=<≤20 ids>&max_results=20` per invocation (Atom),
   ≥ 3 s after any other arXiv request, then embedded like step 3.
7. **Retention** (`retention`, once a day, bounded batches): vectors older than 30 days deleted
   unless saved/seed; D1 papers older than 90 days deleted unless saved, seed or in `picks`; `picks`
   kept 365 days; skips kept 180 days. D1 then stays ≈ 150 MB of 500 MB; DO vectors ≈ 60 MB (Free
   allows 1 GB per object; hard stop at 60,000 vector rows).

Order per day: fetch → parse → embed → rank → tldr; seed resolve and retention run when the day's
run is idle. Each invocation stays far under 30 s CPU (ranking 632 × 17 × 1024 multiply-adds).

## 5. Neuron ledger (hard cap, fail-safe)

- DO table `neurons(day TEXT PRIMARY KEY, used REAL, reserved REAL, cap_hit_at INTEGER)`.
- Before every AI call, reserve an **upper-bound estimate**: embeddings `ceil(utf8_bytes/3)` tokens
  × rate; text `ceil(prompt_bytes/3) × in_rate + max_tokens × out_rate`. If `used + estimate >
  min(LAB_DAILY_NEURONS, settings.cap)`, skip, record `cap_hit_at`, stop AI work until 00:00 UTC.
- After the call: text models return `usage.prompt_tokens/completion_tokens` → charge the exact value;
  bge-m3 returns no usage field (`{shape, data, pooling}` in workers-types) → charge the estimate.
- A Workers AI error that means the account allowance is exhausted also stops AI work for the day
  (signal `neuron_cap_hit`, metric `account_exhausted=1`); other AI errors back off.
- The rate table lives in `worker/src/models.ts` (`MODEL_RATES`), with the doc URL; a setting naming
  an unknown model id is refused, so every call has a known cost.

## 6. Data

**D1 `lab`** (records; the UI reads it directly): `papers(id PK 'arxiv:…', version, title, authors,
categories JSON, primary_category, announce_type, announced_on, abstract, license, new_version,
first_seen_at)`, `picks(day, rank, paper_id, score, tldr, tldr_model, PK(day, rank))`,
`feedback(paper_id PK, label 'save'|'skip', at)`, `seeds(paper_id PK, added_at, state
'pending'|'resolved'|'not_found')`, `settings(key PK, value)` (categories, λ, cap ≤
`LAB_DAILY_NEURONS`, TL;DR model, `ingest_paused`).

**DO SQLite** (coordinator): `jobs` (per-day cursor/phase), `vectors(paper_id PK, day, dim, vec BLOB,
kept)`, `labels(paper_id PK, label, at)` (mirror used for centroids and counters), `centroids`
cache, `neurons`, `guard`, `fetch_meta` (etag, last_modified, last_ok_at, last_error_code), `counters`.
The DO is the only writer to D1; owner mutations are DO RPCs.

Privacy: saves, skips, seeds and settings are personal. They live only in D1/DO behind Access,
never in git, logs, fixtures or ops-v1 output (counts only). Logs carry request IDs, job codes,
counts and error codes. arXiv metadata is public (license per item in `dc:rights`); PDFs are
linked, never fetched or stored.

## 7. Owner API and UI

Every `/api/*` route needs the Access owner (edge-auth); mutations also need Origin + CSRF
(`X-CSRF-Token`, cookie `lab_csrf`). Error envelope `{error: {code, message, request_id}}`. Types
in `worker/src/api-types.ts`:

| Route | Purpose |
| --- | --- |
| `GET /api/csrf` | `{token}` |
| `GET /api/today?day=` | the day's top 20 with TL;DR, authors, categories, arXiv + PDF links, label; run state |
| `GET /api/saved?cursor=` | saved papers, newest first, 50 per page |
| `POST /api/feedback {paper_id, label: 'save'|'skip'|null}` | triage (null = undo) |
| `GET/POST/DELETE /api/seeds` | seed IDs (≤ 50), with resolve state |
| `GET/PUT /api/settings` | categories, λ, cap (≤ ceiling), TL;DR model (allow-list), ingest pause |
| `GET /api/status` | counters, neurons today/cap, last fetch, guard |

UI (Chinese, the dashboard's calm tokens copied, not imported): 今日 list, 已保存, 种子, 设置.
Keys: `j`/`k` move, `s` save, `x` skip, `o` open arXiv (`rel="noopener noreferrer"`), `u` undo.
Mobile: one column, buttons ≥ 44 px. Links are built from the validated ID only
(`https://arxiv.org/abs/<id>`, `https://arxiv.org/pdf/<id>`), never taken from the feed.

## 8. ops-v1 and the dashboard (decision: additive third app)

`status()`/`setGuard()` only. Change to `contracts/ops-v1` (additive, one commit with its tests):

- `OPS_APPS = ['mail-hero', 'todofy', 'lab']`, schema `App` enum + `lab`; `LabModes {maintenance:
  boolean (always false: Lab has no maintenance switch), ingest_paused?: boolean}`;
  `LabStatus = OpsStatus<'lab', LabModes>`; `interface LabOps extends OpsCommon<LabStatus> {}`.
- Fixtures `OpsStatus/lab-ok.json`, `OpsStatus/lab-degraded.json`, `GuardState/shed-lab.json`.
- README/IMPLEMENTATION: Lab row. Lab is the first app whose shed defers **everything**
  (`deferred: feed_fetch, embed, rank, tldr, seed_resolve, retention`); owner triage still works.
  Status is built from DO SQLite only (no D1 reads).
- Status: counters `ingested_24h`, `ranked_24h`, `saved_7d`, `neurons_today`, `neuron_cap`; signals
  `feed_stale` (warning, no successful fetch for > 72 h, metric `hours`), `neuron_cap_hit` (warning,
  metrics `used`, `cap`); `ui_url` `https://lab.ziyixi.science/`; capabilities `['guard']`.

Dashboard (small, additive; another task edits the registry concurrently):

- `wrangler.toml` service `LAB` → `lab`/`Ops`; `Env.LAB`; `ops-client.ts` `CALLED_METHODS.lab`
  and the `lab` branch of `opsStatus`/`opsSetGuard`; `api-v2-types.ts` binding union `+ 'LAB'`.
- `guard_applied` CHECK must allow `lab`: SQLite cannot alter a CHECK, so a one-time rebuild in
  `HomeState` (inside `transactionSync`, only when `sqlite_master.sql` lacks `'lab'`): create
  `guard_applied_v2`, copy, drop, rename. Covered by a runtime test that opens a v1-shaped store.
- Registry: entry `lab` (group `apps`, `tile_metric` counter `saved_7d`, `status: ops_v1 LAB
  guard: true`), flow `paper-radar` "论文雷达" (arXiv → 抓取 → 向量 → 排序 → 分拣), resources D1 `lab`
  (id filled in by the lead) and DO `LabState`.
- Tests that hard-code the two apps (`views-v2`, runtime `guard`/`harness`/`flows`/`v2`) gain `lab`;
  the runtime harness gets a third stub.
- Deploy order: `Dashboard deploy` needs `Lab deploy` (a binding to a missing Worker fails).
  Changing `ops-v1.ts` re-deploys Mail Hero, Todofy, Dashboard and Lab (`BUNDLED_BY`).

Smallest sound fallback if this proves too large for one change: ship Lab with its `Ops`
entrypoint typed locally against `OpsCommon`, register the dashboard entry as `public_http` (Access
302 probe) with no binding, and land the contract + binding change as the next commit.

## 9. CI

- `ci_changes.py`: `APPS += lab`, `PREFIX lab`, `PACKAGE_USERS['edge-auth'] += lab`,
  `BUNDLED_BY[contracts/ops-v1/ops-v1.ts] += lab`; tests updated.
- `Lab checks`: `npm ci` worker + web; `node --test deploy/test/*.test.mjs`; worker lint, typecheck,
  unit tests, runtime tests (workerd, real D1/DO; AI replaced through a wrapped binding / stub
  service exposing `run`, arXiv answered by `outboundService`; no network); web lint, typecheck,
  tests, build (+ `check-dist`); no imports from other apps; dry-run of the committed config through
  the wrapper with placeholder secrets.
- `Lab deploy` (main only, after the gate, environment `production`, concurrency `lab-production`):
  `wrangler d1 migrations apply DB --remote`, deploy through `deploy-vars.mjs exec`, then probe
  `https://lab.ziyixi.science/` expects the Access 302 to `ziyixi.cloudflareaccess.com`.
- `test_wrangler_configs.py`: `PRODUCTION['lab']`, `WRAPPERS['lab']`, `DEPLOY_JOBS`,
  `PERSONAL_INPUTS` (`LAB_ACCESS_OWNER*`), dev-command origin pin.
- Root README/AGENTS app tables, `packages/edge-auth/SPEC.md` §5.4 Lab column (as the dashboard:
  `case-insensitive`, nbf 60, `use-cookie`/`last`, JWKS 600,000/60,000 ms, `loopback-http` bypass,
  `importHmacKeyHex(CSRF_SIGNING_KEY)`, cookie `lab_csrf`, origin `https://<PUBLIC_HOST>`).

## 10. Tests (synthetic only)

Fake RSS fixtures built in code (ASCII + Chinese titles, cross/replace duplicates, a 5 MB+ body, a
malformed item, 304), fake Atom for seeds, fake AI returning deterministic vectors and `usage`,
fixed clocks. Unit: parser, dedupe, ranking maths, k-means determinism, ledger arithmetic and cap,
guard, retention selection, API validation. Runtime: full day run over several alarms, cap hit
mid-run then catch-up next day, shed pause and resume, duplicate alarm, restart mid-embed, Access +
CSRF on every mutation. No network, no real owner data.
