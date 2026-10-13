# recall design

The owner's own browsing recorder and archive on `recall.ziyixi.science`, so that years from now they can answer two
questions: **what did I do on day X**, and **where did I read that**. A Chrome extension (Manifest V3, no runtime
dependencies) records each page's visits with the time it actually had the focus, and text and a visible-viewport screenshot after ten seconds, then about once a minute; it scrubs secrets and uploads to the Worker `recall`, which keeps the records in one SQLite Durable
Object and the snapshot files of a rolling window (seven days by default, §2.3) in a private R2 bucket, indexes them for full-text
search (Chinese included), and serves a timeline and a search UI behind Access. A durable copy of everything leaves
Cloudflare as plain files in an open, versioned layout
([`contracts/recall-archive-v1`](../../contracts/recall-archive-v1/README.md)) that recall itself writes into the
owner's own Dropbox app folder (§7.2); the home NAS syncs that folder with its own Dropbox support, so no code of
recall's runs on the NAS or the owner's Mac, and any other file store can take Dropbox's place. Programs can read the
same records as a change feed.

The owner's requests of 2026-10-10 shape v1: a very good UI (easy search with conditions such as dates, site and type;
a timeline; not bloated; the design language of their other apps); generic protocols and contracts so the NAS can be
replaced later; everything built first, the owner's steps (tokens, Infra apply, loading the extension, the NAS
container) at the end. On 2026-10-11 the owner asked that they run no command at all: the machine tokens are made in
设置 (§2.2), the archive is pushed to Dropbox by recall (§7.2) instead of pulled by a NAS container, and every owner
step is a click (§11). Measured volume: about 300 visits, 190 distinct URLs and 90 pages with at least ten seconds of
focus a day. Chrome keeps 90 days of history; recall keeps everything from its first day (no backfill): every visit in
Cloudflare, every text in the Dropbox archive, and in Cloudflare the texts of the owner's retention window (§2.3,
asked for on 2026-10-11 so that Cloudflare stays within the free limits).

Status: branch `recall`, 2026-10-10. The design was revised the same day after an independent review, and the built
code after a second one (safety, correctness and UI: the daily read budget and bounded search, a wider scrubber and
denylist, the owner's site-only list, no silent losses for hosts with `_` or a newer extension, back keeping the
owner's place); §12 notes what was not adopted. The owner API (`proto/recall/ui/v1`), the upload (`proto/recall/ingest/v1`) and the archive
contract (IDL, generated schema, fixtures and their codec test in `proto/test/`) are written; `shared/`, the Worker
(`worker/`), `deploy/`, the extension (`extension/`, built by CI into an artifact) and the UI (`web/`) are built and
tested, and the smoke run (§10) drives them together from an upload to the archive in a fake Dropbox. recall landed check-only (§11, step 1), the owner's "Infra apply" created its Access applications
and bucket (step 2), and the go-live commit (step 3, `ee02b62`) deployed it; its namespace is recorded (`5086599`).
Branch `recall-dropbox-archive` (2026-10-11, `c3e21b6`) replaced the NAS container (`sync/`, never published) with the
Dropbox writer and moved the tokens into 设置. Branch `recall-retention` (2026-10-11) adds the retention window (§2.3):
That earlier retention release kept a year of text. The owner's next update, described below, uses minute snapshots
with optional screenshots, a seven-day R2 window and Dropbox reads when an archived snapshot is opened. Dated
production acceptance belongs in HANDOFF and the linked verification notes.

## 1. Shape

One Worker, `recall`, one SQLite Durable Object, `RecallState` ("recall-v1", namespace key `recall-state`), one private
R2 bucket, `recall-store`. The structure is mailsort's:

| Part | Responsibility |
| --- | --- |
| `extension/` | The Chrome extension: visits and focus, capture, scrub, denylist, outbox, heartbeat (§3) |
| `shared/` | Code the extension and the Worker both run: URL normalization, the scrubber, the denylist (§3.5-§3.7) |
| `worker/src/http.ts` | The fetch handler: the machine routes first (bearer token, size, path; §4), then Access, Origin and CSRF, then one call to the object; the static UI |
| `worker/src/state.ts` | The object: SQLite, the alarm, ingest, the owner API through the shared transcoder, the change feed, ops-v1 for Home (§9) |
| `worker/src/ingest.ts` | One upload: strict read, the server's own scrub and denylist, R2 then one transaction (§4) |
| `worker/src/search.ts`, `segment.ts` | The index, the bigram segmenter, queries, snippets (§6) |
| `worker/src/feed.ts` | Feed pages, each change rendered from its record's row (§7) |
| `worker/src/tokens.ts` | The machine tokens made in 设置: their digests, grace and revocation (§2.2) |
| `worker/src/archive.ts`, `backup.ts`, `dropbox.ts` | The archive's files, the Dropbox connection and the alarm's pass that writes them (§7.2) |
| `web/` | The Chinese, mobile-first UI (no framework) over `recall.ui.v1` (§8) |
| `deploy/` | `deploy-vars.mjs`, `bundle-size.mjs` and their tests |
| `../proto/recall/ui/v1/` | The owner API (AIP resources and one custom method) |
| `../proto/recall/archive/v1/`, `../contracts/recall-archive-v1/` | The change feed and archive contract |

The flow: the extension uploads batches to `POST /api/machine/v1/batches` → the Worker checks the token and forwards
the body unread → `RecallState` decompresses, validates, scrubs and filters again, writes the text to R2, then commits
the rows (each new or changed record with the feed's next seq) and the index entries in one transaction; about an hour
later the alarm writes the changes to the owner's Dropbox. The UI reads `/api/v1/*`; programs may read
`GET /api/machine/v1/changes` and `/blobs/*`.

No D1, KV, queue or cron. Why a Durable Object rather than D1: D1 refuses to export a database with FTS5 tables and caps
a database at 500 MB, and an ingest that tokenizes 64 KiB texts needs the object's 30 s of CPU, not a Worker request's
10 ms.

## 2. Safety model

Browsing history is the most personal data the owner has. Four walls, from the browser outwards:

1. **What is never recorded.** Incognito windows (`"incognito": "not_allowed"`: the extension does not run there, which
   is also how the owner browses without recording); recall's own pages (its searches would otherwise enter the
   archive); pages that are not http(s) (`chrome://`, extensions, `file://`, the Web Store); visits without one second
   of focus; the path and title of a sensitive site (mail, chats, banks, consoles: its site only, §3.7); the text of a
   denylisted page, of a page with a password field, and of anything Chrome does not let an extension script (the PDF
   viewer).
2. **Scrub before upload, and again on arrival** (§3.6): secret patterns in titles and texts, secret query parameters
   and high-entropy path segments in URLs. The Worker runs the same `shared/` code on every upload, so an older
   extension build or a newer denylist entry cannot let text through.
3. **Private storage.** R2 is private (no public bucket, no r2.dev); the owner API is behind Access; the feed needs the
   export token; the archive goes only to the app folder of the owner's own Dropbox app, which they authorize and can
   revoke. Texts are shown as text only (`textContent`), never as HTML: v1 stores no HTML.
4. **Nothing in logs.** Logs and errors hold request IDs, counts, status codes and reason codes: never a URL, host,
   title or text (the Worker's invocation logs are off, as mailsort's).

Page content is untrusted: a page cannot run anything in recall (no HTML is kept or shown), and the worst a page can do
is put misleading words in its own title and text.

### 2.1 Authentication

| Caller | Routes | Credential |
| --- | --- | --- |
| The owner's browser | `/api/v1/*`, `/api/csrf`, the UI | The whole-host Access application (`kind = "owner"`) and `packages/edge-auth` in the Worker (JWT, owner, Origin, CSRF on mutations), unchanged |
| The extension | `POST /api/machine/v1/batches` | `Authorization: Bearer <ingest token>`: write-only |
| A program reading the feed (optional) | `GET /api/machine/v1/changes`, `GET /api/machine/v1/blobs/<path>` | `Authorization: Bearer <export token>`: read-only |
| The owner's browser back from Dropbox | `GET /api/dropbox/callback` | The whole-host Access application, like the UI, and the one-time `state` of the connection the owner started (§7.2) |

An Access **Bypass** application with exactly three destinations, `recall.ziyixi.science/api/machine/v1/batches`,
`…/api/machine/v1/changes` and `…/api/machine/v1/blobs/*`, lets the two machine callers through Access (edge-auth
refuses service-token JWTs, and an Access session in the extension would expire). Exact paths as Fleet's receipt has,
and a wildcard only where the path carries a blob's path (FlowDay's `/pwa/*` is the precedent for a wildcard Bypass
destination); hand-written in `infra/access.tf` next to `fleet_receipt`. The prefix is `/api/machine/v1` rather than
the `/api/internal/` of Mail Hero's backup and Fleet's receipt: it is part of a contract that other stores implement,
and it names the callers (machines with their own tokens). The Worker checks every machine request itself, strictly
and cheaply, since Bypass traffic counts against the account's Worker requests: before any Durable Object call it
accepts exactly the three method-and-path pairs above, refuses a body over 1 MiB (`Content-Length` first, then while
streaming), and compares the bearer's SHA-256, constant-time, with the digests of that route's token: those RecallState
holds (§2.2), which the Worker keeps in memory for a minute (a refused bearer asks the object again at most every 10
seconds, to see a token made since), and those a Worker secret may hold (`INGEST_TOKEN_SHA256`,
`INGEST_TOKEN_SHA256_PREVIOUS`, `EXPORT_TOKEN_SHA256`, `EXPORT_TOKEN_SHA256_PREVIOUS`, put by hand). Anything else is
answered by the Worker alone: 404, 405, 413, 401, or 503 `not_configured` while no digest exists. The blob route reads R2 itself and asks the object only when R2 has no such object (§7). A machine token
never reaches the owner API, and an Access JWT never replaces a machine token.

### 2.2 Tokens: made in 设置, shown once, kept as digests

The owner makes the machine tokens in 设置 → 插件口令 (`RegenerateMachineToken` of `recall.ui.v1`, a mutation behind
Access, Origin and the CSRF token), with no command:

