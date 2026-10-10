# `recall-archive-v1`: recall's change feed and the archive it fills

recall (`recall/`, the owner's browsing recorder) keeps every visit and captured page text in Cloudflare and offers
them as one ordered **change feed**. An **archive consumer** pulls the feed and keeps a copy as plain files, in a
**layout** that any filesystem or object store can hold and that plain tools (`find`, `zcat`, `grep`, `jq`) can read
for decades. Today the consumer is `recall/sync/` on the owner's NAS; the point of this contract is that the NAS can
be replaced, by another store or another consumer, without touching recall. recall owns the contract.

| File | Purpose |
| --- | --- |
| [`proto/recall/archive/v1/archive.proto`](../../proto/recall/archive/v1/archive.proto) | The records and their value rules: the one source |
| `recall-archive-v1.schema.json` | JSON Schema 2020-12 **generated** from the IDL (`npm run schema` in `proto/`; `npm run check:schema` fails when stale): `$defs/ChangePage` (a feed answer), `$defs/Change` (one archived line), `$defs/ArchiveState` (`state.json`). A consumer's schema: every object open, and a change of a kind it does not know passes on its envelope |
| `fixtures/<Def>/*.json` | Golden examples, synthetic, exact bytes (2-space JSON, as the codec writes them, then a newline) |
| `fixtures/future/` | A change a newer recall may send within v1 (`Change/star.json`, a planned kind, and its blob): every consumer archives it |
| `fixtures/invalid/<Def>/*.json` | Examples every reader must refuse (a blob path with `..`, an upper-case digest, another blob encoding, a visit without its body or page, a visit with a blob, a non-http URL, a malformed tombstone target, another version, a page or state without its feed, a negative cursor) |
| `fixtures/archive/` | The archive an empty store holds after applying `fixtures/ChangePage/first-page.json` on 2026-10-10 (UTC): the expected output of a consumer's test |

## 1. The feed

Two routes on the recall host, outside its owner API, each request with `Authorization: Bearer <export token>`. The
export token reads the feed and nothing else (the extension's upload token cannot read it, and neither token reaches
the owner API). Only GET; a consumer refuses redirects and sends no cookies.

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
| 409 `cursor_ahead` | `after` is above `head_seq`: this archive is ahead of the feed (recall's store was restored to an earlier point) | stops; the operator starts a new archive (§5) |
| 410 `cursor_expired` | `after` is below `oldest_seq - 1` (never in v1) | stops; the operator starts a new archive |
| 429, 503 | recall asks the consumer to slow down (its daily read budget for the feed is spent: until the next UTC day), or a dependency failed | retries after `Retry-After` seconds |

Error bodies are google.rpc.Status in Google's HTTP JSON form; a consumer branches on the status code only.

### `GET /api/machine/v1/blobs/<path>`

The bytes of a blob, `<path>` exactly as a change's `Blob.path` gives it (`2026/10/<uuid>.txt.gz`):
`Content-Type: application/octet-stream`, `Content-Length`, `Content-Digest: sha-256=:<base64>:` (RFC 9530),
`Cache-Control: no-store`. They are the stored bytes as they are: a gzip blob is answered gzip-compressed, without a
`Content-Encoding` header, so the change's `sha256` holds on the wire and on disk. A consumer checks `size_bytes` and
`sha256` itself, against the change, before it keeps a byte.

**410 `blob_deleted`** is the only answer that lets a consumer go on without the blob: recall holds no live record with
that blob, because the owner deleted it (its tombstone follows, or came already). Any other answer, 404 included (a
wrong path, a route that does not exist, a store that lost the object), stops the run without advancing the cursor.

### What recall guarantees

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
5. **Deletion.** The owner deletes a page in recall's UI: one tombstone is committed, `target: pages/<page id>`, and
   from then on the page's visits and documents are not served (a consumer that starts later never sees them); their
   blobs are removed after it. A tombstone deletes every change with a lower seq whose `id` is its target, or whose
   `page_id` is the page its target names, with those changes' blobs.
6. **At-least-once.** A consumer may see a change more than once (it asked again after a crash) and must apply it
   idempotently: by `id` and `seq` for records, by `path` and digest for blobs.

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
- **A kind a consumer does not know** (v1 may add one: `star` is planned, `fixtures/future/Change/star.json`) is
  archived like any other change: the whole line, its blobs fetched and checked, and a tombstone of its page deletes it
  too. Only the envelope is checked; the generated `$defs/Change` has a branch for exactly that.

## 3. The archive

```
<archive root>/
├── VERSION                      recall-archive-v1
├── state.json                   ArchiveState: the feed and the cursor, written last
├── changes/
│   └── 2026/10/
│       ├── 09.jsonl             the changes applied on 9 October (UTC), one per line
│       └── 10.jsonl
└── blobs/
    └── 2026/10/
        └── 7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz
```

- **`VERSION`**: one line, `recall-archive-v1`. A consumer refuses an archive of another version.
- **`state.json`**: an `ArchiveState` (2-space JSON): the `feed_id` the archive follows, the origin it last pulled
  from, the consumer's name and `synced_seq`, every change up to which is durable in this archive. It is written last,
  atomically, after everything it vouches for.
- **`changes/YYYY/MM/DD.jsonl`**: the changes the consumer applied on that UTC day (not the visits' day: a page holds
  changes of any age), one per line, compact JSON, UTF-8, LF, sorted by seq, and per `id` only the line with the
  highest seq. Each pull rewrites the day's file whole and atomically: its old lines and the new ones, merged by those
  rules, so applying the same page again changes nothing. A tombstone's purge rewrites older files (below). About 365
  files a year.
- **`blobs/<Blob.path>`**: each blob as stored in recall (its path is its UTC month and record UUID), written
  atomically after its size and digest were checked.

Reading it: the record with an `id` is its line with the highest `seq` (a record updated across UTC midnight has a line
in two files); a tombstone's targets are gone. For example, every visit of 9 October 2026 (UTC) and its time on the
page:

```sh
find changes -name '*.jsonl' -exec cat {} + \
  | jq -c 'select(.kind == "visit" and (.visit.start_time | startswith("2026-10-09")))' \
  | jq -sc 'group_by(.id) | map(max_by(.seq)) | sort_by(.visit.start_time) | .[]
      | {start: .visit.start_time, site: .visit.site, s: .visit.focus_seconds, title: .visit.title}'
find blobs -name '*.txt.gz' -exec zgrep -l 'Durable Object' {} +
```

## 4. A consumer

A consumer is one loop with one piece of state, `state.json`. The reference consumer is `recall/sync/` (one Python
file, standard library only, run in its own container); anything that follows these steps is a consumer.

1. Read `VERSION` and `state.json` (an empty store: write `VERSION`, start at `synced_seq` 0 with no feed yet).
2. `GET changes?after=<synced_seq>&limit=500&consumer=<name>`. Check the page and refuse it whole if anything is
   wrong, applying no part of it: its `version`; its `feed_id`, which must equal `state.json`'s (an empty store takes
   it); `last_seq` not below `after`; every change against `$defs/Change` (a known kind fully, another kind on its
   envelope). A page of another feed stops the consumer with `feed_changed`: it never mixes two feeds in one archive.
3. Merge the page's changes into today's file (UTC), `changes/YYYY/MM/DD.jsonl`, and write it atomically. Each change
   is kept whole, unknown members included; any JSON serializer may write the compact line.
4. For every blob of every change: skip it if `blobs/<path>` exists with the same size and digest; else fetch it,
   check `size_bytes` and `sha256`, write it atomically. 410 means the record was deleted since: go on without the
   blob. A digest mismatch or any other answer stops the run; nothing advances, and the next run starts again at 2.
5. For every tombstone in the page, in seq order: find the archived lines with a lower seq whose `id` is its target or
   whose `page_id` is the page its target names; delete their blobs, then rewrite (atomically) each file that holds
   one, without those lines. The tombstone's own line stays. (One pass over `changes/` per page with tombstones: they
   are rare, and there is one file per day.)
