# Lab / Paper Radar: design

The Worker `lab` on `lab.ziyixi.science` (Cloudflare Access app "Lab") ranks each day's arXiv
cs.IR + cs.CL + cs.LG announcements against the owner's own likes and seeds, writes a 2–4 sentence
Chinese 简介 for each of the day's top 20, and shows them as a **daily deck, one card at a time**: swipe
right 喜欢, left 不喜欢, undo any number of steps, 重来 the whole deck, and at the end confirm whether to
send the liked papers to Todofy, which creates the Todoist tasks (`contracts/task-intent-v1`). The
interaction spec and the research behind it are in [`ux.md`](ux.md). It runs on Workers Free, is fully deferrable under the
dashboard's guard, and reports to the dashboard through `contracts/ops-v1`. Owner-approved scope:
the brainstorm "MLE" note §1 and REPORT §3 ⑤ (2026-09-30); the newsletter seed contract, HF Daily
Papers, v2 learned ranking and citation follow-up are **not** in this version.

Status: implemented, not deployed (worker and UI, 2026-09-30); §14 lists what the worker build decided
beyond this design. The D1 database `lab` and the Access app exist (ids committed in `wrangler.toml`). Facts
below were checked on 2026-09-30 against the linked public docs and one request to the public feed.
Revision 2 (same day, owner request): the deck/session model (§7), the send step and Todofy intake (§9),
简介 for all 20 cards (§1, §4), labels renamed `like`/`dislike`, and the build split (§12).

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
| 简介, 20 calls × (≈700 in, ≤300 out) on granite | 14k in + 6k out | **≈83** |
| Seeds, one-off (20 × 370) | 7.4k | ≈8 |
| **Typical day** | | **≈340 (3.4 % of the account)** |
| Worst case: all 932 items at the 2,000-char cap, estimate at 3 chars/token | ≈650k | ≈720 (7.2 %) |

So yes, the quota is ample: a normal day uses about 3.4 % of the account budget (with
`@cf/qwen/qwen3-30b-a3b-fp8` as the 简介 model, 20 × (700 × 4,625 + 300 × 30,475) / 10⁶ ≈ 250 neurons,
so ≈ 510 a day, still about 5 %). `LAB_DAILY_NEURONS`
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
| `lab/worker/test/`, `test/runtime/` | Node unit tests (fake bindings); workerd suite (Miniflare, fake AI + fake arXiv + stub Todofy) |
| `contracts/task-intent-v1/` | the Lab → Todofy "create these Todoist tasks" contract (§9) |
| `lab/migrations/` | D1 migrations (`migrations_dir`) |
| `lab/web/` | React 19 + Vite 7 UI (Chinese), same toolchain as `dashboard/web`, builds `web/dist` |
| `lab/deploy/` | `deploy-vars.mjs` (BUILD_SHA + owner secrets), `test/*.test.mjs` |
| `lab/docs/` | this file, [`ux.md`](ux.md) (deck interaction spec + research); later `setup.md`, `verification.md` |

Toolchain = dashboard's (Node 26, TypeScript 5.9.3, vitest 4.1.11, eslint 10.11.0, typescript-eslint
8.71.0, workers-types 5.20260929.1, wrangler 4.142.0, miniflare 5.20260926.0-alpha, esbuild 0.28.1,
React 19.3.0, Vite 7.3.6, react-query 5.104.0, lucide-react 1.48.0). `@ziyixi/edge-auth` is
`file:../../packages/edge-auth`.

## 3. Configuration (`lab/wrangler.toml`)

- `name = "lab"`, committed `account_id`, `workers_dev = false`, `preview_urls = false`, route
  `lab.ziyixi.science` as a Custom Domain.
- Bindings: `DB` (D1 `lab`), `LAB` (DO `LabState`, migration `v1` `new_sqlite_classes`), `AI`
  (`[ai]`), `TODOFY` (service, §9), `ASSETS` (`web/dist`, `run_worker_first = true`, SPA fallback). No cron trigger (3/5
  used): the DO schedules itself with `setAlarm()`.
