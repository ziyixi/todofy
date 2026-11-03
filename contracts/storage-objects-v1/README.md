# Storage objects v1

Storage owns this namespace-scoped machine transport. Existing stat/list and conditional single-object content
routes remain described in [Storage](../../storage/README.md). IDL is
[storage.objects.v1](../../proto/storage/objects/v1/objects.proto); the schema is generated from it.

## Create-only binary batch

`POST /api/storage/v1/content` authenticates the existing application key and checks write access
before reading a body. No query parameters are accepted. The credential selects the namespace; no request field
can change it.

`X-Storage-Batch` is compact wire JSON `BatchCreateManifest`, at most 8,192 ASCII bytes. It contains 1–32 objects
with distinct case-insensitive relative keys. Each segment is 1–33,554,432 bytes; their sum is at most 33,554,432.
Empty objects use the existing single PUT. The binary body concatenates those segments in manifest order.
`Content-Type` is `application/octet-stream`; `Content-Length` must equal the sum and the actual stream length.
The manifest's top-level `content_hash` is Dropbox's block hash of the whole concatenation, across item boundaries.
Each item's hash describes only that item's segment. Neither hash is plain SHA-256.

The producer uses native Dropbox upload sessions and synchronous finish-batch-v2. File bytes stay streamed through
the existing Durable Object. Every commit is create-only with strict conflicts and no autorename. Session IDs are
private provider state and never appear in public responses.

HTTP 200 returns `BatchCreateResponse` with one fully checked metadata record per item, in manifest order. A known
existing object is reusable only after its key, size and hash match. No partial result is acknowledged as success.
Partial or unknown completion returns failure, and consumers keep their prior control head. A whole-response 429
is reserved for an explicit rejection before any file commit; partially committed batches must not become a
retryable whole-request 429. Another provider failure before finish is 503 `BATCH_NOT_COMMITTED`: nothing committed
and the same batch may be sent again. A consumer that does not know this reason may keep treating the 503 as an
unknown outcome. Each item's bytes are checked against its own hash before commit; a difference is 400
`UPLOAD_HASH_MISMATCH`. A full Dropbox is 507 `INSUFFICIENT_SPACE`, before or after finish; retrying cannot
succeed until space is freed. The service does not replay uploads. Existing caller recovery/fencing handles unknown
outcomes. Mutable heads keep their original single-object revision CAS.

Header/body size sums, nonempty batches, duplicate keys, path segments, actual stream lengths and confirmation
ordering are transport rules beyond the generated field schema. The fixtures contain only synthetic bytes:
`abcdefg`, split into `abc` and `defg`. Cross-language golden checks protect both metadata messages.
