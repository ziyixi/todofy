# Rebuild the personal cloud

Most application source and the stable proto contracts can be reused on a fresh VPS and Cloudflare account.
The current code still has account-specific workers.dev references in Watch and the relay acceptance check,
and a first-account creation/adoption gap. A strictly configuration-only complete rebuild is therefore not
yet supported. The [dated code audit](rebuild-audit.md) records those gaps and the smallest proposed fixes.
Public profiles and private credentials change; deploying code does not move provider objects or historical
data. The identity generator is neither a fresh-account provisioner nor a proven complete disaster recovery.

## Configuration entry points

| Input | What changes for a new machine/account | Where it belongs |
| --- | --- | --- |
| `config/cloud.toml` | Access issuer; public Fleet/daemon hostnames; namespace/state directory/node alias, including generated Fleet `HOST_KEY` | Committed public configuration |
| `config/resources.toml` | New account/zone IDs, Access AUDs, D1 IDs, DO namespaces; recorded Access/policy IDs | Committed provider identities; no credentials |
| Application `wrangler.toml` | Materialized identity fields and generated `infra/platform-identity.tf` public DNS locals; existing bindings, routes, schema and Free budgets remain | Generated into the existing sole production config |
| k3s manifests/bootstrap configuration | Immutable image digests, one node namespace, mounts, allowed workload/service accounts | Committed infrastructure configuration |
| GitHub `production` secrets/variables | Deployment tokens, owner identity, operational switches, dedicated machine API credentials | GitHub's secret/variable UI or CLI through a private input file |
| k3s application secrets and mounted auth | Newsletter integration tokens, dedicated Codex login, backup machine identity | Private node state/secret storage; never Git or image |
| Recovery material | Encryption keys, verified data snapshots, deletion journal and side-effect reconciliation | Independent private storage |

The currently verified VPS case keeps the same owner, repository, domain, Worker names and logical
database names. It does not itself solve a new Cloudflare account's workers.dev identity or provisioning.
For a different domain or repository, routes, image publication settings, website canonical origin and
relay dispatch settings require additional configuration changes; Watch self-domain policy and Todofy's
Watch link authorization currently also require implementation work. The profile generator does not
silently rename them. API `ErrorInfo.domain`, proto resource types and locked external protobuf provenance
are stable contract/supply-chain identities; do not globally replace strings in the source to move hosts.

After preparing public identity configuration, run from a temporary clean checkout with Python 3.12:

```sh
python3.12 tools/cloud-config/generate.py
python3.12 tools/cloud-config/generate.py --check
python3.12 tools/service-catalog/catalog.py
python3.12 tools/service-catalog/catalog.py --check
python3.12 .github/scripts/drift_desired.py
python3.12 .github/scripts/drift_desired.py --check
```

Review the diff: identity generation must not alter safety switches, budgets, migrations, binding names,
workers.dev/preview rules or existing endpoint contracts. No second Wrangler production config or `[env.*]`
is introduced. The usual branch CI gate and exact tested-SHA main deployment remain mandatory.

## First-time Cloudflare account preparation

These prerequisites need owner/account access; application code cannot authorize itself:

1. Activate the same domain zone in the new account and arrange registrar nameservers deliberately.
   Preserve the root mailbox's MX/TXT/DKIM/DMARC and third-party records. DNSSEC/DS and mail routing need a
   separate checked cutover; deploying a Worker does not migrate them.