- RecallState makes a token of 32 random bytes, `recall_ingest_<base64url>` (the extension's, write-only) or
  `recall_export_<base64url>` (a feed program's, read-only; optional: the Dropbox backup needs none), keeps only its
  SHA-256 in meta (`token_ingest`, `token_export`), and answers the token once, in that response (`MachineToken.token`,
  OUTPUT_ONLY). The AIP-155 request log keeps the answer without the token, so a repeated request answers without it
  (the UI then asks for another); the status lists the tokens without them; nothing logs one. The prefixes let the
  scrubber and secret scanners recognize a token.
- The UI shows the token in a read-only field with 复制 and the line 只显示这一次; the owner pastes it into the extension's
  options (whose server is already `https://recall.ziyixi.science`).
- 重新生成 keeps the replaced token working for 24 hours (`TOKEN_GRACE_MS`), so the extension uploads until it has the
  new one; the daily alarm drops it after. A token that leaked must stop at once: ⋯ → 旧口令泄露：立即作废并重新生成
  (`revoke_previous`) leaves only the new token. ⋯ → 停用 (`DeleteMachineToken`) stops the route (503).
- The Worker keeps RecallState's digests in memory for a minute (`TOKEN_CACHE_MS`), so a token made, revoked or
  stopped holds everywhere within a minute, and a refused bearer reaches the object at most once per 10 seconds per
  isolate (`TOKEN_RECHECK_MS`).
- A digest put by hand as a Worker secret (`wrangler secret put INGEST_TOKEN_SHA256`, and the others: the way before
  2026-10-11, by the script `deploy/mint-tokens.mjs`, now removed) is still accepted; a deploy keeps it
  (`deploy/test/secrets-kept.test.mjs`), the status says one exists (`MachineToken.worker_secret`), and only deleting
  that secret stops it.

No token passes through a command line, a log, a chat or this repository.

### 2.3 Deletion and retention

recall keeps every page and visit in Cloudflare, and the texts of the retention window (below); the Dropbox archive keeps
every text. The owner deletes a page in its detail view (DeletePage). One
transaction removes the page's row and its index entry, takes its totals off its site, and commits one tombstone,
`pages/<page id>`, to the change feed: from then on the page's visits and texts are gone from the UI, the search and the
feed. The Dropbox archive only grows (§7.2): it gains the tombstone's line within the hour and keeps the page's earlier
lines and blobs, which the owner deletes there by hand if they want them gone from the copies (the UI's confirmation
says so). Right after the transaction the page's texts
leave R2 (deletes are free and write no row, and the blob route reads R2 without asking the object). The rows are
removed by the alarm, at most 500 rows a run and within the day's maintenance allowance (§5.4), so a page visited
every day for years costs no unbounded call and no other app's writes. The
tombstones are also the ledger that keeps a deleted page deleted: a visit that began, or a text captured, before its
page's deletion and uploaded later is dropped. Bounded on purpose:

| What | Kept |
| --- | --- |
| Pages and visits | until the owner deletes them |
| Snapshot files in R2 | seven days by default (owner setting: 7 to 3650, or always), and past it until Dropbox has confirmed every file |
| A document's record (its row: when, where, its size and digest, its archive path) | until the owner deletes its page, also after retention moved its text to the archive alone |
| Tombstones (one small row per deleted page) | always: they keep a deleted page deleted, in recall and in every reader of the archive |
| The search index's text of a page (its first 32 KiB) | until the indexed text passes 500 MiB or the database 850 MiB; then the oldest pages keep only their title and URL in the index (§5.3) |
| The answers to the owner's mutations, by request ID | 1 day |
| Daily usage counters (rows written, uploads, refused items by reason) | 400 days |
| Recent error codes, feed consumers | the last 8 of each |
| The machine tokens' digests | the current one until replaced or stopped; a replaced one 24 hours |
| The Dropbox connection (App key, refresh token, account name) and what the archive wrote (days, blob paths) | until 断开 (the App key and what was written stay, for the same app again) |

The feed is not a table of its own (§5.1), so it never outgrows the records.

**The retention window** (`Settings.text_retention_days`) applies to both snapshot files, with a seven-day default.
The owner may choose 7 to 3650 days or disable file removal using the existing setting. The approved upgrade sets
the existing deployment to seven days. It does not alter either website list.

The existing alarm removes files only after their window and after the connected Dropbox archive confirms every
blob, its date file and the covering state.json. Disconnected or failing archive connections keep the files in R2.
Cleanup preserves document rows, visit associations, seqs, digests and the existing search index. The normal index
budget can still remove old searchable text; file retention itself does not. No tombstone or new feed event is
created by this move to the archive.

Opening an archived snapshot reads its known files through the existing Dropbox client and returns them to the
owner without storing them back in R2. A disconnected archive or a removed file gives a readable error alongside
the snapshot metadata. A changed Dropbox app does not move old files into the new app folder.

## 3. The extension

### 3.1 Files and permissions

`recall/extension/`: TypeScript bundled by esbuild into a service worker (`sw.js`), the capture script injected on
demand (`capture.js`) and the options page; no runtime dependency, no remote code. The manifest:

- `manifest_version: 3`, `minimum_chrome_version: "120"`, `incognito: "not_allowed"`;
- `permissions`: `tabs`, `webNavigation`, `idle`, `alarms`, `storage`, `unlimitedStorage`, `scripting`;
  `host_permissions: ["<all_urls>"]` (to script a page for its text, and to reach recall without a CORS preflight);
- no static content scripts; an action icon whose badge shows `!` while uploads fail (a click opens the options);
- `key`: a public key, so the extension ID (and with it the IndexedDB that holds the outbox) never changes. One key
  pair is made once; only the public half is committed, the private half is not needed for an unpacked extension and
  is thrown away.

### 3.2 Focus

The service worker sleeps after 30 s idle and loses its globals, so focus is a small state machine kept in storage,
driven only by events (listeners registered at the top level):

- **Transitions**: `tabs.onActivated`, `windows.onFocusChanged` (`WINDOW_ID_NONE` is another app in front),
  `idle.onStateChanged` (`setDetectionInterval(180)`), `webNavigation.onCommitted`, `onHistoryStateUpdated` and
  `onReferenceFragmentUpdated` (kept only for `frameType === 'outermost_frame' && documentLifecycle === 'active'`,
  deduplicated on `documentId`, which also drops prerender and back/forward cache replays), `tabs.onUpdated` (a title),
  `tabs.onRemoved`.
- **One open span** `{visitId, tabId, documentId, start}` lives in `storage.session` and is mirrored to `storage.local`
  with `lastBeat`. Every transition closes it (`end = now`) and opens a new one only when a window is focused, the idle
  state is `active` and the tab is that window's active tab. Going idle backdates the end by the 180 s threshold (no
  input for that long means the owner had left); a locked screen ends it at once.
- **A one-minute alarm** (`tick`) updates `lastBeat`, flushes the outbox (§3.8) and sends the heartbeat. After a gap of
  more than two minutes (Chrome closed, the Mac asleep, the worker killed), or on `runtime.onStartup`, an open span is
  closed at `lastBeat`, never at `now`.

### 3.3 Visits

A visit is one document in one tab on one normalized URL (§3.5): an SPA's `pushState` to another URL starts a new one,
a fragment change does not. It has an ID (a UUID), a `revision` and its focus spans, in IndexedDB. It ends when its tab
leaves the URL or closes, after 30 minutes without focus, or 6 hours after its first focus (a pinned tab becomes several
visits, which keeps the timeline's query bounded); the next focus starts a new visit. Only a visit with at least one
second of focus is ever uploaded: background tabs, redirects and pages closed unseen leave nothing. A visit is queued
when it ends, when its tab loses the focus, and every 30 minutes while it lasts if it changed, each time with the next
revision; the outbox keeps only its newest revision (one item per visit), so a flush sends at most one revision of a
visit and the timeline's latest session trails the owner by about one flush (five minutes). At most 200 spans: a visit
that would need more ends.

### 3.4 Capture

The first sample follows ten seconds of foreground focus. Later samples run on the existing minute tick, only
while the page remains eligible and focused. Each visit stores its last attempt time and the last successfully
queued text digest and image preview; failed attempts do not advance this baseline. With unchanged text, a
32×32 preview must have at least 8% of pixels differ by 24 RGB levels before another image is saved. Small clocks
and cursors are ignored; cumulative changes are compared with the last saved image. Visit times continue to be
recorded and no daily capture limit applies.

The isolated capture script reads title, description and body.innerText (UTF-8, at most 64 KiB), with the existing
visible-password check and URL/page identity check. Eligible pages also use captureVisibleTab, then native
OffscreenCanvas WebP encoding: quality 0.75, longest edge 1920 pixels, at most 384 KiB. The current window, tab,
document and focus are checked around the screenshot so a switched page cannot be attached to the old visit.
Screenshots inherit the text/site exclusion lists; their pixels cannot be cleaned by the text scrubber. A screenshot
failure still permits text capture, and an image-only snapshot is useful when a page has no extractable text.

Optional screenshot fields and text travel in the existing DocumentItem. There is no scroll stitching, OCR,
extra scheduler or provider layer.

### 3.5 URLs and the page ID

`shared/url.ts` normalizes with the WHATWG URL parser: http(s) only; lower-case host without a default port or a
trailing dot (`example.com.` is `example.com`); a host the archive's Site format cannot carry (the parser accepts `!`,
`$`, `~` and other punctuation that no real host has; `_` is carried) is a URL recall never records, so the extension
never queues an item the Worker would have to refuse; the fragment dropped unless it starts with `/` or `!` (hash
routers); tracking parameters removed (`utm_*`, `fbclid`,
`gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`, `ref_src`, `_hsenc`, `_hsmi`, `yclid`); the remaining query
kept in its order. The **page ID** is the first 16 bytes of the SHA-256 of that normalized URL **before** scrubbing, in
hex: two pages whose capability tokens the scrubber replaces both read `/reset/[redacted]`, yet stay two pages, and
only the scrubbed URL leaves the browser. The **site** is the host without a leading `www.`.

Nothing is refused for its length. A URL longer than 8192 characters (a map or a dashboard keeping its state in the
query) is cut to 8192 and flagged `url_truncated`, after its page ID was computed from the whole URL; a title or a
description longer than 1000 characters is cut to 999 and ends with `…`. The extension cuts, and the Worker cuts again
for an older build.

### 3.6 Scrub

`shared/scrub.ts` runs on every URL, title, description and text before the outbox, and again in the Worker:

- **Patterns** (adapted from gitleaks and atuin, both MIT, notices kept in `shared/NOTICE`): AWS access key IDs,
  GitHub tokens (`gh[pousr]_…`, `github_pat_…`), Cloudflare tokens (`cfk_`, `cfut_`, `cfat_`, `cfast_`), recall's own
  `recall_ingest_` and `recall_export_`, Slack tokens, Google API keys (`AIza…`) and OAuth tokens (`ya29.`), Stripe keys
  (`sk_live_`, `rk_live_`), the AI providers' keys (Anthropic `sk-ant-…`, OpenAI `sk-proj-…` and the older
  `…T3BlbkFJ…`, OpenRouter, Groq, xAI), npm, GitLab (`glpat-` and its siblings), Hugging Face and PyPI tokens, JWTs,
  PEM private key blocks, card numbers (13 to 19 digits starting with 2 to 6, Luhn-checked, alone or grouped as a card
  is written), US social security numbers in their dashed form, URL user-info (`//user:pass@`) and assignments such as
  `password: …`, `api_key=…`. Each match becomes `[redacted]`. The patterns are linear (no nested quantifiers); the
  unit tests include long hostile inputs.
- **Query parameters** by name, compared without case, `-` and `_` (`reset_password_token`, `accessToken`,
  `X-Amz-Signature`): a name in the list (`token`, `code`, `state`, `sig`, `key`, `pwd`, `auth`, `session`,
  `sessionid`, `sid`, `otp`, `ticket`, `oobcode`, `jwt`, `assertion`, `samlrequest`, `samlresponse`, `credential(s)`,
  `authorization`), one that ends in `token`, `secret`, `signature`, `password`, `passwd`, `apikey` or `accesskey`,
  every `X-Amz-*` and `X-Goog-*`, and `t` or `k` when the value is token-shaped (16 or more characters; `?t=42s` stays):
  the value becomes `[redacted]`.
