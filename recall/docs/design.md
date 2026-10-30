# Recall design

Recall records the owner's foreground browsing visits and eligible text/viewport snapshots. One Worker serves an
Access-protected timeline/search UI, one SQLite Durable Object owns records and the index, and private R2 holds hot
snapshot files. Recall writes the durable archive into the owner's Dropbox app folder; the NAS uses its own Dropbox
sync. Current acceptance limits are in [verification](verification.md), with phone behavior in [mobile](mobile.md).

## 1. Shape

| Boundary | Responsibility |
| --- | --- |
| `extension/` | Focus/visits, capture, scrub, IndexedDB outbox and upload; Chrome MV3 and Orion MV2 builds |
| `shared/` | URL identity, scrubber, denylist, segmentation and diagnostic codes used by both sides |
| `worker/src/http.ts` | Exact routes, machine authentication, Access/Origin/CSRF, static assets; one object call |
| `RecallState` | SQLite, ingest, search, owner API, change feed, Dropbox writer, retention and alarms |
| `web/` | Chinese timeline, search, page and settings UI over `recall.ui.v1` |
| `proto/recall/` | `ui.v1`, `ingest.v1` and `archive.v1`; IDL and shared wire codec own serialization |
| `contracts/recall-archive-v1/` | Public archive layout, reading rules and frozen fixtures |

The object instance is `recall-v1`, namespace key `recall-state`; R2 binding `STORE` uses `recall-store`.
There is no D1, KV, Queue, cron or Workflow. Fetch authentication and dispatch stay within the Worker CPU path;
JSON parsing, tokenization, storage and search run in the object. Application imports stay within Recall and the
repository's shared packages/contracts/proto.

## 2. Safety model

Incognito, Recall's own pages, non-HTTP(S) pages and visits under one second are excluded. Sensitive sites keep only
their site, while no-text sites keep scrubbed URL/title without capture. Password pages produce no text or screenshot.
The browser cleans before upload and the Worker applies the same policy again. Owner-specific private site lists stay
in settings. Titles and text render through `textContent`; highlighted terms use `<mark>`, never saved HTML.
Logs, errors, diagnostics and ops-v1 carry IDs, counts and fixed codes, without URLs, hosts, titles, text or tokens.
Invocation logs and traces remain off. Screenshot pixels are not redacted by the text scrubber.

### 2.1 Authentication

| Caller | Route | Credential |
| --- | --- | --- |
| Owner browser | UI, `/api/v1/*`, `/api/csrf` | Access owner JWT; Origin and CSRF before reading a mutation body |
| Extension | `POST /api/machine/v1/batches` | Ingest bearer token, write only |
| Feed reader | `GET /api/machine/v1/changes`, `GET /api/machine/v1/blobs/<path>` | Export bearer token, read only |
| Dropbox browser callback | `GET /api/dropbox/callback` | Access owner plus the initiating connection's one-time state |

Access Bypass covers exactly the three machine destinations above, with a wildcard only for blob paths. Before any
object call, the Worker matches method/path, bounds compressed input at 1 MiB and compares bearer SHA-256 digests in
constant time. Other paths/methods, invalid credentials and missing configuration return their explicit HTTP errors.
Machine credentials do not authorize owner APIs; Access does not replace machine credentials. Blob reads reach R2
directly and consult the object only on a missing key.

### 2.2 Tokens: made in 设置, shown once, kept as digests

Owner mutations create 32 random bytes with the `recall_ingest_` or `recall_export_` prefix and answer the token once.
Only its SHA-256 is stored; idempotency answers remove the token. Export credentials are optional for Dropbox backup.
Named upload credentials can be disabled independently. Rename changes only the label and preserves identity,
digest, timestamps and grace period; credential labels do not bind devices.

Regeneration keeps the previous token for 24 hours. `revoke_previous` invalidates it immediately; 停用 removes the
credential. Worker memory caches digests for one minute and rechecks refused tokens at most every ten seconds per
isolate. Existing Worker-secret digests remain accepted and deployments preserve them. Never put tokens in logs,
commands, chat or committed files.

### 2.3 Deletion and retention

Pages, visits and document metadata remain until owner deletion. R2 snapshot files use a seven-day default,
configurable from 7 to 3650 days or permanently. Removal requires a live page, a connected non-failing Dropbox target,
confirmed hashes for every text/image blob, the written date file and covering `state.json`. A disconnected or failed
archive keeps files in R2. Retention preserves document associations, seqs, digests and search index entries; its
move creates no tombstone or feed event. Normal index capacity demotion is separate.