2. Keep Workers Free. Activate the R2 subscription checkout, including its free monthly usage; R2
   overages are billed and this is not a hard spending cap. [R2 setup](https://developers.cloudflare.com/r2/get-started/).
3. Initialize the Zero Trust team domain. Configure owner login and GitHub OAuth with the **new** team's
   callback URI/client secret and normal consent. [GitHub identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/).
4. Create narrowly scoped deployment/infra tokens, owner policies and apps, the five named D1 databases,
   the three application buckets and the separate encrypted infra-state bucket. Store credentials through
   normal secret storage. Read-only inventory must verify the new account before any migration or deploy.
5. Create the dedicated Mail Hero backup service identity/policy independently. The dedicated daemon Tunnel, its exact DNS
   entry, Access machine application/service identity and Fleet owner/receipt applications are
   managed by `infra/`. Identity providers, Mail Hero backup service identity/policy and Email Routing still
   need their separate bootstrap. A new account receives new IDs and secrets; old IDs are not transferable.
6. Set up only the dedicated Mail Hero receive subdomain and exact Email Routing rule after the target
   Worker is deployed and checked. Do not replace the root domain's mailbox records. Original mailbox
   forwarding rules live at their providers and require their own verification.

### Prepare account identities before the first production release

For a fresh account, create the required Access/storage resources in the separate reviewed bootstrap and
adoption stage before the first main production release. Prepare the real IDs/AUDs and public profiles on
a branch, regenerate the existing production configurations and pass their checks. The existing account's
identities cannot be carried into another account. Rebuilding existing services does not require editing
the CI classifier. `CHECK_ONLY` and its regressions protect development of a new application before its
resources exist; they are not the migration configuration mechanism. Fleet's sole `wrangler.toml` must
use the new actual AUD, never a synthetic one. Its deploy wrapper permits a credential-free dry run and
refuses a real deployment without the actual AUD.

Complete the separately reviewed creation/adoption stage first; the repository does not yet supply its
complete fresh-account workflow. Do not dispatch the normal `Infra apply` as an empty-account creator.
Read only the new owner app's public AUD/app ID
and the exact receipt app/policy IDs into the supported public inventory fields. Tunnel and service-token
identities remain in protected infrastructure state and the private bootstrap handoff; the inventory does
not declare those fields. Export the platform machine credentials through the private bootstrap channel,
then populate only the corresponding GitHub production secrets; the sealed bootstrap artifact has one-day retention and is not
an application backup. Bootstrap the node and verify its dedicated namespace permissions and TLS trust.

Before that reviewed `Infra apply`, prepare an owner-held RSA key and PEM X.509 certificate with OpenSSL 3
in a private local directory outside Git and cloud sync. Set the **production environment variable**
`VPS_BOOTSTRAP_CERT` to the certificate, not a raw public key; the private key never goes to GitHub.
Without that variable the optional export is skipped. Replace the repository and reviewed apply run ID below:

This CMS example applies only after adoption is complete and the new account's encrypted state actually
contains the creation-time Access client secret. If import did not retain it, use the independent private
handoff instead; do not recreate a working identity just to obtain an export. The normal `Infra apply`
here is the post-adoption gated operation, not an empty-account creator.

```sh
umask 077
bootstrap_repo="OWNER/REPOSITORY"
bootstrap_dir="$(mktemp -d)"
openssl req -x509 -newkey rsa:3072 -sha256 -noenc -days 2 \
  -subj '/CN=Personal cloud bootstrap recipient' \
  -keyout "$bootstrap_dir/recipient-key.pem" -out "$bootstrap_dir/recipient-cert.pem"
gh variable set VPS_BOOTSTRAP_CERT --env production --repo "$bootstrap_repo" \
  < "$bootstrap_dir/recipient-cert.pem"
# Dispatch and verify the separately reviewed Infra apply before downloading its artifact.
bootstrap_run_id="REVIEWED_APPLY_RUN_ID"
gh run download "$bootstrap_run_id" --repo "$bootstrap_repo" \
  --name "platform-bootstrap-$bootstrap_run_id" --dir "$bootstrap_dir/artifact"
openssl cms -decrypt -binary -inform DER -in "$bootstrap_dir/artifact/platform-bootstrap.cms" \
  -recip "$bootstrap_dir/recipient-cert.pem" -inkey "$bootstrap_dir/recipient-key.pem" \
  -out "$bootstrap_dir/platform-bootstrap.json"
```

The existing [CMS export](../infra/scripts/platform_export.py) encrypts only the Access client ID/secret,
Tunnel ID and connector token. Keep the decrypted JSON and key local with mode 600; transfer credentials
through private file/stdin input into their matching stores, without printing them. The independent
`PLATFORM_DEPLOY_TOKEN` is prepared separately. Once the handoff is securely saved, remove the temporary
`VPS_BOOTSTRAP_CERT` variable; retain private recovery material according to the owner's backup policy.
See [OpenSSL CMS](https://docs.openssl.org/3.6/man1/openssl-cms/) for the recipient/decryption format.

Pre-created service identities need special care: Access displays the client secret only at creation.
Importing the resource cannot be assumed to recover that secret for the CMS export. Preserve it in the
creation-time encrypted state/sealed handoff or independently populate its corresponding private stores.
See [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

In the prepared configuration commit, add the actual Fleet AUD to both its production Wrangler field and
the public inventory, and record the owner app ID in `infra/ids.tf`. The identity generator replaces existing
AUD fields; it does not insert a missing one or update the infrastructure import-ID map. Fleet deploys
before Home. Record the provider-issued Fleet DO namespace in `config/resources.toml`, regenerate
Home's resource identities and verify fresh signed observations. Keep `VPS_DEPLOY_ENABLED=false` until
the daemon, dedicated Access credentials and independent deployment Bearer have been verified; enabling that
variable activates subsequent main-branch releases. Do not confuse a skipped bootstrap job with a healthy
server or a successful application rollout.

### Existing OpenTofu protection is intentional

`infra/scripts/bootstrap_state.py` is an **import-only** state bootstrap, not the object creator in step 4.
It refuses creates/updates/deletes and will not repair an already populated state. The regular `Infra apply`
also rejects config/output mismatches: a production Wrangler naming an old AUD/D1 ID cannot be matched
to an unknown new resource before creation. The Mail Hero backup Access app is frozen because its existing
application-scoped policy cannot be rewritten safely by the pinned provider.

For a fresh account, object creation needs a separately reviewed bootstrap configuration/API procedure,
or pre-created objects followed by explicit adoption. No such generic creation workflow is supplied by this
change. Do not strip `prevent_destroy`, remove `FROZEN`, bypass output validation or run a plain unmanaged
production `tofu apply` to make the first plan green.

When adopting pre-created equivalents:

- Pre-create the infra-state bucket in the new account and supply its new private token file. The current
  bootstrap's missing-bucket creation path invokes a legacy helper fixed to the old account; changing only
  the profile/tfvars does not redirect that helper. Do not run that creation path for a new account.
- Record their new IDs/AUDs in `config/resources.toml` and generate the production identities.
- Update only reviewed infrastructure identity references (`infra/ids.tf`, backup/FlowDay policy references
  in `infra/access.tf`, and the new adopted backup application's ID in `infra/scripts/infra_state.py`
  `FROZEN_OBJECTS`). Keep the protected Terraform address and frozen semantics unchanged.
  The read-only `infra/scripts/local_tfvars.py` helper reads its policy/app IDs
  from `config/resources.toml` and refuses an account mismatch before any GET. Those inventory
  references are not rewritten by `tools/cloud-config`; changing profiles alone does not migrate infra state.
- Restore/update `import {}` blocks from the documented history, including later-added applications,
  with new account/object IDs. A historical file is not a current complete import inventory.
- Supply new sensitive identity rules as `INFRA_TFVARS`; keep them out of public configuration. The
  local values helper can read equivalent pre-created policies after the public IDs are updated. Prepare
  an explicit private values file when those policies do not exist yet.
- Use the already-created new-account state bucket; supply a new independently saved state
  encryption passphrase. Import-only plan counts/fingerprint must match the reviewed inventory. Check
  that its final plan is no-op and outputs match production configs before resuming normal gated apply.

Never transplant the old account's encrypted Terraform state as if it described new resources. Keep it as
recovery evidence only. Wrangler's automatic missing-resource provisioning is deliberately not a shortcut:
it would change the existing ownership boundary (OpenTofu owns storage existence; Wrangler owns bindings)
and hide unexpected resource creation. [Cloudflare provisioning behavior](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/).

## Fresh VPS and subsequent code-driven deployment

The first bootstrap installs the pinned single-node k3s service, containerd, independent daemon image and
Cloudflare deployment connector through an existing trusted administrative channel or provider cloud-init.
It needs host privileges once; GitHub cannot start a machine without an authorized management entry point.
Workloads use standard Kubernetes manifests and Kustomize. The daemon resolves those reviewed manifests
from its own release artifact and bounded configuration; an API request cannot supply commands, YAML,
paths, URLs, namespaces, private object names or registry repositories. Preserve existing SSH connectivity
and its `cloudflared` service/configuration. Use a separately named daemon connector service and one exact
`platform_runtime_host`; never repurpose an existing tunnel or expose the raw Kubernetes API.

After bootstrap, deployment is **pushed by GitHub Actions**, not polled from Git by the node:

`green tested commit → production Actions → Cloudflare Access HTTPS → authenticated daemon release API → persisted drain/freeze/apply/verify/resume`.

Actions holds only the dedicated Access client ID/secret and independent daemon deployment Bearer.
It has no Kubernetes token, cluster certificate/private key, SSH key or cluster-admin kubeconfig.
The daemon authenticates before reading request bodies. Only the daemon has the necessary local,
namespace-scoped Kubernetes capabilities; neither it nor the observer needs a GitHub PAT or a GitHub
Actions runner on the production node. The profile hostname does not prove Tunnel/DNS/Access deployment.
Supply the connector and application credentials through private node state, not Git or images; populate
only the matching GitHub production secrets via safe file/stdin input after bootstrap.
An optional namespace reader kubeconfig permits routine metadata diagnosis on the VPS without sudo;
it grants no Secret/log/exec or mutation access and never reaches Actions. Its setup and the bounded
initial SDK-client recovery are documented in [bootstrap](../tools/vps-bootstrap/README.md).

The shared release contract bounds requests to sixteen configured workload aliases. This implementation
requires both configured Newsletter and personal-cloud workloads with the same source SHA and immutable
digests, using stable UUID4 release/request IDs. The daemon persists an asynchronous operation before acknowledging it.
Network retries keep exactly the same IDs and frozen targets. A mismatched body for an existing ID is a
conflict; a held/failed operation needs an explicit resume with its current etag. A main dispatch for
`platform` or `newsletter` must supply the original `resume_source_sha` and set `resume_vps_release=true`;
it reads the existing frozen targets without rebuilding or publishing replacement images. A process restart must not
silently re-admit work or create a different release. Keep `VPS_DEPLOY_ENABLED=false` until the dedicated
transport/authentication, safe drain behavior and actual image provenance have been checked.
After verifying bootstrap/authentication and the held runtime, keep main unchanged and enable that
variable for the controlled first same-SHA Actions release; explicit resume also requires it. Normal
release resumes Newsletter admission and its daily trigger before reaching ready, so provider setup and
the restored unknown-outcome policy must be decided beforehand. There is no separate paused-rollout
activation step. Disabling the GitHub variable does not cancel a persisted server operation.

The independently released `platform` OCI image supplies `personal-cloud`, the local release
controller, status daemon and bounded observer. It embeds generated `platform.runtime.v1`/`fleet.telemetry.v1`
types and codecs; it does not import Newsletter code or reuse its image. Kubernetes runs the daemon and
observer as container workloads: the observer is the five-minute `platform-observer` CronJob with
`concurrencyPolicy: Forbid`, a dedicated state PVC and a namespace-scoped read-only projected identity.
It uses the same platform image and does not run a host systemd timer. The OCI build installs the locked dependencies, including `httpx` and the
official Kubernetes SDK, and CI promotes the exact tested image by registry digest. The VPS installs no
application Python packages or standalone application executables. Python 3.12 is provided inside the
Linux amd64 image; other architectures need a matching image build and validation. Only source identity
and reviewed manifest templates are baked into the image; account, domain,
workload configuration and credentials remain mounted configuration. Read-only observations stay
bounded and preserve unknown/missing evidence. Fleet displays only an operation summary and independently
verified workload state; its UI does not proxy deployments. Application secrets should not be readable by
the daemon's Kubernetes service account unless a narrowly reviewed operation requires it.
The observer's same-image init container reads fixed systemd unit states through Jeepney and the reviewed
system-bus socket mount, using the supported host's existing UID65534 (`nobody`). D-Bus validates the host
identity; adding an account inside the image does not register that identity on the host. A read-only
socket mount does **not** make D-Bus methods read-only: the probe has no capabilities or privilege, and
the host must grant it no systemd management rights through polkit. It checks those rights without
interaction or mutation before reading states. A bounded, timestamped shared-proto snapshot passes
through an emptyDir to the main observer; stale or invalid snapshots remain unknown. Only the main
UID10001 observer receives the projected Kubernetes identity, application monitoring secrets and its
unchanged persistent state. Verify denial and read availability on the actual node. An
unreadable unit is unknown; if k3s cannot schedule the observer, Fleet shows a missing/stale receipt rather
than claiming an independent current host diagnosis. Memory reads use only the exact `/proc/meminfo`
file; disk observations concern the observer's own persistent filesystem, not arbitrary host mounts.
Initial bootstrap also loads the [pinned observer AppArmor profile](../platform/apparmor/README.md).
Only the credential-free init container references it; the main observer remains RuntimeDefault.
The profile retains the exact containerd baseline and adds fixed D-Bus sends. Method arguments are
not inspected by AppArmor, so application selection and the non-mutating Polkit guard remain part
of the boundary. An existing host must load the profile before the corresponding manifest is released.
See [runtime contract](../contracts/platform-runtime-v1/README.md) and the [platform deployment runbook](../platform/README.md) for
exact bootstrap versions, local permissions, secret names and release commands.

`vps.observer_node_key` supplies the daemon's `node_key`, observer `FLEET_HOST_KEY` and generated Fleet
`HOST_KEY`; they must match. Before starting a replacement VPS against retained Fleet state, either restore
the stopped observer's durable state directory (sequence and pending receipt), or deliberately choose a new
matching epoch in Fleet's `HOST_EPOCH` and the observer manifest's `FLEET_HOST_EPOCH`. Apply that reviewed
configuration on both sides before accepting new reports. A new VPS with an empty observer volume and the
old epoch restarts at sequence 1, which retained Fleet rejects as replay. A new Fleet namespace has no old
receipt and can use the initial epoch. Profile generation does not change epochs or reset durable state.

For Newsletter, explicitly select `NEWSLETTER_CONFIG_REPOSITORY=ziyixi/todofy` and the existing Todo API URL;
its historical defaults still point at the old standalone repository/domain. Pin the published image digest,
retain the same exclusive SQLite/auth/content-config mounts, begin/freeze the durable deployment drain,
and verify the new instance before resuming. An old engine that does not implement the drain API needs the
documented first-upgrade stop/wait procedure. See [Newsletter drain](../newsletter/docs/deployment-drain.md)
and [import boundaries](../newsletter/docs/import-source.md).

A fresh node needs a restored or normally authenticated dedicated Codex login directory. The code/image
does not contain subscription credentials. Notion integration grants, Todoist/Gemini/Resend credentials and
recipient configuration also require independent private setup. Avoid using a real model call, private
Notion write or mail send merely to prove that an infrastructure deployment works.

For the supported legacy migration, stop and verify the old runtime before copying its state. After that
copy, the one-time installer disables/stops `docker.socket` and `docker.service` **before** applying K3s
runtime resources. It preserves images, Compose configuration and source state; a failed bootstrap does
not automatically restart them. Keep that bounded rollback copy until replacement pods, persistent data,
scheduled processing, backups and status reporting are verified. Rollback requires an explicit reviewed
stop of the replacement writers and reconciliation before restoring legacy services; never run two
Newsletter workers or backup schedulers against the same state. A fresh VPS has no legacy runtime to retire.

## Secret inventory

GitHub production configuration is documented per app in [CI/CD](ci-cd.md),
[Home setup](../dashboard/docs/setup.md), [Todofy setup](../todofy/docs/cloudflare-setup.md),
[Mail Hero setup](../mail-hero/docs/cloudflare-setup.md), and each application's README. Read the actual
`deploy-vars` wrapper and workflow before restoring settings; an unset operational switch must continue
to fail closed. Never copy live secret values into this runbook or Actions logs.

Additional Worker secrets currently set outside the deploy wrappers include:

| Worker | Names; values remain private |
| --- | --- |
| Mail Hero | `CREDENTIAL_KEY`, `BACKUP_TOKEN`, `BACKUP_RECEIPT_KEY` |
| Todofy gateway | `CSRF_SIGNING_KEY`, `MAIL_WEBHOOK_TOKEN_SHA256`, `REPORT_BASIC_AUTH_SHA256` |
| Todofy core | `GEMINI_API_KEY`, `TODOIST_API_KEY` |
| Website relay | `GITHUB_DISPATCH_TOKEN`, `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID`, `NOTION_WEBHOOK_SECRET` |

Conditional inputs must follow the original deployment's enabled capabilities: Mail Hero's consumer
Access needs `ACCESS_CLIENT_ID`/`ACCESS_CLIENT_SECRET` plus matching `ACCESS_SERVICE_ORIGIN`; its alert
webhook needs `ALERT_WEBHOOK_TOKEN` when enabled. Todofy's existing mail-token rotation window may also
require `MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS`. Rebuilding does not itself enable these optional features.

The matching machine Basic/Bearer credentials, FlowDay sealing key, owner/aliases, Fleet report HMAC key
and independent daemon deployment Bearer must also be restored or deliberately rotated at all consumers.
Fleet publishes only three dedicated inputs: `FLEET_ACCESS_OWNER`, `FLEET_ACCESS_OWNER_ALIASES` and
`FLEET_REPORT_HMAC_KEY`. The gated infrastructure apply creates the platform Access service identity; its
sensitive bootstrap output is sealed to the owner-held X.509 certificate in `VPS_BOOTSTRAP_CERT` before upload; only ciphertext
may enter the one-day bootstrap artifact, never plaintext values or Actions logs. New random keys are appropriate
for a brand-new empty deployment; encrypted historical credentials require their original decryption key.

## Empty-cloud bring-up versus data recovery

| State | Recovery boundary |
| --- | --- |
| Mail Hero D1/R2/DO | Restore SQL and exact object bytes/metadata plus fresh deletion journal and original `CREDENTIAL_KEY`; rebuild capacity/jobs/control and reconcile unknown deliveries by the original event IDs |
| Todofy D1/DO | Verify backup manifest/parts/schema; retain paused Todoist processing until pending/unknown business effects are reconciled; a new DO has no old budgets/cursors |
| FlowDay, Links, Lab D1 | Restore application SQL/schema; FlowDay needs the original sealing key for historical stored tokens |
| Fleet DO SQLite | The current heartbeat/history is disposable observation state; a new namespace begins as never observed and must receive fresh signed reports |
| Platform observer | Retained Fleet with the same epoch requires the observer's durable sequence/pending-receipt directory; otherwise coordinate a new epoch on both sides before starting the fresh observer |
| Watch, Lab and Home DO SQLite | There is no unified account-to-account backup/restore here. A fresh namespace does not recover watches/intent ledger, Lab queue/vector/guard/budgets, Home settings/canary/history or alarms |
| Platform daemon | Before startup, inspect durable release SQLite, frozen targets/phase/checkpoint and matching namespace/PVC/Newsletter gate. Nonterminal operations automatically continue; held/failed need explicit etag Resume. There is no unified read-only restore/quarantine entrypoint |
| Newsletter | Restore exclusive SQLite, frozen run/config identities, original mode/delivery target and dedicated auth; interrupted/unknown external operations are not automatically retried as new operations |
| Website | Rebuild content from authorized Notion sources, following release identity/bootstrap/recovery checks; preserve publication/release evidence deliberately |
| Infra state | Import fresh-account identities into newly encrypted state; do not reuse old resource state as new |

Mail Hero's local restore output deliberately keeps `activation_allowed=false`; it does not import Cloudflare
or rebuild live DO alarms. See [backup recovery](../mail-hero/deploy/backup/README.md) and
[isolated recovery](../mail-hero/docs/cloudflare-setup.md#9-隔离恢复演练).
Existing `vultr-backup` is outside the monorepo application's backup boundary and is not evidence that all
listed state is independently recoverable.

Before activation, record separate evidence for schema/build checks, paused synthetic application tests,
deployed Access/TLS, k3s namespace permissions and rollout, observer freshness, backup read-back, and any
explicitly authorized real-mail/business test. Keep mail/processing paused while restored unknown side
effects remain unreconciled. A profile generation test or green release is not a full disaster-recovery drill.

## Supported VPS prerequisites

The first installation targets Ubuntu 24.04 on Linux amd64, standard systemd and its existing
UID65534 `nobody` account, curl,
iptables/ip6tables, enabled standard AppArmor with `/usr/sbin/apparmor_parser`,
`abi/3.0`, `tunables/global` and `abstractions/base`, and a supported k3s kernel. Reserve at least
2 CPU cores, 4 GiB RAM and 20 GiB free disk for the node and image updates; the existing
Newsletter workload may require more memory, depending on its content. Keep room for
both an old and a new image plus a preserved copy of the application state. The current
node has substantially more capacity; these figures are prerequisites, not a benchmark.

Bootstrap installs the official Linux amd64 `cloudflared` release fixed in
`platform/versions.json`, after checking its published SHA256, at
`/usr/local/libexec/personal-cloud/cloudflared`. A fresh machine does not need to preinstall
the global package. This dedicated binary supplies `--token-file` for the new connector unit;
an existing global binary is neither replaced nor upgraded. Existing SSH/cloudflared services stay
independent. Docker, Compose, application executables, host application Python packages and a new tailnet
are not prerequisites. k3s/containerd runs the published Linux amd64 images, which include the locked
application runtime and libraries. Other architectures require matching, tested images.

Bootstrap restricts the k3s control-plane/agent ports with a dedicated persistent firewall
chain, preserving other firewall rules and SSH. The only new public route is the daemon's
HTTPS hostname through Cloudflare Access and Tunnel; the connector also validates the
exact Access audience. The bounded observer uses its reviewed read-only node/namespace permissions;
unavailable node or host-daemon evidence remains unknown. Confirm public port exposure separately on a new provider rather than assuming
its network is identical to the existing private node.
