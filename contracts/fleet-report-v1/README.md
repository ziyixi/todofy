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

Normal state snapshots overwrite one row. Only state transitions enter history (256 retained, 32 returned).
No billing hard cap, remote control surface, cron or public health telemetry is created.

Newsletter monitoring v2 adds optional category counts, a monotonic unknown-record revision, and the latest delivery record state/update time. Legacy receipts remain valid. Process health and provider outcomes are independent: `provider_accepted` means the provider accepted the send, without claiming inbox arrival. Historical records remain auditable; Home reminder dismissal uses the revision so a reduced count does not reopen a dismissed batch. See [Dashboard state](../../docs/dashboard-state.md).