- **Path segments**: after a segment that introduces what a link unlocks (`reset`, `verify`, `confirm`, `activate`,
  `invite`, `magic`, `token`, `unsubscribe` and their variants), every segment of 16 or more characters becomes
  `[redacted]` whatever its characters (Django's `/reset/MQ/<token>/`, `/verify/<64 hex>`). Anywhere, a segment of 20
  or more characters of the base64url alphabet mixing upper case, lower case and digits (the shape of magic links and
  capability URLs) becomes `[redacted]`, except three kinds that name things rather than unlock them: a slug, which
  splits on `-`, `_` or `.` into at least three parts that are each a word (lower case, capitalized or all upper case),
  all digits or lower-case hex of at least 8 characters (`2024_United_States_presidential_election`, Notion's
  `Meeting-notes-1a2b3c4d…`; `abcDEF-123456-XyZabc`, whose parts mix cases inside them, is a token); a hex-only ID (git
  SHAs, UUIDs); and the document IDs of a short list of hosts whose links still open from recall (`docs.google.com/{document,spreadsheets,presentation,forms}/d/<id>`,
  `drive.google.com/file/d/<id>`, `drive.google.com/drive/folders/<id>`; §12). A corpus of synthetic URLs shaped like
  real ones (wiki and news slugs, Notion, GitHub, Google Docs, reset and magic links, signed S3 URLs) pins the rule.
- Every string is made well-formed (`toWellFormed()`: a lone surrogate becomes U+FFFD), so every JSON writer and reader
  downstream agrees on it.

### 3.7 Denylist

Patterns are a host (covering its subdomains) or a host and a path prefix (ignoring case), in three levels
(`shared/denylist.ts`). A URL is judged by its path and, for a hash router (`#/accounts/1`, `#!/accounts`), by its route
too; a host's trailing dot is ignored.

- **Never recorded**: recall's own host. Its pages leave no visit, so the owner's searches never enter the archive.
- **Site only**: one page per site (its root URL), no title, never text, so the timeline still says
  `mail.google.com · 40 分` while no subject, chat name or account page reaches the archive (§12):
  - mail: `mail.google.com`, `outlook.live.com`, `outlook.office.com`, `outlook.office365.com`, `mail.yahoo.com`,
    `mail.proton.me`, `app.fastmail.com`, `icloud.com`;
  - messaging and AI chats (other people's words as well as the owner's): `web.whatsapp.com`, `web.telegram.org`,
    `app.slack.com`, `discord.com`, `messenger.com`, `facebook.com/messages`, `instagram.com/direct`,
    `linkedin.com/messaging`, `x.com/messages`, `x.com/i/chat`, `wx.qq.com`, `web.wechat.com`, `teams.microsoft.com`,
    `teams.live.com`, `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, `chat.deepseek.com`,
    `messages.google.com` (SMS, one-time codes among them), `voice.google.com`, `chat.google.com`;
  - consoles: `dash.cloudflare.com`, `one.dash.cloudflare.com`, `cloudflareaccess.com`, `console.cloud.google.com`,
    `console.aws.amazon.com`, `portal.azure.com`, `console.firebase.google.com`, `github.com/settings`, and where API
    keys are made: `gitlab.com/-/user_settings`, `gitlab.com/-/profile`, `console.anthropic.com`,
    `platform.claude.com`, `platform.openai.com`, `aistudio.google.com`, `platform.deepseek.com`, `console.groq.com`,
    `console.mistral.ai`, `openrouter.ai/settings`, `huggingface.co/settings`, `npmjs.com/settings`,
    `pypi.org/manage`, `hub.docker.com/settings`, `app.docker.com/settings`, `vercel.com/account`;
  - identity and accounts: `accounts.google.com`, `myaccount.google.com`, `admin.google.com`, `passwords.google.com`,
    `pay.google.com`, `appleid.apple.com`, `account.apple.com`, `idmsa.apple.com`, `login.microsoftonline.com`,
    `login.live.com`, `account.microsoft.com`, `okta.com`, `auth0.com`, `github.com/login`, `github.com/sessions`;
  - password managers: `1password.com`, `bitwarden.com`, `lastpass.com`, `dashlane.com`, `keepersecurity.com`;
  - payments and banks, generic only: `paypal.com`, `venmo.com`, `wise.com`, `stripe.com`, `chase.com`,
    `bankofamerica.com`, `wellsfargo.com`, `citi.com`, `capitalone.com`, `americanexpress.com`, `discover.com`,
    `schwab.com`, `fidelity.com`, `vanguard.com`, `robinhood.com`, `coinbase.com`, `alipay.com`, `95516.com`.
  - and the owner's site-only patterns (below).
- **No text**: visits with their scrubbed URL and title, never captured: the owner's other apps (`ziyixi.science` and
  its other subdomains), any URL whose path has a segment `login`, `signin`, `sign-in`, `logout`, `oauth`, `oauth2`,
  `authorize`, `sso` or `saml`, and the owner's no-text patterns.

The owner's own banks and anything personal go in the UI's lists, never in this public repository: two lists kept in
the object, at most 200 patterns together, each pattern in one of them. `Settings.site_only_patterns` records a site by
its name alone, as the built-in sensitive sites (the owner's own banks: the owner's default for sensitive sites, §12);
`Settings.denylist_patterns` keeps the URL and title without the text (a work wiki). Every upload's answer carries
both lists and their etag, so the extension follows a change within minutes; the Worker applies all three levels to
every item it receives (it drops recall's own pages, reduces a site-only page to its root URL, recomputing the page ID
from it, and drops a no-text page's text), so a change holds at once and an older build cannot let anything through.

### 3.8 Outbox and upload

The outbox is an IndexedDB store of items `{id, kind, json, attempts}` (a visit by its ID with its newest revision, a
document by its ID); the token lives in IndexedDB too, which only the service worker and the options page can read. The
`tick` alarm flushes when the outbox has items and the last upload was 5 minutes ago or more, when it holds 25 items, at
startup, and from the options page's 立即上传. A flush sends one batch of at most 50 items and 1 MiB of JSON, gzipped with
`CompressionStream` (`Content-Type: application/gzip`, no `Content-Encoding`), with `credentials: 'omit'`, the bearer
token and `AbortSignal.timeout(25000)` (a response slower than 30 s would get the worker killed). The answer:

| Answer | The extension |
| --- | --- |
| 200 | removes the accepted and the rejected items, stores the owner's two lists. recall refuses an item only when it breaks the upload's rules (a bug, never its age or length); it counts them by reason and Home hears of it (§9); the options page shows the count too. An item refused as `unsupported_item` (only a newer Worker reads it: the extension runs ahead) is not lost: it stays in the outbox, held six hours at a time, and a tick with only held items sends nothing |
| 401 | stops uploading until the token changes; badge `!`, options say 令牌无效. Nothing in the outbox expires, and recall's device warning reaches Home after 24 hours |
| 413 | halves the batch |
| 429, 503 | waits `Retry-After` |
| other, network | backs off from 1 minute, doubling to 1 hour; badge `!` after an hour of failures |

`unlimitedStorage` keeps a long offline outbox; past 200 MB it stops capturing texts (visits continue). Removing the
extension deletes the outbox, which the options page says next to its count.

### 3.9 Heartbeat and device

At install the extension makes a device ID (a UUID). Every batch carries the device: its ID, the label the owner sets
in the options (`MacBook · 工作`), the extension version, the outbox's size, the last error code, and the batch's
`sent_time`. When nothing was uploaded for 30 minutes, `tick` sends an empty batch: the heartbeat. recall shows each
device's last heartbeat and warns after 24 hours without one, and records the device's clock skew when it passes two
minutes (times are kept as the device gave them; 设置 shows the skew). Every visit and document carries the device's ID
and its label at the time, so the feed has no device records of its own.

### 3.10 Distribution and updates

CI builds the extension into `recall-extension-<sha>.zip` (an artifact kept 30 days; nothing personal in it: the host is
a public build constant, the token is pasted later; on `main` a change to `extension/` or `shared/` also publishes it as
the GitHub Release `recall-extension-v<version>`, kept for good), with the short commit as `version_name` and the build
time (UTC) as the version `<year>.<month × 100 + day>.<hour × 100 + minute>`: 5 January 09:03 is `2026.105.903`, which
still sorts after `2026.104.2359`. (Chrome refuses a version part with a leading zero, so `2026.0105.0903` would not
load; the manifest test builds 5 January 09:03 and 31 December 23:59.) The owner puts it into a stable folder outside
Google Drive (a cloud-only placeholder file would fail to load; `~/recall-extension` is suggested), loads it unpacked
once (Developer mode stays on: since Chrome 134 an unpacked extension runs only then), pastes the token and sets the
label.

Updates never replace files under a running extension. `npm run install-extension` (in `recall/extension`, from a
build or a downloaded artifact) unpacks into the sibling `~/recall-extension.next`, checks it, swaps it in with two
renames (the old folder becomes `~/recall-extension.prev`) and writes the file `BUILD`, holding the version, last. On
every one-minute `tick` (and from the options page's 检查更新) the service worker reads `BUILD` and `manifest.json` from
its own folder, and only when both parse, name the same version and that version differs from its own does it close
its span and call `runtime.reload()`. A half-written folder never passes, and during the swap the read fails and the
next tick tries again. The tick reloads once per version (the version it reloaded for is kept in `storage.local`), so
a Chrome that came back with the old code would not reload every minute; 检查更新 still reloads. A capture result
carries the build it came from, and the service worker drops one from another build (it reloads within the minute
anyway). IndexedDB and `storage.local` survive the reload. That Chrome serves an unpacked extension's files as they are
on disk, which this check relies on, is the first thing phase 1a verifies. No Web Store listing.

## 4. Ingest

`POST /api/machine/v1/batches` with the ingest token. The body is a gzipped `IngestBatch` in the wire JSON profile; its
IDL, `proto/recall/ingest/v1/ingest.proto` (messages only, read strictly), lands with the extension in phase 1a:

| Message | Fields |
| --- | --- |
| `IngestBatch` | `version` (`recall-ingest-v1`), `batch_id` (UUID, for logs), `sent_time`, `device`, `items` (at most 50, a union by `kind`) |
| `DeviceReport` | `device_id`, `label` (1-64 characters), `extension_version` (Chrome's form: up to four parts, no leading zeros), `queued_count`, `last_error_code` |
| `VisitItem` | `id`, `revision`, `page_id`, `url`, `url_truncated`, `title`, `focus_spans` (1-200; start and end follow from them) |
| `DocumentItem` | `id`, `visit_id`, `page_id`, `url`, `url_truncated`, `title`, `description`, `capture_time`, `text` (at most 64 KiB of UTF-8), `text_truncated`, optional `screenshot_webp_base64`, `screenshot_width`, `screenshot_height` |
| `IngestResult` (the answer, plain JSON) | `accepted_count`, `rejected` (`{id, reason}`: `invalid_item`, `id_conflict`, `unsupported_item`), `denylist_patterns`, `denylist_etag`, `site_only_patterns` |

RecallState reads the body through `DecompressionStream` with a 4 MiB cap (413 past it), reads the batch strictly, and
per item: applies the three denylist levels again (§3.7), cuts what is too long (§3.5) and scrubs every string;
computes the site and the focus seconds from the URL and the spans; skips, as accepted, a visit revision not newer than
the stored one, an unchanged snapshot within the same visit, and a visit or capture that began before its page's tombstone (the item's time moved to recall's clock by the batch's
skew, `sent_time` against the arrival, so a device's fast or slow clock neither revives a deleted page nor drops a new
visit); refuses an item that breaks a rule as `invalid_item` (a time more than a minute after the batch's own
`sent_time`, which comes from the same clock, is one; an item is never refused for its age or length), a document ID it
holds with other content as `id_conflict`, and an item that reads only with members or a kind this build does not know
(a lenient read lists them) as `unsupported_item`, which the extension keeps for a newer Worker. Refusals are counted by reason
and day in `usage`, and ops-v1 raises them to Home (§9). A document's text goes to R2 first (gzip, with R2's `sha256`
check), then one transaction writes the rows, each new or changed record row taking the feed's next seq (§5.1), and
the index entry. If the transaction fails after the R2 put, a retry rewrites the same key; nothing refers to an object
before its row exists. The device row is updated once per batch.

The **daily budgets**: the object adds the rows each statement wrote (`cursor.rowsWritten`) and read
(`cursor.rowsRead`) to today's counters (UTC), at the end of every call. Reads: past 1,000,000 rows the change feed
answers 429 with `Retry-After` until the next UTC midnight (an archive catching up from far behind takes several days
and leaves the rest to the owner), past 1,500,000 (under a third of the account's free 5 million) SearchPages answers
SEARCH_OVER_BUDGET, which the UI says in one line; the timeline and the pages still answer. Writes: past 20,000 rows a
day (a fifth of the account's free 100,000, shared by every app) uploads are answered 429 with `Retry-After` until the
next UTC midnight plus up to 10 minutes; the owner's own mutations still pass. The expected day is 4,000 to 13,000 rows
(§5.3). The spread is FTS5's: local workerd counts one row per index insert, while
production may count every segment page FTS5 writes. The first production day measures it; if the high end holds, the
indexed text drops from 32 KiB to 16 KiB a page before the budget is raised.

## 5. Storage

### 5.1 The object's SQLite

Schema version 4 (`store.ts`, migrated in `blockConcurrencyWhile`): version 2 added archive tables, version 3
retention metadata, and version 4 the optional screenshot metadata and seven-day default.

| Table | Columns (indexes) |
| --- | --- |
| `meta` | `key`, `value`: schema version, `feed_id` (a UUID made by the first migration), `seq` (the feed's counter), settings (denylist JSON, etag, `text_retention_days`: days or `off`), the running totals (`archived_count`: texts only in the archive), budget counters, `oldest_indexed_text_ms`, the machine tokens' digests (`token_ingest`, `token_export`), the Dropbox connection (`dropbox_*`) and the archive's progress (`archive_*`: the scanned and the written seq, the target, the last upload, the last failure and its retry time) |
| `devices` | `id`, `label`, `extension_version`, `first_seen_ms`, `last_seen_ms`, `queued_count`, `last_error_code`, `clock_skew_s`, `mobile` |
| `sites` | `host`, `host_key` (labels reversed, `com.github.gist.`; unique), `first_visit_ms`, `last_visit_ms`, `visit_count`, `focus_seconds` (index `focus_seconds`) |
| `pages` | `rowid` (`INTEGER PRIMARY KEY AUTOINCREMENT`, never reused; the index's rowid), `id` (32 hex, unique), `url`, `url_truncated`, `title`, `host_key`, `first_visit_ms`, `last_visit_ms` (never null: a page a capture makes takes the capture's time until its visit arrives), `visit_count`, `focus_seconds`, `document_count`, `latest_document`, `latest_text_document`, `latest_text_sha256`, `text_indexed` (indexes `last_visit_ms`; `host_key, last_visit_ms`) |
| `visits` | `id`, `seq` (unique), `seq_ms`, `page_rowid`, `device_id`, `device_label`, `url`, `url_truncated`, `title`, `start_ms`, `end_ms`, `focus_seconds`, `spans` (JSON, at most 200 pairs), `revision` (indexes `start_ms`; `page_rowid, start_ms`; `device_id, start_ms, id`) |
| `documents` | `id`, `seq` (unique), `seq_ms`, `page_rowid`, `visit`, `device_id`, `device_label`, `capture_ms`, `url`, `url_truncated`, `title`, `description`, `blob_path`, `sha256`, `stored_bytes`, `text_bytes`, `text_sha256`, `truncated`, optional `screenshot_path`, `screenshot_sha256`, `screenshot_bytes`, `screenshot_width`, `screenshot_height`, `archived_ms` (schema 3: when retention moved the text to the archive alone; null while R2 holds it) (indexes `page_rowid, capture_ms`; `device_id`, schema 6; `capture_ms` where `archived_ms` is null, schema 3) |
| `fts` | `fts5(title, url, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`; rowid = `pages.rowid` (§6) |
| `tombstones` | `id`, `seq` (unique), `seq_ms`, `page_id` (indexed): the feed's deletions, and the ledger that keeps a deleted page deleted (§2.3) |
| `purges` | `page_rowid`, `page_id`, `started_ms`: deleted pages whose rows and R2 objects the alarm is still removing |
| `consumers` | `name`, `synced_seq`, `last_pull_ms`: at most 8 feed consumers; one that has not pulled for 30 days is dropped by the daily alarm |
| `archive_days` (schema 2) | `day` (UTC), `min_seq`, `max_seq` (the range of the day's seqs, by which its rows are read), `dirty` (partial index), `content_hash` (Dropbox's, of the file written) |
| `archive_blobs` (schema 2) | `path`, `target` (the connection it was written to), `content_hash`: every blob written to Dropbox, so none is written twice |
| `usage` | `day`, `rows_written`, `rows_read`, `batches`, `items`, `visits`, `long_visits` (of pages that keep their text), `captures` (that arrived for them: kept, or skipped as a text recall had), `texts`, `refused` (counts by reason), `over_budget` |
| `requests` | the AIP-155 request log: `request_id`, `method`, `resource`, `answer`, `time_ms` |

**The change feed is the records' own rows.** Every write of a visit, document or tombstone row takes the next `seq`
from `meta` in its transaction (a revision moves its row to the new seq), so the feed needs no table, holds no copy of a
record and never reuses a seq. Each row holds everything its feed line says (the URL, title and device label as they
were), so a seq always renders the same change. A deleted page's rows wait for the alarm without a page row: every
read joins visits and documents to their live page, which hides them at once.

A site's resource ID is its host; its `host_key` turns "this host and its subdomains" into an index range
(`host_key >= 'com.github.' AND host_key < 'com.github/'`) instead of a `LIKE`, whose patterns production SQLite caps at
50 bytes.

### 5.2 R2

One private bucket, `recall-store` (binding `STORE`; `infra/storage.tf` `r2_buckets`). An object's key is its archive
path: `blobs/2026/10/<document uuid>.txt.gz` (UTC month of the capture), gzip of the scrubbed UTF-8 text, written with
`sha256` and read back only by the object (snippets, the reader view) and the blob route. The archive layout and the
store's layout are the same: the archive's writer copies each object to the same path under `blobs/` in Dropbox. An
object leaves R2 when its page is deleted, or when the retention window passed and the archive confirmed it (§2.3).

### 5.3 Budgets

| Resource (Free, shared by the account) | recall's expected day | Bound |
| --- | --- | --- |
| Worker requests (100,000/day) | about 600: uploads every 5 minutes at most per device, 48 heartbeats, the owner's use | machine refusals reach the object at most once per 10 s and isolate (the token digests kept in memory); the blob route wakes it only when R2 misses |
| Subrequests (50 per invocation) and Dropbox | an archive pass about hourly while changes come: a token refresh, the day's file, state.json and each new text (an R2 read and an upload): about 100 Dropbox calls a day; a retention step one R2 delete | at most 40 subrequests and 5 minutes a pass, with the purge's and the retention step's R2 call or two beside it; a backlog goes on a minute later; Dropbox's 429 and Retry-After are kept |
| Durable Object rows written (100,000/day) | 4,000 to 13,000: a visit revision about 6 (its row, its indexes and seq, the page, the site), about 600 revisions; a kept text about 8 plus FTS5's writes (1 counted locally, possibly 20-100 in production for 32 KiB of Chinese), about 60 kept texts; a batch 2; once the window is reached about 60 texts a day leave Cloudflare, a few rows each (their row and its index entry, for a page's latest text its index row and the page; about 1 counted locally) | 20,000/day, then 429 (§4); purges, demotions and retention stop at 10,000 (§5.4); measured on the first day |
| Durable Object rows read (5 million/day) | timeline days of a few hundred rows; the status a few dozen (at most about 1,000 with Dropbox far behind); a search a few thousand (at most about 6,000 without a range, 62,000 over the longest range: §6.3, measured at two years); an archive pass today's changes and their pages, about 1,000 at the end of a day; a retention step about 630 rows for 100 texts (measured at two years) | 1,500,000/day, then searches refuse (the feed stops at 1,000,000), §4; an archive pass scans at most 10,000 changes a table and renders at most 20,000 changes; a retention step looks at most at the 1,000 oldest texts still in Cloudflare |
| Durable Object storage (5 GB account; 1 GB per object in one line of the docs, 10 GB in another) | the index, about 1.1 bytes per byte of indexed text (at most 32 KiB a page), at most about 550 MiB; with the retention window (a year) a year's texts, about 22,000; the tables, about 0.15 GB a year | budget 900 MiB; file retention preserves the index (§2.3); the oldest pages' texts leave the index while it holds over 500 MiB of text or the database passes 850 MiB (title and URL stay; the archive keeps the text); a warning at 850 MiB |
| R2 (10 GB-month, 1 M Class A, 10 M Class B a month) | about 0.2 GB a year, held at about a year's texts by the retention window; about 3,000 writes and 10,000 reads a month (retention's deletes are free) | shown in 设置 |
| CPU: 10 ms per Worker request, 30 s per object call | the Worker never parses an upload; the object's heaviest call (an upload of 50 items with 10 texts) is expected well under 1 s | CPU tests (§10) |

The texts' real sizes are unknown until phase 1a records them (`stored_bytes`, `text_bytes`); the budgets are checked
again after a week of real use. With the retention window at a year, the index holds about a year's texts (about
22,000 at the expected volume, under its 500 MiB of text) and R2 a year's objects, so neither grows past the
first year; the tables (visits and records, never removed by retention) grow about 0.15 GB a year. Without the window
the index would reach its 500 MiB of text in about a year and then keep only the newest texts (the budget's demotion,
which still applies). Either way the archive keeps every text.

### 5.4 The alarm

Once a day (04:00 UTC, and armed again by any call that finds none), about an hour after an upload or deletion
committed changes while Dropbox is connected, at once after a connection, and a minute later again while work is left:
remove a deleted page's rows (`purges`), at most 500 rows a run, with their R2 objects again (deletes are free; the
deletion already removed them), then its `purges` row; drop the request log older than a day, usage older than 400
days, feed consumers that have not pulled for 30 days and replaced token digests past their grace; while the index holds over 500 MiB of text or the database
passes 850 MiB, move the oldest pages' index rows to title and URL only, 2,000 pages a run, and record
`oldest_indexed_text_ms`. Then the archive's pass (§7.2), which writes few rows and runs whatever the allowance: a
failure waits for its retry time. Last, the retention step (§2.3), after the pass so that what it just confirmed counts:
at most 100 texts past the window that the archive confirmed, found among the 1,000 oldest texts still in Cloudflare
(`documents_retention`), their R2 objects deleted in one call, then one transaction marks them archived, reduces their
pages' index rows and moves the totals; a full batch brings the alarm back a minute later. Purges, demotions and
retention write rows, so they stop for the day once today's rows written reach 10,000 (half the daily budget, so that
uploads keep the other half) and go on at the next daily run; rows that wait are hidden by the join already. Nothing
else runs on a schedule.

## 6. Search

### 6.1 The index

One FTS5 row per page (`rowid = pages.rowid`): `title`, `url` (the host and the path's words) and `body`, the first
32 KiB of the text of the page's latest capture (cut at a character boundary; the whole text is kept, shown and
archived, and the reader view says when search sees only its beginning, as Mail Hero does for its first 16 KiB). It is
written when a page is first seen (title and URL), replaced at each new capture (title, URL and the new text), and
reduced to title and URL when the budget moves the page out or the retention window moves its latest text to the
archive alone (§2.3). Contentless (`content=''`, `contentless_delete=1`): the
texts live in R2, and a row is replaced by deleting it and inserting again.
A later title change of a page is not indexed (it would cost a text read and a row rewrite for every unread-count title
such as `收件箱 (3)`); the page's stored title still changes.

**Chinese.** No custom tokenizer runs in a Durable Object, and `unicode61` reads a run of Chinese characters as one
token. So `segment.ts` prepares every indexed string and every query term the same way: NFKC, lower case, then each
run of Han, Hiragana, Katakana or Hangul characters becomes its overlapping pairs (`数据库` → `数据 据库`), separated by
spaces from the Latin and digit runs around it (`D1数据库` → `d1 数据 据库`); a lone CJK character stays as itself. A
query term that has a lone CJK character beside Latin letters or digits (`iOS版`, `2026年`, `新iPhone`) may meet it
inside a longer run in the text (`iOS版本`), which the index holds only as pairs: as the phrase's last token it is a
prefix (`"ios 版"*` finds `版本`), as its first it is left out of the phrase (FTS5 has no suffix query; the UI still
marks the whole term). The 32 KiB cut applies before this. `detail=full` (the default) keeps positions, so a pair sequence is a phrase:
`数据库` matches only where `数据` is followed by `据库`. Measured locally (workerd 1.20260925.1, synthetic text): about
1.1 bytes of index per byte of text, Chinese phrases of two or more characters and English words found. The segmenter
must never change without rebuilding the index from R2.

### 6.2 The query language

The search box takes words, phrases and operators; the UI turns the operators into chips and sends typed fields
(`SearchPagesRequest`), so the server never parses an operator:

| In the box | Chip | Field |
| --- | --- | --- |
| `durable alarm` (words) | none | `query`: every term must match |
| `"冷启动 优化"` (a phrase) | none | `query`: one term, the words next to each other |
| `site:github.com` | 网站 github.com | `site`: the host and its subdomains |
| `after:2026-09-01` | 时间 9月1日 起 | `start_time`: the owner's local midnight starting that day |
| `before:2026-10-01` | 时间 … 至 9月30日 | `end_time`: the local midnight starting that day (not included) |
| `type:read` | 类型 读过 | `page_type = read`: pages with a captured text |
| `dwell:2m` (also `30s`, `1h`) | 停留 ≥ 2 分 | `min_focus_seconds`: within the time range |

An operator is recognized when it is followed by a space or Enter, becomes a chip and leaves the box; Backspace in an
empty box removes the last chip; a chip's ✕ removes it. An operator that does not parse stays as text and one hint line
says what it expects (`after: 需要日期，如 after:2026-10-01 或 after:昨天`); nothing is searched while it is in the box.
Dates read `YYYY-MM-DD`, `YYYY/MM/DD`, 今天, 昨天 and 前天. The time chip's presets are 今天, 7 天 and 30 天 (the last n
days, today included), or 自定义 (two dates; one picked day is that day). The sort (`sort_order`) is a separate toggle,
相关 · 最新, with 相关 offered only when the box has words.

The server reads `query` as at most 10 terms of at most 200 characters: double quotes make a phrase, spaces separate
terms, every term is segmented (§6.1) and written as an FTS5 phrase with every `"` doubled (`"数据 据库"`), the terms
joined with spaces (all must match). A term that leaves nothing searchable (punctuation only, or a lone CJK character)
is dropped; a query left with no term is QUERY_NOT_SEARCHABLE, which the UI explains: 单个汉字搜不到，请多输入一个字.
Beside other terms, a dropped single character is named in one hint line (`「派」是单个汉字，没有参与搜索，可以连着前后的字
写，如「苹果派」`).

### 6.3 Evaluation

Every row a search reads counts against the account's 5 million a day, shared by every app, so a search gathers its
candidate pages from its most selective condition, each source bounded, then keeps the candidates that meet every other
condition (one indexed read per candidate), sorts them and keeps its first 200 results. A bound is reported
(`candidates_capped`) only where it can change those results, so an answer without the flag is complete.

- **With a time range** (`after:2025-03-01 before:2025-03-08 type:read`, a day of the timeline): the visits overlapping
  the range, newest first, at most 20,000 (about two months of browsing), grouped by page (their count, their focus,
  their latest end; a visit that overlaps the range counts whole); the minimum focus on those sums; the site and the
  type on the live page. A range with more than 20,000 visits is capped: only its newest 20,000 were read.
- **Words**: the index's matches are read once, at most 2,000 (`ORDER BY rank` with `bm25(5, 2, 1)` for 相关, which
  FTS5 sorts inside without counting a row per match; any for 最新). When there are no more, they meet every other
  source exactly. Past them (a common word), a range's or a site's candidates are looked up in the index one by one
  (BM25 for 相关, presence for 最新); without either, 相关 takes the best 2,000 matches (capped only when the other
  conditions left fewer than 200 results among them) and 最新 the scan below, which finds a common word's newest pages
  at once.
- **A site** of at most 5,000 pages is read whole (its `host_key` range), words and conditions included, never capped.
- **The scan**: otherwise (最近读过, a minimum of focus alone, a large site), the pages by `last_visit_ms`, newest first,
  500 a statement with a keyset (`(last_visit_ms, rowid) <`, on the index), until 200 results are found or 5,000 pages
  were read; reaching that bound with fewer results is capped.
- **Overlap**: a visit overlaps `[start, end)` when `start_ms < end AND end_ms > start`; since a visit lasts at most 6
  hours, the scan is `start_ms >= start - 6 h AND start_ms < end` on the index. The timeline (ListVisits on `pages/-`)
  uses the same scan.
- **Snippets**: for each result of the answered page (at most 10) that has a text in Cloudflare and matched in it (a
  text retention moved to the archive alone has none), the object reads the latest text from R2, finds the first
  occurrence of any query term (NFKC, ignoring case, on the plain text), cuts about 160 characters around it at word
  or character boundaries, and answers it as segments with the occurrences highlighted. The UI renders them with
  `textContent` and `<mark>`, never HTML, and marks the query's terms in titles by the same rule.
- **Paging**: page tokens (`proto/ts/page-token.ts`) carry the offset and are bound to every other field. A search's
  200 results stay in the object's memory for 10 minutes (16 searches at most), so 加载更多 reads nothing again and
  shows the results as the first page found them; an object that restarted searches again, and a deletion empties it.
- **Measured** (`worker/test/runtime/scale.test.ts`, held there as bounds) on a synthetic store of two years (65,000
  pages, 220,000 visits each on another page, a third with a text): 最近读过 about 1,000 rows, a common word 6,000 for
  相关 and 3,000 for 最新, a rare word 130, a site 500, a minimum of focus no page reaches 5,000 (capped), a common word
  within 30 days 27,000, the longest range 62,000 (capped), a next page none, the status a dozen. The second review
  measured the earlier single statements at 67,000 to 152,000 rows for the same searches.
- **Budget**: past 1,500,000 rows read in the UTC day, SearchPages answers SEARCH_OVER_BUDGET (§4).

## 7. The archive and the change feed

[`contracts/recall-archive-v1`](../../contracts/recall-archive-v1/README.md) is the protocol: the archive layout and
its reading rules, the records, the feed's routes, the guarantees and how another store or consumer fits. recall writes
the archive itself, to the owner's Dropbox (§7.2); the feed serves the same records to programs. What recall does to
keep the feed:

- **Compacted.** The feed is the `seq` of the `visits`, `documents` and `tombstones` rows (§5.1): a record's write takes
  the next seq in its transaction, a revision moves the record to a new seq, and DeletePage takes a page's visits and
  documents out of the feed at once (their page row is gone) and adds one tombstone. Seqs have gaps, a seq is never
  reused, every record's latest change lies above any cursor that has not seen it, and nothing in the object is a copy
  of a record: a deleted page leaves only its tombstone.
- **A page.** For `after` and `limit`: three reads by seq, each of at most `limit` rows (visits and documents joined to
  their live page), merged, the first `limit` kept, each rendered by the generated `recall.archive.v1` code and the wire
  codec from its row. `last_seq` is the last change's seq when the page is full, else `head_seq` (the counter). The
  Worker passes the object's answer through unread; a test compares pages built from synthetic visits with the
  contract's fixtures.
- **Identity.** `feed_id` is made by the store's first migration and sent with every page; an `after` above `head_seq`
  is 409 `cursor_ahead`. Rebuilding recall from an archive (an import, not built in v1) keeps the archive's `feed_id`
  and starts the counter above its highest seq. A point-in-time restore of the object must renew the `feed_id`, since
  the seqs after the restore point would be handed out again under the same one; recall v1 has no restore path (only
  code can restore a Durable Object), and the code that adds one writes a marker outside the object (an R2 key) before
  `onNextSessionRestoreBookmark`, so that the first session after the restore sets a new `feed_id` and deletes it.
- **Sync positions.** Each request's `after` is that consumer's sync position (`consumers`); 设置 lists the feed's
  consumers under the Dropbox backup with when each last pulled, the changes above it (counted up to 500 while it
  pulls; a consumer silent for a day is not counted) and the commit time of the oldest of them (`seq_ms`, one indexed
  read per table), so the status costs a few rows however far behind a consumer is. A consumer silent for 30 days is
  dropped. They raise no ops-v1 signal: the archive recall answers for is Dropbox's.
- **Budget.** Once today's rows read pass 1,000,000 the feed answers 429 with `Retry-After` until the next UTC day, so
  an archive catching up from far behind (about 2,500 rows a page of 500) takes several days and leaves the rest to the
  owner's searches.
- **Blobs.** The Worker answers the blob route from R2 (token checked, path checked against `BlobPath`) with the digest
  header, without waking the object. Only when R2 has no such object does it ask the object: 410 `blob_deleted` when no
  live document holds that path in R2 (its page was deleted, or the retention window moved its text to the archive
  alone: the archive keeps it), otherwise 500 `blob_missing`, logged and kept among the recent error codes. A wrong bucket binding or a lost object so stops every consumer instead of letting it skip texts.

### 7.1 Visits and the archive's time

A visit's `event_time` is its start. The archive files changes by the day recall committed them (`seq_ms`), not by the
visit's day, so a day's file changes only while that day lasts, and there is one file a day. "What did I do on day X"
reads the visits' own times (the contract shows the `jq` line).

### 7.2 The archive in Dropbox

The owner's request of 2026-10-11: the backup must be generic and must not depend on recall's code running on the NAS
or their Mac, and they run no command. UGREEN's UGOS cannot pull an S3-compatible store (its Cloud Drives take AWS S3
only, without an endpoint), but syncs Dropbox. So recall pushes the archive into the app folder of the owner's own
Dropbox app, and the NAS syncs that folder one way (Dropbox to NAS) with Cloud Drives. The reference consumer that
pulled the feed into a NAS container (`sync/`, its image workflow; never published) was removed.