6. Write `state.json` with the page's `feed_id` and `synced_seq = last_seq`, atomically. Repeat from 2 while
   `last_seq < head_seq`, then sleep (the reference consumer: 15 minutes).

"Atomically" means a reader never sees a partial file: on a filesystem, write a temporary file in the same directory,
flush it, rename it over the name, flush the directory; on an object store, one PUT. A crash anywhere leaves
`state.json` at the last fully applied page, and the next run repeats the rest: step 3 merges the same lines again,
step 4 skips the blobs it has. Lines go in before their blobs, so a deletion that arrives after a crash still finds
the lines whose blobs it must remove. Paths come only from the contract's formats (`BlobPath`, the date): a consumer
never builds a path from any other field, and refuses a change whose path does not match.

## 5. Implementing another store or consumer

- **Another store, same consumer.** The reference consumer talks to its store through a driver with five operations:
  `read(path)`, `write_atomic(path, bytes)`, `exists(path, size, sha256)`, `delete(path)` and `list(prefix)`. It ships
  `dir` (a mounted directory: the NAS share, a USB disk, an SMB or NFS mount). A WebDAV server or an S3-compatible
  bucket (a NAS can expose either) is a new driver of those five operations, nothing else.
- **Another consumer.** Implement §4 in any language. Its tests, comparing each archived line as parsed JSON (key
  order and escaping are the serializer's business) and each blob byte for byte: apply
  `fixtures/ChangePage/first-page.json` to an empty store at a fixed clock and compare with `fixtures/archive/`; apply
  the same page again and find nothing changed; archive `fixtures/future/Change/star.json` whole with its blob from
  `fixtures/future/blobs/`; refuse every file in `fixtures/invalid/`; apply `fixtures/Change/tombstone.json` and
  check that the page's visit and document lines and the document's blob are gone and the other visit stays; refuse a
  page of another `feed_id`; go on after a 410 blob and stop on a 404; crash between every two steps and check the
  next run ends in the same archive.
- **Moving to a new store.** Either copy the archive (it is self-contained: files and `state.json`) and point a
  consumer at the copy, or start an empty one at `after=0`: the compacted feed gives it every record's latest change
  and every tombstone. Run the old and the new consumer side by side under two `consumer` names until both are caught
  up (recall's 设置 shows both), then stop the old one.
- **A new feed** (`feed_changed`, `cursor_ahead`, `cursor_expired`). The old archive stays as it is, readable and
  complete up to its `synced_seq`; the consumer starts a new archive root from `after=0`. Records present in both are
  the same records (same ids), so a reader of both deduplicates by `id` and `seq` within each.
- **Pruning (not built).** recall keeps every tombstone in v1. If it ever drops old ones, it will keep those above the
  lowest sync position of its consumers and raise `oldest_seq`; a consumer below it gets 410 and starts a new
  archive.

## 6. Versioning

Within v1, recall may add optional fields, kinds and blob roles; a consumer keeps what it does not know (it archives
each change whole) and checks what it does. A reader of the archive does the same. Anything else (a renamed or
removed field, a new meaning, another blob encoding, another layout) is `recall-archive-v2`: new routes
(`/api/machine/v2/...`), a new `VERSION`, a new archive root, with v1 still served until the owner retires it. The
profile's breaking checks (`proto/tools/profile_breaking.py`) hold the IDL to this.

## 7. Checks

- `proto/test/recall-archive.test.ts` (Proto checks, which a change here also runs: `PROTO_READS`): every valid
  fixture round-trips byte for byte through the codec's strict read, every invalid one is refused by strict and
  lenient reads, the future change passes a lenient read with its kind and body listed as unrecognized and its blob
  matches it, and `fixtures/archive/` is the first page applied to an empty store (its day file's lines, its
  `state.json`, its blob's size and digest).
- The generated schema is fresh (`npm run check:schema`). Checked by hand on 2026-10-10 with Python `jsonschema`
  (Draft 2020-12): it gives every fixture the codec's verdict, accepts the future change alone and inside a page, and
  accepts a known kind with unknown members.
- With recall's phase 1a: recall's Worker tests build the feed from synthetic visits and compare the answers with
  `fixtures/ChangePage/`; `recall/sync/`'s tests run §5's consumer tests against a loopback fake of the two routes
  serving these fixtures and their blobs.
