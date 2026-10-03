# Fleet boundaries

Follow root `AGENTS.md`. Fleet is a read-only owner monitor, not a remote control plane.

- Read-only owner HTTP uses root `proto/fleet/ui/v1` and shared edge-auth JWT verification. No owner mutation exists; add Origin + CSRF before introducing one.
- Only `/api/internal/fleet/v1/receipt` is machine ingress. Verify the independent HMAC on exact bounded bytes before shared proto decoding; owner login is insufficient.
- The SQLite DO is the single durable latest observation and bounded transition history. Duplicates must not refresh receipt time. Freshness is computed on reads, not inferred from an Alarm.
- Runtime release evidence comes from shared `proto/platform/runtime/v1`. The observer runs as a k3s CronJob using the Platform image; no Fleet module imports another app.
- Only configured daemon aliases, node/workload aliases and safe deployment metadata are permitted. Never read or transmit logs, environment, hostnames/IPs, messages, tasks, prompts or credentials.
- No production inputs in tests. Unit checks do not prove live DNS, Access, kube auth, real release or business success. Use real workerd SQLite tests for persistence/replay/freshness.
- Workers Free; no upgrade, cron or background polling of email providers. Deploy only through the authorized main CI pipeline.