Opening an archived snapshot reads its known Dropbox files without refilling R2. Disconnection and missing files
produce explicit errors. A new Dropbox target cannot recover files held only by the old target.

DeletePage removes the live page and index entry in one transaction and adds the permanent `pages/<id>` tombstone.
All reads join live pages, so its visits/documents disappear immediately; R2 deletion and bounded row purges follow.
Late visits/captures from before deletion cannot revive the page. Dropbox gains the tombstone and keeps old files;
the UI explains that those copies must be removed there separately if desired.

Request-id answers last one day; usage lasts 400 days. Feed consumers expire after 30 days without a pull; recent
errors and consumers are bounded. These bookkeeping limits do not authorize deleting browsing records.

## 3. The extension

### 3.1 Files and permissions

The Chrome manifest is MV3, minimum Chrome 120, `incognito: not_allowed`, with no static content scripts or remote
code. It uses tabs, webNavigation, idle, alarms, storage, unlimitedStorage and scripting, with HTTP(S) host access.
The committed public key fixes extension ID `kpehdcbafdhgghclgaeigokjoceemfhj`; no private key is needed for unpacked
installation. The Orion ZIP uses the same capture core with a nonpersistent MV2 background page.

### 3.2 Focus

Event listeners register at startup. Tab, navigation, window-focus, idle and visibility events drive one serialized
focus state. The open span is mirrored from session to local storage with `lastBeat`. Idle detection is 180 seconds
and backdates the end by that interval; locking ends it immediately. A minute Alarm refreshes state and uploads.
After a gap over two minutes or startup, an old span ends at `lastBeat` rather than counting suspended time.

Orion uses the event's tab ID and a fresh top-frame document/visibility reply. Missing desktop APIs do not establish
foreground activity. Native callbacks have a five-second bound. Current-document listeners are reused; new documents
or old/missing scripts are injected once, then actual messages verify the document before reading text. Phone
background suspension carries no scheduling guarantee.

### 3.3 Visits

A visit identifies one normalized URL/document in a tab. SPA route changes start another; ordinary fragments do not.
It ends on navigation/close, 30 minutes without focus or six hours after its first focus. Upload requires one second
of focus. At most 200 spans fit a visit. Focus loss, end and periodic changed visits queue increasing revisions;
the outbox keeps the newest revision per visit. Times retain device provenance; overlap totals use time unions.

### 3.4 Capture

First capture follows ten seconds of foreground focus; the minute tick retries eligible pages. Failed/empty attempts
do not advance the last successful baseline. Unchanged text and fewer than 8% of pixels changing by 24 RGB levels in
a 32×32 preview skip another image. Comparison is with the last saved image, so cumulative change is preserved.
There is no daily capture cap.

Capture reads at most 64 KiB UTF-8 text and checks URL, document, password fields and focus around screenshot capture.
Native WebP or verified native JPEG uses quality 0.75, longest edge 1920 and at most 384 KiB. Screenshot failure can
still save text, and an image-only snapshot is supported. No OCR, full-page stitching or pixel redaction runs.

### 3.5 URLs and the page ID

`shared/url.ts` uses WHATWG normalization: HTTP(S), lowercase host, no default port/trailing dot, preserved underscore,
ordinary fragment removal but retained hash routes, and tracking-parameter removal. The page ID is the first 16 bytes
of SHA-256 over the whole normalized URL **before** secret scrubbing. The site omits a leading `www.`.
An unsupported archive host is excluded before queueing. URLs over 8192 characters are cut after identity generation
and flagged; titles/descriptions over 1000 characters are shortened with an ellipsis. The Worker applies the same
bounds for older clients.

### 3.6 Scrub

`shared/scrub.ts` owns linear secret patterns and URL rules. Recognized tokens, private keys, credentials, card/SSN
shapes, user-info and secret assignments become `[redacted]`. Query names are normalized for case, hyphens and
underscores; secret/capability parameters are redacted. `t` and `k` are redacted only for token-shaped values so video
timestamps survive. High-entropy capability paths are scrubbed; approved Google Docs/Drive links keep document IDs.
The synthetic corpus and hostile-input tests protect these rules. Notices remain in `shared/NOTICE`.

### 3.7 Denylist

`shared/denylist.ts` matches host/subdomains and optional case-insensitive path prefixes, including hash routes:

