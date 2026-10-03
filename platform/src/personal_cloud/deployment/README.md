# Deployment controller

The daemon accepts the generated `platform.runtime.v1` Create/Get/ResumeRelease API. It renders the
baked Kustomize List rather than receiving manifests, shell commands, logs or provider credentials.
The initial deployment profile supports Newsletter and Platform: both targets have one source SHA
and creation UUID, with separate immutable image digests. Callers cannot supply generation; it is
observed from Kubernetes. Repository images are restricted to the configured owner's
`todofy-newsletter` and `todofy-platform` packages.

FastAPI authorizes the independent release bearer before consuming request bytes. Cloudflare Access
protects the external machine transport. Actions holds neither SSH nor Kubernetes credentials. The
pod's projected identity is namespace scoped; the official SDK owns Kubernetes HTTP and token
rotation. Newsletter's existing private drain protocol is used through httpx, without importing its
application. Credentials come only from environment variables.

The owner-only SQLite ledger freezes targets and request identity. Repeating a create returns the
same record; changing its body conflicts. An unfinished operation blocks another release. Resume
requires the exact current etag and an independently deduplicated UUID. Held/failed operations never
restart automatically.

The durable checkpoints are:

1. Suspend daily triggers, begin `release-<source SHA>` admission drain, wait for tracked work and
   reject active or uncertain local activity, then freeze without a force option. Historical unknown
   outcomes do not block a quiescent release; their records and degraded business health remain visible.
2. Record `install_self` before updating the daemon. The new image's baked SHA and actual startup
   UUID determine when the new controller has taken over. The old controller's baked manifests
   cannot stand in for the new source version.
3. Apply the new image's baked resource List, preserving the mounted configuration, namespace and
   fixed resource scope. The observer CronJob uses the same Platform digest and stays enabled;
   Newsletter's daily CronJob alone is suspended. Record `self_apply` before updating the daemon's
   final pod template again.
4. Verify actual running container manifest digest, observed generation, independent process build
   SHA/startup UUID and healthy frozen admission. Missing or conflicting facts never become ready.
5. Activate release ConfigMaps, resume admission, unsuspend daily triggers and verify a fresh
   accepting runtime receipt.

Active checkpoints recover after process replacement. Each effect is either idempotent or checked
through its durable upstream identity. Dependency failures are held, unexpected failures are failed,
and both require explicit continuation. This is not an automatic rollback system.

A lost resume response can mean the new service already accepts work. A late failure therefore
tries to suspend further cron triggers, reports the actual admission state and remains held. It
does not invent a closed gate, forcibly reopen a gate, or override another drain operation. Explicit
resume retries the original durable control identity. Business health can be degraded by later
unknown operations while the independently verified release remains ready; process health and
business outcome are separate observations.

`PLATFORM_STATE_DIR` defaults to `/var/lib/personal-cloud`. The ledger and SQLite WAL/SHM are mode
0600. It stores durable release metadata only; it never installs binaries or replaces host programs.
The daemon and observer run as Kubernetes workloads using the Platform container image.
`PLATFORM_DEPLOY_TOKEN` and `NEWSLETTER_SEND_TOKEN` must be distinct machine secrets; neither is
stored in the ledger, response or image. Token/schema/configuration
errors fail startup. Dependency availability does not serve as a process liveness probe.

Tests under `platform/tests/deployment` use fake SDK calls, synthetic ledgers and ASGI transport.
They cover authenticated typed requests, conflict/retry/resume, self replacement, template provenance,
real-evidence requirements, unknown work and a lost resume response. They do not prove a real K3s
rollout, Access transport, container-runtime imageID format or business success.
