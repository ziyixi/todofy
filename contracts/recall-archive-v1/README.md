# `recall-archive-v1`: recall's archive and its change feed

recall (`recall/`, the owner's browsing recorder) keeps every visit in Cloudflare, and the captured page texts of a
rolling window the owner chooses (a year by default), and writes a durable copy of everything as plain files in a
**layout** that any file store can hold and that plain tools (`find`, `zcat`, `grep`, `jq`) can read for decades.
recall writes it itself: today into the app folder of the owner's own **Dropbox** app, about hourly while there are
changes, from where the owner's NAS syncs it with its own Dropbox support (UGREEN's Cloud Drives); nothing of recall's
runs on the NAS or the owner's Mac, and any store that holds files can take Dropbox's place (recall's writer is the
only part to change). For programs, recall also serves the same records as one ordered **change feed**. recall owns
the contract.

| File | Purpose |
| --- | --- |
| [`proto/recall/archive/v1/archive.proto`](../../proto/recall/archive/v1/archive.proto) | The records and their value rules: the one source |
| `recall-archive-v1.schema.json` | JSON Schema 2020-12 **generated** from the IDL (`npm run schema` in `proto/`; `npm run check:schema` fails when stale): `$defs/Change` (one archived line), `$defs/ArchiveState` (`state.json`), `$defs/ChangePage` (a feed answer). A reader's schema: every object open, and a change of a kind it does not know passes on its envelope |
| `fixtures/<Def>/*.json` | Golden examples, synthetic, exact bytes (2-space JSON, as the codec writes them, then a newline) |
| `fixtures/future/` | A change a newer recall may write within v1 (`Change/star.json`, a planned kind, and its blob): every reader keeps it |
| `fixtures/invalid/<Def>/*.json` | Examples every reader must refuse (a blob path with `..`, an upper-case digest, another blob encoding, a visit without its body or page, a visit with a blob, a non-http URL, a malformed tombstone target, another version, a page or state without its feed, a negative cursor) |
| `fixtures/archive/` | The archive recall writes for a store holding `fixtures/ChangePage/first-page.json`'s changes, committed on 2026-10-10 (UTC): `VERSION`, `state.json`, the day's file and the blob, byte for byte |

## 1. The archive

```
<archive root>/                  the Dropbox app folder (Dropbox shows it as Apps/<app name>/)
├── VERSION                      recall-archive-v1
├── state.json                   ArchiveState: the feed and how far the archive holds it, written last
├── changes/
│   └── 2026/10/
│       ├── 09.jsonl             the changes recall committed on 9 October (UTC), one per line
│       └── 10.jsonl
└── blobs/
    └── 2026/10/
        └── 7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz
```

- **`VERSION`**: one line, `recall-archive-v1`. A reader refuses an archive of another version.
- **`state.json`**: an `ArchiveState` (2-space JSON): the `feed_id` the archive holds, the origin it came from, its
  keeper (`consumer`: `dropbox` for the archive recall writes to Dropbox, a feed consumer's name for one it fills
  itself), `synced_seq`, every change up to which is in the archive, and `update_time`. Written after everything it
  vouches for. An archive holds one feed: recall never writes into a folder whose `state.json` names another feed.
- **`changes/YYYY/MM/DD.jsonl`**: the feed's changes committed on that UTC day (their commit time, not the visit's
  time: a day's file holds changes of any age), one per line, compact JSON, UTF-8, LF, sorted by seq, one line per
  `id`. recall writes a day's file whole, from what it holds then, whenever the day gains changes (at most about hourly),
  so writing it again changes nothing. A day's file is not written again when a later change supersedes or deletes one
  of its records: the newer line, or the tombstone, is in a later day's file. About 365 files a year.
- **`blobs/<Blob.path>`**: each blob as recall stores it (its path is its UTC month and record UUID), written once,
  before any line that refers to it, after its size and digest were checked; never written over. (One exception, in a
  second archive root of the same feed: a text recall's retention window had already moved out of Cloudflare is
  written there as its line alone, its blob staying in the first root; §4.)
- **Only growing.** recall never deletes or moves a file of the archive. When the owner deletes a page, the archive
  gains its tombstone line; the page's earlier lines and blobs stay where they are, and a blob that no line refers to
  any more belongs to a deleted record. The owner removes such files by hand if they want them gone from the copies.

