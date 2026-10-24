# Personal-cloud runtime v1

The `platform.runtime.v1` API observes and releases explicitly configured workloads independently of their
business code. Source: [`runtime.proto`](../../proto/platform/runtime/v1/runtime.proto) and
[`runtime_service.proto`](../../proto/platform/runtime/v1/runtime_service.proto). The generated
[`JSON Schema`](platform-runtime-v1.schema.json) publishes one `$defs` entry per message. Generated Python
and TypeScript types are the application contract; do not maintain competing dictionaries or DTOs.

| Method | HTTP | Response |
| --- | --- | --- |
| `GetNodeStatus` | `GET /api/v1/nodeStatus` | `NodeStatus` singleton |
| `ListWorkloads` | `GET /api/v1/workloads?page_size=16` | `ListWorkloadsResponse` |
| `GetWorkload` | `GET /api/v1/workloads/{workload_key}` | `WorkloadStatus` |
| `CreateRelease` | `POST /api/v1/releases?release_id={uuid4}&request_id={uuid4}`; body is `Release` with only `targets` | `Release`, accepted asynchronously |
| `GetRelease` | `GET /api/v1/releases/{release_id}` | Persisted `Release` |
| `ResumeRelease` | `POST /api/v1/releases/{release_id}:resume`; body is `{request_id, etag}` | Same persisted `Release` |

Cloudflare Tunnel/Access protects the dedicated daemon HTTPS hostname; mutations and `GetRelease` also
require an independent deployment Bearer. Authentication happens before bounded request-body reads.
Read-only node/workload observations are restricted to the private node/observer path. Actions has no
Kubernetes token, SSH key or exposed cluster API: the daemon alone exercises scoped local capabilities.
The API never accepts shell commands, YAML, paths, URLs, namespaces, provider object names, mutable tags or
image repositories. Configuration maps public aliases to reviewed private adapters/manifests/repositories.
Unknown resources return standard `google.rpc.Status`/`NOT_FOUND`; malformed names/body values are
`INVALID_ARGUMENT`. Requests and replies are generated snake_case wire JSON. They exclude owner names,
hostname/IP, raw provider objects, credentials, logs and exception messages. Node snapshots contain at most
sixteen unique workloads sorted by key. List pagination never enumerates beyond configuration.

The wire profile accepts one to sixteen frozen targets. The current controller requires exactly the two
configured Newsletter/personal-cloud adapters, unique keys and one source SHA; future adapter support is
an explicit server/configuration extension within the same contract. Each target's UUID4 request identity matches the
creation request; caller-supplied generation and output-only fields are rejected by the handler. The daemon
persists the immutable request before returning `accepted`, then reconciles asynchronously through
`draining`, `frozen`, `applying` and `verifying` to `ready`, or safely retains `held`/`failed`.
Retries reuse the original release/request IDs and exact targets. Same ID with a different body returns
`ALREADY_EXISTS`; a network retry never resets progress or auto-resumes a held release. Resume uses the
current etag and a new stable continuation request UUID4; stale concurrency returns `ABORTED`. Original
creation identity and targets stay unchanged. Restore/restart also requires explicit continuation from
held/failed. Full replies contain server-populated name, phase, etag, create/update times and bounded latest
target observations; producers verify these response invariants in addition to the shared shape rules.

`NodeStatus.current_release` is a lightweight `ReleaseSummary`: name, creation request ID, phase, etag,
update time and optional fixed safe error code. It duplicates neither targets nor workload observations.
No operation is represented by an absent summary; unavailable workload evidence remains explicit in the
existing workload statuses. Fleet is a read-only consumer, not an alternative deployment surface.

`ReleaseTarget` carries source SHA, immutable physical image digest, UUID4 release request identity and an
optional positive Kubernetes generation. `ReleaseStatus.desired` is the trusted configured target;
`actual` is populated only after running-image physical digest and build provenance match the observed
release evidence. Labels, annotations, Pod spec image or a desired commit alone are insufficient. If that
proof fails, `actual` is null and the status cannot be ready. No unavailable generation is replaced with zero.
A ready release requires fresh verified evidence for the same workload/source/digest/request and any
known target generation; the producer also verifies Kubernetes readiness and process admission.

