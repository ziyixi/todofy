# infra: Cloudflare resources owned by this repository

This directory describes the Cloudflare objects that the monorepo's apps depend on but that wrangler
does not own. New deployments start with [cloud-bootstrap](../tools/cloud-bootstrap/README.md), which
uses these same files to create an empty environment or import an existing one. It refuses any update
to an existing object. Its private input and captured credentials stay outside Git.

`Personal cloud reconcile` detects drift and repairs only the dedicated runtime CNAME and its authenticated
loopback tunnel ingress. Other changes need review. An approved continuation applies the original
OpenTofu-encrypted plan from the private state bucket after checking its source SHA, signed contents and
current plan. The older P4 dispatch remains available. Detailed historical notes below describe that path.

- Tooling: OpenTofu 1.12 and the Cloudflare provider pinned at exactly **5.25.0**
  (`registry.opentofu.org/cloudflare/cloudflare`). [`.terraform.lock.hcl`](.terraform.lock.hcl) holds
  the provider hashes for darwin_arm64, linux_amd64 and the other published platforms. 5.26.0 is newer
  but is skipped because of open DNS regressions (provider issues #7387 and #7396). Upgrade only on
  purpose, and only after a plan shows zero diff.
- State: the private R2 bucket `infra-state`, object `production/terraform.tfstate`, encrypted by
  OpenTofu (state and plans, enforced, no fallback). See [Remote state](#remote-state).
- Drift: [`.github/workflows/infra.yml`](../.github/workflows/infra.yml) plans daily and on every push to
  `main` that touches `infra/`, checks the [outputs](#outputs) against every app's `wrangler.toml`, and prints
  only the redacted summary. See [Drift plan](#drift-plan-ci).
- Apply: [`.github/workflows/infra-apply.yml`](../.github/workflows/infra-apply.yml), a manual dispatch on
  `main` only. See [Apply](#apply-p4).
- Driver: [`scripts/infra_state.py`](scripts/infra_state.py) runs every OpenTofu command against the
  remote state (CI and local) so that no raw output, value or credential reaches a terminal or log.

## Scope

### Owner rule (2026-10-01)

Only objects that belong to the monorepo apps go here: mail-hero, todofy and todofy-core, the dashboard
`home`, `lab`, `flowday`, `links`, `watch`, the website `ziyixi-website`, the relay `ziyixi-notion-publish`, Fleet and the dedicated VPS platform endpoint.
Nothing unrelated is imported, declared, read or modelled, not even read-only.
[`infra_guard.py`](../.github/scripts/infra_guard.py) enforces the boundary on every push (through
[`test_infra_config.py`](../.github/scripts/test_infra_config.py) in `Changes`, and again in
`Infra checks`). It reads the HCL block structure, so quoted and bare labels (`resource "a" "b"` and
`resource a b`) and nested blocks are all seen, and anything it cannot read fails:

- network, IdP and email rule types are restricted to exact declared addresses; every resource has
  its own `lifecycle { prevent_destroy = true }`;
- the legacy backup app stays frozen. Its sole allowed move adds `[0]` to its state address so a
  fresh account can omit it; the application's identity and rules stay unchanged;
- no output reads a variable (`var.*`, also inside a `"${...}"` template), so a personal value can never
  become an output;
- no data source (not even inside a `check` block), module, `check`, `ephemeral` or `removed` block,
  no provisioner or connection, and no provider other than `cloudflare`;
- committed files are only `*.tf`, the lock file, the docs, `local.tfvars.example` and the Python
  scripts and tests. Any other file fails whatever its name: `*.tofu`, `*.tf.json` and `*.tofu.json`
  (OpenTofu would load them too), and state, plan, values or log files such as `tfplan` or `plan.out`;
- a `backend` or `cloud` block is accepted only together with an `encryption` block that enforces both
  state and plan encryption and a sensitive `state_passphrase` variable. That block may hold no
  `fallback` and no `unencrypted` method, and every key provider's passphrase must be exactly
  `var.state_passphrase` (never a literal).

[`test_infra_guard.py`](../.github/scripts/test_infra_guard.py) tests the guard itself against
configurations built to slip past it.

### Managed here (33 objects)

This is the maximum declared count. Fresh bootstrap creates 31 objects before the first Worker release,
then adds its exact mail rule (32). An adopted account retains the frozen legacy backup app (33).
Older private inputs can temporarily keep the existing external IdP references; bootstrap captures and
imports their actual IDs before switching to the managed references.

| Address | Object | Notes |
| --- | --- | --- |
| `cloudflare_zero_trust_access_identity_provider.github[0]` | GitHub login | Imported OAuth secrets stay untouched because Cloudflare never returns them; fresh creation uses the private OAuth input |
| `cloudflare_zero_trust_access_identity_provider.email[0]` | Email PIN login | Only the provider already selected by these owner applications is adopted |
| `cloudflare_zero_trust_access_policy.flowday["flowday"]` | FlowDay login | Preserves the existing owner email and GitHub login rules |
| `cloudflare_zero_trust_access_policy.flowday["flowday-bypass"]` | FlowDay PWA files | The existing everyone bypass on the PWA path |
| `cloudflare_email_routing_rule.mail_hero[0]` | Exact Mail Hero receive address | Enabled after the Worker exists; no catchall or root mailbox DNS |
| `cloudflare_zero_trust_access_policy.owner` | reusable Access policy "Mail Hero owner" | Allow. Includes the owner's email(s), which come from a sensitive variable. **Shared, see below** |
| `cloudflare_zero_trust_access_policy.github_owner` | reusable Access policy "Mail Hero GitHub owner" | Allow. Includes the owner's email(s) and requires the GitHub login method. **Shared, see below** |
| `cloudflare_zero_trust_access_application.owner["mail-hero"]` | Access app "Mail Hero" | `mail-hero.ziyixi.science` |
| `cloudflare_zero_trust_access_application.owner["todofy"]` | Access app "Todofy" | `todofy.ziyixi.science`. `todofy-hooks` and `daily` are deliberately not behind Access |
| `cloudflare_zero_trust_access_application.owner["home"]` | Access app "Home" | `home.ziyixi.science` (the dashboard) |
| `cloudflare_zero_trust_access_application.owner["lab"]` | Access app "Lab" | `lab.ziyixi.science` |
| `cloudflare_zero_trust_access_application.owner["links"]` | Access app "links" | `s.ziyixi.science/_/*` and the exact `s.ziyixi.science/_` (the launcher and owner API), session 168h, the two shared policies. The rest of the host (the short links) is deliberately not behind Access (links/docs/design.md) |
| `cloudflare_zero_trust_access_application.owner["watch"]` | Access app "watch" | `watch.ziyixi.science` (the whole host), session 24h, the two shared policies. **Created** here before the watch app's first deploy, not imported ([Adding an app](#adding-an-app)) |
| `cloudflare_zero_trust_access_application.owner["fleet"]` | Access app "Fleet" | Whole Fleet owner host; created before the Worker so its real AUD can be recorded |
| `cloudflare_zero_trust_access_application.fleet_receipt` | Fleet machine receipt | Only the exact `/api/internal/fleet/v1/receipt` path; Worker independently validates signed POST receipts |
| `cloudflare_zero_trust_access_policy.fleet_receipt` | Fleet signed receipt only | Bypass policy attached only to the exact receipt application; no owner API bypass |
| `cloudflare_zero_trust_access_service_token.platform_deploy` | Deployment machine identity | Dedicated token in encrypted state and encrypted one-time handoff; never an owner identity |
| `cloudflare_zero_trust_access_policy.platform_deploy` | Deployment machine policy | Includes only the dedicated service token |
| `cloudflare_zero_trust_access_application.platform_machine["runtime"]` | Platform machine API | Whole runtime host; no browser owner access |
| `cloudflare_zero_trust_tunnel_cloudflared.platform` | Platform connector | Dedicated tunnel; preserves the existing SSH tunnel |
| `cloudflare_zero_trust_tunnel_cloudflared_config.platform` | Platform ingress | Loopback daemon HTTP only, then 404; never routes Kubernetes |
| `cloudflare_dns_record.platform["runtime"]` | Runtime CNAME | Only this exact platform host; existing Worker and mailbox DNS remain with their current owners |
| `cloudflare_zero_trust_access_application.mail_hero_backup` | Access app "Mail Hero backup API" | `mail-hero.ziyixi.science/api/internal/backup/*`. Used by the backup collector's machine identity (mail-hero/AGENTS.md §7). **Frozen**: an apply refuses any write to it ([Apply](#apply-p4)) |
| `cloudflare_zero_trust_access_application.flowday["flowday"]` | Access app "flowday" | `flowday.ziyixi.science`, session 168h, FlowDay's own policy by id. See [FlowDay](#flowday) |
| `cloudflare_zero_trust_access_application.flowday["flowday-bypass"]` | Access app "flowday-bypass" | `flowday.ziyixi.science/pwa/*` (and the staging host's), session 6h, FlowDay's own policy by id. See [FlowDay](#flowday) |
| `cloudflare_d1_database.app["mail-hero" \| "todofy" \| "lab" \| "flowday" \| "links"]` | D1 databases | Existence only |
| `cloudflare_r2_bucket.app["mail-hero-store" \| "mail-hero-backups" \| "todofy-backups"]` | R2 buckets | Existence only |

**Never edit these objects in the Cloudflare dashboard** (FlowDay's and the links app's applications included). A
hand edit is drift: the next "Infra apply" reverts it, and before the first apply it would even turn an import into
`import+update`. Every change is a commit here and a dispatch of "Infra apply" ([Apply](#apply-p4)).

Every object has `prevent_destroy`, for two reasons:

- **Access apps.** Replacing an Access app gives it a new AUD. Every Worker's `ACCESS_AUDIENCE`, and the
  backup collector, would then reject requests: an outage.
- **Storage.** A destroyed database or bucket means lost data. A recreated one gets an id that no
  `wrangler.toml` knows.

**The two reusable policies are shared.** Each is attached to the seven owner-facing monorepo apps
(Mail Hero, Todofy, Home, Lab, links, watch, Fleet), plus applications of self-hosted services outside the monorepo.
The Mail Hero backup API uses only its own application-scoped policy, and FlowDay's two apps their own
policies ([FlowDay](#flowday)). Changing a reusable policy here therefore also changes who can reach those
outside services. This prototype never changes a policy's identity rules,
because the include/require values are exactly the live values, passed in through variables. Renaming
them to neutral names (`owner`, `owner-github`) is a P4 decision for the owner, because it affects
those other apps too.

### Owned elsewhere (inside the monorepo, but not by OpenTofu)

| What | Owner | Why not OpenTofu |
| --- | --- | --- |
| Worker scripts, bindings, vars/secrets, crons, Durable Object migrations, Custom Domains, routes, D1 schema migrations | each app's `wrangler.toml` and CI | When wrangler and OpenTofu both manage one object, each overwrites the other (provider issue #7382) |
| DNS records of the Worker hostnames | wrangler (Custom Domains create read-only AAAA records) | They are read-only and wrangler-owned; the dedicated platform CNAME is managed above |
| Email Routing: settings, catch-all, and the receive subdomain's MX/DKIM/SPF records | Email Routing (set up once) | The enable/DNS resources would try to write apex MX/SPF records, which would split the owner's mailbox. The exact Mail Hero address rule is managed separately in `mail-routing.tf`; bootstrap verifies its literal match and keeps private plan output off stdout |
| The service token used by the backup collector, and the rules of the backup app's application-scoped policy | Cloudflare dashboard | A token created or replaced by OpenTofu would put its client secret in state, and replacing it breaks backups without any error. The policy is referenced only by id (see [Import notes](#import-notes)) |
| Legacy Mail Hero backup policy and service token | Cloudflare dashboard | Kept frozen for existing accounts only; fresh accounts use the Worker-native backup and omit this application. FlowDay policies and selected owner IdPs are managed above |
| R2 lifecycle rules | none (only Cloudflare's default multipart-abort rule) | See [Storage](#storage) |
| GitHub secrets and variables, ops switches (`*_PAUSED`, `*_MAINTENANCE_MODE`, …) | GitHub `production` environment | Secret values would end up in state. Switches are flipped at runtime, and IaC would flip them back |

### Not managed here (outside the monorepo)

Listed by category only. These are neither declared nor read, and their values are not recorded:

- the Access applications of self-hosted services and their own policies (including bypass policies);
- the Warp login application;
- the pre-existing tunnel and tunnel hostnames of self-hosted services; the dedicated platform tunnel above is owned here;
- the apex mailbox records (MX, TXT, DKIM, DMARC);
- third-party verification TXT records;
- zone-wide settings (SSL, rulesets, certificates);
- identity providers unrelated to the selected owner login methods;
- notification and budget alerts;
- R2 buckets of other projects.

## FlowDay

FlowDay moved into the monorepo (flowday/docs/design.md) with two Access applications created before the
move: `flowday` (the host) and `flowday-bypass` (its PWA files under `/pwa/*`, which must load without a
login). Both are adopted unchanged (`cloudflare_zero_trust_access_application.flowday[...]`):

- Each app retains its own reusable policy. Bootstrap imports their exact include/require, session and
  connection rules into `cloudflare_zero_trust_access_policy.flowday[...]`; it does not move FlowDay
  onto the shared owner policy or change the bypass. Authentication changes require explicit review.

Cloudflare provider 5.25.0 (and 5.26.0) imports an empty `login_method` selector beside an email rule.
Only these two policies ignore changes to `include` to avoid a perpetual update. Every plan and apply
independently reads their actual rules and verifies the exact owner emails, GitHub provider, bypass,
decision, `require` and `exclude`. A mismatch reports `FLOWDAY_INCLUDE_MISMATCH` and blocks apply.
For this provider defect, restore the exact declared include rules in the official Access policy UI,
then rerun the check; an approved saved plan cannot repair this ignored field. Fresh creation still
uses the HCL include rules. The exception does not cover applications or other policies.

Every change to these two applications goes through this directory, never the dashboard (FlowDay's own runbooks,
`flowday/README.md` "Rollback and removal" and `flowday/docs/design.md` section 11, point here):

- **The F3 staging host left through OpenTofu (after F4, 2026-10-01).** Both apps listed
  `flowday-next.ziyixi.science` (and its `/pwa/*`) as a second destination. After the first P4 apply and after the
  commit that cleared F4's cf-guard allowances, **one commit** dropped `flowday-next.ziyixi.science` from both entries
  of `local.flowday_apps` and empties `RETIRING_HOSTS` in
  [`test_infra_config.py`](../.github/scripts/test_infra_config.py) (`test_retiring_hosts_are_exact` fails if only
  one of the two changes). Its "Infra drift" run must show exactly `update: 2`, the addresses
  `cloudflare_zero_trust_access_application.flowday["flowday"]` and `["flowday-bypass"]`, and nothing else; then
  dispatch "Infra apply" with `update=2@<the fingerprint of that run>`. A local plan of exactly that change
  (2026-10-01, not applied) showed an in-place update of the two apps and no replacement, so their AUDs (and
  FlowDay's `ACCESS_AUDIENCE`) stay. It needs a token with Access: Apps and Policies Edit
  ([Replacing the token](#replacing-the-token)).
- **Adding the staging host back** (the F3 revert, or step 6 of the F4 rollback in `flowday/README.md`): the same
  way in reverse, one commit that adds it to both entries and to `RETIRING_HOSTS`, `update: 2`, then "Infra apply".
- **F6 (retiring `flowday-bypass`)** is its own reviewed change to this directory, planned when F6 starts. The
  application has `prevent_destroy` (on the whole `flowday` resource), and the guard forbids `removed` blocks, so
  either way needs a narrow, reviewed exception in [`infra_guard.py`](../.github/scripts/infra_guard.py) for exactly
  that address: OpenTofu deletes the application (a `delete` in the plan), or a `removed` block with
  `destroy = false` forgets it (`forget`) and it is deleted by hand afterwards. Both are destructive, so the
  dispatch needs `confirm_destructive` = `delete-replace-forget` and the reviewed counts and fingerprint; the same
  commit drops its key from `local.flowday_apps` and its id from `ids.tf`. Deleting it in the
  dashboard first would turn into a `create` in the next plan.
- **Removing FlowDay altogether** (`flowday/README.md` "Remove FlowDay's Worker") takes its D1 database and both
  applications out of this directory in a reviewed change of the same kind, never by hand.

## DNS

Only the dedicated platform runtime CNAME is managed here, in [`platform.tf`](platform.tf).
It points to the new platform tunnel and is restricted by the infrastructure guard to this exact address.
The tunnel routes the authenticated daemon API, never the Kubernetes API. Existing SSH ingress is independent.

Worker hostnames remain Wrangler Custom Domains with read-only records. Mail Hero's receive subdomain
MX, DKIM and SPF records remain Email Routing-owned. Apex mailbox records, third-party verification
records and unrelated self-hosted hostnames remain outside this directory.

Adding any other DNS or tunnel resource requires an explicit scope change in
[`infra_guard.py`](../.github/scripts/infra_guard.py); the four added types are not general permission
to manage the zone or replace an existing tunnel.

## Storage

D1 databases and R2 buckets are recorded for **existence only**: name and account, plus the D1
`read_replication = disabled` setting they were created with. Schemas, data and bindings stay with
each app's wrangler.toml and CI. `test_infra_config.py` checks on every push that these are exactly
the databases and buckets the production configs bind, and that each D1 import id is the
`database_id` committed in that app's config.

R2 lifecycle rules are **not modelled**:

- Each bucket has only Cloudflare's "Default Multipart Abort Rule".
- `cloudflare_r2_bucket_lifecycle` cannot be imported in 5.25.0. A declared rule set would show up as
  "create", and applying it would PUT the whole rule set.
- Time-based expiry must never be added to these buckets:
  - Mail Hero's retention runs through its own ledger and needs the owner's confirmation.
  - Backup rotation is done by the collector, counting only verified packages (mail-hero/AGENTS.md
    §§1, 3, 7).
  - A bucket-level rule would bypass both.

## Variables

All values come from a tfvars file **outside the repository** (locally) or from the GitHub secret
`INFRA_TFVARS` (CI) ([`variables.tf`](variables.tf), [`local.tfvars.example`](local.tfvars.example)):

| Variable | Sensitive | Source |
| --- | --- | --- |
| `account_id` | no | Kept out of `infra/` all the same. Several `wrangler.toml` files already contain it, but this directory adds no new copy |
| `access_owner_emails` | **yes** | The live include list of "Mail Hero owner" |
| `access_github_owner_emails` | **yes** | The live include list of "Mail Hero GitHub owner" |
| `access_allowed_idp_ids` | no | Identity provider ids allowed on the seven owner-facing apps (links, watch and Fleet have the same list as the others; FlowDay's apps allow every provider, `allowed_idps` unset) |
| `access_github_idp_id` | no | The GitHub identity provider that "Mail Hero GitHub owner" requires |
| `access_github_oauth` | **yes** | Fresh OAuth client ID/secret; selected existing IdPs are imported with the existing secret preserved |
| `flowday_policy_names` / `flowday_policy_options` | no | Exact names, session duration and connection rules captured during adoption |
| `mail_receive_address` / `mail_route_name` | **yes** | Exact dedicated-subdomain rule captured privately; `mail_route_ready` activates it only after the Worker exists |
| `legacy_mail_hero_backup` | no | Existing-account compatibility only; false for fresh native backups |
| `state_passphrase` | **yes** | Not a value of the infrastructure: the state and plan encryption passphrase, `INFRA_STATE_PASSPHRASE` ([Remote state](#remote-state)). Never in a values file |

### Values in CI: one dedicated secret, `INFRA_TFVARS`

In CI the infrastructure values come from **one** production-environment secret, `INFRA_TFVARS`: the JSON
object that [`scripts/infra_state.py`](scripts/infra_state.py) `values-json` makes from the local values
file. The email lists therefore reach OpenTofu only as the sensitive variables. GitHub masks a secret
only as its whole string, never the values inside a JSON secret, so on a runner `infra_state.py`
registers **every value inside it** (account id, identity provider ids, both email lists) with
`::add-mask::` before anything else runs; any later log line that held one would show `***`.

The existing secrets `DASHBOARD_ACCESS_OWNER` / `DASHBOARD_ACCESS_OWNER_ALIASES` were considered and
**not** used, because they cannot reproduce the policies and would couple two different things:

- **They are a different shape.** The two reusable policies hold two *separate* lists in a fixed order
  (one address for "Mail Hero owner", another one for "Mail Hero GitHub owner", checked on 2026-10-01 by
  count only). The dashboard secrets are one owner plus an unordered alias allowlist, with Worker-side
  rules (at most 8 aliases, a single space when empty). A mapping would have to guess which alias belongs
  to which policy.
- **They have a different blast radius.** The policies are shared with two self-hosted services outside
  the monorepo. Adding an alias for the dashboard's JWT check must not become, at P4, a change to who can
  reach those services. With a dedicated secret, a policy change is always a deliberate change of
  `INFRA_TFVARS`.
- **One secret is the minimum** that holds all five values; the GitHub variables CI reads stay exactly
  the operational switches (`test_wrangler_configs.py`).

Set or refresh it from the local values file; the value goes from the file through a pipe and is never
shown (`values-json` refuses to write to a terminal):

```sh
python3 infra/scripts/local_tfvars.py --account-id <account id> --out ~/.config/todofy-infra/local.tfvars
python3 infra/scripts/infra_state.py values-json --var-file ~/.config/todofy-infra/local.tfvars \
  | gh secret set INFRA_TFVARS --env production -R ziyixi/todofy
```

**Which ids are committed (one rule).** Ids of the objects this directory manages are committed:
the Access application ids, the two shared reusable policy ids, the backup app's application-scoped policy
id, FlowDay's two managed reusable policy ids, the selected IdPs, owned network/mail-rule IDs and the D1 ids (in
[`ids.tf`](ids.tf), [`access.tf`](access.tf), [`scripts/local_tfvars.py`](scripts/local_tfvars.py) and,
as the backup app's `FROZEN` id, [`scripts/infra_state.py`](scripts/infra_state.py)). They are opaque object handles,
not credentials: no API call can use them without a token for the account. Import needs them, and a
reviewer has to be able to see which object each address adopts. The D1 ids, the Mail Hero app id and the
two reusable policy ids were already public (in the wrangler configs and
`mail-hero/docs/verification-native.md`). Ids of objects **outside** the monorepo boundary that
this configuration only references stay outside the managed inventory. Public account/zone and managed IDs live in `config/resources.toml`; private OAuth/identity values stay in `INFRA_TFVARS`. The generated `platform-identity.tf` is the sole public zone-ID boundary under `infra/`; other files cannot add account/zone literals.

Even with sensitive variables, `tofu show -json` writes **every value in plain text**: the sensitive
variables, the include emails read back from the API, and the account id inside import ids. Plan files
and their JSON must therefore never be committed, uploaded as artifacts, or printed to a log. Only the
redacted summary may be shared ([`tools/infra-plan-summary`](../tools/infra-plan-summary/summary.py)).

## Remote state

| | |
| --- | --- |
| Where | Private R2 bucket **`infra-state`** (account default location, no public access), object `<environment>/terraform.tfstate`; today only `production/terraform.tfstate`. Besides it, only the apply's copies `backups/<environment>/terraform.tfstate.<UTC time>-run<id>` (encrypted like the state; [Apply](#apply-p4)); the bootstrap's probe key is deleted at once |
| Backend | `backend "s3"` in [`versions.tf`](versions.tf) with a **partial** configuration. Committed: bucket, `region = "auto"`, `use_path_style`, the `skip_*` checks R2 needs. Passed at runtime by `infra_state.py` and never committed: the key (`-backend-config=key=...`), the endpoint (`AWS_ENDPOINT_URL_S3=https://<account id>.r2.cloudflarestorage.com`, it contains the account id) and the credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) |
| Encryption | OpenTofu client-side encryption of **state and plans**: `key_provider "pbkdf2"` from `var.state_passphrase` (at least 16 characters, no default) and `method "aes_gcm"`, both `enforced = true`, **no `fallback`**. Every command that reads or writes state or a plan fails without the passphrase; nothing is ever read or written unencrypted. R2 sees only `meta` (key provider name and salt) and `encrypted_data`. `infra_state.py` refuses to start without the passphrase and strips `TF_ENCRYPTION` (which could add a fallback behind the committed file), `TF_LOG*`, `TF_CLI_ARGS*`, other `TF_VAR_*` and every `AWS_*` from tofu's environment |
| Passphrase | GitHub production secret **`INFRA_STATE_PASSPHRASE`**; tofu gets it as `TF_VAR_state_passphrase`. Generated locally by whoever runs the bootstrap, who keeps a copy in the owner's password manager. GitHub cannot show it again: without that copy the state can be decrypted only inside CI, and a lost passphrase means rebuilding the state by import ([Rotating the passphrase](#rotating-the-passphrase)) |
| Credentials | Derived from the Cloudflare API token at runtime: access key id = the token's id (`GET /accounts/<account>/tokens/verify`, or `/user/tokens/verify` for a user token), secret access key = SHA-256 of the token value. Under GitHub Actions both are masked (`::add-mask::`) before tofu starts; they are never printed, written to a file or put on a command line. Derivation verified read-only on 2026-10-01 (a wrong secret is refused) |
| Credentials fallback | If a future token cannot be used this way (no R2 permission, or Cloudflare stops deriving), create an R2 API token for the `infra-state` bucket only (Object Read & Write) in the dashboard and store its pair as production secrets `INFRA_R2_ACCESS_KEY_ID` / `INFRA_R2_SECRET_ACCESS_KEY`, and pass them to the plan step in `infra.yml`. `infra_state.py` uses that pair instead of deriving whenever both are set (and refuses only one of them) |
| Locking | **No lock file.** `use_lockfile` needs R2 to honour `If-None-Match: *` on this bucket, which is not proven yet. Until then the GitHub concurrency group `infra-production` serialises every run in CI. The drift plan never writes the state anyway; the bootstrap, reviewed apply and narrowly scoped reconcile can write it, all under the same CI lock for recurring runs. The bootstrap probes conditional writes and reports the result; enable `use_lockfile` in a separate change only after the probe passes on R2 |
| Contents | The managed objects' attributes as read from the API, including the policies' include emails and the account id, and the [outputs](#outputs): that is why the state is encrypted and never printed. It also holds the platform deployment service-token credentials and tunnel state. Only the private bootstrap exporter reads those outputs; no public plan, log, or inventory includes them |
| Rollback | R2 keeps no object versions. Every apply first copies the state object, byte for byte (it is already encrypted), to a dated key and reads the copy back; restoring one is in [Apply](#apply-p4), and `infra_state.py list-backups` prints their keys (keys only). With `imports.tf` restored from history the state is also rebuildable from the `import {}` blocks ([Bootstrap](#bootstrap-once)) |

## Running a plan locally

A read-only plan needs Access apps/policies/selected IdPs, the exact Email Routing rule, DNS/tunnel, D1 and R2 read scopes plus access to the private state bucket. Apply/bootstrap additionally need writes to the owned resource types. The bootstrap validates account and zone before creating anything:
today the existing deploy token (the admin helper's token file holds the same token), later
`CF_API_TOKEN` or a separately scoped read token. Never put a token or the passphrase in a file in the repository or on a command line.

```sh
brew install opentofu                                   # 1.12.x
export CLOUDFLARE_API_TOKEN=...                         # from your password manager, not the shell history
export INFRA_STATE_PASSPHRASE="$(cat ~/.config/todofy-infra/state-passphrase)"   # chmod 600 file
python3 infra/scripts/local_tfvars.py --account-id <account id> --out ~/.config/todofy-infra/local.tfvars
python3 infra/scripts/infra_state.py plan --var-file ~/.config/todofy-infra/local.tfvars
```

It prints the redacted summary and exits 0 (no changes), 2 (drift), 3 (a delete, replace or forget), 5 (an
[output](#outputs) differs from a `wrangler.toml`) or 1 (an error, with sanitised `Error:` headlines only).
The outputs check needs Python 3.11+ (`tomllib`); with an older `python3` it is skipped with a notice, so
prefer `uv run --no-project --python 3.12 python infra/scripts/infra_state.py plan ...`. Every run works in a **new** private (0700) directory
that it creates itself; `--work-dir <dir outside the repo>` only chooses that directory's parent, which is
never chmodded, emptied or removed. `--keep-work-dir` keeps the run's own directory (tofu's raw 0600 log)
for debugging; the values file and the plan in it are deleted either way (also after an error).
`--keys-from` handling, the `for_each` key placeholders and the summary format are those of
[`tools/infra-plan-summary`](../tools/infra-plan-summary/summary.py).

**Never run `tofu apply`** (or `import`, `state rm`, `force-unlock`) by hand. The only applies are the
bootstrap's import-only plan below, which writes **only a missing** state object, and "Infra apply" on `main`.
`infra_state.py apply` refuses to start unless it runs on a GitHub Actions runner in the workflow "Infra apply",
dispatched (`workflow_dispatch`) on `refs/heads/main`: a local `apply` instead of `plan` does nothing at all. That
check is accident-proofing, not a security boundary (anyone can edit the script); the real boundary is that only the
`production` environment holds the secrets.

## Bootstrap (once)

This section records the old import-only path. For current fresh creation, adoption and resumable setup, use [cloud-bootstrap](../tools/cloud-bootstrap/README.md). It generates temporary import blocks automatically; do not restore old committed imports for the new flow.

[`scripts/bootstrap_state.py`](scripts/bootstrap_state.py) creates the remote state. Run it **before**
the branch that adds `infra.yml` reaches `main` (otherwise the first drift run fails on a missing bucket
or an empty state). It prints one fixed line per step and the redacted summaries, never a value:

1. Checks OpenTofu 1.12, the passphrase, the values file (outside the repository) and the admin helper's
   token file.
2. Derives the S3 credentials, looks for `infra-state` and creates it if missing through the admin
   helper's wrangler wrapper ([`mail-hero/deploy/cloudflare-admin.py`](../mail-hero/deploy/cloudflare-admin.py),
   which reads the token itself; wrangler runs in the private work directory, so no `wrangler.toml` can be
   edited).
3. Probes conditional writes on a throwaway key (report only).
4. Notes whether the state object exists, then `tofu init` with the backend.
5. Plans. The plan must hold **only imports**: every resource `import` (or already `no-op`), exactly 19
   (`EXPECTED_OBJECTS`),
   and outputs only created (a new state has none). Anything else (create, update, replace, delete,
   forget, import+update, an output update, another count) **refuses with exit 4 before any apply**. If the
   state object **already exists**, any import or output create refuses too (exit 4): a populated state changes
   only through "Infra apply" on `main`, with its backup, gates and concurrency group.
6. Applies exactly that saved plan, only into a missing state object. Import reads Cloudflare and writes only
   the state.
7. Reads the state object back and checks that it is encrypted.
8. Plans again: it must be "No changes" (exit 0, 19 no-op, no output change), or the script fails.

A second run on an existing state only verifies it: "No changes" passes, anything else refuses. The bootstrap
needs the `import {}` blocks, which were [removed](#removing-the-import-blocks): restore `imports.tf` from git
history on a branch first. That file predates the objects created here later ([Adding an app](#adding-an-app): the
watch app's application), so add one block for each of them from its id in [`ids.tf`](ids.tf), in the form of the
other applications' blocks; without it the plan holds a `create` and the bootstrap refuses (exit 4). Rebuilding by import (a lost passphrase, or the first way of
[Rotating the passphrase](#rotating-the-passphrase)) therefore means: copy the state object to a backup key
(as in [Apply](#apply-p4) "Restoring a state backup", in reverse), delete the state object, then run the bootstrap.

```sh
cd <a clean checkout of the branch>
npm ci --prefix mail-hero/cloudflare                    # the admin helper's wrangler
umask 077; mkdir -p ~/.config/todofy-infra
openssl rand -base64 32 > ~/.config/todofy-infra/state-passphrase    # copy it into the password manager
CLOUDFLARE_API_TOKEN="$(cat ~/.config/mail-hero/cloudflare-bootstrap-20260926.token)" \
  python3 infra/scripts/local_tfvars.py --account-id <account id> --out ~/.config/todofy-infra/local.tfvars
# The bootstrap reads the admin helper's token file itself (--token-file to choose another one).
python3 infra/scripts/bootstrap_state.py --var-file ~/.config/todofy-infra/local.tfvars \
  --passphrase-file ~/.config/todofy-infra/state-passphrase
# Then the two secrets the drift workflow needs (values through pipes, never shown):
gh secret set INFRA_STATE_PASSPHRASE --env production -R ziyixi/todofy < ~/.config/todofy-infra/state-passphrase
python3 infra/scripts/infra_state.py values-json --var-file ~/.config/todofy-infra/local.tfvars \
  | gh secret set INFRA_TFVARS --env production -R ziyixi/todofy
```

The admin helper's token file holds the same token as the GitHub secret `CF_API_TOKEN`. The bootstrap
creates a new private work directory `~/.cache/todofy-infra/bootstrap-<time>-<random>` (`--work-dir`
picks another parent; an existing directory is never reused, chmodded or removed). It keeps only tofu's
raw log; delete it when done.

## Drift plan (CI)

[`.github/workflows/infra.yml`](../.github/workflows/infra.yml) ("Infra drift") runs on a push to `main`
that changes `infra/**`, `tools/infra-plan-summary/**` or the workflow itself, every day at 13:23 UTC, and on
a manual run. It is a separate workflow, not a job in `ci.yml`: its triggers differ, Cloudflare drift is
not a property of a commit (a red drift run must not fail `CI gate` and hold back app deploys, and a green
branch run must never be reused for it), and it is the only place outside the deploy jobs that holds a
production token.

- `production` environment (it admits `main` only), and `if: github.ref == 'refs/heads/main'`, so a manual
  run from another branch is skipped. Concurrency group `infra-production`, never cancelled.
- Secrets: `CF_API_TOKEN` (the existing deploy token, owner decision 2026-10-01), `INFRA_STATE_PASSPHRASE`
  and `INFRA_TFVARS`. No GitHub variable.
- One step: `python3 infra/scripts/infra_state.py plan`. It runs `tofu init` and
  `tofu plan -detailed-exitcode -out`, with tofu's output in a 0600 file in `$RUNNER_TEMP` that is
  deleted at the end, reads `tofu show -json` into memory, and prints **only the redacted summary**
  (counts, plus the addresses with an action) to the log and the step summary.
- The job **fails on any planned action** (exit 2) and always on a delete, replace or forget (exit 3).
  "Changed outside OpenTofu" entries alone (a D1 `file_size`) do not fail it ([Drift signal](#drift-signal)).
  It also fails (exit 5) when an [output](#outputs) differs from an app's `wrangler.toml`. With planned
  actions it ends with the line `"Infra apply" expect for this plan: <counts>@<fingerprint>`: the counts and the
  **plan fingerprint** (the first 12 hex digits of SHA-256 over the sorted action/address rows, no-op rows
  included, and the output changes; addresses only, so it is public). Compare it with what the change should
  produce; it is the input an apply needs only when it is exactly what you expected.
  An error prints sanitised `Error:` headlines only (no quoted text, address, email, id or long token).
- Nothing is uploaded. There is no apply, import or state command (the apply is its own workflow).
  `test_infra_workflow.py` (run by `Changes`) pins all of this.

GitHub disables scheduled workflows after 60 days without repository activity; a dispatch re-enables it.

## Outputs

[`outputs.tf`](outputs.tf) exposes the identifiers the apps' `wrangler.toml` files repeat:

| Output | Value | Checked against |
| --- | --- | --- |
| `access_aud` | AUD per Access application, keyed by Worker name (plus `flowday-bypass` and `mail-hero-backup`, which no Worker checks itself) | every `vars.ACCESS_AUDIENCE` (`access_aud[<the config's name>]`) |
| `d1_database_ids` | D1 id per database name | every `[[d1_databases]]` `database_id` |
| `r2_bucket_names` | the bucket names | every `[[r2_buckets]]` `bucket_name` |

None is secret (each value is committed in a `wrangler.toml`), and none may read a variable (the guard).
[`infra_state.py`](scripts/infra_state.py) reads the **planned** values (`planned_values.outputs` of the
plan, in memory) and compares them with the production configs it lists in `WRANGLER_CONFIGS` (the same
list as `test_wrangler_configs.py`, which `test_infra_config.py` enforces). A difference prints the
config's path and the field only, never a value, and fails the drift run (exit 5) and refuses an apply.
So a replaced Access application (new AUD), or a `wrangler.toml` that names another database, is caught
every day, not at the next deploy. A planned *create* of an application or database that a `wrangler.toml`
names fails too (its AUD or id is unknown before the apply): for example the import-block removal merged
before the first apply, which would plan `create: 5` (checked locally on 2026-10-01: exit 5).

A create that **no production config names yet** is how a new app gets its Access application before its first
deploy ([Adding an app](#adding-an-app)). `tofu show -json` then leaves `access_aud` out of `planned_values` (the
map is partly unknown); `infra_state.py` reads its known entries from the plan's `output_changes` (`after`, with
the new key in `after_unknown`; the format checked with OpenTofu 1.12.6 on 2026-10-01), compares every known entry
as usual, and accepts the unknown one only while no production `wrangler.toml` names it. The drift run is then
plain drift (exit 2, with its expect line), never a mismatch, and "Infra apply" can apply it; its verify plan
knows the new AUD and compares the complete map again.

**The first plan after adding the outputs shows `output changes: 3`** (`create`) on top of its other
actions, and every drift plan keeps showing them, failing with exit 2, until an apply writes them to the
state. That is expected; after the first apply they are `no-op`. Planned values are known for imported
objects, so the check already runs on that first plan.

## Apply (P4)

[`.github/workflows/infra-apply.yml`](../.github/workflows/infra-apply.yml) ("Infra apply"), one job, one
step: `python3 infra/scripts/infra_state.py apply --environment production`.

- **Trigger: manual `workflow_dispatch` only**, from `main` (`if: github.ref == 'refs/heads/main'`, and the
  `production` environment admits `main` only). An apply should be watched, and the "Infra drift" run of the
  merged commit has already printed the summary to check. A `push` trigger would apply every merged
  `infra/` change unattended; that can come later, after several clean manual applies, as its own change.
- **Separate workflow**, not a job in `infra.yml`: the triggers differ (one wrong `if:` in a shared file would
  make a drift run apply), `infra.yml` stays provably plan-only, and only the apply has inputs. Both share
  the concurrency group `infra-production` (never cancelled), so a plan never reads a half-written state.
  GitHub keeps one *pending* run per group: a drift run queued after a pending apply cancels the apply
  before it starts (harmless; nothing ran). Dispatch when no drift run is running or queued, and
  re-dispatch if the apply shows "cancelled" without having started.
- **Inputs**, passed to the script through the environment only: `expect` (required), the counts and
  plan fingerprint **you expected and checked against the drift run's address table**, for example
  `import=5,outputs=3@fe0e0ae1a4d6` (`none` for no change); never a copy of a printed line that differs from what
  you expected. The fingerprint binds the dispatch to that exact list of addresses and actions: if `main` moved or
  Cloudflare changed after the review, the same counts with other addresses refuse. And `confirm_destructive`
  (empty by default).
- **Where it runs.** The script itself refuses unless it is on a runner in this workflow (`GITHUB_WORKFLOW` =
  `Infra apply`), dispatched on `refs/heads/main` ([Running a plan locally](#running-a-plan-locally)).
- Secrets: `CF_API_TOKEN` (until `CF_INFRA_TOKEN` exists), `INFRA_STATE_PASSPHRASE`, `INFRA_TFVARS`.

The script, in this order; nothing is written before every gate passes:

1. **Encrypted state backup.** Reads `production/terraform.tfstate`, refuses unless it is an OpenTofu-encrypted
   state (`meta` + `encrypted_data`), writes the same bytes to
   `backups/production/terraform.tfstate.<UTC time>-run<run id>` in the same private bucket (after a `HEAD`
   shows the key is free; not `If-None-Match`, which is unproven on R2), reads the copy back and compares it. The copy is never decrypted or readable without
   the passphrase. Only its key is printed.
2. `tofu init`, then `tofu plan -out` (the redacted summary goes to the log and the step summary).
3. **Gates** (each refuses with a fixed message; exit 1, or 3 for the first):
   - a delete, replace or forget (`summary.py`'s `--fail-on-destroy` rule) refuses unless
     `confirm_destructive` is exactly `delete-replace-forget`. `prevent_destroy` still stops a delete or
     replace at plan time; lifting it is a reviewed commit of its own;
   - the **resource-type allowlist**: every resource with a planned action is a managed resource of
     `ALLOWED_TYPES` (equal to `infra_guard.py`'s, enforced by `test_infra_config.py`); no data source;
   - **`FROZEN` objects** may be imported but never written: today the backup app
     ([Import notes](#import-notes)). Matched by address, by previous address (a `moved` rename or a `for_each`
     refactor) and by object id (`before`/`after` id and the import id), so a renamed address cannot carry a write
     past it; the guard also rejects a `moved` block that names it;
   - the [outputs](#outputs) equal every `wrangler.toml`;
   - the plan's action counts equal `expect` exactly, and so does its fingerprint.
4. `tofu apply <the saved plan>`: exactly what was gated, no re-plan.
5. Plans again: it must be "No changes" with matching outputs, or the job fails (the apply has happened;
   the next drift run shows what is left).

**Rollback.**

- *An import-only apply* changes no Cloudflare object, only the state. To undo it, restore the backup
  (below), or leave it: the objects are then simply managed.
- *An apply that changed an object*: revert the commit on a branch, merge, check the drift run's address table
  against the revert, and dispatch "Infra apply" again with those counts and that fingerprint. Access applications are updated in place; their AUDs
  survive (a replacement is refused unless confirmed, and `prevent_destroy` stops it anyway).
- *Restoring a state backup* (the state is wrong, not Cloudflare): with no run in progress, copy the backup's
  bytes back over the state key, never decrypting them, then dispatch "Infra drift":
  ```sh
  python3 mail-hero/deploy/cloudflare-admin.py wrangler r2 object get \
    infra-state/backups/production/terraform.tfstate.<time>-run<id> --remote --file <private dir>/state.enc
  python3 mail-hero/deploy/cloudflare-admin.py wrangler r2 object put \
    infra-state/production/terraform.tfstate --remote --file <private dir>/state.enc
  ```
  The backups accumulate (a few kB each); delete old ones by hand, never with a lifecycle rule:
  `infra_state.py list-backups --var-file <values>` (with the token and the passphrase in the environment, as for a
  plan) prints their keys only, and
  `python3 mail-hero/deploy/cloudflare-admin.py wrangler r2 object delete infra-state/<key> --remote` deletes one by
  its exact key (wrangler cannot list objects).

## Adding an app

A new app's Access application is **created** here, never in the dashboard, and before the app's first deploy: its
AUD exists only once the application does, and the Worker must be deployed with it. The watch app (W2,
`watch/docs/design.md` section 11) is the first; the order, for any app:

1. **This directory** (one commit; no `wrangler.toml` change): the app's entry in `local.owner_apps`
   ([`access.tf`](access.tf), key = the Worker's name, so `access_aud[<name>]` is its AUD) and its entry in
   `AHEAD_OF_DEPLOY` in [`test_infra_config.py`](../.github/scripts/test_infra_config.py) (the Worker's config is
   still undeployed: no route, the all-zeros AUD, the host as `PUBLIC_HOST`). The outputs check accepts the unknown
   AUD because no production config names it yet ([Outputs](#outputs)).
2. **Merge**; the push's "Infra drift" run is **red by design** (exit 2). Check it against exactly this:
   - `create: 1`, nothing else but `no-op` (19 rows in all; with FlowDay's `update: 2` still unapplied, that too);
   - the one row `create` `cloudflare_zero_trust_access_application.owner["<name>"]`;
   - `output changes: 1`: `update` `access_aud`;
   - the expect line. For the watch app, computed from the addresses of this commit (the method reproduces P4's
     recorded `fe0e0ae1a4d6`): `create=1,outputs=1@3e485bfca3ad`, or `create=1,outputs=1,update=2@14144c392b45` if
     FlowDay's staging-host removal (`update: 2`) has not been applied yet.

   If anything differs, stop and find out why; never copy a differing line into the dispatch.
3. **Dispatch "Infra apply"** on `main` with that `expect`. The token must be allowed to edit Access applications
   (Access: Apps and Policies Edit; [Replacing the token](#replacing-the-token)). It ends with "apply: done" and a
   verify plan of `no-op: 19`, `output changes: 0`; then "Infra drift" is green with `no-op: 19`.
4. **Read the AUD and the application id, read-only.** Neither workflow prints an output value (only counts and
   addresses), so read them from the Access API with the admin helper (a GET; the AUD is not secret, every
   `wrangler.toml` commits its own), keeping only the new application's line:

   ```sh
   python3 mail-hero/deploy/cloudflare-admin.py inspect | python3 -c '
   import json, sys
   for line in sys.stdin:
       apps = json.loads(line).get("access_apps")
       for app in apps if isinstance(apps, list) else []:
           if app.get("name") == "watch" and app.get("domain") == "watch.ziyixi.science":
               print("id", app["id"], "aud", app["aud"])'
   ```

   (Or open the application in the Zero Trust dashboard and copy its "Application Audience (AUD) Tag", changing
   nothing.) Exactly one line must print; the AUD is 64 hex digits.
5. **The app's first-deploy commit**: the AUD as the config's `ACCESS_AUDIENCE`, the Custom Domain in its `routes`,
   the Worker moved to `PRODUCTION` in `test_wrangler_configs.py` (and so into `infra_state.py`'s
   `WRANGLER_CONFIGS`), its `AHEAD_OF_DEPLOY` entry removed, and the application id recorded in
   [`ids.tf`](ids.tf) `access_app_ids` (for a rebuild by import, which then needs an import block for it too:
   [Bootstrap](#bootstrap-once)). `test_infra_config.py` requires that id once `AHEAD_OF_DEPLOY` is empty, and refuses
   the all-zeros placeholder, as the app's own config test refuses the all-zeros AUD: both values come from step 4.
   From that commit on, "Infra drift" compares the committed AUD with `access_aud` every day.
6. **After that commit reaches `main`**: it changes `infra/`, so its push runs "Infra drift". That run is the first
   check that the committed AUD is the application's (the deploy's Access probes cannot tell: Access answers before
   the Worker runs, so a wrong AUD only shows as a 403 for the owner). It must be green: `no-op: 19`,
   `output changes: 0`, and no outputs problem. Red with `vars.ACCESS_AUDIENCE differs from access_aud` means the
   committed AUD is wrong: read it again (step 4), fix it and push; the app's deploy job then ships the fix.

Between steps 3 and 5 the application gates a host that no Worker serves yet, which is harmless.

## Removing the import blocks

Done in the commit after the first green "Infra apply" (every object was then in the state and the plan
"No changes"), as planned in P4:

1. The `import {}` blocks were deleted. `imports.tf` became [`ids.tf`](ids.tf): the committed ids only, as the
   record of what each address adopted and for `test_infra_config.py`, which compares the D1 ids with the
   `wrangler.toml` files on every push.
2. The bootstrap and "rebuild by import" need the blocks again: restore them on a branch with
   `git show <that commit>~1:infra/imports.tf > infra/imports.tf` (and delete `ids.tf` there, whose locals it
   repeats).
3. A plan without import blocks never imports: the drift run stays `no-op: 18`, `output changes: 0`. Had this
   commit reached `main` before the apply, the plan would have shown `create: 5`; the new AUDs and D1 ids are
   unknown before an apply, so the outputs check fails it (exit 5, checked locally on 2026-10-01) and "Infra
   apply" refuses it.
4. Passphrase rotation uses the **second way** below (re-encrypt in place).

To adopt a new object later, add its `import {}` block again (a new `imports.tf`), apply, and remove the
block in the next commit the same way.

## Rotating the passphrase

Rotate when the passphrase may have leaked or when the person holding the offline copy changes. Both
ways end with the new value in the secret and in the password manager.

**After a suspected leak, the old state backups must go too.** Every key under `backups/production/` was written
by an apply with the old passphrase and holds what the state holds (the policies' include emails, the account
id): anyone with R2 read on `infra-state` and the leaked passphrase can read them. Once the new state is verified
("No changes" with the new passphrase alone), list them with `infra_state.py list-backups` and delete each by its
exact key ([Apply](#apply-p4), Rollback). The next apply writes a fresh backup with the new passphrase. (To keep
one for a rollback instead, restore it over the state and rotate again: the rotation re-encrypts whatever the
state object holds. That is rarely worth it.) For a routine rotation without a leak, keeping them only means
keeping the old passphrase as long as they exist. `rotate-passphrase` ends by printing how many backups exist.

**First way, only with the `import {}` blocks restored ([Removing the import blocks](#removing-the-import-blocks)):
rebuild by import.** The state holds nothing that cannot be read again.

1. `openssl rand -base64 32 > ~/.config/todofy-infra/state-passphrase.new` (chmod 600).
2. Delete the state object: `python3 mail-hero/deploy/cloudflare-admin.py wrangler r2 object delete
   infra-state/production/terraform.tfstate --remote`. (The bootstrap writes only a missing state object.)
3. Run the bootstrap with `--passphrase-file ~/.config/todofy-infra/state-passphrase.new`. It imports the
   19 objects again (the watch application through the block added from `ids.tf`, [Bootstrap](#bootstrap-once)) into
   a new encrypted state and ends with "No changes".
4. `gh secret set INFRA_STATE_PASSPHRASE --env production -R ziyixi/todofy < ~/.config/todofy-infra/state-passphrase.new`,
   update the password manager, dispatch "Infra drift".
5. After a suspected leak: delete the old backups (above).

**Second way (the normal one since the import blocks were removed): re-encrypt in place.** OpenTofu
decrypts with a key provider found by the name the state was written with, so the committed provider gets a
new name. The apply's state backups stay encrypted with the old passphrase (see above: after a leak, delete them).

1. On a branch, rename the key provider in [`versions.tf`](versions.tf): `key_provider "pbkdf2" "state"`
   becomes `"state_2"` (next time `"state_3"`), and `keys = key_provider.pbkdf2.state_2`. The method
   stays `aes_gcm "state"`.
2. From that branch:
   `INFRA_STATE_PASSPHRASE="$(cat <new file>)" python3 infra/scripts/infra_state.py rotate-passphrase --var-file <values> --old-passphrase-file <old file>`.
   It reads the old provider's name from the state object's metadata, gives tofu the old key **only as a
   decrypt fallback** through `TF_ENCRYPTION` for one `tofu apply -refresh-only` (which rewrites the state
   with the new key and only reads Cloudflare), checks that the object now names the new provider, and
   plans with the new passphrase alone ("No changes").
3. `gh secret set INFRA_STATE_PASSPHRASE ...` with the new value, merge the branch, dispatch "Infra drift".
   Between steps 2 and 3 a scheduled run fails to decrypt; that is expected and harmless.
4. After a suspected leak: delete the old backups (above).

## Replacing the token

Today every Cloudflare call here uses the existing deploy token: `CF_API_TOKEN` in CI and the admin
helper's token file locally (the same token). It can edit Workers, D1 and R2, which is more than a plan
needs. When the owner creates dedicated tokens ([Next steps](#next-steps)):

1. Create `CF_INFRA_READ_TOKEN` (Access: Apps and Policies Read, D1 Read, Workers R2 Storage Read; a
   plan only reads the state, so the S3 credentials derived from it need no write) and, for P4,
   `CF_INFRA_TOKEN` (the same with Edit, which the apply and any later bootstrap need; the apply's S3
   credentials write the state and its backups, so R2 Edit).
2. `gh secret set CF_INFRA_READ_TOKEN --env production -R ziyixi/todofy` (paste at the prompt).
3. In `infra.yml`, change `secrets.CF_API_TOKEN` to `secrets.CF_INFRA_READ_TOKEN`, in `infra-apply.yml` to
   `secrets.CF_INFRA_TOKEN`, and the expected secret names in
   [`test_infra_workflow.py`](../.github/scripts/test_infra_workflow.py). Nothing else
   changes: the S3 credentials are derived from whichever token the step gets, so there is no second
   secret to rotate. If derivation does not work for the new token, use the credentials fallback in
   [Remote state](#remote-state).
4. Dispatch "Infra drift" and check that it is green. The state does not depend on the token (it is
   encrypted with the passphrase), so no re-import is needed.
5. The deploy token `CF_API_TOKEN` then no longer needs to be readable by anything infra-related.

## Import notes

Each object was adopted with an `import {}` block in `imports.tf` (removed after the first P4 apply; the ids are in [`ids.tf`](ids.tf)), written by hand from
the read-only API inventory (13 at the bootstrap, FlowDay's and the links app's 5 in P4). With 18 objects,
cf-terraforming was not needed. Once an apply has recorded the objects in the remote state, these blocks
do nothing; they are removed after the first P4 apply ([Removing the import blocks](#removing-the-import-blocks)).

| Resource | Import id | Notes |
| --- | --- | --- |
| reusable policies | `<account>/<policy id>` | Rules come from the variables. Zero diff on import |
| owner apps (4) | `accounts/<account>/<app id>` | In 5.25.0, `self_hosted_domains` is deprecated and cannot be set together with `destinations`, so the hostname is declared through `domain` + `destinations`. The policies are attached by id with precedence 1 and 2 |
| `mail_hero_backup` | `accounts/<account>/<app id>` | Its only policy is application-scoped (`reusable = false`, decision `non_identity`, includes a service token). The provider reads application-scoped policies back as `{id, precedence}` only. Declaring the policy inline produced a diff, so it is declared by id. Whether the API accepts an application PUT that references an application-scoped policy by id **cannot be checked read-only** (there is no dry run; checked 2026-10-01: the policy is still application-scoped). So the object is **`FROZEN`** in `infra_state.py` (by address, previous address and id `dafc6e08-…`): an apply refuses any planned write to it (an import, which only reads, passes), the guard rejects a `moved` block naming it, and the P4 plans show it `no-op`. Changing it means first converting that policy into a reusable one, in a separate change the owner has confirmed, then removing it from `FROZEN` |
| links app | `accounts/<account>/<app id>` | In `owner_apps` with a second destination (`more`) and session 168h. Zero diff on import |
| FlowDay apps (2) | `accounts/<account>/<app id>` | `allowed_idps` unset (every provider), `http_only_cookie_attribute = false`, one reusable policy each by id at precedence 1. Zero diff on import |
| D1 (5) | `<account>/<database id>` | `read_replication = { mode = "disabled" }` is declared, because omitting it plans an update. `file_size`, `num_tables` and `version` are computed |
| R2 (3) | `<account>/<bucket>/default` | Default jurisdiction. Location and storage class are computed. No lifecycle (see [Storage](#storage)) |

Also kept in mind for P4 (provider issue #7284): never delete a policy and re-attach it to an
application in the same apply.

### Drift signal

The summary has two sections, and they mean different things:

- **Planned actions** (anything other than `no-op`) are drift between the configuration and Cloudflare.
  This is the signal to act on.
- **"Changed outside OpenTofu"** lists objects whose refreshed attributes differ from the stored state.
  These include computed values that change by themselves, such as a D1 database's `file_size`.
  `ignore_changes` cannot suppress them, because it covers only arguments in the configuration. The
  drift plan never writes the state, so they keep appearing (and growing in number) until an apply (P4)
  writes the refreshed values; they stay informational.

A drift check (P3) therefore fails on planned actions, and reports "changed outside" addresses only
for information.

### `ignore_changes`

**None.** With provider 5.25.0, the plan is zero-diff without any `ignore_changes`. If a later provider
version brings a permanent diff, add the narrowest `ignore_changes` you can and list it here together
with its reason and the provider issue.

## Verification record

### Prototype with local state (2026-10-01)

Done on 2026-10-01 with OpenTofu 1.12.6 and provider 5.25.0. Local state was kept outside the
repository, the read-only token was used through the environment, and the personal values came from a
`0600` file outside the repository.

1. `tofu validate`: valid.
2. Plan with the `import {}` blocks and an empty state: 13 to import, 0 to add, 0 to change, 0 to
   destroy.
3. State-only `tofu import` of the 13 addresses into the local state outside the repository, then a
   plan: **"No changes"**, exit code 0. The summary showed `no-op: 13`, 0 changed outside OpenTofu and
   0 output changes. A re-plan about 20 minutes later was still "No changes". Its summary listed 2
   addresses as "changed outside OpenTofu": `cloudflare_d1_database.app["mail-hero"]` and `["todofy"]`.
   Only their computed `file_size` had changed, because the databases grow. See
   [Drift signal](#drift-signal).
4. A summary of that real plan with `--all` contained none of the values from the local values file.
5. By hand, the live AUDs of Mail Hero, Todofy, Home and Lab were checked against the committed
   `ACCESS_AUDIENCE` values: all four match.
6. After the guard and summary hardening (structural guard, file allowlist, for_each key
   placeholders), the plan was run again against the same local state: "No changes" (exit 0), summary
   `no-op: 13`, `--fail-on-destroy` exit 0. Two addresses were "changed outside OpenTofu"
   (`cloudflare_d1_database.app["mail-hero"]` and `["todofy"]`, `file_size` only). The `--all` summary
   contained none of the values from the local values file.
7. After the rebase onto the `main` that added `tools/cf-guard`, the green-SHA reuse and Mail Hero's
   deploy secrets, the plan was run again against the same local state: "No changes" (exit 0),
   summary `no-op: 13`, `--fail-on-destroy` exit 0, the same two `file_size`-only addresses "changed
   outside OpenTofu", and none of the values from the local values file in the `--all` summary.

No `tofu apply` was run, and nothing was written to Cloudflare or GitHub.

### P3: remote state, encryption and the drift driver (2026-10-01, before the bootstrap on R2)

Done with OpenTofu 1.12.6, provider 5.25.0, the existing deploy token (read through the admin helper,
never printed) and the same `0600` values file. R2 itself was only read; the bucket `infra-state` does not
exist yet, so the backend ran against a local S3 stand-in (an in-memory HTTP server for one bucket). The
Cloudflare side was real throughout, and the import apply wrote only to the stand-in.

1. Credential derivation, read-only on R2: the verify endpoint returned the token's id, the derived pair
   was accepted, `infra-state` was reported missing, and a wrong secret was refused.
2. `bootstrap_state.py` against the stand-in: import plan `import: 13` and nothing else, apply, the state
   object encrypted (`meta` + `encrypted_data`, none of the values file's values or the account id in
   it), final plan "No changes" (`no-op: 13`). The conditional-write probe passed **on the stand-in
   only**; R2 is still unproven. A second run skipped the apply and passed. The plan file on disk was
   encrypted (not a plaintext plan archive); the work directory held no token, derived secret or
   passphrase.
3. Refusal: with one identity provider id removed from the values, the import plan was
   `import+update: 4`; the bootstrap exited 4 before any apply and nothing was written to the stand-in.
4. `infra_state.py plan` (the CI driver) against that state: exit 0 and the summary only; with the
   altered values, exit 2 and the four `update` addresses only; with a wrong passphrase, exit 1 and the
   single sanitised headline `Error: Error refreshing state`.
5. `infra_state.py rotate-passphrase` after a temporary rename (reverted) of the key provider to `state_2` in
   `versions.tf`: the state object then named only `key_provider.pbkdf2.state_2`, the plan with the new
   passphrase alone was "No changes", and the old passphrase no longer decrypted it.

Still to do on R2 (the bootstrap, [Next steps](#next-steps)): bucket creation, the conditional-write probe,
the import apply and the first green "Infra drift" run.

### P4: adoption of FlowDay and links, outputs, apply (2026-10-01, before the first apply)

Done with OpenTofu 1.12.6, provider 5.25.0, the existing deploy token (through the admin helper's token
file, never printed), the passphrase file and the `0600` values file, against the **real remote state in R2**,
plan only. Nothing was applied and nothing was written to Cloudflare, R2 or GitHub.

1. Read-only inventory of the five new objects (D1 `flowday`, `links`; Access apps `flowday`,
   `flowday-bypass`, `links`): the attributes declared here, and that FlowDay's two policies are reusable
   and attached to one application each. No identity value was copied.
2. `infra_state.py plan` with this change: `import: 5`, `no-op: 13`, `output changes: 3`, nothing else.
   Every import is zero-diff (no `import+update`); the backup app is `no-op`. The planned outputs equal every
   production `wrangler.toml` (`ACCESS_AUDIENCE` of mail-hero, todofy, home, lab, flowday, links; all
   `database_id`s; all bucket names).
3. A throwaway plan without the staging host in `local.flowday_apps` (reverted, never committed): the two
   FlowDay apps became `import+update` in place, no `replace`.
4. After the review fixes (fingerprint, apply context, `FROZEN` by identity, bootstrap on an existing state), the
   same plan again: `import: 5`, `no-op: 13`, `output changes: 3`, nothing else, and the expect line
   `import=5,outputs=3@fe0e0ae1a4d6`.

## CI: "Infra checks"

The job runs when `infra/`, `tools/infra-plan-summary/` or `.github/` changes
([`ci_changes.py`](../.github/scripts/ci_changes.py) output `infra`; another `tools/` directory does not
run it), and `CI gate` requires it. A push to `main` may reuse a green branch run of the same commit only
if that run's `Infra checks` succeeded (`CHECK_JOBS`), as for every other check job. It uses no
Cloudflare token, no state and no plan. Steps:

- **Guards.** Fail on:
  - `external` or `http` data sources, which can run code or send data out (quoted or bare labels);
  - provisioners;
  - a lock file holding any provider other than Cloudflare;
  - any email address in `infra/` (only file names are printed);
  - any tracked file outside the allowed kinds (an allowlist, so a plan named `tfplan` or `plan.out`
    fails too);
  - anything [`infra_guard.py`](../.github/scripts/infra_guard.py) reports (see [Scope](#scope)). The
    greps are a quick first line; the guard reads the structure and is the authority.
- `tofu fmt -check -recursive`.
- `tofu init -backend=false -lockfile=readonly` and `tofu validate`. Init only downloads the provider,
  checked against the committed hashes.
- The plan-summary tests, including the sentinel test that proves personal values never reach the
  summary, the `local_tfvars.py` tests, and the state-driver tests
  ([`tests/test_infra_state.py`](tests/test_infra_state.py)): a fake `tofu` on `PATH` prints sentinel
  values and serves plan fixtures, and the tests prove that only counts and addresses reach the output,
  that the passphrase is required before anything runs (no unencrypted fallback), that the bootstrap
  refuses every plan but an import-only one before any apply, that the derived credentials and every value
  inside `INFRA_TFVARS` are masked on a runner and never printed, that `TF_ENCRYPTION`, `TF_LOG*` and the
  other overrides never reach tofu, that the rotation uses the old key only as a decrypt fallback, and
  that a `--work-dir` parent (its files and mode) survives every run, refused or not; and the apply (`ApplyGates`,
  `ApplyCommand`): the refusal outside "Infra apply" on `main` before anything runs, the encrypted backup before
  tofu starts, every gate refusing before any apply (the fingerprint, `FROZEN` by previous address and id), a
  confirmation lifting only the destructive gate, exactly the saved plan applied, the verify plan, and the
  outputs check naming fields only; the bootstrap refusing to write an existing state; and `list-backups`
  printing backup keys only.

The drift plan itself is a separate workflow ([Drift plan](#drift-plan-ci)); `Infra checks` still uses no
token and no state.

The checks against the apps' configs ([`test_infra_config.py`](../.github/scripts/test_infra_config.py))
run in `Changes` on every push, so a `wrangler.toml` change that no longer matches `infra/` fails at
once.

## Next steps

### P3 bootstrap (done: the remote state exists and "Infra drift" plans against it)

Owner decision 2026-10-01: use the existing token now and do not wait for dedicated tokens. The steps as run
(kept for a rebuild):

1. Run the [Bootstrap](#bootstrap-once) from a clean checkout of the branch. It must end with "done";
   write down the conditional-write probe result.
2. Set `INFRA_STATE_PASSPHRASE` and `INFRA_TFVARS` in the `production` environment (the commands at the
   end of the bootstrap block). Put the passphrase in the owner's password manager.
3. Merge. The push to `main` starts "Infra drift"; it must be green with `no-op: 13`.
4. If the probe said "honoured" on R2, a later change may enable `use_lockfile` (and a test that runs two
   writers). Until then the concurrency group is the lock.

### Owner, later (about 10 minutes)

The original P3/P4 storage and owner-Access scope needs these dedicated permissions:

- **`CF_INFRA_READ_TOKEN`**: Account → Access: Apps and Policies → Read; Account → D1 → Read; Account →
  Workers R2 Storage → Read.
- **`CF_INFRA_TOKEN`** (for P4): the same with Edit.

The added platform resources also need Access service-token and Cloudflare Tunnel permissions, plus
DNS access restricted to the configured zone. Use Read for planning and Edit for applying. Preserve
existing Worker permissions when extending an existing token; Email Routing permissions are not needed
for this change. The original import instructions and 19-object counts below describe the pre-platform
baseline; the platform follow-up creates nine new objects and expects 28 no-op objects after apply.

Store each from your own terminal (paste at the prompt, never in chat):
`gh secret set CF_INFRA_READ_TOKEN --env production -R ziyixi/todofy`, likewise `CF_INFRA_TOKEN`. Then
follow [Replacing the token](#replacing-the-token).

### P3, still open

- Seven consecutive green daily drift runs (the IaC plan's acceptance).
- A plan on branch pushes (it would need a branch-readable environment and a read-only token; not before
  `CF_INFRA_READ_TOKEN` exists, because the deploy token must stay on `main`).

### P4 (apply)

Done in code: [Apply](#apply-p4), [Outputs](#outputs), FlowDay and the links app adopted. In order, after
the merge:

1. The push's "Infra drift" run is **red by design**. Check it against exactly this:
   - `import: 5, create: 0, update: 0, replace: 0, delete: 0, forget: 0, read: 0, no-op: 13`;
   - the five rows, all plain `import`: `cloudflare_d1_database.app["flowday"]`, `cloudflare_d1_database.app["links"]`,
     `cloudflare_zero_trust_access_application.flowday["flowday"]`,
     `cloudflare_zero_trust_access_application.flowday["flowday-bypass"]`,
     `cloudflare_zero_trust_access_application.owner["links"]`;
   - `output changes: 3` (`access_aud`, `d1_database_ids`, `r2_bucket_names`, all `create`);
   - the last line `"Infra apply" expect for this plan: import=5,outputs=3@fe0e0ae1a4d6` (the fingerprint of the
     local plan of this commit against the real state, 2026-10-01).

   **If anything differs** (an `import+update`, an `update`, another count or fingerprint), **stop**: something
   changed one of these objects in the dashboard, or `main` moved. Find out why first; never copy a differing
   line into the dispatch.
2. Dispatch "Infra apply" on `main` with `expect` = `import=5,outputs=3@fe0e0ae1a4d6` (literally). It must end
   with "apply: done" and a verify plan of `no-op: 18`, `output changes: 0`.
3. Dispatch "Infra drift": green, `no-op: 18`.
4. The follow-up commit [Removing the import blocks](#removing-the-import-blocks) (done).
5. FlowDay, in this order: the commit that clears F4's cf-guard allowances (`flowday/docs/design.md` F4), then the
   staging-host removal through this directory ([FlowDay](#flowday)): its drift run shows `update: 2` (the two
   FlowDay applications only), dispatch with `update=2@<that run's fingerprint>`.

Historical follow-ups recorded at that point:

- After F4: remove the staging host from FlowDay's apps through OpenTofu ([FlowDay](#flowday), step 5 above);
  needs `CF_INFRA_TOKEN` or a deploy token with Access Edit.
- FlowDay policy ownership is now implemented while retaining the exact existing policies; moving it onto shared policies remains a separate owner decision.
- The owner decides whether to rename the shared policies (this affects the self-hosted apps) and
  whether the backup app's application-scoped policy becomes reusable (then drop it from `FROZEN`).
- A `push` trigger for "Infra apply", after several clean manual applies.