- Committed vars: `PUBLIC_HOST`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `LAB_DAILY_NEURONS=5000`,
  `LAB_FETCH_UTC_HOUR=6`. Model ids are **not** vars: `worker/src/models.ts` holds the allow-list with
  each model's neuron rates and doc URL (embeddings `@cf/baai/bge-m3`; TL;DR default
  `@cf/ibm-granite/granite-4.0-h-micro`, alternatives `@cf/meta/llama-3.2-1b-instruct`,
  `@cf/qwen/qwen3-30b-a3b-fp8`), and the settings page picks the TL;DR model from that list. (This also
  keeps `@` out of the committed config, which `test_wrangler_configs.py` refuses for wrapped apps.)
- Real resources, committed: D1 `lab` `database_id = f20238dc-93a4-4d1a-91c4-c013f01cbdc9`; Access app
  for `lab.ziyixi.science`, `ACCESS_ISSUER = https://ziyixi.cloudflareaccess.com`, `ACCESS_AUDIENCE =
  3a8b5e31…c4c8c` (full value in `wrangler.toml`). `deploy/deploy-vars.mjs` still refuses an all-zeros id
  or AUD, as a guard against a revert.
- Service binding `TODOFY` → Worker `todofy`, entrypoint `Ops` (contracts/task-intent-v1, §9). Deploy
  order: Todofy's release with `proposeTasks` should be live before the first send; an older Todofy makes
  the call reject, which Lab shows as "Todofy 暂不可用" (never a lost or doubled send).
