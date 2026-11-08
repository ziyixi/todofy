# Fleet report v1

One fixed host sends content-free observations to `POST /api/internal/fleet/v1/receipt`.
The application authenticates an independent machine identity by HMAC-SHA256 of the **exact UTF-8 request bytes**,
using `X-Fleet-Key-Id: primary` and `X-Fleet-Signature: <64 lowercase hex>`.
The path alone is exempt from owner Access; the signature is mandatory even for a logged-in owner.

The authoritative IDL is `proto/fleet/telemetry/v1/host_report.proto`; its generated JSON Schema and the synthetic
fixture are consumer artifacts. Raw reports are limited to 16 KiB. No logs, private hostnames/IP addresses,
configuration/environment, mail, tasks, prompts or provider responses may be sent.

`host_key` is the configured public alias and `epoch` is an explicitly configured generation. A new host/credential
must use a new epoch; the monitor never guesses a reset. `sequence` is durably reserved before transmission.
Retry reuses identical bytes, UUID and signature. Identical latest sequence/hash returns
`{"version":"fleet-receipt-v1","accepted":false,"sequence":N}` without refreshing server receipt time;
an older or conflicting sequence is 409. Successful new persistence returns the same envelope with `accepted:true`.

Reports observed more than ten minutes ago or more than two minutes in the future fail. Freshness uses the server's
receipt time: fresh ≤10 minutes, stale ≤20 minutes, otherwise missing. Never-seen is unknown. A lost report is not
a diagnosis of the host. Optional fields remain unknown rather than guessed as zero or healthy.

`runtime` embeds the shared `platform.runtime.v1.NodeStatus` directly. The local RuntimeService endpoint is
`GET /api/v1/nodeStatus`; observations older than sixty seconds are not forwarded as current evidence.
The observer verifies node/workload aliases and unique, sorted configured workload keys. Desired release metadata
and actual physical image/provenance remain distinct; an absent actual identity cannot prove deployment success.
`current_release` is the daemon's durable, bounded operation summary. In-progress, held and failed phases remain
visible independently of workload readiness. `observer_source_sha` is the observer image's baked build identity,
or null when unavailable; it does not come from an environment variable or the requested release.

Exactly k3s/cloudflared/ssh aliases are required; cloudflared_platform is optional and expected only when explicitly
configured. Kubernetes state, readiness, daemon state and Newsletter process/drain state are distinct. None proves
Codex, Notion or email success. `unknown_count` means provider outcomes need reconciliation, not a retry permission.

Optional `workload_inventory` reports Kubernetes readiness for deployments that declare a public monitoring alias.
It is independent of `runtime.workloads`: discovering a ready workload supplies no release identity, daemon ACK or
business result and changes no release or alert calculation. The report's `observation_time` applies to this inventory.
`state` is `observed` after a complete discovery, `unavailable` when it could not be read, or `truncated` when the bounded
discovery is incomplete. A missing inventory from an older observer remains unknown. An empty `observed` inventory
means no declared workload was found; `unavailable` and `truncated` never establish that an absent workload is healthy.

Each of at most 16 rows has a unique public `workload_key`, sorted in ascending order and matching the existing
32-character safe alias format. Rows carry `ready`, `starting`, `stopped`, `degraded` or `unknown`, optional nonnegative
32-bit desired/ready/restart counts, and a required `readiness_probe` boolean. Missing counts remain unknown.
`readiness_probe:false` means no readiness probe was declared; a ready Pod without a probe does not prove endpoint
health. Namespace, deployment and Pod names, URLs, probe bodies and response content are never transmitted.
`workload_inventory.json` is the new synthetic fixture; existing fixtures remain frozen.

Optional `metrics` carries numbers only: cumulative CPU milliseconds from `/proc/stat`, load averages,
memory and swap bytes (available memory includes the ZFS ARC above `c_min`), statvfs of fixed filesystem roles
(`root`, `k3s`, `state`), summed byte counters of physical
interfaces (never their names), the kernel boot ID with uptime, and up to 16 workloads' CPU cores and working-set bytes
summed by `app` label or CronJob name (never Pod names). Counters are doubles because the wire profile has no 64-bit
integers; values stay below 2^53. A report without `metrics`, or with only some groups, is valid; an unreadable group is
absent, never zero. Fleet refuses impossible relations (idle above total, available above total, unsorted workloads)
and derives rates only between two reports of one boot. `node_metrics.json` is the synthetic fixture.

Normal state snapshots overwrite one row. Only state transitions enter history (256 retained, 32 returned).

Newsletter observations include optional category counts, a monotonic unknown-record revision and the latest
delivery state/update time. Legacy receipts remain valid. `provider_accepted` means the provider accepted the send;
it does not prove inbox arrival. Home uses the revision for reminder dismissal, so a reduced count does not reopen
a dismissed batch. See [Dashboard state](../../docs/dashboard-state.md).
