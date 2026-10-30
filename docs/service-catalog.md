# Service catalog

Each application owns one public [`app.toml`](../dashboard/app.toml). The catalog is a small build-time
index of those files, not a runtime service or a second infrastructure controller.

| Source | Owns |
| --- | --- |
| `<app>/app.toml` | Application identity, Cloudflare or VPS target, Home labels and ordering, probe paths, Access paths and session duration |
| The application's committed `wrangler.toml` | Worker name, Custom Domains, resources, bindings, ordinary configuration |
| `infra/*.tf` outside the marked catalog regions | Resource identities, policy attachment, `prevent_destroy`, storage existence, outputs, encrypted state and provider configuration |
| GitHub's production environment and application deploy wrappers | Secret values and operational switches |
| VPS image release tooling | Independently tested Newsletter/Platform/Codex gateway artifacts, source SHA and immutable digests; the catalog records only each image repository |

The catalog contains no email address, account or resource ID, IP address, credential, private endpoint,
operational switch or production state. It never reads `.env`, private configuration, credentials or an
OpenTofu state file, and it makes no network request. Wrangler and OpenTofu keep their existing ownership
boundaries; adding metadata does not deploy an application or create a resource.

## Validate and regenerate

The catalog/configuration checks run through Bazel:

```sh
bazel test //tools/service-catalog:check //.github/scripts:generated_config_test
```

Regeneration remains an explicit source update; it performs no provider call or deployment.

After reviewing a metadata change, regenerate with:

```sh
python3 tools/service-catalog/catalog.py
git diff -- dashboard/worker/src/registry.ts infra/access.tf
python3 tools/service-catalog/catalog.py --check
```

Generation replaces only the explicit `BEGIN/END service-catalog` regions. It fails if a boundary is
missing or ambiguous. Commit the manifests and generated literal regions together. `--check` writes
nothing and fails when either output is stale. Production code imports the generated TypeScript
literals, never Python tooling or another application's package.

The committed manifests are the inventory of Cloudflare and VPS applications; `--check` prints its
derived application/Worker counts. Tests compare generated Home entries, Worker roles and Access
destinations with those manifests and retain independent infrastructure/host guards. These checks
prove source consistency, not live Cloudflare resources or a deployed VPS.

## Manifest shape

This abbreviated example shows the fields used by an owner application. Hostnames are derived from
the selected Worker's Custom Domain; only paths belong in the manifest.

```toml
version = 1
id = "example"                 # matches the enclosing app directory
target = "cloudflare"

[[workers]]
config = "example/wrangler.toml"
entry = "example"              # an entry owned by this application
role = "Pages and owner API"
position = 11                  # unique order in the complete Worker list

[[entries]]
id = "example"
name = "Example"
description = "A short public description"
group = "apps"                 # apps, sites, services or hidden
icon = "mail"
accent = "blue"
worker = "example"             # must match the committed config's name
url_path = "/"
access = true
app_only_signals = []
order = 7                      # existing order within a Home group
position = 12                  # unique order in the complete entry list
[entries.status]
type = "none"

[[access]]
key = "example"                # existing owner Access application identity
kind = "owner"
worker = "example"
name = "Example"
paths = [""]                   # host itself; "/_/*" is a path scope
session = "24h"                # 6h, 24h or 168h
```

An owner application may also gate paths on the platform runtime host (`vps.platform_runtime_host` in
`config/cloud.toml`) with `runtime_paths = ["/api/<app>/v1/*"]`: the app's read path into its VPS service, which the
platform tunnel routes with the same application's audience (`infra/platform.tf`). Only paths under `/api/`, never the
whole host, which the platform's machine application owns. The Newsletter console is the one user.

All fields are checked by [`catalog.py`](../tools/service-catalog/catalog.py); unknown fields fail at
every level. There is no free-form configuration blob. Worker paths must be ordinary, non-symlinked
files inside their owning application, with basename `wrangler.toml`. Test and development configs
are excluded; every production `wrangler.toml` must appear exactly once. The same Worker cannot be
declared by two applications. Config paths through private, hidden, dependency or build directories
are refused.

The host uses `vars.PUBLIC_HOST` when declared and otherwise the first Custom Domain route. A declared
`PUBLIC_HOST` must itself be a Custom Domain route. This preserves the website's `www` primary link and
Todofy's owner-facing route without duplicating them here. URL and probe paths cannot contain query
strings, fragments, encoded traversal or an external host.

Each entry has one status kind:

| Kind | Fields and meaning |
| --- | --- |
| `ops_v1` | `binding`, `guard`; binding must name the same Worker's `Ops` entrypoint in Home's Wrangler config. The explicit VPS Fleet adapters use `NEWSLETTER`/`NewsletterOps` or `CODEX_GATEWAY`/`CodexGatewayOps`. Optional `[entries.status.probe]` with `public_http`'s fields but `enabled`: a probe of the app's own Worker beside its Ops answer; the tile shows the worse of the two. |
| `public_http` | `path`, nonempty 2xx `expect`, boolean `enabled`; optional `content_type`, `outside_access`, `error_rate` |
| `analytics` | `max_idle_hours`, an integer from 1 to 168; existing traffic-based activity signal |
| `self` | Home's own status |
| `none` | No direct Home status method for this entry; it must not imply health |

