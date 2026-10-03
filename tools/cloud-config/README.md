# Public cloud configuration

`config/cloud.toml` holds the exact public zone, repository, Access issuer, Fleet hostname and one
`vps.platform_runtime_host` daemon HTTPS hostname, plus namespace/state directory/node alias. It does not
expose a Kubernetes API hostname or separate Newsletter runtime ingress.
`config/resources.toml` records the account, zone and provider-issued resource identities. Neither file may
hold credentials, owner emails, mailbox addresses, private node IPs or business data.

Python 3.12 is enough; this tool has no package, account or network dependency:

```sh
python3.12 tools/cloud-config/generate.py
python3.12 tools/cloud-config/generate.py --check
python3.12 -m unittest discover -s tools/cloud-config/tests
```

`generate` changes only existing production `wrangler.toml` identity fields (`account_id`,
`ACCOUNT_ID`, Access issuer/AUD, D1 IDs and Fleet's `HOST_KEY` from `vps.observer_node_key`), Home's generated `resource-identities.ts` and the public DNS locals in
`infra/platform-identity.tf`. It preserves
all other configuration bytes and comments. Every generated Worker file is still that application's
sole top-level production config; there is no extra Wrangler file, environment or deploy-time override.
`--check` refuses stale files without writing. Validation names fields, never bad values.

Schema enforcement lives in `cloud_profile.py`: exact keys, version 1, typed values, precise public
hostname/image ownership, provider ID formats, no symlink traversal and no placeholder zero IDs.
The catalog uses this same public zone/repository to retain its exact hostname and image allowlists.

The optional Access application/policy maps are an inventory for explicit infrastructure adoption.
This tool does **not** update OpenTofu state, `infra/ids.tf`, frozen/app-scoped policy references,
identity providers, Tunnel configuration/state, Email Routing, Worker secrets or historical data. Home D1 matches are keyed
as `<database name>-db`; the Durable Object map uses existing Home logical resource IDs. An unknown new
DO stays `match: null` until its first deployment provides an ID.
Fleet's `HOST_EPOCH` stays operator-managed; profile generation never resets observer sequence or provider state.

The supported narrow case is moving the same owner/repository/domain to a new VPS or Cloudflare account.
Changing a zone or repository validates new allowed public identities; it does not rename routes,
images, website canonical content, immutable API identities or source provenance. See
[the rebuild runbook](../../docs/rebuild.md) for prerequisites, configuration gaps and recovery boundaries.
