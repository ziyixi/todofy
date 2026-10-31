# Cloudflare infrastructure

`infra/` owns the account resources that application Wrangler configurations do not own.
Start a new environment or adopt an existing one with [the rebuild runbook](../docs/rebuild.md).
Current resource identities are in `config/resources.toml`; application membership and hostnames come from
[the service catalog](../docs/service-catalog.md).

## Scope

| Resource | Owner |
| --- | --- |
| Owner Access apps and the two shared owner policies | `access.tf` |
| Selected GitHub and email-PIN identity providers | `identity.tf` |
| Exact Mail Hero receiving-address rule | `mail-routing.tf`; enabled after its Worker exists |
| Dedicated runtime Tunnel, runtime/API CNAMEs and machine Access apps | `platform.tf` |
| D1 databases and private R2 buckets | `storage.tf`; existence and identities, not application data |
| Router request-body and backup expiry | `storage.tf`; seven days in each of the two Router buckets |
| Retired resource transitions | `retired.tf`, paired with the guard's explicit retirement list |

Wrangler owns Workers, their bindings, variables, secrets, schedules, domains and D1 schema migrations.
Each application owns its data and backup/retention logic. Other buckets do not inherit Router's expiry rules.
The receiving subdomain's Email Routing setup and root mailbox DNS remain outside this directory.
Unrelated Access apps, identity providers, tunnels, DNS and account settings are not adopted. Creation-time
collision checks read only the bounded inventories needed to refuse an existing name or hostname.

The Kubernetes hostname is a second destination of the existing runtime machine Access application. Its Tunnel
route carries TCP to the local API with that application's audience required; Kubernetes verifies the separate
short-lived Actions identity. Existing runtime application, Tunnel and DNS identities remain unchanged.
Introducing this hostname checks bounded DNS, Worker-domain and Access inventories before applying the saved plan.

The optional legacy Mail Hero backup Access app is frozen for existing accounts; new accounts omit it and use
Worker-native backups. Its historical machine policy and token are not managed here. Shared owner policies can
also serve applications outside the repository, so changing their identity rules needs explicit review.

Every managed resource has `prevent_destroy`. Replacing an Access app changes its AUD; replacing storage can lose
data and breaks bindings. Missing or changed persistent identities require recovery, not routine drift repair.
The structural [infra guard](../.github/scripts/infra_guard.py) restricts resource types and exact network/mail
addresses, forbids data sources and provisioners, and rejects undeclared file/configuration formats.

## Toolchain and checks

Bazel fixes OpenTofu at 1.12.6 and uses Cloudflare provider 5.25.0 with the hashes in
[`.terraform.lock.hcl`](.terraform.lock.hcl). Change these pins deliberately and verify the resulting plan.
`identity.tf` ignores only the imported GitHub OAuth client secret because Cloudflare cannot return that value;
the rest of the managed configuration remains compared.

```sh
bazel build //infra:config
bazel test //infra:check
```

The check facade runs formatting, backend-free validation with the locked local provider mirror, scope guards,
state-driver tests and output/config comparisons. It needs no account, production credential or remote state.
`CI gate` selects these tests through the affected Bazel graph.

## Remote state

OpenTofu stores encrypted state in private R2 at `infra-state/production/terraform.tfstate`. State and saved plans
require the existing enforced encryption; raw plans and provider output must not be published. The driver emits
only resource addresses, action counts, safe errors and review fingerprints. Public inventories contain resource
identities, never owner identities or credentials.

All recurring state operations share the GitHub `infra-production` lock. The backend does not use an R2 lockfile.
An apply first copies and verifies the existing encrypted state, applies the reviewed saved plan, then requires a
clean verification plan. State copies do not back up D1/R2 application data; use each application's recovery guide.

The [bootstrap](../tools/cloud-bootstrap/README.md) handles the state bucket before backend initialization and
supports creation, adoption, extension and continuation after interruption. It exports provider-issued identities
and regenerates committed configuration. Do not restore the old hand-written import-block workflow.

## Drift plan (CI)