- Recall itself is never recorded.
- Mail, messaging/AI chat, identity, password managers, financial sites and account/API consoles keep only site-root
  identity, with no path, title, text or screenshot.
- The owner's other apps, login/auth paths and no-text list keep scrubbed URL/title without capture.

Private owner patterns stay in two settings lists, at most 200 together. Upload answers include both lists and their
etag; the Worker enforces them on every received item, including old clients. Site-only reduction recomputes page ID
from the root. Personal banks/sites do not enter the public repository.

### 3.8 Outbox and upload

IndexedDB keeps documents and each visit's newest revision. The ordinary tick flushes after five minutes, at 25 items,
at startup or explicit 立即上传. A batch has at most 50 items and 1 MiB JSON, gzip via `CompressionStream`, no cookies,
and a 25-second request timeout. Mobile durably queues changed captures/ended visits before immediate upload.

| Response | Queue behavior |
| --- | --- |
| 200 | Remove accepted/rejected items, except hold `unsupported_item` for six hours for a newer Worker |
| 401 | Stop until the credential changes; preserve queue and show error |
| 413 | Halve the batch |
| 429/503 | Honor Retry-After |
| Network/other | Existing exponential backoff, one minute to one hour |

No queued item expires. Above 200 MB the extension stops capturing text while visits continue. Uninstalling deletes
the local outbox; switching it off leaves queued data. Settings saving is independent of capture/upload and reports
an unconfirmed save after twelve seconds without discarding the pasted token.

### 3.9 Heartbeat and device

Each installation owns a UUID, label and queue. Batches report version, queued count, fixed last error and sent time;
after 30 minutes without upload a minute tick can send a heartbeat. Clock skew over two minutes is displayed.
A heartbeat or empty queue does not prove capture. Same-name devices fold only in UI. DeleteDevice is allowed only
with no retained visits/snapshots and `queued_count=0`; it removes connection metadata, not credentials or history.
Actual ingest may register it again. Inactivity alone does not justify deletion or phone warnings.

### 3.10 Distribution and updates

Bazel builds Chrome and Orion folders/ZIPs; main Actions publishes the tested artifacts as immutable version releases.
Versions use `<year>.<month×100+day>.<hour×100+minute>` with no leading-zero components. Stamped release builds embed
source identity; ordinary local builds have stable development identity. [Extension instructions](../extension/README.md)
own install/update details.

The installer validates files, version and public key in a sibling folder, swaps with two renames and writes `BUILD`
last. The running Chrome extension reloads once only when `BUILD` and manifest agree on a different version. Half
writes, swap gaps or a stale capture build do not become a valid update. IndexedDB survives reload. Orion phone ZIP
installation is explicit and has no unpacked-folder self-update.

## 4. Ingest

`recall.ingest.v1` defines gzip batch/device/visit/document wire JSON. The object bounds decompressed data at 4 MiB,
uses the strict shared codec, re-scrubs/re-filters, computes focus totals and applies idempotency. Older visit revisions,
unchanged snapshots and pre-tombstone records are accepted without duplicate writes. Device clock skew translates
tombstone comparisons to the Recall clock; items are not rejected merely for age or string length. Invalid data,
conflicting document identity and newer unsupported fields/kinds have separate rejection codes.

Blob bytes go to R2 with digest checks before the row transaction. New/changed rows, seqs and index state commit
atomically; retry rewrites the same blob key if the transaction failed. One device update occurs per batch.
Rows read/written are charged from SQLite cursors after every object call. Limits are in §5.3; owner mutations,
timeline and page reads retain their defined behavior when upload/search quotas are exhausted.

## 5. Storage

### 5.1 The object's SQLite

`worker/src/store.ts` owns schema version 6 and the incremental migrations under `blockConcurrencyWhile`.
Meta/settings/digests, devices, sites, pages, visits, document metadata, FTS5, tombstones/purges, consumers,
archive confirmations, usage and request-id records live in the same database. Column/index definitions stay in
those migrations rather than a second documentation schema. Version 4 added screenshot/retention metadata;
version 5 added the mobile device flag and version 6 added device/capture indexes.

The feed is the records' own seq, without a duplicate history table. Revisions move a row to a new seq; seqs are
never reused, and each row retains the values its feed line renders. Deleted-page joins hide records while bounded
purge continues. `host_key` reverses host labels for an indexed host/subdomain range, avoiding unbounded LIKE.

### 5.2 R2

Private R2 keys match archive blob paths. Gzipped scrubbed text and optional image bytes keep their size/digest
metadata; retention/deletion removes them only through the rules in §2.3. The archive uses the same paths.
A missing key is not automatically treated as a valid deletion (§7).