- Injected at deploy by `deploy/deploy-vars.mjs` (like the dashboard): `--var BUILD_SHA`; Worker
  secrets `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES`, `CSRF_SIGNING_KEY` from the wrapper inputs
  `LAB_ACCESS_OWNER`, `LAB_ACCESS_OWNER_ALIASES`, `LAB_CSRF_SIGNING_KEY`. In `Lab deploy` the first two
  are the dashboard's existing environment secrets `DASHBOARD_ACCESS_OWNER` / `DASHBOARD_ACCESS_OWNER_ALIASES`
  (the same owner); `LAB_CSRF_SIGNING_KEY` is Lab's own secret (`lab/README.md` "Deploy secrets"). No
  GitHub variable toggles.
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
   `dc:rights`. Keep `new` and `cross`; drop `replace`/`replace-cross` unless the ID is liked (then set
   `new_version` on the liked row). A repeated ID keeps the first. Items are written to D1 in
   `INSERT … SELECT … FROM json_each(?)` chunks (≤ 100 items, ≤ 500 KB per statement: D1 Free allows
   50 queries per invocation and 100 bound parameters per query).
   [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
3. **Embed** (`embed`): `AI.run('@cf/baai/bge-m3', {text: [...≤50], truncate_inputs: true})`, text =
   `title + "\n\n" + abstract` cut to 2,000 characters; ≤ 8 calls per invocation. Vectors are
   L2-normalised and stored as Float32 BLOBs (1024 × 4 B) in DO SQLite.
4. **Rank** (`rank`): positives = seed + liked vectors; if ≤ 16, each is a centroid, else spherical
   k-means with k = 16 (deterministic init, ≤ 10 iterations; cached until labels change). Negative
   centroid = mean of disliked vectors (latest 500). `score = max_i cos(x, c_i) − λ·cos(x, n)`,
   λ = 0.3 (setting, 0–1), no negative term without dislikes. Candidates: the day's items with no
   label. Top 20 → D1 `picks` with `because_id` = the single positive paper with the highest cosine to
   the pick (the card's "为什么推荐" line; one pass over ≤ a few hundred positive vectors). Ranking runs
   once per announcement day, so a deck never reshuffles under the owner. **Cold start** (no positive
   vectors): an **explore** deck instead: 20 of the day's `new` items taken round-robin over primary
   categories in feed order (deterministic), `because_id` null. Either way the deck (§7) is created in
   the same D1 batch as the picks, with `ready_at` null.
5. **简介** (`brief`, was `tldr`): every card of the day's deck without a 简介, rank order, one call
   each, `max_tokens` 300, temperature 0.2. Prompt: the title and abstract only, "用 2–4 句简体中文概括这篇
   论文做了什么、怎么做、结果如何；只使用摘要中的信息，不要推测，不要评价，不要列表，不超过 180 字". Output is
   untrusted text: control characters stripped, whitespace collapsed, a leading "简介：" or quote removed,
   ≤ 400 characters, and refused (stored null, counter `brief_rejected`) when it contains no CJK
   character, a URL, or more than 6 sentences. Shown as plain text only. When every card has a 简介 or a
   refusal, or the neuron cap stops the step, the deck gets `ready_at` (the UI shows "简介明天补上" for
   the missing ones and falls back to the first two abstract sentences).
6. **Seed resolve** (`seed_resolve`): seed IDs not yet in D1 are fetched with **one**
   `GET https://export.arxiv.org/api/query?id_list=<≤20 ids>&max_results=20` per invocation (Atom),
   ≥ 3 s after any other arXiv request, then embedded like step 3.
7. **Retention** (`retention`, once a day, bounded batches): vectors older than 30 days deleted
   unless liked/seed; D1 papers older than 90 days deleted unless liked, seed or in `picks`; `picks`,
   decks, cards and deck events kept 365 days; dislikes kept 180 days; `owner_ops` 30 days; `sends`
   400 days (longer than Todofy keeps the intent), their frozen payload nulled 30 days after settling. D1 then stays ≈ 150 MB of 500 MB; DO vectors ≈ 60 MB (Free
   allows 1 GB per object; hard stop at 60,000 vector rows).

Order per day: fetch → parse → embed → rank (+ deck) → brief → deck ready; seed resolve and retention run when the day's
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

**D1 `lab`** (records; written only by `LabState`, read by the Worker for GET routes).
`migrations/0001_init.sql` is still unapplied (nothing deployed), so revision 2 edits it in place.

| Table | Columns (key points) |
| --- | --- |
| `papers` | `id` PK `arxiv:<id>`, version, title, authors, categories JSON, primary_category, announce_type, announced_on, abstract, license, new_version, first_seen_at |
| `picks` | `(day, rank)` PK, paper_id, score, `because_id` (nearest positive paper or null), `brief` (简介 ≤ 400 chars or null), `brief_model`, created_at |
| `decks` | `deck_id` PK (= the announce day `YYYY-MM-DD`), `kind` `ranked`\|`explore`, `size` (≤ 20), `version` (bumped by every decision event), `created_at`, `ready_at`, `finished_at`, `later_at` (owner chose 暂不发送) |
| `deck_cards` | `(deck_id, position)` PK, `paper_id` (UNIQUE per deck), `decision` null\|`like`\|`dislike`, `decided_seq`, `send_excluded` 0/1, `sent_generation` (null until a send containing it is recorded) |
| `deck_events` | `(deck_id, seq)` PK, `kind` `decide`\|`undo`\|`restart`, `paper_id`, `decision`, `target_seq` (undo: the event it cancels), `at`; append-only, ≤ 400 per deck |
| `owner_ops` | `op_id` PK (client UUID), `route`, `deck_id`, `status`, `response` JSON (≤ 16 KB), `at`: replay of any mutation; 30 days |
| `sends` | `(deck_id, generation)` PK, `intent_id` UNIQUE (`deck-<day>-g<n>`), `mode`, `paper_ids` JSON, `payload` (frozen TaskIntent JSON, nulled 30 days after settling), `payload_sha256`, `state` (§9), `recorded` 0/1, `tasks_total`, `tasks_created`, `error_code`, `next_poll_at`, created_at, updated_at |
| `feedback` | `paper_id` PK, `label` `like`\|`dislike`, `source` `deck`\|`library`, `deck_id`, `at`: the effective label that ranking reads |
| `seeds` | `paper_id` PK, added_at, state `pending`\|`resolved`\|`not_found` |
| `settings` | categories, λ, neuron_cap (≤ `LAB_DAILY_NEURONS`), tldr_model (the 简介 model), ingest_paused, `send_mode` (`subtasks` default) |

**DO SQLite** (coordinator): `jobs` (per-day cursor/phase), `vectors(paper_id PK, day, dim, vec BLOB,
kept)`, `labels(paper_id PK, label, at)` (mirror of `feedback` for centroids and counters, rewritten
after each committed decision), `centroids` cache, `neurons`, `guard`, `fetch_meta` (etag,
last_modified, last_ok_at, last_error_code), `counters`. The DO is the only writer to D1; owner
mutations are DO RPCs.

Privacy: likes, dislikes, decks, sends, seeds and settings are personal. They live only in D1/DO
behind Access (and, for a send, in the Todoist tasks the owner asked for), never in git, logs, fixtures
or ops-v1 output (counts only). Logs carry request IDs, op IDs, job codes, counts and error codes.
arXiv metadata is public (license per item in `dc:rights`); PDFs are linked, never fetched or stored.

## 7. Decks, decisions, undo and 重来

**Session = deck = one arXiv announcement day.** Not a UTC day (arXiv announces once per weekday
around 04:00 UTC; a weekend has none, and the owner's evening crosses UTC midnight) and not a fetch (a
re-fetch of an unchanged feed must not make a new deck). The rank step creates the deck with its
frozen card order; it becomes visible at `ready_at`. `GET /api/today` points at the newest ready deck;
older unfinished decks (≤ 7 days) are offered separately and never merged.

**Decision log.** Every mutation appends to `deck_events` and updates the materialised
`deck_cards.decision` and `feedback` in the **same D1 batch** (atomic), with a compare-and-set on
`decks.version`:

- `decide(paper, like|dislike)`: only for an undecided card of this deck (else 409 `already_decided`);
  cards may be decided in any order, the UI offers the first undecided one.
- `undo`: cancels the **latest effective** `decide` or `restart` event (`target_seq`); repeatable until
  nothing is left (409 `nothing_to_undo`). Undoing a decide clears that card; undoing a restart brings
  back every decision the restart cleared.
- `restart` (重来): clears every decision of the deck (the events stay; the restart is one undoable
  event). Sent papers stay sent (§9).
- Effective state = replay of the events not cancelled by an undo (decide sets a card, restart clears
  all). The materialised columns are that replay; a unit test checks them against the pure replay for
  random operation sequences.
- `feedback` for the deck's papers is recomputed from `deck_cards` in the same batch (a like/dislike
  row with `source = deck`, or no row), then the DO rewrites its `labels` mirror. Ranking reads labels
  at the next day's rank run; today's deck does not reshuffle.
- `finished_at` is set when every card has a decision and cleared when an undo/restart reopens one.

**Idempotency and concurrency.** Every mutation carries `op_id` (UUID v4 from the browser) and, for
deck mutations, `base_version`. The DO serialises mutations per deck (an in-memory promise chain; D1
calls can interleave otherwise) and checks `owner_ops` first: a known `op_id` returns its stored
response unchanged (a retried request after a lost response is harmless). A replay also re-derives
LabState's mirrors from D1 (`labels` for the deck's cards or the one paper from `feedback`; `seed_ids`
from `seeds`): the first attempt's D1 batch may have committed while the call failed before the mirror
was written, and ranking must not miss that like, dislike or seed for good. A stale `base_version` is
409 `deck_changed` with the current `DeckState`, which the UI adopts (another tab or device). Each
mutation is at most 6 D1 statements in one batch; a decision costs ≈ 25 rows written, well inside D1
Free (100,000 rows written per day).