**Reading it**: the record with an `id` is its line with the highest `seq` (a record updated across UTC midnight has a
line in two files); a tombstone deletes every line with a lower seq whose `id` is its target, or whose `page_id` is the
page its target names, with those lines' blobs. For example, every visit of 9 October 2026 (UTC) and its time on the
page, deleted pages left out:

```sh
find changes -name '*.jsonl' -exec cat {} + | jq -sc '
  (map(select(.kind == "tombstone")) | map({key: .tombstone.target, value: .seq}) | from_entries) as $gone
  | group_by(.id) | map(max_by(.seq))
  | map(select(.kind == "visit" and (.visit.start_time | startswith("2026-10-09"))
               and (($gone["pages/" + .page_id] // 0) < .seq) and (($gone[.id] // 0) < .seq)))
  | sort_by(.visit.start_time) | .[]
  | {start: .visit.start_time, site: .visit.site, s: .visit.focus_seconds, title: .visit.title}'
find blobs -name '*.txt.gz' -exec zgrep -l 'Durable Object' {} +
```

**Copies**: any tool that copies files keeps a faithful copy, since the archive only grows and each file is written
whole: the owner's NAS syncs the Dropbox app folder (one direction, Dropbox to NAS), and a copy of a copy is as good.
A copy taken while recall writes may lack the newest lines, never hold a broken file; `state.json` says how far it
holds the feed.

## 2. Records

Every change has the same **envelope**: `seq`, `id` (`<collection>/<uuid>`), `kind`, `event_time`, `page_id` (the page
the record belongs to; absent for a tombstone), `blobs` (`[]` when none), and one body named after its kind.

| Kind | `id` | `event_time` | Body | Blobs |
| --- | --- | --- | --- | --- |
| `visit` | `visits/<uuid>` | the visit's start | `visit`: URL, title, site, device ID and label, start, end, focus seconds, focus spans | none |
| `document` | `documents/<uuid>` | the capture | `document`: visit, URL, title, description, site, device ID and label, capture time, text size, truncated | `text`: the page's text, UTF-8, gzip |
| `tombstone` | `tombstones/<uuid>` | the deletion | `tombstone`: `target`, `pages/<page id>` (or a record's id) | none |

- **A visit** is one page in one tab, from its first focus to its last (it ends when the tab leaves the page or
  closes, after 30 minutes without focus, or 6 hours after it began). Only visits with at least one second of focus
  exist. A long visit is uploaded again while it grows: an upsert. A page of a sensitive kind (mail, chat, banking, a
  password manager, a console) is recorded by its site alone: the URL is the site's root and the title is empty.
- **A document** is the text recall captured from a page after ten seconds of focus, at most once per page and UTC
  day and only when it differs from the page's latest text: the page's `innerText`, scrubbed of secrets, cut at
  64 KiB.
- **The page ID** is the first 16 bytes of the SHA-256 of the page's normalized URL before scrubbing, in hex: it joins
  a page's visits and documents, and it keeps two URLs apart whose secret-bearing parts the scrubber replaced with the
  same `[redacted]`. A URL over 8192 characters is cut (`url_truncated`); its page ID still comes from the whole URL.
- **The device** is one browser profile running the extension: `device_id` (a UUID) and the `device_label` the owner
  gave it, as they were when the record was made, so every line describes itself.
- Titles, URLs and texts come from web pages: untrusted, already scrubbed, shown as text only.
- **A kind a reader does not know** (v1 may add one: `star` is planned, `fixtures/future/Change/star.json`) is kept
  like any other change: the whole line and its blobs, and a tombstone of its page deletes it too. Only the envelope is
  checked; the generated `$defs/Change` has a branch for exactly that.

## 3. The feed (for programs)

The archive is the copy to keep. For a program that wants the records as they change (another store, an index), recall
serves the same records as a feed: two routes on the recall host, outside its owner API, each request with
`Authorization: Bearer <export token>`. The export token reads the feed and nothing else; the owner makes it in recall's
设置 → 插件口令 → 导出口令 (optional: recall answers 503 while there is none) and can regenerate or stop it there.
Only GET; a consumer refuses redirects and sends no cookies.

### `GET /api/machine/v1/changes?after=<seq>&limit=<n>&consumer=<name>`

| Parameter | Rule |
| --- | --- |
| `after` | Every change with a seq up to `after` is already durable in the caller's archive; 0 for an empty archive |
| `limit` | 1 to 500; default 200 |
| `consumer` | The archive's name, `[a-z][a-z0-9-]{0,31}` (`nas`). recall records each name's latest `after` as that archive's sync position (shown in recall's 设置) and keeps at most 8 names (the one unseen longest goes first) |