[Infra drift](../.github/workflows/infra.yml) plans on relevant main pushes and manual dispatch.
[Personal cloud reconcile](../.github/workflows/personal-cloud-reconcile.yml) also checks the running environment
daily and after publication. These production checks are separate from account-free source tests.

| Result | Meaning | Next step |
| --- | --- | --- |
| No planned actions, matching outputs | Managed resources match the declared configuration | None |
| Planned in-place changes | Actual configuration differs | Use the repair/review path below |
| Delete, replace or forget | A resource identity or declaration is being removed | Review the intended retirement or recovery |
| Output mismatch | An app names a different AUD, database or bucket | Correct the inventory/configuration before applying |
| Dependency or permission error | No trustworthy comparison completed | Resolve the reported prerequisite and repeat the same check |

Computed readback changes such as D1 `file_size` are informational. They do not by themselves constitute a planned
action or fail the drift check. A successful source test is not a current Cloudflare observation.

## Apply (P4)

There are three existing write paths, all on main and under the same infrastructure lock:

1. Routine reconcile repairs only the dedicated runtime/API CNAMEs and authenticated loopback Tunnel ingress, preserving
   the Tunnel target and exact route/audience policy in [reconcile_policy.py](scripts/reconcile_policy.py).
2. Reviewed reconcile applies the original saved plan through the protected `infra-review` environment. Its source
   revision and current differences must still match the review.
3. [Infra apply](../.github/workflows/infra-apply.yml) accepts reviewed action counts and the plan fingerprint from
   the matching drift run. Its destructive-confirmation input is only for an explicitly reviewed retirement.

Access permissions, identity providers, receiving rules, resource creation/deletion and unknown provider shapes
require review. A routine repair cannot create empty storage in place of missing data. Owner pauses and operating
switches remain authoritative. Do not apply raw OpenTofu commands outside these workflows.

A failed apply may have changed some resources. Re-read the current plan before deciding the next action; do not
assume failure rolled it back. Reverting a resource configuration follows the same branch, review and apply flow.
State-only recovery restores the existing encrypted state copy under the same lock, then verifies a new plan;
application data restoration is independent.

## Outputs

[outputs.tf](outputs.tf) exposes public `access_aud`, `d1_database_ids` and `r2_bucket_names`.
The state driver compares planned values with every production Wrangler configuration. Unknown identities are
accepted only for a resource no deployed configuration names yet. After creation, bootstrap records real identities
in `config/resources.toml` and regenerates configuration; resource IDs are not hand-copied into multiple files.
Sensitive outputs are private bootstrap inputs and never part of the public summary or inventory.

## Adding an app

1. Declare its service, resource identities and owned resources through the catalog and HCL; keep its release disabled
   until required resources exist. Use the bootstrap's explicit extension addresses for an existing environment.
2. Review and apply only the new resources. Record the resulting identities through the existing exporter and generator.
3. Deploy the same green source after its service-binding providers. After its first deployment, record any new DO
   namespace and remove the first-deploy exclusion.
4. Require the matching reconcile, resource-registration and provider-readback checks. An Access redirect alone does
   not prove the Worker's AUD or an authenticated business call works.

Personal MCP additionally needs its exact observed OAuth redirect; Newsletter's console needs its authenticated
runtime path. Those application-specific requirements remain in their own runbooks.

## Retiring an app

1. Remove consumers and release jobs, regenerate the catalog, and declare each intended resource retirement in
   `retired.tf` and the guard. Keep application-scoped policy deletion at its original address so dependency ordering
   removes the application before its policy. Any removed Worker binding needs its exact release retirement entry.
2. After consumers deploy without the binding, remove the retired Worker through its authorized publication owner.
3. Review the resulting destructive plan, including storage/data consequences, and apply it through Infra apply.
4. Once provider readback and state confirm removal, delete the completed retirement declarations. Reconcile must
   report no unexpected Worker, namespace, database or route.

Historical prototype and P3/P4 evidence remain in
[the earlier revision](https://github.com/ziyixi/todofy/blob/288e5ef7c9e3df3761b45b0e436b86503bf38cba/infra/README.md).
Use the current [rebuild verification](../docs/rebuild-verification.md) for the boundary between synthetic tests,
existing-environment acceptance and a clean-account/clean-VPS exercise.