### 5.3 Budgets

Workers Free limits are shared across the account. Recall's own source-enforced budgets are:

| Resource | Bound |
| --- | --- |
| Uploaded SQLite writes | 20,000 rows/UTC day, then 429 until next UTC midnight plus bounded jitter |
| Maintenance writes | Stop at 10,000 daily rows, preserving upload allowance |
| Feed reads | Stop at 1,000,000 daily rows with Retry-After |
| Search reads | Stop at 1,500,000 daily rows with SEARCH_OVER_BUDGET |
| Indexed text | At most first 32 KiB/page; demote oldest text beyond 500 MiB or 850 MiB database |
| Object storage budget | 900 MiB, warning at 850 MiB |
| Archive pass | At most 40 subrequests, five minutes, 10,000 scanned changes/table and 20,000 rendered changes |
| Retention step | At most 100 snapshots from 1,000 oldest candidates |
| Purge step | At most 500 rows |

The Worker routes/authenticates without parsing uploads; object CPU and row bounds have real workerd checks.
R2 hot-file retention does not bound visit/database growth or erase indexed text. Account/provider quotas are not a
billing hard cap, and these estimates are not production CPU measurements. Budget changes require an intentional
code change and the original CPU/scale/bundle checks.

### 5.4 The alarm

The daily alarm runs at 04:00 UTC. Changes while Dropbox is connected schedule an archive pass about an hour later;
connection schedules one immediately and a backlog continues a minute later. It purges deleted-page rows, expires
small bookkeeping records, demotes old index text when needed, writes the archive, then removes confirmed hot files.
Maintenance stops at its row allowance and resumes on the next daily run. No separate scheduler runs.

## 6. Search

### 6.1 The index

FTS5 holds one contentless row per live page: title, URL and up to 32 KiB of its latest text. New capture replaces it;
capacity demotion keeps title/URL. File retention preserves it. A later title-only revision does not reread/rewrite
text solely to update the index.

The segmenter applies NFKC/lowercase and overlapping CJK pairs (`数据库` → `数据 据库`) to both index and query.
Terms become escaped FTS phrases; a lone CJK query character is unsearchable. Mixed Latin/CJK terms retain the
existing prefix behavior and UI explanation. Changing segmentation requires an index rebuild, not merely a new client.

### 6.2 The query language

The UI converts operators to typed `SearchPagesRequest` fields. The server reads at most ten query terms of at most
200 characters, escapes quotes and never parses UI operators.

| Operator | Meaning |
| --- | --- |
| `site:github.com` | Host and subdomains |
| `after:2026-09-01` | Inclusive local midnight |
| `before:2026-10-01` | Exclusive local midnight |
| `type:read` | Page with captured text |
| `dwell:2m` | Minimum focus in the selected range |
| `"冷启动 优化"` | Phrase |

Invalid operators stay editable and block a search with a hint. Dates accept the supported numeric forms and
今天/昨天/前天. Filtering and sort remain in URL/history state; Back restores the view rather than jumping to latest.
Results use escaped plain text and bounded snippets, with dropped single-character terms explained.

### 6.3 Evaluation

The most selective candidate source drives bounded indexed reads; every other condition is checked before sorting.
A time range scans at most 20,000 overlapping visits; FTS reads at most 2,000 matches before the alternate bounded
path; a site of at most 5,000 pages can be read whole. The fallback keyset scan stops at 200 results or 5,000 pages.
Visits overlap `[start,end)` using their maximum six-hour duration to bound the indexed scan. `candidates_capped`
appears only when a bound can change the answer.

At most ten snippets read currently hot text from R2. The result set, up to 200 rows, stays in object memory for ten
minutes with at most sixteen searches; bound page tokens reuse it without another scan. Restart recomputes and
deletion invalidates it. Original synthetic two-year scale tests assert actual SQLite rows read on each query path,
including capped searches and zero additional reads for a cached next page.

## 7. The archive and the change feed

The [recall-archive-v1 contract](../../contracts/recall-archive-v1/README.md) owns layout, schemas, frozen bytes and
consumer guarantees. Visits/documents join live pages; tombstones remain. Three bounded seq reads merge into each
page. `last_seq` is the last emitted seq for a full page and `head_seq` for a short page. Seqs may have gaps and
revisions move above cursors that missed them.

