# Actions → daemon release

`deploy.py` calls the generated `platform.runtime.v1.RuntimeService` HTTP bindings. It sends only frozen
configured workload aliases, source SHA, image digests and UUID4 identities. Kubernetes manifests, object
names, admission adapters and local cluster credentials belong to the daemon. Actions holds no Kubernetes
token, SSH key, Docker socket or cluster-admin identity.

The gated workflow supplies these environment secrets through normal GitHub production secret storage:

- `PLATFORM_ACCESS_CLIENT_ID` and `PLATFORM_ACCESS_CLIENT_SECRET`: the dedicated Cloudflare machine identity.
- `PLATFORM_DEPLOY_TOKEN`: the independent daemon deployment Bearer.

The exact HTTPS hostname comes from the strict public profile's `vps.platform_runtime_host`. The client
uses `httpx` with TLS verification, no redirects/proxies, a total wall-clock timeout for each request and a
32 KiB reply bound. It logs only a safe error code or verified source/release identity and bounded business
health/counts. It never logs credentials, upstream
errors or response bodies. Generated bindings determine path variables, query parameters and body mapping;
the shared strict codec and duplicate-rejecting JSON parser read replies.

After the proto generation and locked platform environment are ready:

```sh
uv run --project platform --frozen python tools/vps-release/deploy.py \
  --source-sha VERIFIED_FULL_SHA \
  --newsletter-image ghcr.io/OWNER/todofy-newsletter@sha256:FULL_DIGEST \
  --platform-image ghcr.io/OWNER/todofy-platform@sha256:FULL_DIGEST
```

Both repositories must belong to the configured owner; mutable tags and partial digests are refused.
The same SHA derives the same release/request UUID4. A transport retry repeats the identical frozen body.
Changing images under that existing identity is a conflict, not an excuse to silently create a new release.
The daemon acknowledges persistence first; the client polls the exact resource. Success additionally
requires fresh `NodeStatus`, verified desired/actual source/digest/request identities and known generation,
running processes and accepting/unsupported admission. An acknowledged desired SHA alone cannot pass.
Newsletter can acquire unknown business operations after admission resumes. Its explicit nonzero
`unknown_count` and `degraded` business health are reported separately when the running image, release
identity and admission are verified; an unhealthy process, unknown evidence or degraded unrelated workload
still cannot pass deployment verification.

Held/failed operations stop the client immediately. Only an explicit approved main dispatch for `platform`
or `newsletter` sets `resume_vps_release=true` and supplies `resume_source_sha`, the original release's full
source SHA. The checkout commit runs current source/contract checks, but no image is built, saved, uploaded
or published. The client uses the original source SHA to fetch the authenticated release, validates its two
configured aliases, source/request identity and strict digest fields, and retains those frozen targets.
Digests alone contain no repository: the daemon maps the fixed aliases to the profile owner's allowlisted
repositories. Resume accepts no replacement image input. It reads the current etag and derives a stable
continuation UUID for that exact revision; all later receipts and physical running observations must match
the original targets. Ordinary retries never resume automatically. Client timeout does not cancel the persisted server operation. Re-run with the
same verified input to inspect progress; make a deliberate concurrency decision before continuing held work.

```sh
uv run --project platform --frozen python tools/vps-release/deploy.py \
  --source-sha ORIGINAL_HELD_FULL_SHA --resume
```

Without explicit resume, `resume_source_sha` is forbidden and a new release still requires both images
from the same tested artifact/source SHA. Missing or mismatched existing releases fail rather than being
created or replaced by the resume path.
The one overall timeout starts before Create/Get/Resume. Temporary network/429/5xx failures, including a
daemon Recreate rollout lasting minutes, keep retrying the identical request inside that budget. Credentials,
schema errors and held/failed results stop immediately; retries never extend the deadline.

`release_identity.py` also preserves the offline renderer's canonical SHA identity. `render.py` uses
Kustomize only for local manifest compilation; the Actions deployment client never applies its output.
Runtime source must not import either tool. Synthetic client checks:

```sh
uv run --project platform --frozen python -m unittest discover -s tools/vps-release/tests
uv run --project platform --frozen ruff check tools/vps-release
```

The tests cover lost acknowledgements, identical retries, explicit etag continuation, redirect/size/JSON
guards, wrong image provenance, unknown generations and a ready acknowledgement with stale observations.
They do not prove live credentials, Tunnel connectivity or a production rollout.