## 8. Owner API and UI

Every `/api/*` route needs the Access owner (edge-auth); mutations also need Origin + CSRF
(`X-CSRF-Token`, cookie `lab_csrf`). Error envelope `{error: {code, message, request_id}}`. Types in
`worker/src/api-types.ts` (updated in revision 2; the UI imports it):

| Route | Purpose |
| --- | --- |
| `GET /api/csrf` | `{token}` |
| `GET /api/today` | `TodayResponse`: newest ready deck id and progress, `building` phase, `next_run_at`, cold start, older unfinished decks |
| `GET /api/decks/:day` | `Deck`: the frozen cards (paper, 简介, because, links) + `DeckState` + the send status |
| `POST /api/decks/:day/decide` | `{op_id, base_version, paper_id, decision}` → `DeckMutationResponse` |
| `POST /api/decks/:day/undo` | `{op_id, base_version}` → `DeckMutationResponse` (with what was undone, for the animation) |
| `POST /api/decks/:day/restart` | `{op_id, base_version}` → `DeckMutationResponse` |
| `GET /api/decks/:day/summary` | `DeckSummary`: liked cards with `excluded`/`sent_generation`, counts, the current send |
| `POST /api/decks/:day/exclude` | `{op_id, paper_id, excluded}` → `DeckSummary` (a flag, not a decision event: no version bump) |
| `POST /api/decks/:day/send` | `{op_id, mode}` → `SendStatus` (§9) |
| `GET /api/decks/:day/send` | `SendStatus`; polls Todofy when due (≥ 3 s apart) |
| `POST /api/decks/:day/later` | `{op_id}` → marks 暂不发送 (`later_at`) |
| `GET /api/liked?cursor=&q=` | liked papers, newest first, 50 per page, optional title filter |
| `POST /api/feedback` | `{op_id, paper_id, label: 'like'\|'dislike'\|null}` from the 已喜欢 list (source `library`) |
| `GET/POST/DELETE /api/seeds` | seed IDs (≤ 50), with resolve state; POST `{op_id, ids}`, DELETE `{op_id, paper_id}` |
| `GET/PUT /api/settings` | categories, λ, cap (≤ ceiling), 简介 model (allow-list), ingest pause, default send mode; PUT `{op_id, …Settings}` → `SettingsResponse` |
| `GET /api/status` | counters, neurons today/cap, last fetch, guard |

