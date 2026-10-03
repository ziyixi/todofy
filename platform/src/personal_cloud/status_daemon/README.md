# Runtime status

This module observes configured workloads. It never discovers arbitrary workloads, reads logs or
returns Kubernetes objects, provider responses, private names or credentials.

`RuntimeService` routes and message types come from `proto/platform/runtime/v1`. Generated HTTP
bindings decode requests; the shared Python wire codec checks outputs. Errors use shared Google RPC
Status. Unknown workload aliases and invalid queries fail before provider reads.

- `config.py`: bounded public configuration, sixteen unique workload aliases at most.
- `reader.py`: fixed Kubernetes reads through the official SDK with rotating pod credentials and a
  verified CA. Newsletter uses httpx with redirects/proxy environment disabled. A shared twelve-second
  time budget stops further dependency calls; individual calls receive the remaining timeout.
- `adapters.py`: separate business capabilities. Newsletter uses its existing private monitor-only
  JSON interface; the local daemon uses baked image metadata and its actual startup request ID.
- `evidence.py`: combines physical container digest, generation and process provenance. Desired
  specs and annotations cannot supply actual identity. Missing generation remains absent.
- `server.py`: FastAPI/Uvicorn transport, thirty-second snapshot cache, sixty-second maximum fallback
  age, generated read API and deployment router hook. Blocking reads/controller calls run in the
  framework thread pool. Release summary is read fresh outside the snapshot cache. Automatic OpenAPI
  and documentation routes are disabled; shared protobuf bindings remain the sole API schema.

The server listens on container port 8080. Status reads require the private ClusterIP transport or
the host's loopback port 18765. Actions uses the release API through Cloudflare Access and an independent release credential,
without a kubeconfig, SSH key or Kubernetes token. The deployment router authorizes POST requests
before FastAPI consumes their body stream. Bodies are bounded to 16 KiB and five seconds; the shared
JSON decoder runs only after authentication. Uvicorn shutdown closes the controller and SDK clients
through the application lifespan. Status and release authorization remain separate.

`PLATFORM_RUNTIME_CONFIG` selects `/etc/personal-cloud/runtime.json` by default:

```json
{
  "version": 1,
  "repository": "example/personal-cloud",
  "node_key": "vps",
  "namespace": "personal-cloud",
  "workloads": [
    {
      "workload_key": "newsletter",
      "deployment": "newsletter",
      "container": "newsletter",
      "release_configmap": "newsletter-release",
      "adapter": "newsletter"
    }
  ]
}
```

Adapters are `newsletter`, `personal-cloud` or `deployment`. The generic deployment adapter reports
unsupported business capabilities and cannot invent image provenance. Newsletter's URL is the fixed
private `http://newsletter:8080/internal/monitoring/status`; its only credential is
`NEWSLETTER_MONITOR_TOKEN`. The local adapter uses `PLATFORM_RELEASE_REQUEST_ID` and the immutable
`personal_cloud/build-info.json` in the image. Kubernetes credentials use standard projected
pod paths, optionally selected by `KUBERNETES_TOKEN_FILE` and `KUBERNETES_CA_FILE`.

Each configured release ConfigMap has `request_id`, `source_sha`, immutable full `image` and `phase`
(`target`, `applying`, `activated`). An actual receipt also needs the process's independently reported
build SHA/request ID and the running pod's manifest digest. Release `ready` requires physical rollout
completion, matching identity, publisher activation, healthy process and resumed admission. A frozen
healthy process is `paused`; past unknown business operations can make business health `degraded`
while the current release is `ready`.

Dependency failure returns a valid unavailable/unknown status. It does not kill the daemon or restart
business work. `personal-cloud identity` checks baked source identity without any provider calls.
Synthetic tests are under `platform/tests/status_daemon`; they do not prove live transport, credentials
or production rollout.