Release state, process state, work admission and application health are separate observations. A running
process may be frozen, degraded or have unknown business operations. Unsupported adapter capabilities
are explicit; an omitted optional counter means unknown/unsupported, not zero. `missing` means an expected
object/target is absent; `unknown` means a read or verification failed. `observed_at` records the attempted
observation, including missing/unknown results. Consumers compute staleness separately; an authenticated
HTTP response or signed Fleet receipt does not prove that the observations are current or healthy.
After admission resumes, new Newsletter work can create unknown business operations without invalidating
the verified running release. A deployment client may report success alongside explicit nonzero
`unknown_count`/`degraded` business health; it must still verify physical source/digest/generation, ready
release identity and accepting admission. This exception never treats unhealthy/unknown process evidence
or another adapter's degraded health as successful deployment.

The Python service creates generated dataclasses and serializes with
`ziyixi_proto.wire_json.to_wire`; route metadata comes from generated `runtime_service_pb.HTTP_BINDINGS`,
with bounded request matching/decoding in shared `http_routes`. Its `decode_json_body` rejects duplicate
JSON keys at any depth before `decode_request` maps the generated HTTP body/path/query fields. Errors use shared `rpc_status`, the Python
twin of the existing TypeScript Google RPC transport. Before returning it verifies its complete response through the shared
strict codec. Consumers use `from_wire(..., strict=True)` and retain no unrecognized fields. Cross-field
invariants (matching names/keys, uniqueness, desired/actual evidence, generation and freshness) are semantic
checks of the adapter/consumer, in addition to the schema's shape/bounds. Synthetic fixtures cover a verified
ready release, absent actual evidence with unknown generation, and an explicitly missing workload.

Fleet embeds `NodeStatus` in `HostReport` rather than copying release acknowledgement fields. The independent
`platform` Python package and image contain both the status daemon and bounded observer as Kubernetes
container workloads. The observer is a five-minute CronJob with `Forbid` concurrency and independent
state storage; neither component installs application executables or Python dependencies on the host.
If k3s cannot run it, Fleet marks the absent/stale observation; it cannot infer fresh system daemon state.
Newsletter remains a separate image and adapter. Adding a workload requires a bounded configuration entry and adapter, not a new
protocol or a daemon import of that application's implementation.

## Protocol errors

All errors use the existing Google HTTP `google.rpc.Status` shape with one `google.rpc.ErrorInfo`.
The domain is the stable contract identity `platform.ziyixi.science`, regardless of the configured
deployment hostname. The reason is the generated enum value name without its prefix. Generic transport
failures reuse [`CommonReason`](../../proto/common/errors/v1/errors.proto): `BAD_REQUEST`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED` (HTTP 405), `INTERNAL`, `UNAVAILABLE`, `UNAUTHORIZED`, and configuration failures.
Handlers do not maintain a second private error envelope. Unexpected bugs are `INTERNAL`; only a failed
dependency is retryable `UNAVAILABLE`. Retrying a deployment preserves its exact resource/request identity.

Domain reasons come from [`ErrorReason`](../../proto/platform/runtime/v1/errors.proto):

| Reason | Google code | Meaning |
| --- | --- | --- |
| `WORKLOAD_NOT_FOUND` | `NOT_FOUND` | The stable alias is not configured; no provider discovery follows |
| `RELEASE_NOT_FOUND` | `NOT_FOUND` | The exact persisted operation does not exist |
| `RELEASE_CONFLICT` | `ALREADY_EXISTS` | An existing ID has a different frozen request |
| `RESUME_CONFLICT` | `ALREADY_EXISTS` | A continuation request ID has a different frozen input |
| `RELEASE_HELD` | `FAILED_PRECONDITION` | Finish or explicitly continue the existing operation first |
| `RELEASE_NOT_HELD` | `FAILED_PRECONDITION` | The current phase does not permit explicit continuation |
| `ETAG_MISMATCH` | `ABORTED` | Read the latest operation and make a fresh concurrency decision |

`Release.error_code` is a separate bounded fixed diagnostic alias on persisted failed/held state,
not an HTTP status or a raw exception. Adapter implementations document their aliases; consumers display
an unfamiliar safe alias without treating it as ready or automatically resuming the operation.
