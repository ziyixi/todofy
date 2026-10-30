# Actions release client

The client uses generated `platform.runtime.v1.RuntimeService` HTTP bindings. It sends frozen workload aliases, source SHA, image digests and UUID identities. The daemon owns Kubernetes resources and admission adapters. The client receives no SSH or Kubernetes credential.

The existing production job supplies independent Access client credentials and `PLATFORM_DEPLOY_TOKEN`. The HTTPS origin comes from the public profile. HTTP uses verified TLS, no redirects/proxies, bounded replies and one wall-clock deadline; logs contain safe codes and verified identities/counts.

## Entrypoints

From the repository root:

```sh
bazel run //tools/vps-release:deploy_cli -- --help
bazel run //tools/vps-release:reconcile_cli -- --help
bazel test //tools/vps-release:check
```

These binaries use the fixed Python/proto/dependency toolchain. Operator configuration is intentionally read from `BUILD_WORKSPACE_DIRECTORY`; it is not a cached build input. Real execution remains the authorized main Actions job, with the same environment secrets, evidence path and concurrency lock.

Paired deployment takes `--source-sha`, `--newsletter-image` and `--platform-image`; the independent gateway uses `--codex-gateway-image`. Images must match the profile's repositories and full immutable digests. Gateway-only release preserves Newsletter admission and schedule state.

## Persistence and continuation

The same source derives the same creation UUID. Retries repeat the frozen body; conflicting images cannot replace an existing identity. The daemon acknowledges persistence first. Completion additionally requires fresh actual Pod digest, observed generation, process source/request identity and accepting or unsupported admission.

Held/failed work stops. Explicit `--resume` uses the original source and current etag, without replacement images; gateway continuation additionally uses `--gateway-only`. Timeout never cancels the server's persisted operation. Network/429/5xx retry within the original deadline; authentication, schema errors and held results do not extend it or trigger automatic continuation.

Reconciliation supports `plan`, `repair` and `resume`. It selects accepted immutable targets from the ledger and keeps the existing manual-pause/drain boundary. Evidence is recorded only after physical verification. Desired annotations, stale snapshots, process health or degraded business counts alone cannot establish a new running release.

`render.py` is offline Kustomize compilation used by bundle preparation; the deployment client never applies its output. Synthetic tests cover lost acknowledgements, strict wire/JSON parsing, identical retries, etag continuation and wrong/stale physical evidence. Live credentials, connectivity and business success require separate observation.