`:day` must match `^\d{4}-\d{2}-\d{2}$` and name an existing deck (404 `deck_not_found`). Deck GETs read
D1 directly in the Worker (≤ 3 queries); mutations go to the DO. Links are built from the validated ID
only (`https://arxiv.org/abs/<id>`, `https://arxiv.org/pdf/<id>`), never taken from the feed.

UI: [`ux.md`](ux.md) is the spec (card anatomy, drag thresholds, keyboard, undo/重来, summary, send
states, empty/building/done states, accessibility). Views: 今日 (deck → summary → done), 已喜欢, 种子,
设置. React 19 without a router or gesture library (pointer events + CSS transforms), react-query for
data, an operation queue for optimistic swipes.

## 9. Sending likes to Todofy (`contracts/task-intent-v1`)

Todofy stays the only Todoist writer. Lab calls `env.TODOFY.proposeTasks(intent)` and
`taskIntentStatus(ref)` on Todofy's gateway entrypoint `Ops` from inside `LabState` (the only D1
writer); the contract, states and Todofy's implementation plan are in
[`contracts/task-intent-v1/README.md`](../../contracts/task-intent-v1/README.md).

**Lab side, per deck:**

- **Generations.** A deck has at most one open send; `sends.generation` counts them. The first send is
  `deck-<day>-g1`; after it is created, papers liked later in the same deck can go out as `g2`
  ("补发", title `论文雷达 <day>（补发）· N 篇`), and so on. A paper is in at most one recorded
  generation (`deck_cards.sent_generation`), so no paper is ever sent twice.
- **Freeze.** `POST …/send` builds the intent from the liked, not excluded, not yet sent cards in deck
  order (none → 409 `nothing_to_send`): `mode` from the request; parent `论文雷达 <day> · N 篇`,
  description `来自 Lab 论文雷达\nhttps://lab.ziyixi.science/deck/<day>`; per paper `title` (whitespace
  collapsed, ≤ 300 code points with "…"), `url` `https://arxiv.org/abs/<id>`, `description` = the
  简介's first sentence (≤ 120 chars; absent without 简介). The TaskIntent JSON is stored in `sends`
  **before** the RPC (state `sending`), then sent.
- **Outcome** (stored on the row, shown per `ux.md` §5): `pending` (poll), `created`, `duplicate`
  (both set `sent_generation` on its cards), `paused`, `failed`, `rejected`, or `unknown` when the RPC
  itself rejected (binding error, older Todofy, `unavailable`/`busy`). `invalid_input` is a Lab bug:
  stored as `rejected`/`invalid_input`, logged, never retried unchanged.
- **Retry and edit rules.** Result `recorded = false` (paused, rejected, not_found) means Todofy holds
  nothing: the generation is **unfrozen** and the next send rebuilds it (same `intent_id`, current
  likes and mode). Any other state keeps it frozen: 重试 resends the identical payload (Todofy replays or
  re-queues; never duplicates). `unknown` first asks `taskIntentStatus`; `not_found` → resend the same
  payload. A retry of a `failed` generation that Todofy answers `paused` (recorded: it held a pause and
  re-queued nothing) stays `failed` here with the pause as its `error_code` and no poll, so the owner is told
  the retry did not happen, not that it resumes by itself.