**The connection** (`backup.ts`, `dropbox.ts`), OAuth 2 with PKCE for an App-folder app, so no app secret exists:

- 设置 → 备份到 Dropbox: the owner pastes the App key and presses 连接. `ConnectDropboxBackup` keeps the App key, the
  SHA-256 of a fresh `state` (32 random bytes) and a PKCE verifier (48 random bytes) for 15 minutes in meta, and
  answers `https://www.dropbox.com/oauth2/authorize?client_id=…&response_type=code&code_challenge=…&code_challenge_method=S256&token_access_type=offline&redirect_uri=https://recall.ziyixi.science/api/dropbox/callback&state=…`,
  where the browser goes.
- Dropbox sends the browser back to `GET /api/dropbox/callback?code=…&state=…`, behind the whole-host Access
  application like every owner path (the browser carries the owner's Access cookie, so no Bypass is needed; Dropbox's
  servers never call recall). The Worker checks the owner's Access JWT, and RecallState checks the state once, in
  constant time, against the connection the owner started (CSRF: no one else can start one, since that is a mutation
  behind Origin and the CSRF token, and the state works once), exchanges the code with the App key and the verifier for
  a refresh token (`/oauth2/token`), reads the account's display name (`users/get_current_account`), and answers the
  browser 303 to `/settings?dropbox=connected` (or `denied`, `expired`, `failed`), so the code leaves the address bar.
