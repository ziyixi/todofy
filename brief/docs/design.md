# brief design

A daily briefing for the owner on `brief.ziyixi.science`: on weekdays a short email (5-8 items, about a 3-minute read)
with **研究前沿** (the owner's research fields and AI/LLM research) and **世界与经济** (only the day's 2-3 most important
stories), and on Saturday one **深读**, a single topic explained thoroughly. The Worker fetches a curated registry of
feeds and APIs itself (no search); Claude Haiku 5.5 screens every candidate for relevance; Claude Opus 5.5 compares
the best fifty or so side by side, picks the day's items, reads their full text and writes in Chinese, each topic as
densely as the owner reads it; code checks that every quote, name and number is in the text the Worker fetched, and
a Haiku entailment check logs overstatements. One send per day through Resend, never replayed after an unknown
outcome; a private archive behind Access shows every issue, its sources, its quotes and what it cost. The owner's
👍 / 👎 / 多来点 adjust source and topic weights weekly.

**Status: deployed in archive mode** (2026-10-11). The implementation landed in `0e48a59`; the first deployment,
`7bea3ec`, passed [CI](https://github.com/ziyixi/todofy/actions/runs/38128504001). The Access applications and
`BriefState` namespace exist, and production has both provider secret names configured. Production `MODE` and the
GitHub variable `BRIEF_MODE` are `archive`: the pipeline can call the paid Claude API and archive issues, but sends
no email. Real model quality and delivery remain separate acceptance steps (§16).

The resource registration and Home Ops integration are being completed on `codex/brief-home-monitoring`; deployment
of Brief and Home at the same commit and the production checks remain pending. [`HANDOFF.md`](../../HANDOFF.md)
records that rollout and the initial synthetic validation. The production settings page confirms the owner's saved
$80 monthly budget; preserve it across deployment. This does not change the $40 initial default or establish the
Console spend limit (§13). Newsletter continues unchanged, and its retirement remains a separate decision
(root `AGENTS.md`).

The owner's decisions of 2026-10-10: the current newsletter's quality is low and its topics are not the owner's; make
it cheaper and better. Two sections only (tool-chain/platform changes and jobs/immigration not chosen); weekday brief
plus a weekend deep read; quality over cost, so writing uses the best model; target well under the $100 of monthly API
credits the owner's Max 5x plan includes.

What changes against `newsletter/` and why:

| | Newsletter (k3s) | brief |
| --- | --- | --- |
| Discovery | Codex live web search, 23-37 serial threads an issue | 49 feeds and APIs the Worker polls (§3) |
| Topics | 8 fixed generic directions | the owner's fields, AI/LLM research, and the day's top 2-3 world stories |
| Selection | the writer's choice among search results | Haiku screens for relevance, then Opus compares the cards side by side (§5) |
| Reading | writer and reviewer each re-research every story | read once: the fetched full text, or the abstract, marked |
| Writing | one explanatory style, every term defined | per topic: dense in the owner's own field, explanatory elsewhere (§6) |
| Checking | a model reviewer | code: every quote, name and number in the fetched text (§8); an entailment log |
| Learning | the reader profile forbids it | votes adjust source and topic weights weekly (§10) |
| Tokens an issue | 1.56M uncached + 10.8M cached in, 55K out | about 60K in, 20-40K out (§13) |
| Bill | $0 extra: a ChatGPT subscription login, not an API key | about $20-30 a month of the Max plan's $100 of API credits (§13) |

At Opus prices the newsletter's tokens would cost about $300+ a month; that explains why the brief reads once instead
of searching, but it is not a saving against today's bill, which the subscription covers. The honest comparison is
about $25 a month of included credits against $0 extra today, for the owner's topics and a checked text.

The owner approved Brief as the newsletter's successor on 2026-10-10. The first implementation updated root
`AGENTS.md` accordingly; Newsletter's retirement remains a separate decision (§16). The current rollout keeps
Brief in archive mode and leaves Newsletter unchanged. A later shadow week requires the owner's approval.

## 1. Shape

One Worker `brief`, one SQLite Durable Object `BriefState` ("brief-v1"), the shape of the watch app and mailsort:

| Part | Responsibility |
| --- | --- |
| `worker/src/http.ts` | Access JWT (packages/edge-auth), Origin + CSRF on mutations, then one call to the object; the feedback route's token (§10); static UI |
| `worker/src/state.ts` | The object: SQLite, the alarm chain (`setAlarm`, no cron), the owner API through the shared transcoder, ops-v1 |
| `worker/src/schedule.ts` | Slots in America/Los_Angeles (§2) |
| `worker/src/registry.ts` | `content-config/sources.yaml`, validated at build and bundled (§3) |
| `worker/src/fetch/` | Polling, feed parsers, robots.txt, full text through HTMLRewriter (MathML to its alt text), the URL policy (§3, §6) |
| `worker/src/cluster.ts` | Canonical keys, mentions, bge-m3 embeddings, world clusters (§4) |
| `worker/src/claude.ts` | **The only code that calls the Claude API**: the gate, the pick, the writing and the entailment log; timeouts, refusals, usage and cost (§5, §7, §8, §13) |
| `worker/src/ground.ts` | The grounding check, pure functions: normalization, quote alignment, the number classifier (§8) |
| `worker/src/render.ts` | The email (HTML and text) and the archive's items (§11) |
| `worker/src/send.ts` | **The only code that calls Resend**, through the ledger (§12) |
| `worker/src/learn.ts` | Votes into weights (§10) |
| `web/` | The archive: Chinese, mobile-first, no framework, over `brief.ui.v1` (§11) |
| `brief.ui.v1` | The owner API (AIP resources and custom methods) in `proto/brief/ui/v1/`, landed with the first implementation in `0e48a59` |

No D1, R2, KV, Queues, Workflows or cron trigger. Bindings: `BRIEF` (the object), `ASSETS`, `AI` (Workers AI, for
bge-m3 only). Vars: `PUBLIC_HOST`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and from the deploy wrapper `BUILD_SHA` and
`MODE` (the GitHub variable `BRIEF_MODE`: `off`, `archive`, `shadow` or `live`; anything else refused). Secrets from
GitHub: `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES`, `CSRF_SIGNING_KEY`, `FEEDBACK_SIGNING_KEY` (64 hex each),
`MAIL_FROM`, `MAIL_TO` (personal values). Owner-machine secrets, put with `wrangler secret put` and never in GitHub
(mailsort's `owner_machine_secrets` pattern): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`. The SDK gets the key explicitly
(`new Anthropic({ apiKey })`): its default credential chain does not exist in Workers.

The whole host is behind the Access application `brief`; only the exact path `/feedback` has an Access Bypass
application (the Fleet receipt's pattern), and the Worker verifies its token itself (§10). No Notion, no Todofy.

## 2. Schedule

Times are America/Los_Angeles, computed by the object for each day with `Intl.DateTimeFormat` offsets. No slot falls
between 01:00 and 03:00, so none is skipped or repeated at a DST change.

| Time (PT) | Monday-Friday | Saturday | Sunday |
| --- | --- | --- | --- |
| 12:30, 18:30, 23:30 | fetch rounds (§3): poll, deduplicate, embed, cluster, gate | same | same |
| 03:30 | the cutoff round, then the pick (§5.3) | the cutoff round, then the deep-read pick (§9) | — |
| right after | full text, write, check, repair, render, the entailment log (§6-§8) | full text, deep read, check, repair, render, the entailment log | — |
| 06:30 | send, or when ready if later, until 12:00; after that archived only | 07:30 send | — |
| 12:00 | | | weekly learning (§10) |

A weekday issue considers what passed the gate since the previous cutoff (Monday's since Friday 03:30) and what is
still eligible: world items for 3 days, research for 7. An arXiv paper, with its Hugging Face entry, is eligible from
the **second** cutoff after it was first fetched: arXiv announces in the evening, and the following day brings the
corroboration the ranking reads (§5.2): Hugging Face's list for that date, the blogs and newsletters that link it, a
second query. Journals and lab posts are eligible at once. Sources with `poll_per_day: 1` are read in the 18:30 round
(after arXiv's announcement), `2` at 18:30 and 03:30, `4` in every round (feeds that hold 8-25 items).

## 3. Sources

### 3.1 The registry

`content-config/sources.yaml`, owner-editable and public (its header lists every field). 49 sources are enabled
(36 research, 13 world; 4 of them signal-only), 13 more researched ones are present with `enabled: false`, and 3
disabled Crossref alternates stand in for publisher feeds that might block Workers. It is bundled into the Worker and
validated by a unit test (unknown fields and values refused, IDs unique), so an edit deploys through CI like code;
there is no runtime config fetch. IDs are stable: votes and learned weights hang on them. Sources carry no topic: the
gate gives each item one of the profile's topics (§5.1).

Two roles. A **candidate** may be written up and cited. A **signal-only** source (OpenAI's 150-character news items,
the headlines of The Economist, the FT and Nikkei Asia) only raises the importance of a cluster: it is never cited and
never runs without a candidate in the same cluster. The `text` tier says what the writer may read: the feed's full
text, its abstract or summary, the page's full text or abstract (fetched for shortlisted items only, §3.3), or a
headline. `review` is what the source line says about review status (`doi_review` overrides it by DOI prefix:
Nature's news items are `10.1038/d41586`).

The research behind it (2026-10-10, one fetch per URL from a home IP) also rejected sources that 404 or 403
(Anthropic's and OpenAI's research RSS, Meta, AP, Reuters, IMF, transformer-circuits), that are frozen (WSJ's feed),
that robots.txt closes to everyone (Elsevier's EPSL feed), that serve the wrong content (eartharxiv.org/feed/), and
Google Scholar (no API; its terms forbid automated access). Meta's papers reach arXiv and Hugging Face anyway. A second
check the same day added Ahead of AI, the PyTorch and vLLM blogs, EGU's Solid Earth, SEG's Geophysics (through
Crossref), CNA's Asia feed and Nikkei Asia's headlines, and turned on Thinking Machines, the Hugging Face blog and Al
Jazeera; it found no feed for LMSYS/SGLang, and none for the ESS Open Archive (Crossref's prefix 10.22541 is all of
Authorea, with no seismology in a 3-day sample).

**Alternates.** Wiley's AGU feeds and Nature's were checked from a home IP; a Worker fetches from Cloudflare's network
with a `CF-Worker` header, which publishers may block. The AGU journals have Crossref alternates (an abstract on 67 of
67 recent records): if the archive days show a block, the YAML switches a journal to its alternate (its votes start
again at weight 1). Nature's feeds have none: Crossref carried abstracts on 7 of 63 recent records of four Nature
journals and OpenAlex on 4 of 19 Nature Geoscience ones (2026-10-10; OpenAlex now meters free use in dollars a day).
A blocked Nature feed leaves headlines (signal-only) or Springer Nature's metadata API, which needs a free key the owner
sets as a secret (§19).

### 3.2 Polling

- One request per source per round; conditional GET with the last `ETag`/`Last-Modified` (Nature, Wiley).
- Bodies are streamed and read up to `max_bytes` (default 1 MiB; OpenAI's 766 KB feed is read to 256 KiB, newest items
  first), then parsed as far as they got, within 128 MB and the invocation's CPU. The format is read from the content,
  not the header (Seismica serves Atom as `text/html`); fetch decodes gzip a server sends unasked.
- The URL policy is the watch app's, reimplemented (apps never import each other): `https:` only, redirects followed by
  hand (at most 5, each hop checked), never an IP literal, a local suffix or one of the owner's own hosts. 15 s per
  request, its timer always cleared.
- Per host: one request at a time, at least 3 s apart or the host's `Crawl-delay` (CNA's is 10 s); 429 and 503 back off
  for `Retry-After` or 15 minutes doubling. A host not ready defers its sources to the next alarm, never a failure.
- arXiv: one request every 3 s on one connection across all queries (its API terms). Each query is limited to the
  submissions of the last 7 days (`submittedDate:[…]`, added by code) and read in full, newest first, pages of 100 (at
  most 5): sorting by submission date and stopping at the first ID already seen would miss a paper announced days
  after it was submitted. IDs without their version deduplicate; about 10 pages a day. Crossref: the public pool, one
  request at a time, no `mailto` (a personal value); windows of 3 days, DOIs deduplicate. Hugging Face daily papers:
  yesterday's list, optional (an undocumented endpoint the brief must work without).
- Keyword prefilters (Nature, Science, GRL, EarthArXiv) match whole words and phrases; a trailing `*` matches the
  start of a word (`fault*` matches faults, not default); a keyword written in capitals matches case-sensitively (`AI`
  matches AI, not said or domain).
- Anthropic has no feed: the sitemap's first poll records every URL, and later polls turn new URLs under
  `/research/`, `/news/`, `/engineering/` into items (their page is fetched for a title and summary; about one a day).
  `lastmod` is rewritten in bulk, so it is never read as a date. A page that is gone or refuses (a 4xx, a refused
  redirect) is skipped for good; one that fails for a moment (429, a 5xx, a timeout) ends the source's round and is
  tried in the next rounds, 3 in all, so a failing page never makes a round poll the sitemap again.
- An entry dated past its section's eligibility, with room for a late feed (research 21 days, world 7), is not
  ingested: a feed that lists months of posts (Interconnects, Import AI) adds none of them, and an entry a feed keeps
  listing never comes back as new once its item is pruned (30 days).
- Health: a failed poll (status, timeout, parse error, too large) counts; 5 in a row pause the source, which is then
  tried once a day and resumes on success. A source can also answer 200 and bring nothing for weeks (a moved or
  frozen feed, an ISSN change at Crossref, a keyword filter or `requires_abstract` that rejects everything, arXiv's
  occasional empty answer), so each source's usual gap is the median gap between its items accepted after filtering
  over the last 60 days, and a source silent for 3 times that (at least 7 days; 30 days for one with fewer than 4
  accepted items in 60 days) is **stale**. ListSources shows each source's state, last error, recent volume and last
  accepted item.

### 3.3 Robots and terms

Feeds and APIs are always fetched: they are published for polling, and arXiv's API is governed by its terms of use
(its export host's robots.txt disallows everything for `*`). A **page** (full text) is fetched wherever it is publicly
reachable as the owner's own browser would reach it (the owner's answer of 2026-10-10): rules for AI agents
(`Claude-User`, `ChatGPT-User`, `ClaudeBot` and the like) do not apply to a personal reader fetching for one person,
and a group of robots.txt that names the brief's own product token `ziyixi-brief` does (RFC 9309: its longest-match
Disallow and Allow; a `*` group never closes a page to it). A Crawl-delay is honoured from the brief's own group or
else from `*`, up to 60 s. Verdicts are cached 24 hours per host (a 4xx allows everything; a 5xx or no answer
disallows everything and is cached an hour). Paywalls and logins are never circumvented: a 401, 402 or 403, or a page
whose text is too short, falls back to the feed's text and the source line says 仅摘要. The per-host pacing (3 s, or the
Crawl-delay) and the honest user agent stay.

User agent: `Mozilla/5.0 (compatible; ziyixi-brief/1.0; personal research digest)`, no address, no cookie.

Terms. Several outlets allow personal, non-commercial use only, and the Economist forbids storing or transmitting its
content, so: fetched full text is transient (kept in the object, deleted 7 days after its issue, never shown in the
archive beyond the quotes), the email and the Access-gated archive carry the model's Chinese text, quotes of at most
300 characters and links, and the Economist, the FT and Nikkei Asia give headlines only (signal-only). Crossref
abstracts may be the publisher's: short quotes only.

### 3.4 Volume

From the research (calendar-day averages; arXiv announcement days carry about 1.4 times this):

| | Raw a day | After deduplication |
| --- | --- | --- |
| Research | about 250: arXiv 150 (the queries overlap; about 190 before the query fixes of 2026-10-10), Hugging Face 50, journals 50, labs and analysis 8 | about 170 |
| World | about 200 headlines | about 45 stories |
| Requests | about 60 feed polls, 10 arXiv pages, 6 Crossref calls, 8-16 pages and the robots.txt of about 10 article hosts (cached a day) | spread over about 10 alarms |

arXiv dominates; geophysics is thin there (3-6 a day), so the journals and Crossref carry that topic.

## 4. Deduplication, mentions and clusters

- **Canonical key**: the arXiv ID without version; else the DOI, lower-cased; else the normalized URL (`https`, lower-case
  host, no fragment, no `utm_*`/`fbclid`/`gclid`, Nature's `error=cookies_not_supported` dropped, no trailing slash).
  The same key from another source adds that source to the item (Hugging Face's upvotes, a second arXiv query).
- **Mentions**: the text of a `feed_full` or `page_full` item (Import AI, Interconnects, Ahead of AI, a lab's post about
  its own paper) is searched for arXiv IDs and DOIs; each one that names an item of the last 7 days records a mention
  on it (the mentioning source and item, never the text), and one that names an item not fetched yet (a post polled
  before arXiv's page) is kept 7 days and recorded when the item comes. A mention is corroboration (§5.2); the post
  stays an item of its own.
- **Never repeat**: every key that ran is kept 400 days (`sent_keys`) and never runs again. When a world story runs, its
  whole cluster has run: the members it had never make a card again, and a member that comes later makes one only
  marked 已报道 with the title that ran. An item at cosine ≥ 0.88 to one that ran in the last 7 days is held back the
  same way, computed at each cutoff against what ran by then (a post embedded before its paper ran included): it
  reaches the pick only marked 已报道 with the earlier title, the pick takes it only for a real new development and
  names it in its reason (§5.3), and the writer then gets the earlier title too.
- **Embeddings**: Workers AI `@cf/baai/bge-m3` (mailsort's model) of the title and the summary's first 600 characters
  of every candidate, 50 texts a call: about 7 calls and 70 neurons a day (1,075 neurons per million input tokens),
  against the account's free 10,000 a day that mailsort mostly uses; the brief caps itself at 500. Stored as 1,024
  float32 values. They serve three things only: the world clusters, the hold-back above, and the score of a research
  candidate Haiku refused (§5.1), for which the profile's topic descriptions are embedded once per profile version.
- **World clusters**: a new world item joins the most similar world cluster of the last 72 hours at cosine ≥ 0.86, else
  it starts one; the centroid is the normalized mean. A cluster counts its independent candidate sources (distinct
  registry names) and its signal-only ones, and knows whether a member's full text is readable. The threshold is a
  starting value: the shadow week logs pairs near it (IDs and cosines only) to set it. Research has no embedding
  clusters: the arXiv ID and the DOI already join the same work across sources, and a post about a paper is linked by
  its mention, not by similarity.
- Without embeddings (the quota, or Home's guard) items deduplicate by key only, each world story is its own cluster,
  the hold-back is by key only, and a refused research candidate stays unscored.

## 5. The gate, corroboration and the pick

### 5.1 The gate

Claude Haiku 5.5 (`claude-haiku-5-5`) screens every new candidate in the round that fetched it: groups of 12 per call,
up to 10 calls a round, about 30 a day; `output_config.effort: "low"`; structured output
`{"scores": [{"id", "topic", "score"}]}` (`score` 0-10: relevance for research, importance for world, as `profile.md`
defines them; `topic` one of the profile's IDs). It only gates. An abstract read alone, once, cannot say how much a
paper matters (every abstract claims novelty), and absolute scores from separate groups of 12 drift; the comparison
is the pick's (§5.3). The system block is `content-config/profile.md` and the rubric, frozen, with one cache
breakpoint at its end (above the 512-token minimum; the round's calls run back to back within the 5-minute TTL). A
candidate is its section, venue, review status, title, the summary's first 1,200 characters and its other venues (the
item's, or for world its cluster's). At most 400 candidates are screened a day; past that, the rest wait for the next
day's rounds, the highest-weight sources first.

**Refusals.** Haiku's classifiers decline in four categories: `cyber`, `bio`, `frontier_llm` ("could assist the
development of competing AI models": a risk for every LLM architecture, training and inference abstract, the owner's
main topic) and `general_harms` (war and disaster headlines can trip it); Haiku has no server-side fallback. A group
answered with a refusal or an answer the schema check refuses is split in two and tried once more. A candidate still
refused is not dropped. A research candidate takes the nearest topic by embedding, and a score from its similarity to
the profile's topic descriptions: the similarity's percentile among that day's Haiku-scored candidates gives the score
at the same percentile of their scores, so there is no constant to calibrate. A world candidate takes its cluster's
Haiku score when another member has one, and otherwise passes the gate when 3 or more independent sources carry its
story. Each is marked `gate: fallback` and counted (`score_refused`); above 5% of a day's candidates, the warning
`gate_refused_high` says the main topic may be shrinking.

**Synchronous, not the Batches API** (a deviation, §19): batching would save half of about $0.60 a month, and costs a
state machine of its own: a create without an idempotency key (a crash leaves a stray batch), polling alarms, a cutoff
that cancels and scores synchronously anyway, and request errors that only show at the end. Synchronous calls fit the
rounds' alarms. Revisit past about 1,000 candidates a day.

### 5.2 Corroboration and the gate order

The order is computed again at every cutoff from the item and its cluster as they are then, because the signals that
say a paper matters arrive after the gate call (upvotes a day later, a mention when the blog posts):

```
research: order = score × w_source × w_topic + c
          c     = min(3, 0.75 × (independent sources − 1) + 1 × [mentioned] + 1.5 × upvote percentile)
world:    order = score × w_source × w_topic + 0.5 × log2(candidate sources + 0.5 × signal-only sources)
                  + 1 × [a member's full text is readable]
```

Independent sources are distinct registry names (two arXiv queries are one); the upvote percentile is among that
day's Hugging Face list (0 when absent); a full text is readable when its tier is `feed_full`, or `page_full` on a host
whose robots.txt allows it (§3.3). `w` ∈ [0.6, 1.4] are the weekly weights (§10). The constants are starting values
(`limits.ts`) the shadow week sets.

**Cards.** At the cutoff: the research items that passed the gate (score ≥ 6), are eligible (§2) and never ran, the 40
best by order with every topic's best 3 (a 专业 topic's 5) kept first and at most 10 per topic, on a tie the newer
item first (corroboration reaches ML papers only, so order alone could leave the owner's own field without a card);
and the world clusters with score ≥ 6 and at least one candidate source, the 10 best.

### 5.3 The pick

One Opus call at the cutoff reads the cards side by side and picks up to 3 world stories and up to 8 research items (at
most 2 per topic), 8 items in all (the policy's 5-8), fewer when fewer deserve it, each with a reason of at most 60
characters that the archive shows.
This is where quality is decided, so it uses the best model, as the owner chose: about 15K tokens in, about
$0.10-0.20 a day.

- A card: its ID, section, topic, venue(s), review status, title, the summary's first 800 characters, its
  corroboration in words (2 个独立来源; Import AI 链接; Hugging Face 当日前 10%), whether its full text is readable, and
  已报道 with the earlier title when held back (§4). The system block is the profile with its 挑选 rubric; the user
  turn holds the cards and each topic's current weight as a number (from the owner's votes, never a voted title: §10).
- Request: `claude-opus-5-5` through `client.beta.messages.stream`, `fallbacks: "default"` as in §7, effort `medium`,
  `max_tokens` 32,000, structured output `{"research": [{"id", "reason"}], "world": [{"id", "reason"}]}`. The reason
  says why the item matters to this reader; it does not ask for the model's reasoning (a `reasoning_extraction`
  decline is never retried by the fallback).
- Code keeps only card IDs, at most 3 world and 8 research with 2 per topic, 8 in all, in the pick's order. A refusal, an invalid answer or a
  failure, after one retry, falls back to the gate order (§6): the issue never fails for its pick (`pick_fallback`,
  info).

## 6. Shortlist, formats and full text

The weekday shortlist is the pick's (§5.3). Without a pick it is the gate order: world, the 3 best clusters with score
≥ 7; research, cards up to 8 items in all, each topic's best first and at most 2 per topic. At most 8 packets; fewer is
fine.

Full text, for the shortlisted items only (world: the cluster's two best candidate documents, readable full text
first), by each source's `text` tier and the robots rule (§3.3): the arXiv HTML version (`arxiv.org/html/<id>`,
`Crawl-delay` 15, so 8 papers take two minutes) or the abstract when there is none; pages through a streaming
HTMLRewriter extraction (the main or article text with its headings; scripts, styles, navigation, asides, footers and
elements hidden by their own markup (`hidden`, `aria-hidden`, an inline `display: none`) dropped; character references
decoded; the charset decided first, as the watch app does; each MathML element replaced by its `alttext`, since arXiv's
HTML carries a formula twice and garbles it as text); 2 MiB and 15 s a page. Each
document is cut to 16,000 characters, keeping the abstract and, when a heading names it, the conclusion or discussion
(a quarter of the budget). A page that fails falls back to the feed's text, marked. A host that is not ready is waited
for at most 10 minutes at a time and never past an hour before the send: one backing off for longer (a 429's backoff
doubles up to 6 hours) leaves its document with the feed's text, and while the read waits the fetch rounds run. This
takes one or two alarms.

Each packet carries a **format**, from its topic's 写法 in `profile.md` and from what was read:

| Format | For | Length | Claims |
| --- | --- | --- | --- |
| 专业 | the owner's own field (`geo.seismology`, `geo.ml` to start): the field's terms, no definitions, only what was done, found and how it differs | 60-120 characters | at least 1 |
| 熟悉 | a neighbouring field (`geo.earth`) and the LLM topics (`llm.architecture`, `llm.systems`, `llm.agents`; the owner's answer of 2026-10-10): only sub-field terms explained | 100-180 | at least 2 |
| 通俗 | every other topic, world included: every term defined on first use, as the old reader profile asked | 120-250 | at least 2 |
| 世界·短 | a world story of which only summaries or a lead were read (a page behind a paywall or too short, a page the brief's robots.txt group closes) | 60-100: the fact and why it matters | at least 1 |

A Chinese paraphrase of an English abstract with its terms explained is worth less to a reader in the field than the
abstract itself, so the 专业 format is short and dense. 世界·短 exists because the policy's background (原有局面, 各方,
影响渠道) written from a summary is either thin or filled in from memory, which cannot be cited.

A packet is `{id, section, topic, format, held_back, documents: [{doc, venue, review, text_scope, title, published,
text}], signals: [headline, ...]}`; signals are listed for importance and are not citable. It carries no link: the
source line and its links are code's (§7, §11).

**还有.** After 研究前沿, up to 5 more items of the 专业 topics from the cards the pick did not take (gate order): the
original title, the venue, the review status and the link, rendered by code. In the reader's own field a title is
enough to decide; nothing is written, so nothing needs checking, and no full text is fetched. An item is listed in 还有
once; the pick may still take it later.

## 7. Writing

One Opus call writes the whole weekday issue (one call keeps it coherent: no story twice, the sections balanced), with
the whole shortlist; Opus may leave a weak packet out (`omitted`), and a short issue is fine.

- Request: `claude-opus-5-5` through `client.beta.messages.stream` with `betas: ["server-side-fallback-2026-07-01"]` and
  `fallbacks: "default"`; thinking adaptive (always on in Opus 5.5, so omitted); `output_config: { effort: "high",
  format: { type: "json_schema", schema } }`; `max_tokens` 64,000; no sampling parameters, no prefill. About 5K tokens
  of the answer are visible (1,500 Chinese characters, 16-24 English quotes, the keys), and Opus 5.5 thinks more per
  turn at a given effort than Opus 5, so 15-30K output tokens are expected; a lower limit would truncate, and a retry
  of the same request would truncate the same way.
- Prompt: two system blocks, frozen and without a date. The first is `content-config/policy.md` then the profile, the
  same bytes in every writer call (the write, the bisection, the repair, the deep read and its repair), ending in the
  one cache breakpoint (the default 5 minutes): the spec's caching of the stable prefix. The second is that call's
  output rules. The user turn holds the date, the packets with their formats (in the pick's order), and the 已报道 titles.
  The breakpoint pays when a writer call starts within 5 minutes of the previous one's start (a bisection after an early
  refusal, a repair after a short write, a call run again after a deploy killed it early: a read at $0.20 instead of $4
  per million); after a long write the repair misses it and the prefix, about 3.4K tokens, is written again at 1.25
  times the input price: about $0.003 a call, $0.1 a month. The reservation counts the prefix at that write price (§13).
- Output: `{"items": [{"packet", "section", "title", "paragraphs": [{"heading", "text"}], "why", "claims": [{"n",
  "doc", "quote"}]}], "omitted": [{"packet", "code"}]}`; a paragraph cites claims as `[n]`; a weekday item's headings
  (its rules leave them empty) are dropped when the answer is read. The source line is not the
  model's: code renders it from the registry and the fetch (venue, review status, whether only an abstract was read,
  the link).
- Reading the answer: the JSON is every `text` block of `content` joined in order. A fallback during the stream leaves
  the declined model's partial text, a `fallback` block, then the fallback model's continuation (the API hands it the
  partial as context), so the first or the last text block alone would be cut JSON and waste an attempt; a test
  streams exactly this.
- Runtime: SDK `timeout: 120_000` (it covers only the time to response headers, a declined attempt before a fallback
  included) and `maxRetries: 0` (the alarm chain retries); the stream has its own deadline,
  `signal: AbortSignal.timeout(min(13 min, alarm time left − 60 s))`, because nothing in the SDK bounds a stalled body;
  the call is the first thing its alarm does and never starts with less than 11 minutes left. Before the call an
  attempt row commits with the build's `BUILD_SHA` and the reserved cost (§13); `message_start`'s usage (the input
  tokens, the model) is stored when it arrives; `finalMessage()` is stored at once (the JSON, the usage, the request
  ID, the model that served it, the stop reason), and its cost replaces the reservation.
- Outcomes:
  - `end_turn` with a valid answer goes to the check; one whose items are all `omitted` ends the day with the note.
  - `max_tokens`, the deadline or a stall: the same request would run as long again, so the shortlist is halved through
    the bisection below (each half writes about half as much; a half that runs out again is halved in turn), within
    its 4 calls; with one packet, another attempt.
  - An invalid answer or a mid-stream error (an `overloaded_error` after HTTP 200 arrives as an `APIError` without
    status and is not retried by the SDK) uses one of 3 attempts, 15 minutes apart; an answer that is no JSON is never
    stored to be read again.
  - A deploy that kills the call does not use an attempt: the attempt row's `BUILD_SHA` is older than the running
    build's and no final message was stored (a deploy kills in-flight work after 30 s, and every change to `proto/` or a
    shared package redeploys the brief). The call runs again at once, bounded by the send cutoff and the monthly budget
    (a killed call keeps its reservation).
  - 408, 409, 429, 529 or 5xx before the stream starts costs nothing and is retried with backoff until the send cutoff.
  - No call starts past the send cutoff (12:00): every retry is due at the cutoff at the latest, where the step ends the
    day with its note, archived (`issue_missed`); an earlier day's unfinished run is stepped at once, so it never holds
    up the next day's.
  - Paused (设置 → 暂停) or switched off (`BRIEF_MODE=off`) while an issue runs: the model calls stop at once (both are
    read at the moment of every call); the step uses no attempt, looks again every 10 minutes and resumes when the stop
    lifts, or ends the day at the cutoff (archived: 发信时已暂停, 部署为关闭模式).
  - Any other 4xx before the stream starts is a state that repeats, not a bad moment: 400 (a beta header the
    organization is not enabled for, a credit or limit message, a request the API refuses), 401, 402 `billing_error`
    (the credits are used up), 403, 404 (a model the organization cannot use), 413. Every model call stops at once, no
    attempt is used, and the critical signal `anthropic_rejected` carries the status and the error type (never the
    message's text), until the key changes (the object keeps a SHA-256 prefix of it, never the key), a new build
    deploys, or the owner presses 设置 → 恢复调用. Otherwise a gate that scores nothing would end the day in
    `STATE_EMPTY` and look like a quiet day.
- Refusals. Opus 5.5's classifiers decline in an open set of categories (`cyber`, `bio`, `reasoning_extraction`, and
  any the API adds). The server-side fallback answers most declines with the model Anthropic routes that category to
  (Opus 5 or Opus 4.8, at $5/$25 per million dearer than Opus 5.5: reservations are priced at that, §13), which the
  issue records (`writer_models`, and the footer names it). A final `stop_reason: "refusal"` (the whole chain declined,
  or a category the fallback never retries, such as `reasoning_extraction`) discards the output and bisects by packet,
  so one packet never fails the issue or takes a topic with it: the call runs again without the packets that hold a
  candidate Haiku refused (§5.1), then, still refused, on each half of the shortlist, and so on until the refused
  packet is alone and dropped (`packet_refused`, info). At most 4 extra calls, within the send cutoff and the budget;
  the halves that answered make the issue.

## 8. The grounding check

`ground.ts` checks the writer's answer against the packets it was given, the exact text the Worker fetched, never a new
fetch. Normalization `N`, applied to quote and text alike, keeps a map from each normalized character back to the
original: NFKC; lower case; soft hyphens and zero-width characters removed; a word hyphenated across a line break
joined; curly quotes made straight, the dashes `‐ – — −` made `-`, `…` made `...`; citation marks removed (bracketed
numbers `[12]`, `[3, 7]`, `[4–6]`; parenthesised author-year citations `(Smith et al., 2020)`, `(Li and Wang 2019;
Chen 2021)`; footnote marks, superscript digits and `* † ‡ §` after a word); whitespace collapsed; spaces between CJK
characters removed. MathML is already its alt text (§6).

1. **Claims**: each names a document of its item's packet that is citable (a candidate's, never a signal); its quote is
   20-300 characters after `N` (8 or more when mostly CJK) and holds no `...` (no splicing). It is found when `N(quote)`
   occurs in `N(text)`, or else when an alignment finds at least 90% of its tokens (words; CJK characters one by one) in
   order within a window of the text at most 1.2 times its length, and the words it left out or added hold no negation
   (`not`, `never`, `without`, 不, 未: a quote that drops a `not` says the opposite): a model silently fixes a
   spelling, drops a footnote mark or reads a formula its own way. The claim then keeps the source's exact span (the original characters, mapped
   back through `N`), and the archive shows that span, so a displayed quote is verbatim whatever the model typed. The
   alignment runs only when the exact match fails (at most a few milliseconds a claim; the CPU test bounds it).
2. **Markers**: every paragraph cites at least one claim; every `[n]` names a claim of the item; every claim is cited.
3. **Numbers**: every token with a digit or a Chinese numeral in a paragraph is classified first.
   - **Identifiers**: digits joined to Latin letters or inside a hyphenated name (`GPT-5`, `H100`, `FP8`, `3D`,
     `Qwen3-235B`, `Llama-3-8B`), except digits followed only by a scale suffix (`7B`, `128K`, `1.5T`, `70M`), which are
     quantities. An identifier must occur verbatim (after `N`) somewhere in the item's documents: a model or a chip is
     checked as a name, not as a number.
   - **Dates and times** are exempt: years (1900-2100, alone or with 年), months and days (`9 月 17 日`, `17 日`),
     quarters (`Q3`, `第三季度`), decades and centuries (`90 年代`, `20 世纪`), weekdays and clock times (`3 点`, and
     `分` or `秒` only after a clock: `3 点 20 分`; `提升 3 分` and `20 秒` are quantities).
   - **Quantities**, everything else: ASCII or full-width digits, with a decimal part or thousands separators; an
     adjacent `%` or 百分之; scale words alone or compound (千, 万, 亿, 百万, 千万, 十亿, 千亿, 万亿; thousand, million,
     billion, trillion; k, K, M, mn, B, bn, T); an earthquake's magnitude written joined (`M7.1`, `Mw6.8`). A quantity
     matches a number in one of that paragraph's quotes (a title's, a why's or a heading's: in any of the item's
     quotes), scales applied on both sides and English number words read on the source side (one to twenty, twice,
     double, triple, half), when the source number rounds to the written one at the precision written (its significant
     figures, an integer's trailing zeros not counted) and lies within 10% of it. `约 15 亿` matches 1.47 billion and
     `1500 万` matches 15.2 million; `15.0 亿` does not match 1.47 billion, nor `10 倍` 5.2x (one significant figure
     alone would allow it). (A fixed 0.5% tolerance flagged ordinary Chinese rounding: 15 亿 for 1.47 billion is 2%
     off.)
   - **Chinese numerals in a quantity** (a Chinese numeral, 几 or 数 before 倍, 成, 万, 亿 or 百分之; 近, 上, 过, 破, 逾
     or 超 before 万, 亿, 千 or 百; 翻一番 and 一半: 两倍, 三成, 数十亿, 近万; not 一番, 一成不变, 半成品 or the adverb
     千万): this is where an overstated quantity would hide. The policy writes quantities in Arabic
     digits, so each is `number_style` and goes to the repair, which rewrites it (`三成` → `30%`) to be checked as a
     quantity. Counts in words (两种方法, 三位作者) are ordinary Chinese and not checked.
4. **Links**: no title, why, heading or paragraph holds a URL, an e-mail address or a domain name with a common
   top-level domain (`link_in_text`). The writer writes none, so one can only come from text a fetched page planted
   (hidden text included), and mail clients make a bare domain a link.
5. **Items**: a research item cites its primary document; a world item cites a candidate source; each meets its
   format's claim minimum (§6).

The classifier has its own synthetic test set: Chinese paragraphs and English quotes written for the tests, no real
article, covering each class, the rounding cases and the style flags (§17).

A failing item gets codes (`quote_not_found`, `doc_not_citable`, `identifier_not_found`, `number_unsupported`,
`number_style`, `link_in_text`, `uncited_paragraph`, `unknown_marker`, `unused_claim`). All failing items go back together in **one
repair call** (the next alarm, `max_tokens` 32,000): only their packets, their JSON and the codes with the offending
quote, number or sentence, the same rules. Checked again, what still fails is cut at the smallest unit, not the item:
a sentence with a failing number, identifier, style or link is removed (sentences end at 。！？；), a failing claim is
removed with the sentences that cite only it, a failing why or heading is emptied, and markers are renumbered; an item
whose title still fails is dropped. An item that loses more than a third of its
characters, its primary document's claims or a whole paragraph is dropped (`dropped_item_count`). When more than 40%
of an issue's items are dropped, the warning `ground_drop_high` tells Home; the rest still goes out. A weekday issue
with no item left sends the note of §11 (`STATE_EMPTY`), as does one whose writer left every packet out
(`all_omitted`).

**No model review pass, and an entailment log.** The newsletter's cost went into a writer and a reviewer each
re-researching every story; a reviewer of the same model is not an independent check (the old editorial policy says so
itself); and the failures a reviewer would catch most cheaply, invented quotes, names, numbers and sources, code
catches for free. What code cannot see is a real quote under an overstated Chinese sentence. So from the first archive
day one Haiku 5.5 call per issue (effort `low`) reads each claim's citing sentences against its verbatim span and
answers `{"verdicts": [{"item", "n", "verdict"}]}` (`supported`, `overstated` or `unsupported`): about 15K tokens,
under $0.05 a month. It only logs: the archive shows each claim's verdict by its quote, ServiceStatus counts them, and
the send never waits for it. After the shadow week, with the verdicts set against the owner's reading, the owner
decides whether `unsupported` sends a claim to the repair. A refusal or a failure leaves the verdicts empty
(`entail_skipped`, info).

**Not the Citations feature.** The API's citations would make quotes verbatim by construction (`cited_text`), but they
cannot be combined with `output_config.format` (a 400), so the issue's structure would move into markup that code
parses. Aligning, then keeping and showing the source's own span, gives the same guarantee for what is displayed and
keeps the schema. Revisit if the archive days show many `quote_not_found`.

The email drops the markers; the archive shows them, each opening its quote (the source's span), its verdict and its
document.

## 9. The weekend deep read

On Saturday the candidates are the week's cards (Saturday to Friday, by gate order, briefed ones included: the deep
read explains more, so `sent_keys` does not apply). One Opus pick (effort `medium`, `max_tokens` 32,000, about 12K
tokens in) reads the 30 best, each marked with whether its full text is readable and with the owner's votes on it,
plus the titles of the last 4 deep reads, and answers two ranked threads: `{"threads": [{"title", "angle", "ids",
"reason"}]}` (3-8 card IDs each). The profile's 深读挑选 asks for a thread near the 专业 and 熟悉 topics when full text
allows, and for none of the last 4. Code takes the first thread with at least 2 documents whose full text is readable,
else the second; with neither, Saturday has no deep read and the note of §11 says so (`deep_read_none`, info). One
decision a week needs no thread builder of its own: no seeds, similarity thresholds, member caps or vote bonuses to
calibrate, and no rule that quietly favours the topics with the most full text.

The thread's documents (at most 8, 16,000 characters each, about 45K tokens) are fetched over two or three alarms; one
Opus call at effort `high` with `max_tokens` 64,000 writes `{"title", "paragraphs": [{"heading", "text"}], "claims"}`:
1,500-2,500 Chinese characters (outside 1,200-3,000 is a failure for the repair), two or three headings, in its
topic's format. `xhigh` thinks longest, its turns run longest on Opus 5.5, and the call must end inside the alarm's
15 minutes (§7's 13-minute deadline), so `xhigh` (with 96,000) waits for the archive days' measured durations (§19).
A deep read that ran out of tokens or time is tried again at once with the thread's first 4 documents (the same request
would run as long again; the effort stays `high`, the owner's choice). The same check; the repair rewrites the failing paragraphs; what still fails is cut by sentence (§8), and when more
than a quarter of the text is cut the deep read is not sent (`STATE_FAILED`, `deep_read_ungrounded`).

## 10. Feedback and learning

**Links.** Each item of the email ends with 👍 · 👎 · 多来点, each `https://brief.ziyixi.science/feedback?t=<token>`:
`base64url(issue, item, vote, expiry in 30 days) "." base64url(HMAC-SHA-256(FEEDBACK_SIGNING_KEY, payload))`,
truncated to 128 bits. `/feedback` is the exact path of an Access Bypass application. The Worker verifies the token
before anything else (no object call, a 404 for a bad or expired token or another method), then: GET answers a small
page with the item's title and one button (`记下 👍`, `记下 👎` or `多来点`; `no-store`, `noindex`, no referrer, no
script); POST (that button, the token in the form body) records the vote in the object. Two taps on purpose: mail
scanners and link prefetchers open GET links, and votes they cast would teach the profile noise. The route reads no
cookie and shows nothing but that title; its key is its own, not the owner's (a machine route never inherits owner
rights). In the archive the same buttons call VoteItem. A vote replaces the item's earlier one.

**Weekly update** (Sunday 12:00; Home's guard may defer it): for each source and each topic, over the last 8 weeks of
votes after the last reset, with `n` its items that ran and `s = up + 2 × more − 2 × down`:
`w = clamp(1 + s / (n + 10), 0.6, 1.4)`. The prior of 10 means a few votes move a weight a little. The weights order
the gate and the cards (§5.2), and the pick reads each topic's weight as a number (§5.3). No second, per-item mechanism
(a bonus for similarity to voted items): at about one vote a day it would learn from too little, and two mechanisms on
sparse votes could not be told apart.

It never rewrites `profile.md` and never puts voted titles into a prompt: titles are untrusted text, and a prompt that
grew from them could be steered. The profile's words stay the owner's. 来源 and 偏好 in the archive show every weight
and its votes; ResetProfile puts them back to 1 and ignores earlier votes.

**Recall's reading history** (a hook, not built): a later named entrypoint `Signals` on the brief Worker, which recall
binds with `props = { source = "recall" }` (least privilege, as the watch app binds Todofy's `Intents`), with one method
`recordReads([{uri, read_time}])`. The brief keeps only reads whose canonical key matches an item it fetched in the last
30 days, as a vote of origin `recall` worth half a 👍, and drops the rest unlogged. The votes table has `origin` from
the start; the contract goes into `contracts/` when recall exists.

## 11. The email and the archive

**Subject**: `简报 · 10月12日（周一）`; Saturday `深读 · 10月17日：<title>`; in shadow mode prefixed `[影子版] `.

**Email**: one column, at most 600 px; the system font stack with PingFang SC and Noto Sans SC; 17 px text, line height
1.75; inline styles, plus a head `<style>` with `@media (prefers-color-scheme: dark)` and the `color-scheme` meta for
clients that honour them, and colors that survive Gmail's forced dark inversion (no background images, no pure black on
white panels). No image, no remote resource, no tracking pixel, no script; under 60 KB of HTML (Gmail clips at 102 KB);
a text/plain part with the same words. The model's text is typeset for the email only (a space between Han characters
and Latin letters or digits, the `[n]` markers dropped); the check and the archive keep it as written. Items follow the
pick's order whatever order the writer, the bisection or the repair answered in. A weekday issue:

```
简报 · 10月12日（周一）
研究前沿
  标题
  一两段正文（专业主题更短、更密）。
  为什么看：一句。                                       (muted)
  Nature Geoscience · 同行评议 · 仅摘要 · 原文           (the source line, by code)
  👍  👎  多来点
  …
  还有                                                   (专业 topics: original titles, by code)
    <title> · Seismica · 同行评议 · 原文
世界与经济
  …
网页版 · 6 条 · 本期 $0.82                               (footer; names the writer model after a fallback)
```

The source line: the venue (up to three, joined by 、), the status in words (同行评议, 预印本（未经同行评议）, 机构发布,
评论, 新闻报道, 官方发布, 数据), 仅摘要 when only an abstract or feed text was read, and 原文 (the arXiv abstract page, the
DOI link or the article). The deep read has its headings and lists its sources at the end.

**A quiet day is said, not silent.** A weekday with no item, or a Saturday without a deep read, sends a two-line note
instead of nothing, through the same ledger (one send a day): the subject `简报 · 10月12日：今日无条目` (Saturday
`深读 · 10月17日：本周无深读`) and one line with the reason in words: 没有新的候选, 候选未能打分, 入选条目都未通过核对,
没有可读全文的线索, 预算已用完, 调用被拒 or 写作未能完成 (the writing ran out of its attempts). A breakage then never looks
like a quiet day; the signals (§15) say the same on Home.

**Archive** (`web/`, plain TypeScript DOM, the light and dark tokens of mailsort's design system, 16 px gutters, works at
360 px, no external resource): 期刊, the issues newest first (date, kind, title, items, cost; a chip for 影子版, 无条目,
未知 or 未发送); an issue, its items as in the email with the pick's reason for each, the `[n]` markers as superscripts
that open their quote, its verdict and its document, the vote buttons showing the current vote, and the footer with
成本明细 (each step's tokens and dollars); 来源, each source's state (failing, paused, stale), recent volume, last
accepted item and weight; 偏好, the topic weights and 重置; 设置, 暂停, 恢复调用 (after `anthropic_rejected`) and the
monthly budget, under a status line (mode, next run, today's and the month's cost).

As built (2026-10-10): four tabs over the paths `/` (期刊), `/issues/<date>`, `/sources`, `/profile` and `/settings`;
the accent is the amber of the brief's Home tile and problems are drawn in red, so that a warning never reads as the
accent. A quote opens under its paragraph; its verdict reads 模型核对 (the entailment log only logs). 来源 folds the
disabled sources away and names a source by its registry ID where several share a venue (the six arXiv queries). 设置
shows the mode as the deployment's, not the owner's to change (§19). Titles, texts, quotes and links are untrusted: set
as text, and a document is linked only when its address is http(s). The JavaScript is 47.7 KiB gzip against a 57 KiB
budget (`web/scripts/js-budget.mjs`).

## 12. The delivery ledger

The newsletter's lessons (`newsletter/src/newsletter/store.py`, `delivery.py`, `adapters.py`), kept:

- **One send per day**: `sends.issue_date` is the primary key; the idempotency key `brief-<date>` is unique; the render
  hash is frozen with the row. A quiet day's note (§11) is that day's one send.
- **Reserve first**: the row, state `submitting`, commits before the request, and the request carries exactly the
  frozen render.
- **One attempt**: `POST https://api.resend.com/emails` with `Idempotency-Key`, 30 s, no redirect, no client retry.
- **Outcomes**: 2xx with a message ID is `accepted` (Resend took it; not proof of inbox delivery). A 4xx other than 408,
  409 and 429 is `rejected`: not sent, not retried (`send_rejected`). Anything else is `unknown`: no answer, a timeout,
  408, 409 (Resend's answer while the same key is in flight), 429, 5xx, a malformed 2xx, an exception, or a `submitting`
  row a later alarm finds after a crash. **An unknown send is never made again**: not with a new key, not after
  deleting the row, not after a deploy. `send_unknown` tells Home; the owner checks the inbox; the archive has the issue.
- No test or verification send ever goes to Resend from production; tests use a fake on loopback.

Whether a send may go out is read at the moment of the send: the mode in force is `shadow` or `live`, the brief is not
paused, the issue (or the note) is ready, the time is before the cutoff (12:00), and the mail secrets are set. Otherwise
the issue is `STATE_ARCHIVED`.

## 13. Costs and budgets

`prices.ts` holds the prices per million tokens (the pricing page, 2026-10-10): Opus 5.5 $4 input, $5 cache write
(5 minutes), $0.20 cache read, $20 output; Opus 5 and Opus 4.8, the fallback targets, $5 input and $25 output; Haiku
5.5 $0.10, $0.125, $0.01, $0.50 (prompts up to 100K). Every call's `usage` becomes dollars: `input_tokens` is only the
uncached rest, output includes thinking, and with fallbacks every entry of `usage.iterations` is summed at its own
model's prices (a declined attempt, whose entry does not say why, at Opus 5.5 prices). Workers AI neurons are
estimated from reported tokens, as mailsort does.

Estimated per step (to be measured in the archive days and the shadow week):

| Step | Model | A day | Cost |
| --- | --- | --- | --- |
| Fetch, robots.txt, full text | none | about 100 requests over about 10 alarms | $0 (Workers Free) |
| Embed | bge-m3 | about 7 calls, 70 neurons | $0 (the free allocation) |
| Gate | Haiku 5.5, effort low | about 30 calls, 165K tokens in, 8K out | about $0.02 |
| Pick (weekday) | Opus 5.5, effort medium | 1 call, about 15K in, 4-8K out | about $0.15 |
| Write (weekday) | Opus 5.5, effort high | 1 call, about 45K in, 15-30K out | about $0.50-0.80 |
| Repair | Opus 5.5, effort high | 0-1 call, about 10K in, 3-6K out | about $0.10-0.15 when needed |
| Entailment log | Haiku 5.5, effort low | 1 call, about 15K in, 2K out | under $0.01 |
| Deep-read pick (Saturday) | Opus 5.5, effort medium | 1 call, about 12K in, 4-8K out | about $0.15 |
| Deep read (Saturday) | Opus 5.5, effort high | 1 call, about 50K in, 25-45K out | about $0.70-1.10 |

A month: 22 weekdays at about $0.85 (the pick, the write, a repair every other day), 4 Saturdays at about $1.1, and
about $1 of gating and logging: **about $20-30 a month**, the figure to plan with. That is above the spec's $15-25 aim
at its top, because the pick (about $3.5 a month) buys the selection the owner put first and Opus 5.5 thinks longer at
`high` than the first estimate assumed; it stays well under the $100 of credits. Against today's bill the newsletter
adds $0 (a ChatGPT subscription login, not an API key), so the brief costs about $25 a month more in included credits.
The gate keeps one breakpoint (its calls run back to back), the writer calls share one on their frozen prefix (§7), and
the picks have none (one call a day each). Output and thinking dominate, so effort is the lever.

**Three walls**, metered in code:

1. **The call's reservation.** Before every model call its maximum is reserved: the estimated input and `max_tokens`
   at the dearest model that may serve it (an Opus call at its fallbacks' $5/$25: about $1.85 for a 64K write). The call
   starts only if every reservation in flight still fits under what is left of the month's budget. When the final
   message arrives, its real cost replaces the reservation. A call that dies keeps its reservation: the stream reports
   output tokens only in its last event (`message_delta`) and the thinking text is omitted, so what a dead call
   generated cannot be counted from what streamed (only its input, from `message_start`); the conservative charge is
   rare enough (§7) to stand.
2. **The month's budget**, `Settings.monthly_budget_usd` per calendar month (default $40). Past it no call starts
   (`budget_spent`: critical when it blocks an issue's call, info otherwise).
3. **The Console workspace's spend limit** (suggested $50), the outer wall, which the brief cannot change.

On 2026-10-11 the production settings page confirmed the owner's saved **$80** monthly budget in 设置. It is persisted
in `BriefState` and must survive deployment. The initial code default remains $40, and the actual Console workspace
limit has not been verified; the $50 above is the original recommendation, not a record of its current setting.

No per-issue or per-day cap: with 64K reservations a per-issue cap of $2.50 would leave no room for the repair, and the
attempt limits already bound an issue (one pick and its retry, 3 writes, 2 repairs, 4 bisection calls; a deploy-killed
call bounded by the cutoff), while the month's budget bounds the rest.

Shown: each issue's footer and 成本明细, ServiceStatus (today, the month, the budget) and ops-v1 for Home.

## 14. The alarm chain, storage and limits

`BriefState` does one step per alarm: read the step's state, do bounded work, commit, set the next alarm (a second later,
or the next slot). An alarm that throws is caught, logged as a code and re-armed 5 minutes later; every API call and
ops-v1 `status()` arm one when none is set (the watch app's fallback). Every step can run again: fetches are upserts by
key, model calls have attempt rows, the send has the ledger.

| Step | Work | External requests | Attempts |
| --- | --- | --- | --- |
| collect | poll the due sources; deduplicate, find mentions, embed, cluster; gate | at most 40 an alarm (feeds, Workers AI, Haiku); a round continues over as many alarms as it needs | per source and per gate group |
| pick | the order and the cards (§5.2), one Opus call | 1 | 2, then the gate order |
| shortlist, thread | SQL | 0 | — |
| read | full text | at most 40 an alarm (pages and robots.txt) | 2 per page, then the feed's text |
| write | one Opus call | 1 | 3 (a deploy-killed call not counted), plus at most 4 bisection calls |
| check, render | code | 0 | — |
| repair | one Opus call | 1 | 2 |
| entail | one Haiku call, log only | 1 | 1 |
| send | one Resend request | 1 | 1 (the ledger) |
| learn (Sunday), prune (daily) | SQL | 0 | — |

Workers Free: 10 ms of CPU per Worker request (the fetch handler does Access or the feedback token and one object call),
30 s per Durable Object invocation, 15 minutes of wall time per alarm, 50 subrequests (each SDK retry would be one; the
brief makes none), 128 MB. The CPU test (`worker/test/runtime/cpu.test.ts`, the shared meter) bounds the fetch handler,
the heaviest API calls, a collect alarm at its bounds (40 polls of 1 MiB, 120 candidates embedded, their mentions
found and the world ones clustered against 3 days of centroids), and the check over the largest answer with every quote
aligned against 16,000-character documents (measured on 2026-10-10 in reference milliseconds: the polls 474, the
embedding and gate 111, the check 219, the render 218, which derives the quotes' spans again; the fetch handler's
first request 2.2; on 2026-10-11, after the review's changes and with the issue at the pick's 8 items: the polls 523,
the embedding and gate 96, the pick 35 with its hold-back against a week of items that ran, the check 137 over 68
aligned quotes, the render 128). The bundle carries the Anthropic SDK (640.57 KiB, 114.04 KiB gzip in a
`wrangler deploy --dry-run` on 2026-10-10, no `nodejs_compat`), the protobuf-es runtime and the transcoder; its budget
is set from the first build (`deploy/bundle-size.mjs`).

| Table | Holds | Kept |
| --- | --- | --- |
| `sources`, `hosts` | per source: validators, failures, pause, accepted-item gaps (60 days); per host: spacing, backoff, robots.txt verdicts (a day) | registry size |
| `items` | key, sources, mentions, section, title, summary (at most 2,000 characters), link, times, cluster, gate score and its origin (Haiku or fallback), upvote percentile, state | 30 days |
| `embeddings` | 1,024 float32 per item | 14 days; a voted item's 90 days |
| `clusters` | world only: centroid, sources, counts, readable full text | 14 days |
| `texts` | the fetched full text of shortlisted documents (at most 16,000 characters each) | 7 days after the issue |
| `issues`, `issue_items` | the rendered issue (HTML, text), the pick's cards and reasons, its items, quotes (the source's spans), verdicts and references | 2 years |
| `calls` | every model call: step, attempt, build SHA, model served, usage, cost or reservation, request ID, stop reason, refusal category | 400 days |
| `sends` | the ledger | 400 days |
| `sent_keys`, `votes` | the keys that ran; the votes (issue, item, vote, time, origin) | 400 days |
| `pending_mentions` | an arXiv ID or DOI a post named before its item was fetched (the key, the post) | 7 days |
| `weights`, `settings`, `usage_daily`, `requests` | learned weights; the settings (with the rejected state and the key's SHA-256 prefix); per day requests, neurons, cost; AIP-155 replies | current; 400 days; 1 day |

SQLite rows are an account-wide budget (100,000 written and 5 million read a day, shared with Mail Hero, the watch app
and mailsort): at the bounds (`worker/test/runtime/bulk.ts`: 40 feeds of 50 entries, 120 new candidates a round, the
largest issue) about 6,500 written and 36,000 read a day, measured on 2026-10-11 (6,200 and 53,000 on 2026-10-10,
before the hold-back moved to the cutoff), and about 12,500 written once by the first round of a new registry; `rows.test.ts` holds each path to a budget, as the watch app's does. Storage grows about 2.5 MB a day, about 100 MB at the bounds.

## 15. Failures and operations

**ops-v1** (`Ops` entrypoint, Home's `BRIEF` binding): counters `items_today`, `candidates_today`, `gate_refused_today`,
`sources_failing`, `sources_stale`, `issues_sent_7d`, `last_issue_age_hours`, `cost_today_cents`, `cost_month_cents`,
`budget_month_cents`, `neurons_today`; modes `maintenance` (always false), `paused`, `mode_limited` (`BRIEF_MODE` below
`live`); the signals below. Counts and codes only. Home's guard defers `embedding`, `learning` and `source_probe`, never
an issue.

| Failure | What happens | Signal |
| --- | --- | --- |
| The Claude API refuses a request before its stream (400, 401, 402, 403, 404, 413) | every model call stops, no attempt used, until the key changes, a build deploys or 设置 → 恢复调用 | `anthropic_rejected` (critical; status and error type) |
| No Claude key, or no Resend key or addresses | issues are not made, or made and archived | `anthropic_not_configured`, `mail_not_configured` |
| 408, 409, 429, 529 or 5xx before a stream | retried with backoff until the cutoff, then the note, archived | `issue_late` past 07:30, `issue_missed` |
| A write runs out of tokens or time (`max_tokens`, the deadline, a stall) | the shortlist halved through the bisection | `issue_failed` when nothing answers |
| A write dies otherwise (an invalid answer, a mid-stream error) | its attempt counts; at most 3 | `issue_failed` when they run out |
| A deploy kills a write | runs again at once, no attempt used, never past 12:00 | — |
| 设置 → 暂停, or `BRIEF_MODE=off` deployed, while an issue runs | no model call starts and no attempt is used; the step resumes when the stop lifts, or the day ends at 12:00, archived | — (the archive says why) |
| Haiku refuses candidates | the fallback score (§5.1) | `gate_refused_high` (warning) above 5% of a day |
| The pick fails or is refused | the gate order | `pick_fallback` (info) |
| Opus refuses after the fallback | bisection by packet; the refused packet dropped | `packet_refused` (info) |
| A cap reached | no model call starts | `budget_spent` (critical when it blocks an issue, else info) |
| The check drops more than 40% of an issue's items | the rest is sent | `ground_drop_high` (warning) |
| An issue day with nothing to send | the note (§11) | `issue_empty` (info, with the reason) |
| The entailment log fails | the issue is unaffected | `entail_skipped` (info) |
| No issue by 12:00 on an issue day | an issue ready later is only archived | `issue_missed` |
| The send's outcome unknown | never sent again | `send_unknown` |
| Resend refused the send | not sent | `send_rejected` |
| A source silent past 3 times its usual gap (§3.2) | shown on 来源 | `sources_stale` (warning) |
| Geo research or world candidates below 30% of their 14-day median | likely a blocked publisher or a broken query | `section_thin` (warning) |
| 5 sources or more paused | each tried once a day | `sources_degraded` (info) |
| No alarm progress for 12 hours | `status()` re-arms the alarm | `scheduler_stale` |
| Home's guard sheds | deferrable work waits | `guard_shed` (info) |

Emergency stop, fastest first: 设置 → 暂停; `BRIEF_MODE=off` and a redeploy; disable the key in the Console. The first
two stop an issue already running before its next model call (a call already streaming finishes or dies; a call a
deploy killed is not run again). Logs: one line per alarm (step, counts, a code) and per refused request (request ID,
status, error type); invocation logs and traces off.

## 16. The shadow run

1. **Archive mode** (`BRIEF_MODE=archive`, one or two days): sources are fetched and paid Claude API calls run;
   issues are made and archived, nothing is emailed. Check
   every source from Cloudflare's egress (ListSources: the research fetched from a home IP, and bot walls differ:
   Wiley, Nature, Science, OUP, GSW, OpenAI, FT, NYT, the Economist; a blocked AGU journal switches to its Crossref
   alternate, §3.1), the robots verdicts, the costs, the Opus durations against the 13-minute deadline (they decide the
   deep read's effort, §9), the entailment verdicts, and the alarms' timing.
2. **Shadow week** (`BRIEF_MODE=shadow`, Monday to Saturday) beside the old newsletter: subjects tagged `[影子版]`. The
   owner compares the two each day and votes. Measured: cost per issue and per step, Opus durations, refusals (gate,
   pick, write), the pick's choices against the votes, grounding failures, sentence cuts and drops, the entailment
   verdicts, items per issue, quiet days, send times, failing and stale sources, world cluster pairs near the threshold.
3. **Decision**. Proposed bar: 5 weekday issues (or notes) and the deep read on time; weekdays at most $1.2 on average
   and the deep read at most $2; no unknown send; the owner prefers the brief. Then `BRIEF_MODE=live`, effort and
   constants set from what was measured, and the newsletter's retirement decided separately (root `AGENTS.md` then
   drops the newsletter's line).

What else depends on the VPS, for that later decision: the Newsletter itself (its k3s CronJob and config sync), the
Platform runtime (the release API and its ledger), Fleet's observer CronJob (Fleet's host, daemon and Newsletter
reports, Home's Fleet and Newsletter tiles), Todofy's report routes for the newsletter (`/api/recommendation`,
`/api/summary`: no caller would be left), CI's `newsletter_deploy` and `platform_deploy` jobs with `tools/vps-release`,
`tools/container-release` and `tools/platform-build`, and whatever else the owner self-hosts on that machine outside
this repository.

## 17. Tests

All data synthetic: feeds, pages and API answers come from fake upstreams on loopback (`DEV_FAKE_UPSTREAM`, as in the
watch app and mailsort); the fake Claude API streams SSE (thinking omitted, pings, a refusal before and during output,
a fallback before and during output, a mid-stream `overloaded_error`, a stall, every 4xx class); fake Resend and
Workers AI. CI never holds a Claude key.

- **Unit** (Node):
  - sources: the registry (loads, unknown fields refused, IDs unique); canonical keys and URL normalization; mentions
    (old and new arXiv IDs, DOIs in links and text); the parsers (RSS 2, Atom, RDF, Crossref, Hugging Face, sitemap,
    GeoJSON; Atom served as HTML; a truncated body); keyword matching (`fault*` against default, `AI` against said and
    domain); arXiv's window (a paper announced days after one already seen is still found); RFC 9309 for both tokens;
    stale cadence;
  - selection: the schedule across both DST changes and arXiv's second-cutoff eligibility; the order with
    corroboration recomputed at the cutoff; the gate's refusal fallback (the percentile mapping, the world cluster
    rule); the weights; the pick's caps and its fallback to the gate order;
  - grounding: normalization (MathML alt text, bracketed and author-year citations, footnote marks, line-break hyphens,
    curly quotes, dashes, NFKC, CJK spacing); the alignment and its exact span (a corrected spelling, a dropped
    footnote mark, a formula); a spliced quote; the number classifier on its synthetic Chinese/English set (identifiers
    GPT-5, H100, Qwen3-235B, Llama-3-8B and the quantity 7B; dates 9 月 17 日, Q3, 第三季度; compound scales 万亿, 千亿,
    十亿 and B, T, K, M; 约 15 亿 against 1.47 billion and 15.0 亿 against it; 两倍, 三成, 一半, 翻一番 flagged, 两种方法
    not); sentence cuts and an item's third; a signal cited; an uncited paragraph;
  - the model calls: the answer joined across a `fallback` block; the refusal bisection; every 4xx class (retried,
    stopped without an attempt, re-enabled by a new key, a new build or the owner); a deploy-killed attempt not
    counted; reservations at fallback prices and their release; cost from usage with fallback iterations;
  - the feedback token (signature, expiry, tampering); the ledger's mapping of every status class; the quiet-day note;
    the render (size, no remote resource, both color schemes, 还有).
- **workerd** (a real SQLite `BriefState`): a whole weekday and a Saturday over a synthetic registry; the end-to-end dry
  run of a shadow weekday (`dry-run.test.ts`: synthetic feeds and article pages, the gate, a fake Opus that picks across
  topics and writes plausible Chinese items with verbatim quotes and the quotes' numbers, one overstated number sent to
  the repair, the render in the pick's order, the entailment log, and exactly one send through the fake Resend while the
  day runs on and an alarm runs twice); a deploy in the middle of every step (the step runs again; a `submitting` row
  becomes unknown); the refusal paths of the gate, the pick, the write and the log; every wall of §13;
  `anthropic_rejected` and 恢复调用; paused and archive modes; the emergency stops during an issue (a pause after the
  pick, `BRIEF_MODE=off` and a redeploy during a write: no call after either); a write failing for a moment until the
  cutoff, and the next day's issue; a write out of tokens halved; answers that are no JSON; every packet omitted; a
  host backing off during the read; a gate call failing mid-stream; a story that ran and 还有 never repeated; the deep
  read out of tokens; the weekly learning and the reset; the feedback route (GET page, POST vote, a chunked body, a bad
  token answered without an object call); the owner API through the transcoder; ops-v1 golden bytes; the CPU and rows
  budgets.
- **UI** (jsdom) and **deploy** tests (the wrapper, `BRIEF_MODE`, the owner-machine secrets kept), as in the other apps.
- The real model runs only in the archive days and the shadow week, never in CI.

## 18. Owner steps

Completed through the first deployment on 2026-10-11:

- The owner approved the spend and successor on 2026-10-10. The implementation and owner API landed in `0e48a59`.
- "Infra apply" created `brief` and the exact-path `brief-feedback` Access applications; their identities are recorded
  in the repository. `7bea3ec` passed CI and deployed Brief in archive mode.
- A limited production check confirmed `BUILD_SHA=7bea3ec`, `MODE=archive`, the `BriefState` namespace and the names
  `ANTHROPIC_API_KEY` and `RESEND_API_KEY`. It did not read secret values or prove a successful provider call.
  The GitHub variable `BRIEF_MODE` is also `archive`.
- The production settings page confirms version `7bea3ec`, archive mode and the owner's saved $80 monthly budget.
  Preserve the persisted budget (§13); the UI's configured-provider indicators do not prove calls or delivery.

Current repository follow-up (`codex/brief-home-monitoring`): register the existing `brief-state` namespace in
`config/resources.toml` and the generated resource inventory; remove the first-deploy exceptions; connect Home's
`BRIEF` binding to Brief's `Ops`, including the bounded status/guard contracts and labels. CI must deploy Brief before
Home at the same SHA. The release and production acceptance are pending; see [`HANDOFF.md`](../../HANDOFF.md).

After that release, confirm both build SHAs, the registered namespace, Home's real Ops status, `MODE=archive` and the
preserved $80 budget. Archive-day source coverage, model quality and costs still need observation (§16). A shadow
week, live sending and Newsletter retirement each require the owner's decision; this follow-up changes none of them.
The owner manages provider keys in the Cloudflare dashboard or with `wrangler secret put`, never through chat,
issues or GitHub. The Console workspace's actual credit balance and spend limit are separate owner-side settings.

## 19. Deviations and open questions

Deviations from the spec, each for a reason:

1. **Haiku only gates; Opus picks** (§5): the spec had Haiku score and keep the top 15-20. An abstract scored alone,
   once, cannot rank significance, and that is where the old complaint (plausible but unimportant papers) comes from;
   the pick costs about $3.5 a month.
2. **Synchronous gating, not the Batches API** (§5.1): about $0.30 a month saved is not worth a second state machine.
3. **Names and numbers are checked too** (§8), not only quotes: invented figures are the costliest error, and code
   checks them for free.
4. **One model check, logged only** (§8): the spec allowed a model review only if cheap and clearly useful. The Haiku
   entailment log costs under $0.05 a month and measures the one failure code cannot see; it gates nothing until the
   shadow week shows it helps.
5. **A quiet day sends a note** (§11): the spec says never pad; a two-line status is not filler, and without it a
   breakage looks like a quiet day.
6. **The source line is code's** (§7), from the registry, so a review status is never the model's guess.
7. **Votes take two taps** (§10): a GET that voted would count every scanner's visit.
8. **Learning moves weights only** (§10), never the profile's text or a prompt: voted titles are untrusted.
9. **The owner API landed with the first implementation** (§18): its design and consumers were checked together;
   later changes follow the repository's proto compatibility rules.
10. **No owner mode in the UI**: the deployment's `BRIEF_MODE` and 暂停 cover it (less is more).

The owner's answers (2026-10-10):

1. **Writing density**: the LLM topics are 熟悉; seismology and ML for geophysics stay 专业; the other topics (IR,
   AI for science, the rest of ML, the world) stay 通俗 (`content-config/profile.md`).
2. **Robots**: full text wherever it is publicly reachable as the owner's browser would reach it; AI-agent blocks
   (`Claude-User`, `ChatGPT-User`) do not apply, a group naming `ziyixi-brief` does; polite per-host pacing and the
   honest user agent stay; paywalls and logins are never circumvented; the archive stays private behind Access
   (§3.3). arXiv's API terms (one request every 3 seconds) still apply.
3. **Deep read effort**: `high`.
4. **Spend**: approved in principle ($20-30 a month expected, an initial $40 monthly budget and a suggested $50 Console
   limit). The owner later saved an $80 runtime budget (§13).

Defaults unless the owner says otherwise: sends at 06:30 on weekdays and 07:30 on Saturday, none on Sunday; a monthly
budget default of $40 and a suggested $50 Console limit (the current runtime budget is $80, §13); the host
`brief.ziyixi.science`; the Guardian's Open Platform API and Springer Nature's metadata API off (each needs a free key
the owner sets; Springer Nature's only if Nature's feeds block
Workers).