- **Polling.** `GET …/send` refreshes a `pending`/`paused`(recorded)/`unknown` generation through the
  DO when `next_poll_at` has passed (≥ 3 s, `retry_after_seconds` honoured, backing off to 60 s after
  2 minutes of the current attempt: `sends.created_at` is reset by every retry, rebuild and re-propose). No background polling: a send left pending is refreshed the next time the owner looks
  (and Todofy finishes it anyway).
- The ops-v1 guard does not defer sends (owner-initiated). Nothing is sent without the owner pressing
  发送; 暂不发送 only records `later_at`.

**Todofy side** (separate build, keeps all existing behaviour identical): two `Ops` methods forwarding
to new `TodofyCore` RPCs; migration `todofy/migrations/0005_task_intents.sql` (renumbered from 0004
at merge, after the GTD ledger's `0004_gtd.sql`; additive and independent of it); a D1 ledger row per intent plus one row per task with a frozen request ID; creation
in the existing alarm, ≤ 6 tasks per step through the existing `todoist.create_task`, parent first then
subtasks with `parent_id`; the footer `Todofy intent: lab/<intent_id>#<n>` for the existing read-only
lookup after an unknown result; `paused` (nothing recorded) under maintenance, processing pause,
`FORCE_PAUSE_TODOIST`, the Todoist auth block or a backup lease; never Gemini; content dropped once
created.

## 10. ops-v1 and the dashboard (decision: additive third app)

`status()`/`setGuard()` only. Change to `contracts/ops-v1` (additive, one commit with its tests):

- `OPS_APPS = ['mail-hero', 'todofy', 'lab']`, schema `App` enum + `lab`; `LabModes {maintenance:
  boolean (always false: Lab has no maintenance switch), ingest_paused?: boolean}`;
  `LabStatus = OpsStatus<'lab', LabModes>`; `interface LabOps extends OpsCommon<LabStatus> {}`.
- Fixtures `OpsStatus/lab-ok.json`, `OpsStatus/lab-degraded.json`, `GuardState/shed-lab.json`.
- README/IMPLEMENTATION: Lab row. Lab is the first app whose shed defers **everything**
  (`deferred: feed_fetch, embed, rank, brief, seed_resolve, retention`); decisions and sends to
  Todofy still work.
  Status is built from DO SQLite only (no D1 reads).
- Status: counters `ingested_24h`, `ranked_24h`, `liked_7d`, `decided_7d`, `neurons_today`,
  `neuron_cap`; signals `feed_stale` (warning, no successful fetch for > 72 h, metric `hours`),
  `neuron_cap_hit` (warning, metrics `used`, `cap`), `send_unsettled` (warning, a send `failed` or
  `unknown` for > 24 h, metric `count`); `ui_url` `https://lab.ziyixi.science/`; capabilities `['guard']`.

Dashboard (small, additive; another task edits the registry concurrently):

- `wrangler.toml` service `LAB` → `lab`/`Ops`; `Env.LAB`; `ops-client.ts` `CALLED_METHODS.lab`
  and the `lab` branch of `opsStatus`/`opsSetGuard`; `api-v2-types.ts` binding union `+ 'LAB'`.
- `guard_applied` CHECK must allow `lab`: SQLite cannot alter a CHECK, so a one-time rebuild in
  `HomeState` (inside `transactionSync`, only when `sqlite_master.sql` lacks `'lab'`): create
  `guard_applied_v2`, copy, drop, rename. Covered by a runtime test that opens a v1-shaped store.
- Registry: entry `lab` (group `apps`, `tile_metric` counter `liked_7d`, `status: ops_v1 LAB
  guard: true`), flow `paper-radar` "论文雷达" (arXiv → 抓取 → 向量 → 排序 → 简介 → 卡片 → Todofy), resources D1 `lab`
  (`f20238dc-93a4-4d1a-91c4-c013f01cbdc9`) and DO `LabState`.
- Tests that hard-code the two apps (`views-v2`, runtime `guard`/`harness`/`flows`/`v2`) gain `lab`;
  the runtime harness gets a third stub.
- Deploy order: `Dashboard deploy` needs `Lab deploy` (a binding to a missing Worker fails).
  Changing `ops-v1.ts` re-deploys Mail Hero, Todofy, Dashboard and Lab (`BUNDLED_BY`).

Smallest sound fallback if this proves too large for one change: ship Lab with its `Ops`
entrypoint typed locally against `OpsCommon`, register the dashboard entry as `public_http` (Access
302 probe) with no binding, and land the contract + binding change as the next commit.

## 11. CI

- `ci_changes.py`: `APPS += lab`, `PREFIX lab`, `PACKAGE_USERS['edge-auth'] += lab`,
  `BUNDLED_BY[contracts/ops-v1/ops-v1.ts] += lab`; new `BUNDLED_BY[contracts/task-intent-v1/task-intent-v1.ts]
  = lab, todofy` and `contracts/task-intent-v1/**` → Lab checks + Todofy checks + Contracts; tests updated.
- `Contracts` job: also runs `lab/worker` `test/task-intent-contract.test.ts` and Todofy's
  `tests/unit/test_task_intent_contract.py` (same fixtures, same verdicts).
- `Lab checks`: `npm ci` worker + web; `node --test deploy/test/*.test.mjs`; worker lint, typecheck,
  unit tests, runtime tests (workerd, real D1/DO; AI replaced through a wrapped binding / stub
  service exposing `run`, arXiv answered by `outboundService`; no network); web lint, typecheck,
  tests, build (+ `check-dist`); no imports from other apps; dry-run of the committed config through
  the wrapper with placeholder secrets. The runtime suite binds `TODOFY` to a stub Worker exporting an
  `Ops` entrypoint that answers from the contract fixtures (pending → created, paused, failed, reject).
- `Lab deploy` (main only, after the gate and after `Todofy deploy`, environment `production`,
  concurrency `lab-production`):
  `wrangler d1 migrations apply DB --remote`, deploy through `deploy-vars.mjs exec`, then probe
  `https://lab.ziyixi.science/` expects the Access 302 to `ziyixi.cloudflareaccess.com`.
- `test_wrangler_configs.py`: `PRODUCTION['lab']`, `WRAPPERS['lab']`, `DEPLOY_JOBS`,
  `PERSONAL_INPUTS` (`LAB_ACCESS_OWNER*`), `SHARED_SECRETS` (Lab deploy reads them from
  `DASHBOARD_ACCESS_OWNER*`), dev-command origin pin.
- Root README/AGENTS app tables, `packages/edge-auth/SPEC.md` §5.4 Lab column (as the dashboard:
  `case-insensitive`, nbf 60, `use-cookie`/`last`, JWKS 600,000/60,000 ms, `loopback-http` bypass,
  `importHmacKeyHex(CSRF_SIGNING_KEY)`, cookie `lab_csrf`, origin `https://<PUBLIC_HOST>`).

## 12. Tests (synthetic only)

Fake RSS fixtures built in code (ASCII + Chinese titles, cross/replace duplicates, a 5 MB+ body, a
malformed item, 304), fake Atom for seeds, fake AI returning deterministic vectors and `usage`,
fixed clocks. Unit: parser, dedupe, ranking maths, k-means determinism, ledger arithmetic and cap,
guard, retention selection, API validation; the deck replay (random decide/undo/restart sequences
against the materialised columns), `op_id` replay, version conflicts, send generations, freeze and
unfreeze by `recorded`, intent building (titles, truncation, first-sentence 简介, arXiv-only URLs; every
built intent passes the task-intent-v1 schema), every result state mapped. Runtime: full day run over several alarms, cap hit
mid-run then catch-up next day, shed pause and resume, duplicate alarm, restart mid-embed, Access +
CSRF on every mutation; a full deck (swipe 20, undo 3, 重来 and undo it, finish, exclude one, send,
poll to created, resend = duplicate, 补发 g2) against the stub Todofy. No network, no real owner data.

## 13. Build split

Revision 2 fixes the shared surfaces first (this commit): `contracts/task-intent-v1/` (schema, types,
fixtures, Lab's contract test), `worker/src/api-types.ts` (deck API), `migrations/0001_init.sql` (deck
tables), `wrangler.toml` (real D1 id, Access AUD, `TODOFY` binding), `env.ts`. Then three independent
builds, in parallel:

| Build | Scope | Depends on |
| --- | --- | --- |
| **Lab worker** | pipeline (§4, 简介 for every card, explore deck, `because_id`), neuron ledger, decks/decisions/undo/restart (§7), owner API with edge-auth + CSRF (§8), send client + polling (§9), ops-v1 `lab` + dashboard wiring (§10), CI (§11), runtime suite with fake AI, fake arXiv and a stub Todofy | api-types, migration, contract |
| **Lab web** | everything in `ux.md` against `api-types.ts` and fixtures (no worker needed): deck, gestures, keyboard, undo/重来 queue, summary + send states, empty/building/done, 已喜欢, 种子, 设置 | api-types |
| **Todofy intake** | `contracts/task-intent-v1/README.md` "Todofy's side": migration 0005, core RPCs, alarm step, rendering, lookup footer, gateway `Ops` methods, Python contract test, docs; existing behaviour and tests unchanged | contract |

Then a review (quota/security, product/UX on a phone), fixes, and a clean-clone run of every CI job.
Deploy order: Todofy (with the intake) → Lab → Dashboard.

## 14. Worker build notes (2026-09-30)

What the implementation (`worker/src/`) settled where this design left room, all covered by tests:

- **Order in an alarm slice**: an unfinished day's job first (embed → rank → 简介), then pending seeds (one
  export.arxiv.org request, so a seed entered before the slot already shapes that day's deck), then the
  daily fetch, then retention. arXiv requests keep ≥ 3 s between them across both hosts. The first run after
  deploy fetches at once instead of waiting for the next slot.
- **Failures**: a failed fetch retries after 5 min and 30 min, then waits for the next slot. A step that fails
  5 times in a row is given up so it cannot block later days (embed: the rest of that day's texts are dropped
  and ranking uses what exists; rank: the day has no deck); a card whose 简介 call fails 3 times keeps the
  abstract fallback.
- **Cap**: once a call would pass the cap (or Workers AI reports the account allowance gone), AI work stops
  for the rest of the UTC day. A deck capped during 简介 is shown at once (`ready_at`) and its missing 简介
  are written on the next UTC day while it is at most 3 days old. A day whose embeddings the cap stops
  continues after 00:00 UTC; if the next fetch slot comes first, the day is ranked with what was embedded
  (with no vectors at all, an explore deck), so a cap too small for a day never holds back the next one.
- **Guard bound** (ops-v1: every deferred job has a bound): when the last successful fetch is more than 48 h
  old, the whole day's pipeline runs to its end despite the shed, then defers again.
- **Settings** live in D1 (`settings`, the source the GETs read); LabState mirrors the effective cap and the
  ingest pause into its own storage so `status()` needs no D1 read. `PUT /api/settings` replaces the whole
  set (`SettingsUpdateRequest`); a cap above `LAB_DAILY_NEURONS` is refused.
- **Replay**: `owner_ops` stores the exact response of decide/undo/重来 (a repeated `op_id` never applies
  twice); for the idempotent mutations (exclude, 暂不发送, send, feedback, seeds, settings) a repeated `op_id`
  returns the current view without applying anything again (a replayed send never proposes again).
  `decks.undo` materialises the next undo target (migration 0001, unapplied, edited in place).
- **Send**: `GET …/send` answers 404 `not_found` before the first send. The card's `sent_generation` is set
  as soon as Todofy has *recorded* the generation (pending included), so 补发 never repeats a paper; the open
  frozen generation's papers are also held back while its outcome is unknown.
- **Tests drive the alarm**: `LabState.step(now)` is the alarm body; with `DEV_MANUAL_ALARMS=true` (a
  test-only binding, refused in production by the config tests) it never arms a real alarm, and the workerd
  suite passes explicit clocks (next UTC day, the 48 h bound).
- **Dashboard**: the 论文雷达 flow has 5 stages (arXiv → 抓取 → 排序与简介 → 卡片 → 交给 Todofy) because 8
  stages pushed the flows view past its 16 KiB budget; the `LabState` namespace is not in the registry's
  resources yet (every registered resource must name its ID; add it after the first deploy). ops-v1's
  signal table row "both" became "every app".