The answer is a `ChangePage` (`application/json`, `Cache-Control: no-store`): `feed_id`, the feed's identity;
`changes` with a seq above `after`, in seq order, at most `limit`; `last_seq`, the next request's `after` (the last
change's seq when the page is full, otherwise `head_seq`); `head_seq`, the newest seq when the page was read;
`oldest_seq`, the seq from which recall keeps every tombstone. Other answers:

| Status | When | The consumer |
| --- | --- | --- |
| 400 | A parameter breaks its rule | stops: a bug |
| 401 | No or wrong token | stops until its token changes |
| 409 `cursor_ahead` | `after` is above `head_seq`: this archive is ahead of the feed (recall's store was restored to an earlier point) | stops; the operator starts a new archive (§4) |
| 410 `cursor_expired` | `after` is below `oldest_seq - 1` (never in v1) | stops; the operator starts a new archive |
| 429, 503 | recall asks the consumer to slow down (its daily read budget for the feed is spent: until the next UTC day), or a dependency failed | retries after `Retry-After` seconds |

Error bodies are google.rpc.Status in Google's HTTP JSON form; a consumer branches on the status code only.

### `GET /api/machine/v1/blobs/<path>`

The bytes of a blob, `<path>` exactly as a change's `Blob.path` gives it (`2026/10/<uuid>.txt.gz`):
`Content-Type: application/octet-stream`, `Content-Length`, `Content-Digest: sha-256=:<base64>:` (RFC 9530),
`Cache-Control: no-store`. They are the stored bytes as they are: a gzip blob is answered gzip-compressed, without a
`Content-Encoding` header, so the change's `sha256` holds on the wire and on disk. A consumer checks `size_bytes` and
`sha256` itself, against the change, before it keeps a byte.

**410 `blob_deleted`** is the only answer that lets a consumer go on without the blob: recall holds no copy of it,
because the owner deleted its record (its tombstone follows, or came already), or because recall's **retention
window** moved the text out of Cloudflare. Retention is not a deletion: recall moves a text out only after its own
archive (the Dropbox folder of §1) confirmed holding that blob and the day file that names it, so the archive keeps the
copy at `blobs/<path>`, the record stays live in the feed, and no tombstone follows. A consumer that wants every blob
copies it while it is recent (the window is at least 30 days), or reads it from recall's archive. Any other answer, 404
included (a wrong path, a route that does not exist, a store that lost the object), stops the run without advancing
the cursor.

### What recall guarantees (the feed and the archive alike)

1. **One feed.** `feed_id` names the feed, and a seq means something only within it. A recall rebuilt from an
   archive keeps that archive's `feed_id` and numbers on above its highest seq; a recall whose store was reset has a
   new `feed_id`, and so must one whose store is restored to an earlier point (recall v1 offers no such restore: the
   code that adds one renews `feed_id`, recall's design §7).
2. **Order and gaps.** Seqs increase in commit order. The feed is compacted: a change that a newer change of the same
   record superseded, or that a deletion removed, is no longer served, so seqs have gaps; `last_seq` decides where
   the next page starts. The latest change of every record always has a seq above any cursor that has not seen it.
3. **Upserts.** An update of a record is a new change with the same `id` and a higher seq: the change with the highest
   seq is the record. Reading a seq again gives the same change (a newer recall may add optional fields to it).
4. **Blobs first.** A change is committed only after all its blobs are stored.
5. **Deletion and retention.** Retention (recall keeping only a window of texts in Cloudflare) deletes nothing: the
   records stay in the feed and in the archive, and the archive keeps every blob; only the blob route answers 410 for a
   text recall's archive alone holds. The owner deletes a page in recall's UI: one tombstone is committed,
   `target: pages/<page id>`, and from then on the page's visits and documents are not served (a consumer that starts
   later never sees them); their blobs leave recall's store after it. A tombstone deletes every change with a lower
   seq whose `id` is its target, or whose `page_id` is the page its target names, with those changes' blobs; lines and
   blobs an archive already holds stay there, deleted by the tombstone line that follows them (§1).
6. **At-least-once.** A reader may see a change more than once (in two day files, or a feed page asked again after a
   crash) and applies it idempotently: by `id` and `seq` for records, by `path` and digest for blobs.

## 4. Another store or consumer

- **Another file store instead of Dropbox.** The layout is the contract; recall's writer (`recall/worker/src/backup.ts`)
  is the one part that knows Dropbox: three operations (write a file whole, add a file once, read `state.json`), and no
  delete. A WebDAV server or an S3-compatible bucket is a writer of those operations.
- **A program reading the feed.** It pulls `changes?after=<its seq>`, keeps what it needs idempotently (by `id` and
  `seq`), fetches blobs by path and checks their size and `sha256`, follows each tombstone, and remembers `last_seq`;
  a page of another `feed_id`, 409 `cursor_ahead` and 410 `cursor_expired` mean a new feed: it starts again from
  `after=0`. One that keeps its own archive writes this layout with its own name in `state.json`, and may remove a
  deleted page's lines and blobs (recall's own archive keeps them).