- The refresh token stays in meta: no answer carries it, nothing logs it. Access tokens live in the object's memory,
  refreshed (App key and refresh token) when they near their end. Dropbox refusing the refresh token (the owner
  removed the app) disconnects (`dropbox_refused`), and Home warns.
- 断开 (`DisconnectDropboxBackup`) revokes the token at Dropbox (`/2/auth/token/revoke`, which also revokes the refresh
  token) and forgets it; the App key and what was written stay, so connecting the same app and account again goes on
  where it stopped. Another app or account (a new `target`) gets the whole archive written again; a folder whose
  `state.json` names another feed is never written into (`dropbox_other_feed`).

**The pass** (`archive.ts`, `backup.ts`), part of every alarm run while connected; the alarm comes about an hour after
an upload or deletion commits changes (`ARCHIVE_INTERVAL_MS`), at once after a connection, and a minute later while
work is left:

1. A scan of the changes above `archive_scan_seq` (their seq and commit time only, at most 10,000 of each table a
   pass) marks the days they were committed on dirty in `archive_days`, widening each day's seq range. Writing waits
   until the scan reached the head, so no day's file is written while a record it lost is not yet in a later one.
2. With at most 40 subrequests (R2 reads and Dropbox calls; Free allows 50 an invocation) and 5 minutes of wall time:
   on a new target, the folder's `state.json` is read (another feed's stops the pass) and `VERSION` written; then each
   dirty day, newest first, is rendered whole from the rows its range holds (the same code as the feed), after the
   blobs its lines refer to: each read from R2, checked against its size and digest, written once with mode `add`
   (Dropbox's content hash sent and checked), recorded in `archive_blobs`; the day's file is written (`overwrite`) only
   when its content hash changed. A pass starts no new day after 20,000 rendered changes. Last, `state.json` with the
   scanned seq.
3. Nothing is ever deleted or moved at Dropbox: a deletion is its tombstone's line; a blob whose path holds another
   file is left as it is (`dropbox_conflict`, recorded without a content hash, so retention never takes that text for
   archived). Writing the same bytes again changes nothing, and what was written is recorded, so a pass repeated after
   a crash writes nothing twice. A text the retention window moved out of Cloudflare has no R2 object: a pass skips its
   blob (the archive that confirmed it holds it; a new connection's folder gets its line without it, §2.3). What a pass
   records (`archive_blobs`, `archive_days`, `state.json`'s seq) is the ledger retention trusts.
4. A failure records its code (the status shows it in words) and waits: Dropbox's `Retry-After` for 429 and
   `too_many_write_operations`, else a minute doubled up to an hour; 401 drops the access token for a refresh;
   `dropbox_refused` disconnects. Calls have a 30 s timeout. Logs hold codes only.

The status (`ServiceStatus.dropbox_backup`) says whether it is connected, the account, the last upload, the seq written,
the changes waiting (counted up to 500) and the oldest of them, and the last failure. ops-v1 raises
`archive_not_connected` until it is connected and `archive_behind` when a change has waited more than 24 hours,
counted from the connection at the earliest (a first upload of an old store is no lag). Those two also cover a paused
retention window (it pauses only while Dropbox is not connected or failing), so it has no signal of its own; 设置 says
it in words.

## 8. The owner API and the UI

### 8.1 The API

`recall.ui.v1` under /api/v1 is served by RecallState through the existing shared transcoder. Pages, visits, sites,
settings, tokens and archive setup keep their existing methods. ListDocuments lists a page's snapshot metadata
newest first, in pages of 20 (maximum 50), with a seek cursor. GetDocument returns the selected snapshot's text
and optional WebP picture, using R2 for recent files or the existing Dropbox connection for archived ones. The
picture is a bounded base64 string; the strict CSP already permits data images. Content loading errors have safe
reason codes and preserve metadata. No additional image endpoint is needed.

Settings keeps the existing text_retention_days field, now the common text/image file window: default 7 days,
7 to 3650 or unset for no removal. The search index remains governed by its existing budget. Authentication,
Origin/CSRF and request IDs follow the existing owner API rules.

### 8.2 The design language

recall copies the visual system of mailsort's UI (`mailsort/web/src/styles.css`, 2026-10-07) and shares its vocabulary
with Home (`dashboard/web`): apps never import each other, so the tokens and components are copied, with the same
names. What they share:

- **Tokens** on `:root`, light and dark from `prefers-color-scheme`: neutral `--bg`, `--surface`, `--sunken`, `--ink`,
  `--muted`, `--line`, `--track`; one accent `--accent` with `--accent-ink` and `--accent-soft`; `--warn`, `--warn-soft`
  and `--danger` for state only; eight categorical `--series-1` … `--series-8` validated for color-vision deficiency on
  both surfaces. Each app's accent is the accent of its Home tile (mailsort teal, Home ink blue). recall's tile is
  **violet**: no other tile of Home's apps group has it, and rose, the one accent no tile uses, is barred from any tile
  with a health level by Home's registry test (rose beside ● 正常 reads as a fault), which recall's ops-v1 status gives
  it (§9); a red-like accent would also sit beside `--danger` in recall's own chips and tabs. So `--accent: #56419a`,
  `--accent-soft: #eae5f5`, `--accent-ink: #ffffff` in light and `#b9a8ea`, `#2e2842`, `#1b1433` in dark (Home's
  `--accent-violet-*`; each ink on its accent is above 7:1). Everything else is mailsort's values.
- **Type**: the system font with PingFang SC and Noto Sans SC, tabular figures for every number. The scale: 12 (chips,
  legends), 13 (meta, hints, hour headings), 14 (buttons, secondary lines), 15 (tabs, card titles, row titles), 16
  (body), 17 (the brand), 22 (the page detail's title), 28 (KPI numbers); one addition for reading, the captured text at
  17 px with line height 1.75 and lines of at most 40 em.
- **Space and shape**: the 8 px scale (4, 8, 16, 24, 32, 48), a 10 px radius, 1 px hairlines, no shadow but the
  segmented control's, a 2 px accent focus ring, touch targets of at least 44 px.
- **Components** (copied from mailsort's `components.ts`): the card, the chip (accent, warn, muted), the segmented
  control, the disclosure, the ⋯ menu, the compact row list, the meter and the small bar, the KPI number, the empty
  state, the toast, the searchable picker, the keys hint. New in recall: the day bar, the hour grid, the site badge,
  the filter chip with its popover, the snippet and the reader (below).
- **Layout**: one 48 rem column with 16 px gutters, each page one `minmax(0, 1fr)` grid column so no child widens it, at
  360 px nothing scrolls sideways; `check-layout.test.ts` pins these rules as mailsort's does.
- **Sites have colors**: a site's badge (its initial on a circle) takes a `--series-*` slot from a hash of its host, so
  a site keeps its color from day to day; on a day where two shown sites want the same slot, the more focused keeps it
  and the other borrows a free one, and beyond eight sites the rest are `--muted` (mailsort's `groupSlots` rule).

### 8.3 The shell

A sticky header: 浏览记录 and, on the same row (under it on a phone), one quiet status line from GetServiceStatus:
`上传 3 分钟前 · Dropbox 已备份` (or `Dropbox 待备份 12 条`), or the problem in the warning color (`MacBook 2 天没有上传`,
`Dropbox 备份未连接`, `Dropbox 落后 500+ 条` once a change waited a day since the connection, `存储接近上限`); under it three tabs, 时间线 · 搜索 · 设置, the current one underlined in the accent. The page detail
opens over the tab it came from (the tab stays marked). The status is read once per navigation. Routes: `/` (today),
`/day/2026-10-09`, `/search?q=…&site=…&after=…&before=…&type=read&dwell=120&sort=recent`, `/pages/<id>`, `/settings`;
the URL always holds the state, so reload and back work. Back returns to where the owner was: each history entry keeps
its scroll position and what its view kept of itself (the search's results with the pages 加载更多 added, the
timeline's open session), in memory, and the view draws itself from that without asking again (`history`'s own scroll
restoration is off). `/` anywhere focuses the search box.

### 8.4 时间线 (`/`, `/day/<date>`)

- **The day bar**: ‹ · the date as a button (`10月9日 周四`, opening the browser's date picker, `input[type=date]`,
  from the first recorded day to today) · ›, and 今天 when another day is shown. ← and → move a day, `t` returns to
  today.
- **The summary**: `23 个网站 · 专注 4 小时 12 分 · 87 个页面` (focus is the union of the day's spans) and one link,
  在这天里搜索, which opens 搜索 with the 时间 chip set to that day: filtering lives in one place.
- **The hour grid**: 24 cells, the day's overview and the way into it at once. An empty hour is only outlined (a
  hairline) and disabled, so that a lightly used hour never reads as a gap; a used one is filled in five steps, 20, 35,
  50 and 80 % of the accent mixed into the surface and the accent itself, by that hour's focus minutes, each numeral at
  least 4.5:1 on its fill in light and dark (`--ink` on the first three, `--accent-ink` on the last two). Each cell is
  labeled for assistive technology (`09 点 · 专注 28 分`), and a tap or Enter scrolls the list to that hour. The grid
  is one Tab stop; ← → (Home, End) move between its hours there, never between days. One row from 624 px of grid width (a
  container query: 24 cells of 24 px and their gaps need 622 px), two rows of 12 below; each cell at least 24 × 32 px, WCAG's minimum target and the one exception to the 44 px
  rule, since every hour is also reachable as a heading of the list.
- **The list**: hour headings (`09:00`, muted) over sessions: a session is consecutive focus on one site, gaps of up to
  five minutes merged. One row each: the site badge, the host (without `www.`), `09:12–09:40`, `28 分`, `4 页`; on a
  narrow list (under 480 px, a container query) two lines, the host whole on the first and the time and figures muted
  under it, so a phone always shows which site it was. A row opens to its pages (the title on one line, its minutes; a
  title opens the page detail) and closes again; one open at a time. Within an hour, sessions under 30 s fold into
  `还有 6 个短暂访问`. Oldest first, like a diary; a fresh visit of today opens scrolled to the latest session, back
  from a page returns to where the owner was with the session they opened open.
- **Empty**: a day without visits says 这天没有记录 with 上一个有记录的日子 (ListVisits ending at the day's start,
  newest first, one visit) and the next when there is one. Before any upload, 还没有记录 and where to start (设置).

### 8.5 搜索 (`/search`)

- **The box** (`搜索读过的内容、标题或网址`), focused on arrival on a desktop, and under it four filter chips: 时间,
  网站, 类型, 停留. An idle chip reads its name (`时间 ▾`); a set one reads its value in the accent (`近 7 天 ✕`). Each
  opens a small popover: 时间 a segmented 今天 · 7 天 · 30 天 · 自定义 (two dates) and 任何时间; 网站 the searchable
  picker over ListSites (the top 200 loaded once and filtered as one types, then the server's prefix filter for the
  rest; a typed domain is the first option, `google.com（含子域名）`, then the hosts that are it, start with it and hold
  it, so Enter takes what was typed); 类型 全部 · 读过; 停留 不限 · 30 秒 · 2 分 · 10 分 · 自定义. One popover is open at a
  time; it opens on its chosen option; a choice, Escape or a click outside closes it and gives the focus back to its
  chip, and a chip's ✕ leaves the focus on the chip, idle; on a phone it is a full-width panel under the chips.
  Operators typed in the box become the same chips (§6.2). The box's own ✕ (or deleting every character) searches
  again without words, as Escape does.
- **The line above the results**: `10+ 个结果` while more remain, the exact count once the last page is in; the sort
  toggle 相关 · 最新 on the right. The line stays while a search runs (skeleton rows below it), so the toggle keeps the
  focus.
- **A result**: the title (one line, the query's terms marked), `github.com · 10月9日 · 停留 12 分 · 3 次` (the date of
  the latest visit within the range; `今天 14:20` today), then up to two lines of snippet with the matches marked, or
  the URL in small mono when there is no text. A tap opens the page detail with the query, which marks the matches in
  the text and scrolls to the first.
- **More**: 加载更多 adds the next ten (no endless scroll) and moves the focus to the first of them;
  `candidates_capped` adds one line naming the bound (§6.3), also under 没有找到: with a range
  这段时间访问太多，只看了最近的 2 万次访问，缩短时间试试; words sorted 相关 匹配的页面太多，只看了最相关的 2000 个，加个条件或换个词试试;
  otherwise 结果可能不全：只看了最近访问的 5000 个页面，加个时间范围或换个条件试试. A day's read budget spent: its one line
  instead of results (今天的搜索额度用完了…), without 重试.
- **Keyboard**: ↓ ↑ or j k between results, Enter opens, Escape clears the box.
- **Without words or chips**: 最近读过, the pages with a text by their latest visit, so the tab is useful before anything
  is typed.
- **No results**: 没有找到, with one button per set chip to drop it (`去掉 网站：github.com`), the line 正文只搜每页前
  32 KB, and when the index lost old texts (`oldest_indexed_text_time`), the line 正文搜索覆盖 2025年3月 起，更早的页面只按
  标题和网址搜索（全文仍在页面详情和 Dropbox 归档里）.
- File retention does not limit text-search history. Only the existing index-budget coverage hint applies.

### 8.6 页面详情 (`/pages/<id>`)

- **Head**: the title (22 px), the site and the URL (a link opening a new tab with `noopener noreferrer`; when the URL
  has `[redacted]`, a hint: 网址里的敏感部分已去掉; when it was cut, 网址太长，只保存了开头), then
  `第一次 2026-09-01 · 最近 今天 14:20 · 12 次 · 共停留 1 小时 5 分`.
- **Actions** behind ⋯: 打开原网页, 以后不保存这个网站的正文 (adds the host to the denylist; asks first), 删除这个页面
  的记录 (asks first: 访问和正文会从 recall 删除，不能恢复；Dropbox 备份只增不删，会多一条删除记录，原来的文件要在
  Dropbox 里自己删).
- **快照**: newest-first capture times, twenty at a time with 更多. Selecting one loads its plain text and optional
  viewport screenshot. Text keeps the existing reader, match navigation and truncation hints. The picture preserves
  its aspect ratio and is displayed as image/webp. Empty content says 未保存正文; it does not guess a dwell time or
  privacy reason. Archived content is read on demand and marked as coming from Dropbox. An unavailable archive
  or missing file has a specific hint.
- **访问**: the visits, newest first, 20 at a time (更多): the date and time range, the minutes, the device label; a
  date opens that day's timeline at that hour.

### 8.7 设置 (`/settings`)

Five cards, in the owner's words (a code stays in a tooltip only):

- **设备**: same-name installations form a display group. The latest connection is visible; older connections
  are folded under 同名旧连接 with their own version, status and 访问记录 link. Labels do not merge identities.
  Timeline options retain every ID and distinguish repeated names by version. 移除空连接 is offered only when
  the server explicitly reports no stored activity and no pending uploads. DeleteDevice rechecks visits, snapshots
  and queued_count in the transaction, then removes only connection metadata; tokens and archives stay unchanged.
  A later upload registers the installation again. Offline age never authorizes deletion.
- **插件口令** (§2.2): named and active shared upload credentials use one compact list, with a name and ⋯ above
  type and creation time. 改名 saves only label through UpdateMachineToken and an explicit update mask; digest,
  creation time, previous-token grace and Worker-secret credentials stay unchanged. Display names use
  last-write-wins; labels do not bind credentials to devices. New secrets still show once, with 复制. Adding a
  credential uses one form; rotation and stop actions remain in ⋯, and optional export access stays folded.
- **备份到 Dropbox** (§7.2): not connected, one line of what it does, the four steps at Dropbox (the apps page, Scoped
  access and App folder, the two permissions, the exact Redirect URI built from the page's own origin, the App key)
  and the App key field with 连接; connected, `Dropbox · <account>` with `20 分钟前上传` (the seq in a tooltip),
  `已全部备份` or `待备份 32 条（最早一条 3 小时前）` (in the warning color once a change waited a day since the
  connection), the last failure as a sentence that says what to do (the code in a tooltip), the line that the backup
  only grows, and 断开 (asks first). The browser's return from Dropbox (`?dropbox=connected|denied|expired|failed`) is a
  toast, then leaves the address. Under it, only when the feed has consumers, `读取变更 feed 的程序`: one row per consumer
  (its name, `2 分钟前同步`, `已全部同步` or `落后 32 条（最早一条 3 小时前）`, late or stale in the warning color).
- **存储**: meters: the object's database against its budget, the texts in the cloud, today's records written against
  20,000 and read against 1,500,000 (each with what happens when it runs out); the counts of pages, visits and texts;
  the index's reach (`正文搜索覆盖全部` or `覆盖 2025年3月 起`). Under the texts' meter the retention window: 正文在云端保留
  with a choice of 7 天 (the default), 30 天, 90 天, 180 天, 1 年, 2, 3, 5 or 10 年, or 永久 (a window set otherwise is shown as
  it is); a shorter window asks first (更早保存的正文在 Dropbox 确认备份后会从云端移除…); one line of what it means, the
  counts `云端 300 篇 · 只在 Dropbox 45 篇`, and in the warning color while Dropbox keeps it paused (`Dropbox 备份未连接：
  暂不从云端移除正文…`, or a failing backup). It shares the settings' etag with 网站名单: each saves on top of the other.
- **网站名单**: the owner's two lists (§3.7) as rows with their list (只记网站 or 不存正文) and ✕, an add field
  (`example.com 或 example.com/path`) with its list chosen (只记网站 by default: what the owner adds is mostly their own
  banks; a pattern added to one list leaves the other), one hint saying what each list keeps; the built-in lists folded
  under `内置 N 条`, in the same two groups. Every change sends only the two lists with the etag.

The build's short commit sits at the bottom.

### 8.8 States, keyboard and budgets

Loading shows skeleton rows in the list's shape, never a spinner over the page; an error is one line with 重试 where the
content would be; a mutation's error is a toast with the localized message. Light and dark from the same tokens,
`prefers-reduced-motion` respected (the only motion: a popover's fade and a row opening). Bundles: the UI's JavaScript
held to about 1.2 times its first measured size (`web/scripts/js-budget.mjs`; mailsort's is 67 KiB gzip), the Worker
likewise (`deploy/bundle-size.mjs`).

## 9. Operations

- **Status** lives in recall's 设置 and header line, and reaches Home through ops-v1: an `Ops` entrypoint, built in
  phase 1b as mailsort's is, with codes and counts only. Signals: `device_stale` (warning: a device seen in the last 30
  days without an upload for 24 hours), `archive_not_connected` (warning: the Dropbox backup is not connected, or
  Dropbox refused its token), `archive_behind` (warning, `hours`: a change has waited more than 24 hours for Dropbox,
  counted from the connection at the earliest; the feed's consumers raise nothing), `no_captures` (warning: yesterday
  had visits of ten seconds or more on pages that keep their text and no capture of them arrived, not even one recall skipped as a text
  it had: site-only and no-text pages, and texts that did not change, raise nothing), `items_rejected` (warning:
  uploads lost items in the last 24 hours; an `unsupported_item` waits and is not lost), `storage_high` (warning past
  850 MiB, critical at the budget), `upload_over_budget` (warning: today's row budget ran out), `reads_over_budget`
  (warning: today's reads stopped the feed, or the searches too) and `no_device` (info, before the first upload). A
  paused retention window raises nothing of its own: it pauses only while `archive_not_connected` or a failing backup
  (which `archive_behind` reports after a day) says why.
  Counters: `visits_today`, `texts_today`, `rows_written_today`, `rows_read_today`. No guard: the daily row budget already caps recall's share, and an upload it refuses waits in
  the extension's outbox. Home's entry had `status.type = "none"` while recall was check-only and has its `RECALL`
  binding and `"ops_v1"` since the go-live commit (§11), because Home's deploy waits for every service it binds.
- **Logs**: one line per upload (batch ID, items accepted and rejected, rows written, a code), per refused machine
  request (request ID, status, reason), per feed pull (request ID, status), per alarm (with the archive pass's state),
  per Dropbox connection (its outcome) and per archive failure (its code). Never a URL, host, title, text, token, code
  or path.
- **Emergency stops**, fastest first: the extension's switch in `chrome://extensions` (recording stops); 设置 → 插件口令
  → ⋯ → 停用 (every upload 503 within a minute); → 旧口令泄露：立即作废并重新生成 for a leaked token (only the new token
  works; a plain 重新生成 keeps the old one 24 hours); 设置 → 备份到 Dropbox → 断开 (revoked at Dropbox; the files stay);
  DeletePage for something that should not have been kept (and, if it must leave the copies too, the files deleted in
  Dropbox by hand).
- **Cost guard**: nothing here can bill on Workers Free except R2 past its free tier, which §5.3 keeps far away; Home's
  quota bars show the account's use.

## 10. Tests

All data is synthetic: pages on example.com, example.org and example.net hosts, Chinese and English texts written for
the tests, synthetic tokens of every scrubbed shape.

- `shared/` and `worker/test/*.test.ts` (Node): URL normalization and the page ID (a trailing dot, an underscore, a
  host the archive cannot carry); cutting long URLs and titles (the page ID of the whole URL); the scrubber (every
  pattern, the AI providers' and registries' keys, card and social security numbers and the numbers that only look like
  them, every parameter form, path segments kept and redacted over the corpus of synthetic URLs shaped like real ones,
  after an unlocking segment too, long hostile inputs in linear time, well-formed output); the denylist's three levels,
  the API key consoles, hash routes, trailing dots and the owner's two lists; the segmenter (CJK runs, mixed runs, lone
  characters, NFKC) and query building (phrases, quote doubling, a lone CJK character beside Latin letters, the term
  and length bounds, QUERY_NOT_SEARCHABLE); ingest validation; rendering a change from its row against the contract's
  fixtures; the archive's day file, `state.json` and `VERSION` against `fixtures/archive/` byte for byte, the bounded
  scan and a change filed by its own commit day (`archive.test.ts`); the Dropbox client (RFC 7636's PKCE example, the
  authorization URL, the content hash over 4 MiB blocks, ASCII Dropbox-API-Arg, every failure's code and Retry-After:
  `dropbox.test.ts`); the machine tokens (their shape, only the digest kept, the grace and the revocation, the Worker's
  minute of memory and the 10-second recheck: `tokens.test.ts`); the retention window (`retention.test.ts`: the setting
  and its default, nothing without a connection, a failing backup or a first `state.json`, each confirmation required
  (the blob for this connection with its hash, the day file written, the seq vouched for, a live page), the window's
  edge, at most 100 a step in one R2 call, the index row reduced and the digest forgotten, the totals, no tombstone and
  no seq, a deleted page's archived texts off the totals and the purge deleting only what R2 holds).
- `worker/test/runtime/*.test.ts` (workerd with a real SQLite RecallState and R2 binding, like mailsort's harness):
  upload to feed to blob end to end; idempotent retries (a visit's older revision, a second capture, a capture with the
  latest text's digest, a replayed document, a visit that began before its page's deletion); the denylist levels and
  scrub applied by the server to an old client's upload; refusals counted by reason; the compacted feed (a revision
  moves its record to a new seq, the gaps, `last_seq` on a short page, a deleted page gone at once from a feed read from
  0, its tombstone above every cursor, `feed_id`, 409 `cursor_ahead`); DeletePage of a page with 5,000 visits (one
  bounded call, then the alarm's chunks; the purge stopping at the maintenance allowance and going on the next day);
  the deleted page's text gone from R2 at once (410); the deletion ledger in recall's clock for a fast and a slow
  device; a host with an underscore stored and a newer extension's items refused as `unsupported_item`; a crash between
  the R2 put and the commit; the write budget's 429; the read budget (every call charged; the feed's 429, then
  SEARCH_OVER_BUDGET, the timeline still answering); the owner's site-only list on uploads; the index budget's
  demotion; search with every filter, both sorts, the caps reported only where they change results, snippets, Chinese
  phrases, a lone CJK character, and on a synthetic two-year store an old week with `type:read` and a common word with
  a range; **rows read at the design's two-year scale** (`scale.test.ts`: every search path, a next page, the status
  with an archive far behind and one gone, ops-v1, each held to a bound); ops-v1's `no_captures` and `items_rejected`
  not raised for pages without text, unchanged texts or an `unsupported_item`; the timeline's overlap
  scan; **the rows written per visit revision, per text and per FTS5 insert of 32 KiB of Chinese, measured**; pages
  against the contract's fixtures; ops-v1's signals; the machine routes' refusals never reaching the object; the
  machine tokens made in 设置 (`tokens.test.ts`: 503 before one, shown once, only the digest in meta and none in the
  request log or the status, a repeated request without the token, the grace of 24 hours, `revoke_previous`, delete,
  Origin and CSRF required, a Worker-secret digest still accepted); the archive pushed to a fake Dropbox
  (`archive.test.ts`, `fake-dropbox.ts`: the PKCE connection with the App key alone, the state used once and expiring,
  the refresh token never answered or logged; the first pass writes exactly `fixtures/archive/`; a pass with nothing new
  makes no call; later changes write their day and state.json, each blob once with `add`; a deletion adds its tombstone
  and deletes nothing; a large first upload in passes of at most 40 calls, newest day first; 429 with Retry-After,
  `too_many_write_operations`, doubling backoff; an expired access token refreshed; a refused refresh token
  disconnecting with `archive_not_connected`; disconnecting, the same app resuming, another app getting everything; a
  folder of another feed never written into); the retention window against a fake Dropbox (`retention.test.ts`: nothing
  removed while not connected or after a failed upload, with the status saying why; after the confirming pass the text
  leaves R2 while the index and page, its visits and the record stay, no tombstone, the feed unchanged, the blob
  route's 410, GetDocument's archive path, the search by title only; a text read again kept again; the owner's window,
  its range and 永久; a new Dropbox without the texts only the old one holds; on 250 seeded texts at most 100 a pass,
  oldest first, rows bounded, the edge kept); `scale.test.ts` also connects Dropbox to the two-year store (the status,
  each archive pass and a retention step held to a bound); CPU (`tools/workerd-cpu`): the Worker's requests, the
  heaviest upload, both search paths, a timeline day of 500 visits, the alarm, the archive's passes and a retention step
  of 100 texts whose index rows hold 32 KiB.
- `worker/test/smoke/smoke.mts` (`npm run test:smoke`, in "Recall checks"): the real `wrangler dev` on loopback; the
  owner API makes both machine tokens. The extension's own code (`extension/test/smoke-upload.ts`, under its fake
  `chrome.*`, only the network real) uploads a session; the owner's two lists set through the owner API come back in the upload's answer and
  the no-text one holds on the server for a text sent before the extension knew it; a host with an underscore and one
  written with a trailing dot are recorded; each token opens its own route only; the feed
  carries every uploaded record and the blob route its bytes and digest; the owner API answers the UI's calls (status,
  timeline, a Chinese search with a snippet, the page's text); Dropbox is connected through its OAuth flow (a loopback
  fake, `DEV_DROPBOX_ORIGIN`), and the archive the alarm writes there is accepted by the generated codec and, read by
  the contract's rules, holds exactly the feed's records with their blobs; a late upload of a text read 400 days ago
  waits while Dropbox is not connected, then leaves Cloudflare right after the pass that wrote it (the blob route's 410,
  the archive's bytes, GetDocument's Dropbox text and screenshot reads, still found by indexed text, the feed unchanged); after a DeletePage it gains
  the tombstone and keeps every file; no delete is ever called; the dev server's log holds no URL, title, text or token.
- `extension/test/` (Node, fake `chrome.*` APIs and a fake clock): the focus state machine (window and tab changes,
  idle backdating, lock, worker restarts, sleep gaps), visit splitting and revisions (one queued on focus loss,
  coalesced), the capture's rules (no text read on another route of the same document), the outbox (coalescing,
  batching, gzip, every answer of §3.8, an `unsupported_item` held and sent again, the owner's site-only list), the update check (a
  half-written folder, `BUILD` and the manifest disagreeing, the folder missing mid-swap: no reload; a matching pair:
  one), `install-extension`'s swap, the manifest (permissions, no `content_scripts`, `incognito`, the version of
  5 January 09:03 and 31 December 23:59 valid by Chrome's rule).
- `web/src/*.test.ts` (jsdom, a fake API on the shared transcoder): the timeline (sessions, hosts without `www.`,
  short-visit folding, the hour grid's shades, labels, jumps and one Tab stop, 在这天里搜索, site colors and borrowing,
  back to the open session without the jump to the latest, empty days and the jump, keyboard), the search (chips and
  where the focus goes, every operator and its errors with nothing searched meanwhile, 昨天, the box's own ✕, URL state,
  results, snippets, more and its focus, the caps' lines, the coverage lines, a dropped single character named, the
  read budget's line, a typed domain taking the picker's Enter, presets of the last n days, a single custom day, back
  showing the results as they were without a search), the page detail (marks, n and N, the first match scrolled to only
  below the screen, the capture lines, visits, delete and denylist confirmations), 设置 (stale devices, errors and
  refusals in words, clock skew, lost and waiting items, 插件口令 generated, shown once and copied, regenerated with its
  grace, revoked, stopped and the export token folded, 备份到 Dropbox's steps, 连接, the outcome toast, the connected state
  and its failures, 断开, the feed's consumers, meters, the retention window (its choice, the counts, the pause in words, a
  shorter window asked first, 永久, the etag it shares with the lists), the owner's two lists with mask and etag), the
  page detail's archived text, the search's coverage line, the header's backup line (connected, waiting, a day behind
  since the connection, not connected);
  `check-layout.test.ts` (the outlined empty hours, the two-line session rows, the sticky match bar among mailsort's
  rules) and `no-external.test.ts` as mailsort's.
- `proto/test/recall-archive.test.ts` runs already: the contract's fixtures against the codec (the contract's §7).
- `deploy/test/*.test.mjs`: the production config, the wrapper, Worker secrets kept by a deploy, the owner-machine
  secrets left out of GitHub.

## 11. Rollout and owner steps

**Phases.** 1a: the extension, ingest, the object and R2, the change feed, `recall-ingest-v1`'s IDL (and, until
2026-10-11, a reference consumer for the NAS; since then the archive's writer to Dropbox and the tokens in 设置). 1b:
the UI. 2, only after a week of 1a's measured sizes: stars (a full snapshot with inlined
images, a screenshot and a note; a `star` kind and the `读过 · 收藏` type, both compatible additions), shown in a
sandboxed frame (`<iframe sandbox="">` from a raw route answering with `default-src 'none'; img-src data:; style-src
'unsafe-inline' data:; font-src data:; form-action 'none'; base-uri 'none'`, and a matching `frame-src` in the page's
CSP).

**Landing** (mailsort's four steps; the owner said to build everything first and grant access at the end):

1. **Check-only.** 1a and 1b land with `recall` in `CHECK_ONLY`, `AHEAD_OF_DEPLOY` and `FIRST_DEPLOY_PENDING`,
   Home's entry 浏览记录 (group apps, icon `notebook-pen`, accent violet, `status.type = "none"`), the bucket in
   `infra/storage.tf` and the Bypass application (its three destinations) in `infra/access.tf`, and the "Recall
   deploy" job with its release recipe (the production, Access and Bypass probes), which `CHECK_ONLY` keeps from
   running, and the reconcile matrix entry. `FIRST_DEPLOY_PENDING` (`tools/service-catalog/inventory.py`) keeps the
   daily checks quiet until the first deploy: the account inventory accepts the Worker and `recall-store` absent and
   does not report `RecallState`'s namespace (it has no id yet), and "Personal cloud reconcile" excludes recall from
   its Worker comparison, which needs a verified deployment. The shared files are the ones every app is added to
   (`infra/README.md` "Adding an app"; mailsort's commits are the template), each edit one entry; another branch
   changes some of them at the same time, so recall rebases onto it and keeps its edits minimal.
2. **The owner dispatches "Infra apply"** (done 2026-10-10): the Access applications (whole host, Bypass) and the
   bucket.
3. **Go-live commit** (branch `recall-release`): the whole host's AUD and application ID into `config/resources.toml`,
   which `generate.py` writes into `recall/wrangler.toml` and `infra/ids.tf`; `CHECK_ONLY` and `AHEAD_OF_DEPLOY`
   emptied; Home's entry becomes `status.type = "ops_v1"` with its `RECALL` binding (`UNBOUND_OPS_APPS` emptied, Home
   deploys after recall in that run, and its tick budget grows to 31 outbound calls), with recall's ops-v1 fixtures
   `OpsStatus/recall-ok.json` and `recall-degraded.json` and their golden test. The Bypass application's own AUD and ID
   are not recorded: the Worker checks the machine tokens itself, and no check reads them. The CSRF key goes in before
   the commit lands, by piping a random value straight into `gh secret set RECALL_CSRF_SIGNING_KEY`, never shown;
   without it the deploy stops at its secrets step, and Home's with it.
4. **After the first deploy**: the object's namespace ID as `[durable_objects]["recall-state"]`, `FIRST_DEPLOY_PENDING`
   emptied and the reconcile matrix's `exclude` removed in the same commit (the inventory refuses a recorded ID while
   the entry remains, and a guard test holds the exclude equal to it), the generated inventories refreshed (done:
   `5086599`).
5. **The archive to Dropbox and the tokens in 设置** (branch `recall-dropbox-archive`, 2026-10-11): schema 2
   (`archive_days`, `archive_blobs`), the owner API's ConnectDropboxBackup, DisconnectDropboxBackup,
   RegenerateMachineToken and DeleteMachineToken (additive), the callback route, the ops-v1 signals, and the removal of
   `sync/`, its image workflow and `deploy/mint-tokens.mjs`. Its deploy changes nothing the owner set: a digest put
   before stays accepted. Landed and deployed as `c3e21b6`.
6. **The retention window** (branch `recall-retention`, 2026-10-11): schema 3 (`documents.archived_ms`, the index
   `documents_retention`), `Settings.text_retention_days`, `Document.text_archived` and `.archive_path`,
   `ServiceStatus.text_retention_days`, `.archived_text_count` and `.text_retention_paused_reason`,
   `ERROR_REASON_INVALID_RETENTION` (all additive), the alarm's retention step and the UI's lines. Its deploy moves no
   text before the owner's Dropbox backup is connected and has confirmed it; with the then-default of 365 days and recall
   live since 2026-10-11, the first text leaves Cloudflare in October 2027.

**The owner's steps**, all clicks, in this order (the agent builds the extension into its folder first:
`npm run install-extension` in `recall/extension`, into `~/recall-extension`):

1. recall → 设置 → 插件口令 → **生成** → **复制** (shown once).
2. Chrome → `chrome://extensions` → **开发者模式** → **加载已解压的扩展程序** → the folder; the extension's icon (the
   puzzle-piece menu → recall) opens its options: paste the token, type the device label (the server is filled in),
   **保存**.
3. dropbox.com/developers/apps → **Create app** → **Scoped access** → **App folder** → any name → **Create app**;
   **Permissions**: tick `files.content.write` and `files.content.read` → **Submit**; **Settings** → **OAuth 2** →
   **Redirect URIs**: add `https://recall.ziyixi.science/api/dropbox/callback`; copy the **App key**.
4. recall → 设置 → 备份到 Dropbox → paste the App key → **连接** → at Dropbox **Allow**.
5. The NAS (UGOS) → **Cloud Drives** → add **Dropbox** (the same account) → a sync task from `Apps/<app name>` to a
   shared folder, direction cloud → NAS.

The CSRF key was set before the go-live commit (`gh secret set RECALL_CSRF_SIGNING_KEY`, done).

**Checks after go-live**: an upload within five minutes of browsing, the device's heartbeat in 设置 and recall's tile
on Home, the first texts searchable (a Chinese phrase among them), 设置 → 备份到 Dropbox `已全部备份` with the app
folder holding `VERSION`, `state.json`, a day file and the texts (and the NAS's shared folder the same after its sync),
the day's rows written against the estimate (FTS5's writes in production decide between 32 and 16 KiB of indexed
text), and after a week the texts' sizes and `databaseSize` against §5.3.

## 12. Defaults to confirm, and review notes

Two privacy defaults the owner may turn around at review; each is one list in `shared/`:

- **Sensitive sites by their site alone** (§3.7): mail, chats and AI chats, banks and payments, password managers,
  consoles and account pages are recorded as `mail.google.com · 40 分`, without path or title, so no mail subject,
  chat name or account page reaches the archive. The alternative, the request's first idea, keeps their URL and title
  (never their text).
- **Google Docs and Drive links keep their document IDs** (§3.6), so they open from recall. A document shared with
  anyone who has its link can then be opened by whoever reads the (private) archive. The alternative redacts the IDs:
  the pages stay distinct and titled, the links stop opening.

Settled, no answer needed: the idle threshold (180 s, and going idle backdates the focus's end by it); the object's
budget (900 MiB, under the 1 GB that one line of Cloudflare's limits gives Free; it grows if the 10 GB of the table
holds, §5.3); the machine routes' prefix (§2.1).

An independent review of the first draft (2026-10-10) found the feed's frozen history at odds with deletion and the
object's size, silent losses, wrong date-range searches, an extension version Chrome refuses and a self-update race;
its fixes are in this text. Not taken as proposed:

- **Refusing a page whose `source` differs from the archive's**: the feed is named by `feed_id`; the origin is
  recorded but may change with the same feed (a renamed host), so it is not checked.
- **A ledger of deleted record IDs for the blob route's 410**: "no live document holds this path" gives the same
  answer for the failures that matter (a wrong binding or a lost object leaves a live document, so 500), without a row
  per deleted record.
- **A separate `$defs/ChangeEnvelope`**: the schema generator gives a consumer's union a branch for a kind it does not
  know (as the codec's lenient read does), so `$defs/Change` and `$defs/ChangePage` both accept a newer kind and stay
  the one place a consumer validates.
- **Blue for the accent**: violet, unused in the apps group, tells recall's tile from Mail Hero's and Watch's.

A second review (2026-10-10, of the built code) measured searches reading up to 150,000 rows at two years' scale and
found scrubber and denylist gaps, losses for hosts with `_` and for a newer extension's items, a leaked token that
`--rotate` kept working, and UI faults (back losing the owner's place, hosts cut to `ww…` on a phone, the picker's
Enter, focus lost on redraws). Every finding was taken; where its fix was a choice, this text took:

- **加载更多**: the first page's 200 results kept in the object's memory for 10 minutes (§6.3), rather than keyset
  tokens per path: one mechanism for every path, and the next pages read nothing.
- **A newer extension's items**: held in the outbox six hours at a time and sent again, rather than retried when the
  Worker's build changes: the answer carries no build, and a timer needs no new field.
- **Back**: each history entry's snapshot kept in the page's memory (lost on reload, which searches again), rather than
  keeping every view's DOM.
- **`?t=` and `?k=`**: redacted when the value is token-shaped, so that `?t=42s` keeps a video's time; `code` and `otp`
  always.
- **The read budget**: 1,500,000 rows a day for the searches, and the feed stopping at 1,000,000, so that an archive
  catching up never takes the owner's searches for the day.


## Mobile and multiple devices (October 12)

Each browser install keeps its own device UUID and upload queue. Named ingest credentials can be created and
stopped independently while the existing shared credential remains valid. Device identity remains client-reported;
credential labels are not a pairing protocol. Timeline filtering uses the stored device ID, not its editable label.
Settings folds repeated installation names for display only. Empty connections can be removed; every connection
with retained visits or snapshots is protected, including old computers. Label changes never rotate a credential.
Orion uses a file-install build of the same capture core and probes top-frame visibility/document identity on iOS.
Native JPEG is accepted when WebP encoding is unavailable, within the same byte/pixel limits. Both formats use
the existing R2, feed and single Dropbox archive; hot removal requires the same archive confirmations.
Mobile inactivity alone is not an Ops warning. Installation, foreground/background and update verification are
kept in the short [mobile runbook](mobile.md); no phone compatibility is claimed from fake browser tests alone.
