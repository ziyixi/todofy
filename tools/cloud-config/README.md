# Public cloud configuration

Edit `config/cloud.toml` for the public zone, repository, Access issuer, `workers_dev_subdomain`, Fleet hostname
and `vps.platform_runtime_host`. The VPS section also declares its namespace, state directory, node alias and
expected system daemons. `config/resources.toml` records the account, zone and provider-issued resource IDs.
Neither file may hold credentials, owner emails, mailbox addresses, private node IPs or business data.

Python 3.12 is enough for generation; it needs no package, account or network access:

```sh
python3.12 tools/cloud-config/generate.py
python3.12 tools/service-catalog/catalog.py
python3.12 tools/cloud-config/generate.py --check
python3.12 -m unittest discover -s tools/cloud-config/tests
node --test tools/cloud-config/tests/worker-secrets.test.mjs
```

Each app manifest's `workers.hosts` declares relative host labels. An empty label means the zone itself; an
empty list means the Worker has no Custom Domain. Generation applies these labels to the configured zone and
updates each application's existing sole production `wrangler.toml`. It also updates public URLs and hook
allowlists, Access issuer/AUD, account and D1 IDs, Fleet's node key, the Website canonical origin, and the
Newsletter/Platform images (`ghcr.io/<repository>-newsletter` and `ghcr.io/<repository>-platform`).

Watch receives its own generated deployment module containing the zone and exact workers.dev suffix that its
URL policy must refuse. Todofy receives its own generated Watch hostname for new intent validation. Runtime apps
do not import this tool or one another. Stable protocol names, authentication domain separation strings,
historical fixtures and frozen event bytes keep their existing identity. A stored intent replay remains valid
under its original bytes; a new proposal must use the deployment's exact Watch hostname.

Generation also writes Home's private `resource-identities.ts`, `infra/platform-identity.tf` public DNS locals,
the existing `infra/ids.tf` inventory locals, Fleet's public repair links, and the public `worker-secrets.json`
binding declarations used during deployment. Other configuration bytes
and comments remain unchanged. There is no second production Wrangler config, environment or keep-vars mode.
`--check` refuses stale files without writing. Validation names fields, never rejected values.

Before a fresh account has AUD/D1 IDs, `generate.bootstrap_infra_files(root)` returns only
`infra/access.tf`, `infra/platform-identity.tf`, and `infra/ids.tf` for the cloud bootstrap's private
OpenTofu copy. Its in-memory catalog derives domains and images from the profile and uses zero
account/AUD/D1 placeholders; it writes no Worker or business source files. Normal generation remains
strict and runs after bootstrap exports the real resource inventory, followed by the normal catalog
renderer. No bootstrap catalog is used for deployment.

The current VPS expects `k3s`, `ssh`, the existing SSH `cloudflared`, and `cloudflared_platform`. A fresh host
normally declares `["k3s", "ssh", "cloudflared_platform"]`, so it does not report an absent legacy SSH tunnel.
Only these four daemon aliases are accepted; k3s, SSH and the platform tunnel are required. The observer consumes
this list through its rendered configuration. `HOST_EPOCH` remains operator-managed; generation never resets
observer sequence or provider state.

## Public CI outputs

```sh
python3.12 tools/cloud-config/outputs.py
python3.12 tools/cloud-config/outputs.py --github-output "$GITHUB_OUTPUT"
```

These commands return `website_url` and `relay_url` derived from the same validated profile. They do not look
up or create a Cloudflare workers.dev subdomain. Bootstrap must first provision or verify the chosen subdomain.

## Worker secrets

Each app manifest lists its Worker's `personal_secrets`, `manual_secrets` and `optional_secrets`, containing
binding names only. `cloud_profile.worker_secret_specs(root)` returns the validated Worker-to-GitHub map with
`github_secret`, `required` and `optional` lists. The generator writes the same public map to
`tools/cloud-config/worker-secrets.json`. Bootstrap validates private values separately; no secret values are
written by this generator.

The existing app deploy wrappers accept `<APP>_WORKER_SECRETS` JSON, reject undeclared bindings, merge the
map with their validated personal inputs, and write an exclusive file with mode 0600. Personal inputs take
precedence. A supplied map must contain all required bindings after that merge.
`REQUIRE_COMPLETE_WORKER_SECRETS=true` requires a map for a first deployment or repair. Existing invocations
without a map and without that flag retain their previous behavior.

Todofy's core uses `TODOFY_CORE_WORKER_SECRETS`; its gateway uses `TODOFY_WORKER_SECRETS`. Home uses
`DASHBOARD_WORKER_SECRETS`, and the Website relay uses `WEBSITE_RELAY_WORKER_SECRETS`. The relay has its own
`website/relay/deploy/deploy-vars.mjs` wrapper with the same `check`, `secrets <path>` and `exec --` commands.
Wrappers use `BUILD_SOURCE_SHA` when supplied, otherwise `GITHUB_SHA`, and require a full lowercase 40-hex SHA.
Both the normal release and a repair can therefore report the exact source they built.

The optional Access application/policy maps and `managed_ids` remain an inventory for explicit infrastructure
adoption. `managed_ids` accepts only the fixed OpenTofu addresses declared in `MANAGED_ADDRESSES`, with nonzero
UUID or 32-hex provider IDs; a tunnel and its configuration may share one ID. Bootstrap exports these public
IDs after creation or adoption. Routine drift repair must keep this baseline unchanged. An absent optional legacy backup application renders
its inventory scalar as `null`; generation does not delete the remote application or change a frozen policy. This
tool does not update OpenTofu state, frozen/app-scoped policy references, identity providers, Tunnel state,
Email Routing, Worker secrets or historical data. Home D1 matches use `<database name>-db`; Durable Objects use
the existing logical resource IDs. A new DO remains `match: null` until its first deployment provides an ID.
See [the rebuild runbook](../../docs/rebuild.md) for bootstrap prerequisites and recovery boundaries.