- **A new archive root for the same feed** (the owner connects another Dropbox app or account). recall writes every
  line again, and every blob it still holds; a text its retention window already moved out of Cloudflare is in the
  earlier root only, so the new root has its line without its blob. Keep the earlier root (and its copies).
- **A new feed** (recall's store reset). The old archive stays as it is, readable and complete up to its `synced_seq`;
  the new feed is written into a new archive root (for Dropbox: a new app, whose folder is new). Records present in both
  are the same records (same ids), so a reader of both deduplicates by `id` and `seq` within each.
- **Pruning (not built).** recall keeps every tombstone in v1. If it ever drops old ones, it will raise `oldest_seq`; a
  consumer below it gets 410 and starts again.

## 5. Versioning

Within v1, recall may add optional fields, kinds and blob roles; a reader keeps what it does not know (each change is
kept whole) and checks what it does. Anything else (a renamed or
removed field, a new meaning, another blob encoding, another layout) is `recall-archive-v2`: new routes
(`/api/machine/v2/...`), a new `VERSION`, a new archive root (a new Dropbox app folder), with v1 still served until the
owner retires it. The
profile's breaking checks (`proto/tools/profile_breaking.py`) hold the IDL to this.

## 6. Checks

- `proto/test/recall-archive.test.ts` (Proto checks, which a change here also runs: `PROTO_READS`): every valid
  fixture round-trips byte for byte through the codec's strict read, every invalid one is refused by strict and
  lenient reads, the future change passes a lenient read with its kind and body listed as unrecognized and its blob
  matches it, and `fixtures/archive/` holds the first page's changes (its day file's lines, its `state.json`, its blob's
  size and digest).
- The generated schema is fresh (`npm run check:schema`). Checked by hand on 2026-10-10 with Python `jsonschema`
  (Draft 2020-12): it gives every fixture the codec's verdict, accepts the future change alone and inside a page, and
  accepts a known kind with unknown members.
- In "Recall checks": recall's Worker renders each change from its row and its tests rebuild `fixtures/Change/`,
  `fixtures/ChangePage/` (`recall/worker/test/feed.test.ts`) and `fixtures/archive/` (`test/archive.test.ts`, and in
  workerd `test/runtime/archive.test.ts`, which writes it to a fake Dropbox byte for byte) from synthetic records; the
  smoke run (`recall/worker/test/smoke/`) checks the archive a real `wrangler dev` writes to a loopback fake of Dropbox
  against the codec and the reading rules above, before and after a deletion, and that a text past the retention
  window leaves recall's store only after the archive holds it (the blob route's 410, the feed unchanged);
  `test/runtime/retention.test.ts` holds the same in workerd.
