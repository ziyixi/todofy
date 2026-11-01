# Storage

Storage gives applications a namespace-scoped HTTP interface to a separate Dropbox App-folder connection.
The owner console connects Dropbox and creates independently revocable read-only or read/write keys.
Each key selects a fixed namespace on the server. File data lives in Dropbox; the native SQLite Durable Object
holds the connection, key hashes and pagination-signing state. Storage uses no D1, R2 or scheduled job.

The separate Dropbox app uses `files.metadata.read`, `files.content.read` and `files.content.write` with offline PKCE.
The callback is `/api/dropbox/callback`. Existing Recall connections, files and archive contracts are independent.
Disconnecting revokes this connection and retains files. There is no delete-object endpoint.

## HTTP protocol

Machine requests use `Authorization: Bearer <application key>`. Owner cookies and Access assertions do not replace
that key. Authentication precedes reading JSON or binary bodies. The three machine paths are:

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /api/storage/v1/stat` | JSON `{key}` | `{key,revision,size_bytes,content_hash}` |
| `POST /api/storage/v1/list` | JSON `{prefix,cursor,page_size}` | `{objects,next_cursor}` |
| `GET /api/storage/v1/content?key=...` | Optional Range and If-Match | Binary content, ETag and X-Storage-Content-Hash |
| `HEAD /api/storage/v1/content?key=...` | Same read conditions | Metadata headers without content |
| `PUT /api/storage/v1/content?key=...` | Binary body and a write precondition | The complete object metadata |

Control JSON uses the repository wire profile in `storage.objects.v1`; failures use `google.rpc.Status`.
Keys are relative, at most 1,024 ASCII characters. Segments cannot be empty, `.` or `..`; absolute paths,
backslashes, URI escapes and Dropbox `id:`, `ns:` and `rev:` selectors are rejected. Dropbox retains its
case-insensitive path behavior. A listing may return an empty page with a continuation; keep reading until
`next_cursor` is empty. Continuations are authenticated and bound to the namespace and prefix.

Each object is at most 32 MiB. Uploads require Content-Length and enforce the actual stream length.
`If-None-Match: *` creates an absent object. `If-Match: "revision"` replaces that exact revision; the unquoted
original revision is also accepted. Blind writes, weak validators, lists and wildcard If-Match are refused.
The provider uses `strict_conflict: true` and `autorename: false`. Conflicts return 409 `ABORTED`.
Explicit provider rate limits and recognized namespace write contention return 429 `UNAVAILABLE` with Retry-After;
an absent delay becomes one second. The gateway does not repeat uploads. The caller can bound retries of those
explicit rejections while preserving its body and condition. See [Dropbox's rate and namespace-lock semantics](https://docs.dropboxapi.com/dropbox-api/docs/performance).
A lost successful upload response can be resolved by statting and verifying the intended size and hash.

GET and HEAD also accept If-Match and reject a different revision before returning content. Valid ranges retain
the provider's 206, Content-Range and 416 semantics. An upstream 200 remains 200.
ETag carries the quoted Dropbox revision. Content hashes follow Dropbox's 4 MiB block-hash algorithm;
they are not plain SHA256. An optional `X-Storage-Content-Hash` upload header asks Dropbox to verify that hash.

Owner HTTP is `storage.ui.v1` under `/api/v1/`, behind edge-auth. Mutations require the exact Origin,
`X-CSRF-Token: 1` and JSON. Newly created application keys are returned once; listings and replays return metadata.

## Development

From the repository root:

```sh
bazel test //storage:check
bazel build //storage
```

The checks use synthetic objects and a fake native Dropbox API. The workerd suite exercises a real SQLite
Durable Object and bounded content streams. Local checks do not establish a real Dropbox authorization or upload.
The app exposes the repository's standard `:config` and `:release` targets; normal release uses protected Actions.
