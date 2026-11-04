# Storage

Storage gives applications a namespace-scoped HTTP interface to a separate Dropbox App-folder connection.
The owner console connects Dropbox and creates independently revocable read-only or read/write keys.
Each key selects a fixed namespace on the server. File data lives in Dropbox; the native SQLite Durable Object
holds the connection state, key hashes, a cursor-signing key, the last provider error reason and request counters.
Storage uses no D1, R2, cron trigger or alarm; counters are written periodically from memory (below).

The separate Dropbox app uses `files.metadata.read`, `files.content.read` and `files.content.write` with offline PKCE.
The callback is `/api/dropbox/callback`. Existing Recall connections, files and archive contracts are independent.
Disconnecting revokes this connection and retains files. There is no delete-object endpoint. If Dropbox already
revoked the authorization, disconnecting removes the local connection, and connecting replaces it.

## HTTP protocol

Machine requests use `Authorization: Bearer <application key>`. Owner cookies and Access assertions do not replace
that key. Authentication precedes reading JSON or binary bodies, and the ordinary Worker refuses a malformed key
with 401 before waking the Durable Object. The three machine paths are:

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /api/storage/v1/stat` | JSON `{key}` | `{key,revision,size_bytes,content_hash}` |
| `POST /api/storage/v1/list` | JSON `{prefix,cursor,page_size}` | `{objects,next_cursor}` |
| `GET /api/storage/v1/content?key=...` | Optional Range and If-Match | Binary content, ETag and X-Storage-Content-Hash |
| `HEAD /api/storage/v1/content?key=...` | Same read conditions | Metadata headers without content |
| `PUT /api/storage/v1/content?key=...` | Binary body and a write precondition | The complete object metadata |
| `POST /api/storage/v1/content` | Binary concatenation and `X-Storage-Batch` manifest | Complete object metadata in manifest order |

Control JSON uses the repository wire profile in `storage.objects.v1`; failures use `google.rpc.Status`.
Keys are relative, at most 1,024 ASCII characters. Segments cannot be empty, `.` or `..`; absolute paths,
backslashes, URI escapes and Dropbox `id:`, `ns:` and `rev:` selectors are rejected. Dropbox retains its
case-insensitive path behavior. A listing may return an empty page with a continuation; keep reading until
`next_cursor` is empty. Continuations are authenticated and bound to the namespace and prefix.

`page_size` defaults to 100 and is capped at 100. Each response is one Dropbox page with at most the requested
number of objects. The first request asks Dropbox for that limit; continuations return Dropbox's next page, which
keeps the first request's limit, so keep `page_size` the same throughout one listing. Dropbox's limit is approximate;
a page with more matching objects than `page_size` fails with 503 `PROVIDER_RESPONSE_INVALID` instead of being
truncated, and repeating the same request fails again. A continuation carries the signed Dropbox cursor and expires
after 24 hours; a continuation from the retired page cache returns `CURSOR_INVALID`.
Provider JSON remains bounded at 512 KiB. [Dropbox documents the approximate limit and continuation rules](https://github.com/dropbox/dropbox-api-spec/blob/main/files.stone#L1687-L1771).

Each object is at most 32 MiB. Uploads require Content-Length and enforce the actual stream length.
`If-None-Match: *` creates an absent object. `If-Match: "revision"` replaces that exact revision; the unquoted
original revision is also accepted. Blind writes, weak validators, lists and wildcard If-Match are refused.
The provider uses `strict_conflict: true` and `autorename: false`. Conflicts return 409 `ABORTED`.
Explicit provider rate limits and recognized namespace write contention return 429 `UNAVAILABLE` with Retry-After;
an absent delay becomes one second. The gateway does not repeat uploads. The caller can bound retries of those
explicit rejections while preserving its body and condition. See [Dropbox's rate and namespace-lock semantics](https://docs.dropboxapi.com/dropbox-api/docs/performance).
A lost successful upload response can be resolved by statting and verifying the intended size and hash.
A full Dropbox (`insufficient_space`) returns 507 `INSUFFICIENT_SPACE` without Retry-After, also for a batch after
finish: no retry can succeed until the owner frees space, so a caller should wait rather than retry or recover.

`POST content` accepts only create-only objects in the caller's namespace. It has no query parameters and
requires `Content-Type: application/octet-stream`, exact `Content-Length`, and an ASCII `X-Storage-Batch` header
of at most 8,192 bytes. That header contains the `BatchCreateManifest` wire JSON: `objects` lists each relative
`key`, positive `size_bytes` and Dropbox `content_hash`; the top-level `content_hash` covers the concatenated body
across object boundaries. There are 1 to 32 objects, at most 32 MiB each and at most 32 MiB in total. Duplicate keys,
including case variants, are refused. Zero-byte objects continue using the existing conditional PUT route.

The existing Durable Object streams the body through Dropbox's native `start_batch`, `append_batch` and synchronous
`finish_batch_v2`. The ordinary Worker only forwards the request. While streaming, the object hashes each item and
refuses one whose bytes differ from its manifest hash with 400 `UPLOAD_HASH_MISMATCH` before finish, so wrong bytes
never commit under a create-only key. Every commit uses `add`, `autorename: false` and `strict_conflict: true`.
An existing object is reused only after stat confirms its key, length and hash; different bytes return 409
`REVISION_CONFLICT`. With 32 items, even a batch of existing objects uses at most 36 of the 50 provider subrequests
one invocation may make. A complete response contains every metadata record in order.
A failure before finish commits nothing. A definite refusal keeps its own answer: an explicit rate limit returns 429
with Retry-After, and an invalid connection or a wrong manifest hash returns 400. Another provider or transport
failure returns 503 `BATCH_NOT_COMMITTED`; the caller may send the same batch again a bounded number of times.
Once finish may have begun, partial, invalid or unknown provider results return 503 `BATCH_INCOMPLETE`, including a
rate limit. Such errors can leave new immutable objects and must not advance a caller's checkpoint. Storage never
replays uploads.
The mutable control head continues using the original revision-matched PUT; no object format or permission changes.

GET and HEAD also accept If-Match and reject a different revision before returning content. Valid ranges retain
the provider's 206, Content-Range and 416 semantics. An upstream 200 remains 200.
ETag carries the quoted Dropbox revision. Content hashes follow Dropbox's 4 MiB block-hash algorithm;
they are not plain SHA256. An optional `X-Storage-Content-Hash` upload header asks Dropbox to verify that hash.

Owner HTTP is `storage.ui.v1` under `/api/v1/`, behind edge-auth. Mutations require the exact Origin,
`X-CSRF-Token: 1` and JSON. Newly created application keys are returned once; listings and replays return metadata.
Settings include the Storage reason and time of the newest error Dropbox answered, never provider content.
Absent objects and create conflicts are ordinary answers and are not recorded. A new or removed connection clears it.
Settings also carry the connection time and the last success; an error newer than the last success is still
occurring, an older one has recovered.

## Request counters

The Durable Object counts each application request that presents a known key, by UTC day (when the quota resets), key,
operation (`stat`, `list`, `get`, `head`, `put`, `batch_create`) and outcome:

| Outcome | Meaning |
| --- | --- |
| `ok` | Answered successfully |
| `not_found`, `conflict` | Ordinary answers: an absent object, or a revision or create precondition that did not hold |
| `rate_limited` | 429 with Retry-After |
| `failed` | Anything else; also listed in recent failures |

Each count also sums the objects written (one per PUT, every object of a batch) and their bytes, download bytes by
Content-Length, and the largest batch. Recent failures keep the newest 50, at most one a minute per key, operation and
reason, with the reason code, HTTP status and Retry-After, never provider content. Malformed keys refused at the edge,
unknown or revoked keys, unknown paths or methods, the console and `/health` are not counted; Home shows the
account-wide totals.

Counts accumulate in memory and are written in one transaction about 30 seconds after the first request that changed
them, and before every overview: one row per changed day, key, operation and outcome rather than one per request, at
most 2,880 writes a day. The pending timer keeps the object in memory until the write, so a burst can add up to about
20 seconds of Durable Object duration; an alarm would wake a hibernated instance without the counts and cost a request.
A deploy or eviction loses at most those 30 seconds. Daily counts are kept 90 days. Each key's last use and the
connection's last success are written with the counts. `GetOverview` answers the settings, keys, 14 days of counts
and recent failures in one call.

## Development

From the repository root:

```sh
bazel test //storage:check
bazel build //storage
```

The checks use synthetic objects and a fake native Dropbox API. The workerd suite exercises a real SQLite
Durable Object and bounded content streams. Local checks do not establish a real Dropbox authorization or upload.
The app exposes the repository's standard `:config` and `:release` targets; normal release uses protected Actions.
