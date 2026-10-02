# Service catalog

Each application owns one public [`app.toml`](../dashboard/app.toml). The catalog is a small build-time
index of those files, not a runtime service or a second infrastructure controller.

| Source | Owns |
| --- | --- |
| `<app>/app.toml` | Application identity, Cloudflare or VPS target, Home labels and ordering, probe paths, Access paths and session duration |
| The application's committed `wrangler.toml` | Worker name, Custom Domains, resources, bindings, ordinary configuration |
| `infra/*.tf` outside the marked catalog regions | Resource identities, policy attachment, `prevent_destroy`, storage existence, outputs, encrypted state and provider configuration |
| GitHub's production environment and application deploy wrappers | Secret values and operational switches |
| Newsletter's release tooling | Tested image artifact, source SHA and published immutable digest; the catalog records only the image repository |

The catalog contains no email address, account or resource ID, IP address, credential, private endpoint,
operational switch or production state. It never reads `.env`, private configuration, credentials or an
OpenTofu state file, and it makes no network request. Wrangler and OpenTofu keep their existing ownership
boundaries; adding metadata does not deploy an application or create a resource.

## Validate and regenerate

Use Python 3.11 or newer, from the repository root:

```sh
python3 tools/service-catalog/catalog.py --check
python3 -m unittest discover -s tools/service-catalog/tests
```

On a Mac whose `python3` is older, prefix those commands with `uv run --no-project --python 3.12`.
The existing `Changes` job discovers these tests through
[`.github/scripts/test_service_catalog.py`](../.github/scripts/test_service_catalog.py).
No additional package is required.

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

The initial catalog covers eight Cloudflare applications and ten Workers, plus Newsletter as a VPS
application. Tests compare every generated Home entry and Worker role with the public metadata from
before this change, and retain the existing infrastructure and host guards. These checks prove source
consistency; they do not verify live Cloudflare resources or a deployed VPS.

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
| `ops_v1` | `binding`, `guard`; binding must already name the same Worker and its `Ops` entrypoint in Home's Wrangler config |
| `public_http` | `path`, nonempty 2xx `expect`, boolean `enabled`; optional `content_type`, `outside_access`, `error_rate` |
| `analytics` | `max_idle_hours`, an integer from 1 to 168; existing traffic-based activity signal |
| `self` | Home's own status |
| `none` | No collector exists; it must not imply health |

Optional `tile_metric` is `counter` plus a counter `name`, `latency`, or `last_active`. `app_only_signals`
lists existing public counter names that stay in the detail view. This metadata does not add a new
signal or collector. In particular, FlowDay's probe still reads its public PWA manifest, checks the
manifest content type, and keeps the Worker error-rate signal. It does not probe the authenticated
owner page or a retired staging hostname.

Newsletter uses `target = "vps"`, `image = "ghcr.io/ziyixi/todofy-newsletter"`, no `workers` or `access`, and its
existing Home entry with `status.type = "none"`. The image field identifies the repository, not a tag
to run. Release and deployment status, heartbeat transport and Kubernetes manifests are separate
contracts; this phase does not invent a scheduler or a second Newsletter state database.

## Generated outputs and consumers

[`dashboard/worker/src/registry.ts`](../dashboard/worker/src/registry.ts) receives the catalog's Home
entries and Worker-to-entry mapping. Its external self-hosted-services entry, resource identifiers,
flows and runtime behavior remain explicitly maintained outside these regions.

[`infra/access.tf`](../infra/access.tf) receives the existing owner application map, plus destinations
and session durations for the two existing FlowDay applications. It preserves their Terraform
addresses, policy IDs and `prevent_destroy`. It does not take over policy rules, the frozen Mail Hero
backup application, identity providers or secret values. An actual Access change still requires the
normal reviewed OpenTofu plan and gated apply; generation itself performs neither.

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

CI may use `apps` to distinguish Cloudflare checks from VPS image checks. Newsletter must not enter
Worker hostname guards, Wrangler deploy steps or the OpenTofu resource set. Its CI prefix is
`newsletter`; existing output prefixes remain unchanged, including `mail_hero`.

## Adding or changing a service

1. Add an application-owned manifest and, for Cloudflare, the committed production config and its
   normal deploy wrapper. Add actual service bindings only when the receiving application's contract
   requires them.
2. Choose unused entry and Worker positions. Declare existing UI metadata and same-origin probe
   paths. A Worker with `ACCESS_AUDIENCE` must have its exact Access application key in the manifest.
3. Regenerate, inspect both output diffs and run the catalog, Wrangler and infrastructure checks.
   Resource creation, identities and secrets remain explicit work in their existing owning files.
4. Change CI jobs only when the application has its real check and release contract. A catalog row
   alone does not authorize deployment, billing, data import or access to another service.

Special policies remain explicit: FlowDay's keys and policy attachment differ from owner applications;
the backup application is frozen; Email Routing and the root mailbox are outside this catalog. Keep
those exceptions in their owning contracts rather than adding general-purpose escape hatches here.