Optional `tile_metric` is `counter` plus a counter `name`, `latency`, or `last_active`. `app_only_signals`
lists existing public counter names that stay in the detail view. This metadata does not add a new
signal or collector. Two probes remain: the website's `build-info.json`, and the links app's `robots.txt` beside its
`ops_v1` answer (`LINKS`, its daily backup's age and failures), so a broken Custom Domain or route still shows on its
tile with the Worker's error rate and the probe's latency.

Newsletter uses `target = "vps"`, its image repository and no `workers` or `access`. Its Home entry (「Newsletter 引擎」)
uses `ops_v1` through the exact Fleet provider/binding above, with `guard = false`. This reports the latest
bounded Newsletter business snapshot without Home reaching the VPS or storing a second business ledger. Its owner pages
are a separate Cloudflare app, the Newsletter console (`newsletter-console`, an `apps` tile with status `none`), which
reads the engine's own records; Home's engine row opens it.
Platform is a separate VPS image application with a hidden `platform-runtime` entry and `status.type = "none"`;
Fleet displays the shared runtime node/workload/release status. Both image fields identify repositories,
never mutable deployment tags. Release targets, heartbeat transport and Kubernetes manifests belong to
their [architecture/contracts](architecture.md), not to the catalog. Codex gateway is a separate VPS image
with a Home service entry; Fleet projects its process/release evidence through `CodexGatewayOps` without
calling inference. Login, quota and actual model results remain the caller's responsibility.

Hostname and image-owner validation use the public profile in [`config/cloud.toml`](../config/cloud.toml).
Personal settings and resource identities still do not belong in manifests. A provider field is not a
general cross-application escape hatch: the schema allows only the two explicit checked Fleet adapters.

## Generated outputs and consumers

[`dashboard/worker/src/registry.ts`](../dashboard/worker/src/registry.ts) receives the catalog's Home
entries and Worker-to-entry mapping. Its external self-hosted-services entry, flows and runtime behavior
remain explicitly maintained outside these regions. The independent cloud-config generator owns public
[`resource-identities.ts`](../dashboard/worker/src/resource-identities.ts), consumed outside catalog regions.

[`infra/access.tf`](../infra/access.tf) receives the owner application map, including Fleet. It preserves
Terraform addresses, policy attachments
and `prevent_destroy`. Policy rules, Fleet's exact machine receipt bypass with independent HMAC authentication,
the frozen Mail Hero backup application and Platform's separate machine/Tunnel objects stay explicitly
maintained outside catalog regions. The catalog does not take over identity providers or secret values.
An actual Access change requires the normal reviewed OpenTofu plan and gated apply; generation performs neither.

The Wrangler safety checks, desired-drift comparison and infrastructure output check read the same
Worker-config map from the catalog. Their independent host, secret, resource and provider guards
continue to validate the underlying configs and generated literals.

The Python API is deliberately narrow:

```python
sys.path.insert(0, str(REPO / "tools" / "service-catalog"))
from catalog import load_catalog

catalog = load_catalog(REPO)
catalog.apps                   # app ID -> validated manifest; alphabetical order
catalog.worker_configs()       # Worker name -> repository-relative production config
catalog.configs                # Worker name -> parsed committed Wrangler config
catalog.entries                # normalized public Home metadata, in position order
catalog.workers                # normalized Worker mapping, in position order
catalog.access                 # public paths plus Wrangler-derived destinations
```

CI discovers check/release facades in native Bazel metadata. The catalog owns service identity/presentation, not
another dependency map. Newsletter/Platform/Codex gateway keep independent images and the existing paired versus
gateway-only rollout rules. A metadata edit is published only where actual build/release dependencies consume it.

## Adding or changing a service

1. Add an application-owned manifest and, for Cloudflare, the committed production config and its
   normal deploy wrapper, declared on the shared core `tools/cloud-config/worker-deploy.mjs` (as Watch's
   is) rather than copied from another app. Add actual service bindings only when the receiving
   application's contract requires them.
2. Choose unused entry and Worker positions. Declare existing UI metadata and same-origin probe
   paths. A Worker with `ACCESS_AUDIENCE` must have its exact Access application key in the manifest.
3. Regenerate, inspect both output diffs and run the catalog, Wrangler and infrastructure checks.
   Resource creation, identities and secrets remain explicit work in their existing owning files.
4. Add the application's public root `:check` and tagged `:release` facades with actual dependencies. The static
   publication job and ordering must also match its real release contract. Metadata alone never authorizes billing,
   data import or access to another service.

Special policies remain explicit: the backup application is frozen; Email Routing and the root mailbox are outside this catalog. Keep
those exceptions in their owning contracts rather than adding general-purpose escape hatches here.