A first migration creates `feed_id`; a cursor beyond head returns `cursor_ahead`. A point-in-time restore cannot reuse
later seqs under the same feed identity. No archive-import/restore implementation is implied by readable backup files.
A future restore must satisfy the contract's identity/reset rules. Consumers expire after thirty days of inactivity;
status counts lag with a cap rather than scanning an unlimited backlog. Feed-read exhaustion preserves search allowance.

Blob reads validate path/token and return R2 bytes/digest. On a miss the object distinguishes intentional removal
(`blob_deleted`, 410) from a live document's missing bytes (`blob_missing`, 500). Wrong bindings/lost blobs must stop
consumers rather than silently skip records.

### 7.1 Visits and the archive's time

Visit event time is its start. Archive day files group by Recall commit time (`seq_ms`), not visit time, so a late
upload still belongs to the day it committed. Timeline consumers use the visit's own timestamps.

### 7.2 The archive in Dropbox

Recall alone writes the owner's App-folder archive. OAuth uses App key and PKCE without App secret. An owner mutation
creates one-time hashed state/verifier valid for fifteen minutes; the Access-protected browser callback consumes it,
exchanges the code and redirects to settings. The refresh token remains in object meta; access tokens stay in memory.
Disconnect revokes authorization and forgets it, leaving files intact. Reconnecting the same app/account resumes;
another target receives the available archive again. A folder naming another feed is refused.

Each pass scans bounded change seq/time ranges and marks their days dirty. Writing waits until the scan reaches head,
then newest dirty days render from current records. Every referenced blob is read, size/digest checked and uploaded
once with `add`, with Dropbox content hash checked. Day files, `VERSION` and `state.json` use whole-file writes.
State advances only after its files. A blob conflict leaves its confirmation absent, so retention cannot remove it.
Retries reuse the confirmed ledger and never delete or move Dropbox files. The new target cannot reproduce blobs
already removed from R2 and held only by the old archive.

The pass honors Retry-After/too_many_write_operations; other failures back off from one minute to one hour, with
30-second request timeouts. Refused refresh authorization disconnects. Settings reports connection, last upload,
waiting changes and fixed failure codes. ops-v1 reports missing connection and changes waiting over 24 hours,
counted from connection at the earliest; it never logs archive paths or private data.

## 8. The owner API and the UI

The generated owner API uses typed resources, etags/update masks and request-id idempotency. Timeline, search, page
detail and settings provide explicit loading/error/empty states. UI-only labels never become persistent device or
credential identity. Settings owns token creation/rename/revocation, protected connection cleanup, private site lists,
Dropbox authorization, retention and bounded usage/status. Delete confirmations explain archive copies.

The UI's responsive layout and focus/keyboard behavior are checked with synthetic content. Search chips preserve
editable invalid input, highlight text safely and report coverage/budget caps. Snapshot details retain metadata when
content is unavailable and distinguish hot/archived sources. Mobile and diagnostics follow the [mobile runbook](mobile.md).

## 9. Operations

Home reads ops-v1 codes/counts through the private binding: no device, stale desktop device, no captures, rejected
items, archive connection/lag, storage and row budget. Phone inactivity or an unchanged/no-text capture is not a false
capture warning. `unsupported_item` waits in the extension and is not counted as lost.

Stopping the extension stops capture; disabling a credential stops its uploads after digest-cache expiry. Dropbox
disconnect leaves archive files. Code rollback uses the repository release/recovery procedure and must preserve read
support for archived snapshot metadata. Deleting the Worker/object or storage is not a code rollback. Restore
acceptance is separate from backups existing; see [rebuild verification](../../docs/rebuild-verification.md).

## 10. Tests

From the workspace root:

```sh
bazel test //recall:check
bazel test //recall/worker:runtime_tests --nocache_test_results
bazel test //recall/worker:smoke_test --nocache_test_results
bazel test //recall/extension:browser_tests
bazel build //recall
```

File-level units cover focus, URL/privacy, queue/retries, codec/fixtures, search, token/setting rules and install swaps.
Real workerd checks exercise SQLite, R2, strict owner/machine routes, archive/retention failures, row scale and CPU.
The smoke chain uploads from extension code to the real local Worker and fake Dropbox, then verifies contract bytes,
archived reads and tombstones. The pinned WebKit check executes built probe/capture/settings with real DOM,
IndexedDB, JPEG and gzip behind a synthetic extension API bridge. These checks use no private pages or production
credentials. WebKit/macOS observations do not establish Orion iOS background or continuous capture acceptance.
