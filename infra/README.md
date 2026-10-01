# infra: plan-only OpenTofu for the monorepo apps

This directory describes the Cloudflare objects that the monorepo's apps depend on but that wrangler
does not own. It is a **prototype that has only been planned, never applied**: nothing here has
changed Cloudflare, and no CI job holds a Cloudflare token for it yet. It is the first part of step P3
in the IaC plan (OpenTofu import, plan only). P4 is apply.

- Tooling: OpenTofu 1.12 and the Cloudflare provider pinned at exactly **5.25.0**
  (`registry.opentofu.org/cloudflare/cloudflare`). [`.terraform.lock.hcl`](.terraform.lock.hcl) holds
  the provider hashes for darwin_arm64, linux_amd64 and the other published platforms. 5.26.0 is newer
  but is skipped because of open DNS regressions (provider issues #7387 and #7396). Upgrade only on
  purpose, and only after a plan shows zero diff.
- State: local, and always **outside** the repository. The remote R2 backend and state/plan
  encryption are already written in [`versions.tf`](versions.tf) but commented out (see
  [Next steps](#next-steps-p3-and-p4)).
- Last verified on 2026-10-01: the plan showed no changes for all 13 objects
  ([Verification record](#verification-record)).

## Scope

### Owner rule (2026-10-01)

Only objects that belong to the monorepo apps go here: mail-hero, todofy and todofy-core, the dashboard
`home`, `lab`, the website `ziyixi-website` and the relay `ziyixi-notion-publish`. Nothing unrelated is
imported, declared, read or modelled, not even read-only.
[`infra_guard.py`](../.github/scripts/infra_guard.py) enforces the boundary on every push (through
[`test_infra_config.py`](../.github/scripts/test_infra_config.py) in `Changes`, and again in
`Infra checks`). It reads the HCL block structure, so quoted and bare labels (`resource "a" "b"` and
`resource a b`) and nested blocks are all seen, and anything it cannot read fails:

- only four resource types, and every resource has its own `lifecycle { prevent_destroy = true }`;
- no data source (not even inside a `check` block), module, `check`, `ephemeral` or `removed` block,
  no provisioner or connection, and no provider other than `cloudflare`;
- committed files are only `*.tf`, the lock file, the docs, `local.tfvars.example` and the Python
  scripts and tests. Any other file fails whatever its name: `*.tofu`, `*.tf.json` and `*.tofu.json`
  (OpenTofu would load them too), and state, plan, values or log files such as `tfplan` or `plan.out`;
- a `backend` or `cloud` block is accepted only together with an `encryption` block that enforces both
  state and plan encryption and a sensitive `state_passphrase` variable.

[`test_infra_guard.py`](../.github/scripts/test_infra_guard.py) tests the guard itself against
configurations built to slip past it.

### Managed here (13 objects)

| Address | Object | Notes |
| --- | --- | --- |
| `cloudflare_zero_trust_access_policy.owner` | reusable Access policy "Mail Hero owner" | Allow. Includes the owner's email(s), which come from a sensitive variable. **Shared, see below** |
| `cloudflare_zero_trust_access_policy.github_owner` | reusable Access policy "Mail Hero GitHub owner" | Allow. Includes the owner's email(s) and requires the GitHub login method. **Shared, see below** |
| `cloudflare_zero_trust_access_application.owner["mail-hero"]` | Access app "Mail Hero" | `mail-hero.ziyixi.science` |
| `cloudflare_zero_trust_access_application.owner["todofy"]` | Access app "Todofy" | `todofy.ziyixi.science`. `todofy-hooks` and `daily` are deliberately not behind Access |
| `cloudflare_zero_trust_access_application.owner["home"]` | Access app "Home" | `home.ziyixi.science` (the dashboard) |
| `cloudflare_zero_trust_access_application.owner["lab"]` | Access app "Lab" | `lab.ziyixi.science` |
| `cloudflare_zero_trust_access_application.mail_hero_backup` | Access app "Mail Hero backup API" | `mail-hero.ziyixi.science/api/internal/backup/*`. Used by the backup collector's machine identity (mail-hero/AGENTS.md §7) |
| `cloudflare_d1_database.app["mail-hero" \| "todofy" \| "lab"]` | D1 databases | Existence only |
| `cloudflare_r2_bucket.app["mail-hero-store" \| "mail-hero-backups" \| "todofy-backups"]` | R2 buckets | Existence only |

Every object has `prevent_destroy`, for two reasons:

- **Access apps.** Replacing an Access app gives it a new AUD. Every Worker's `ACCESS_AUDIENCE`, and the
  backup collector, would then reject requests: an outage.
- **Storage.** A destroyed database or bucket means lost data. A recreated one gets an id that no
  `wrangler.toml` knows.

**The two reusable policies are shared.** Each is attached to six Access applications: the four
owner-facing monorepo apps (Mail Hero, Todofy, Home, Lab), plus two applications of self-hosted
services outside the monorepo. The Mail Hero backup API uses only its own application-scoped policy.
Changing a reusable policy here therefore also changes who can reach those two outside services. This prototype never changes a policy's identity rules,
because the include/require values are exactly the live values, passed in through variables. Renaming
them to neutral names (`owner`, `owner-github`) is a P4 decision for the owner, because it affects
those other apps too.

### Owned elsewhere (inside the monorepo, but not by OpenTofu)

| What | Owner | Why not OpenTofu |
| --- | --- | --- |
| Worker scripts, bindings, vars/secrets, crons, Durable Object migrations, Custom Domains, routes, D1 schema migrations | each app's `wrangler.toml` and CI | When wrangler and OpenTofu both manage one object, each overwrites the other (provider issue #7382) |
| DNS records of the apps' hostnames | wrangler (Custom Domains create read-only AAAA records) | They are read-only and wrangler-owned |
| Email Routing: settings, the Mail Hero rule, catch-all, and the receive subdomain's MX/DKIM/SPF records | Email Routing (set up once) | The enable/DNS resources would try to write apex MX/SPF records, which would split the owner's mailbox. The rule diffs on every plan (#7352). A plan's refresh section would print the receive address from the API |
| The service token used by the backup collector, and the rules of the backup app's application-scoped policy | Cloudflare dashboard | A token created or replaced by OpenTofu would put its client secret in state, and replacing it breaks backups without any error. The policy is referenced only by id (see [Import notes](#import-notes)) |
| R2 lifecycle rules | none (only Cloudflare's default multipart-abort rule) | See [Storage](#storage) |
| GitHub secrets and variables, ops switches (`*_PAUSED`, `*_MAINTENANCE_MODE`, …) | GitHub `production` environment | Secret values would end up in state. Switches are flipped at runtime, and IaC would flip them back |

### Not managed here (outside the monorepo)

Listed by category only. These are neither declared nor read, and their values are not recorded:

- the Access applications of self-hosted services and their own policies (including bypass policies);
- the Warp login application;
- the tunnel and the tunnel hostnames of self-hosted services;
- the apex mailbox records (MX, TXT, DKIM, DMARC);
- third-party verification TXT records;
- zone-wide settings (SSL, rulesets, certificates);
- identity providers;
- notification and budget alerts;
- R2 buckets of other projects.

## DNS

**No DNS record is managed, deliberately.** The live zone was checked on 2026-10-01 (category counts
only, no values were copied). Every record that a monorepo app depends on already has another owner:

- **App hostnames.** `mail-hero`, `todofy`, `todofy-hooks`, `daily`, `home`, `lab`, `www` and the apex
  are Workers Custom Domains. Their AAAA records are created by wrangler and marked read-only
  (`meta.read_only`, `origin_worker_id`).
- **Mail Hero's receive subdomain.** Its MX and DKIM records are read-only Email Routing records. Its
  SPF TXT record has no read-only flag but was created by Email Routing and belongs to it.
- **Everything else in the zone** is outside the monorepo (see the list above).

So the set of records that a monorepo app needs and that neither wrangler nor Email Routing owns is
**empty**. [`dns.tf`](dns.tf) explains this in comments only. Add a record here only when an app needs
one that no one else owns, for example a future sending-domain DKIM record. Take its value from a
variable, and add `cloudflare_dns_record` to `ALLOWED_TYPES` in
[`infra_guard.py`](../.github/scripts/infra_guard.py) in the same change.

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

All values come from a tfvars file **outside the repository** or, later in CI, from GitHub secrets
and variables ([`variables.tf`](variables.tf), [`local.tfvars.example`](local.tfvars.example)):

| Variable | Sensitive | Source |
| --- | --- | --- |
| `account_id` | no | Kept out of `infra/` all the same. Several `wrangler.toml` files already contain it, but this directory adds no new copy |
| `access_owner_emails` | **yes** | The live include list of "Mail Hero owner" |
| `access_github_owner_emails` | **yes** | The live include list of "Mail Hero GitHub owner" |
| `access_allowed_idp_ids` | no | Identity provider ids allowed on the four owner-facing apps |
| `access_github_idp_id` | no | The GitHub identity provider that "Mail Hero GitHub owner" requires |

**Which ids are committed (one rule).** Ids of the objects this directory manages are committed:
the Access application ids, the two reusable policy ids and the backup app's application-scoped policy
id (in [`imports.tf`](imports.tf), [`access.tf`](access.tf) and
[`scripts/local_tfvars.py`](scripts/local_tfvars.py)), and the D1 ids. They are opaque object handles,
not credentials: no API call can use them without a token for the account. Import needs them, and a
reviewer has to be able to see which object each address adopts. The D1 ids, the Mail Hero app id and the
two reusable policy ids were already public (in the wrangler configs and
`mail-hero/docs/verification-native.md`). Ids of objects **outside** the monorepo boundary that
this configuration only references, namely the identity providers and the account, come from variables,
so `infra/` adds no copy of them. The guard test rejects any 32-hex-digit value (the format of account
and zone ids) under `infra/`.

Even with sensitive variables, `tofu show -json` writes **every value in plain text**: the sensitive
variables, the include emails read back from the API, and the account id inside import ids. Plan files
and their JSON must therefore never be committed, uploaded as artifacts, or printed to a log. Only the
redacted summary may be shared ([`tools/infra-plan-summary`](../tools/infra-plan-summary/summary.py)).

## Running a plan locally

You need a token that can read Access apps and policies, D1 and R2, set in `CLOUDFLARE_API_TOKEN`.
Today that is the owner's bootstrap token, used read-only; from P3 it is `CF_INFRA_READ_TOKEN`. Never
put the token in a file in the repository or pass it as a `-var`.

```sh
brew install opentofu                         # 1.12.x
export CLOUDFLARE_API_TOKEN=...               # from your password manager or token file, not the shell history
WORK=~/.cache/todofy-infra                    # everything mutable lives outside the repository
export TF_DATA_DIR=$WORK/tfdata
VALUES=~/.config/todofy-infra/local.tfvars

# 1. Write the live values (GET only; refuses a path inside the repository; prints no value).
python3 infra/scripts/local_tfvars.py --account-id <account id> --out "$VALUES"

# 2. Initialise. Init only downloads the locked provider; .terraform/ goes to $TF_DATA_DIR.
cd infra && tofu init -input=false

# 3. Plan. Raw output goes to a file outside the repo, never to the terminal you might paste from.
tofu plan -input=false -lock=false -state="$WORK/terraform.tfstate" -var-file="$VALUES" \
  -out="$WORK/plan.bin" -detailed-exitcode > "$WORK/plan.log" 2>&1; echo "exit $?"
tofu show -json "$WORK/plan.bin" | python3 ../tools/infra-plan-summary/summary.py --keys-from .
```

`--keys-from .` lets the summary print the `for_each` keys that are written as map keys in the
committed `*.tf` files (such as `"mail-hero"`). Those are already public. Any other key, for example
one that is an id, a hostname or a token, is printed as a numbered placeholder (`["<key 1>"]`).

With an empty state, the plan reports **13 to import, 0 to add, 0 to change, 0 to destroy**. To get a
zero-diff baseline without any apply, adopt the objects into the local state. `tofu import` writes only
to state; on the Cloudflare side it only reads:

```sh
tofu show -json "$WORK/plan.bin" | python3 -c '
import json, sys
for rc in json.load(sys.stdin)["resource_changes"]:
    if rc["change"].get("importing"): print(rc["address"] + "\t" + rc["change"]["importing"]["id"])
' > "$WORK/imports.tsv"
while IFS=$'\t' read -r address id; do
  tofu import -input=false -lock=false -state="$WORK/terraform.tfstate" -var-file="$VALUES" "$address" "$id" > /dev/null
done < "$WORK/imports.tsv"
```

Run the plan again. It should print "No changes" (exit 0), and the summary should show `no-op: 13`.
**Never run `tofu apply`** from a laptop: apply belongs to the P4 CI job on `main`.

## Import notes

Each object was adopted with an `import {}` block in [`imports.tf`](imports.tf), written by hand from
the read-only API inventory. With only 13 objects, cf-terraforming was not needed. Once a P4 apply has
recorded the objects in the remote state, these blocks do nothing and can be deleted.

| Resource | Import id | Notes |
| --- | --- | --- |
| reusable policies | `<account>/<policy id>` | Rules come from the variables. Zero diff on import |
| owner apps (4) | `accounts/<account>/<app id>` | In 5.25.0, `self_hosted_domains` is deprecated and cannot be set together with `destinations`, so the hostname is declared through `domain` + `destinations`. The policies are attached by id with precedence 1 and 2 |
| `mail_hero_backup` | `accounts/<account>/<app id>` | Its only policy is application-scoped (`reusable = false`, decision `non_identity`, includes a service token). The provider reads application-scoped policies back as `{id, precedence}` only. Declaring the policy inline produced a diff, so it is declared by id. **Open for P4:** before the first apply, verify that the API accepts the application PUT with an application-scoped policy id. Otherwise convert that policy into a reusable one in a separate change that the owner has confirmed |
| D1 (3) | `<account>/<database id>` | `read_replication = { mode = "disabled" }` is declared, because omitting it plans an update. `file_size`, `num_tables` and `version` are computed |
| R2 (3) | `<account>/<bucket>/default` | Default jurisdiction. Location and storage class are computed. No lifecycle (see [Storage](#storage)) |

Also kept in mind for P4 (provider issue #7284): never delete a policy and re-attach it to an
application in the same apply.

### Drift signal

The summary has two sections, and they mean different things:

- **Planned actions** (anything other than `no-op`) are drift between the configuration and Cloudflare.
  This is the signal to act on.
- **"Changed outside OpenTofu"** lists objects whose refreshed attributes differ from the stored state.
  These include computed values that change by themselves, such as a D1 database's `file_size`.
  `ignore_changes` cannot suppress them, because it covers only arguments in the configuration. They
  stop appearing once an apply (P4) writes the refreshed values to state.

A drift check (P3) therefore fails on planned actions, and reports "changed outside" addresses only
for information.

### `ignore_changes`

**None.** With provider 5.25.0, the plan is zero-diff without any `ignore_changes`. If a later provider
version brings a permanent diff, add the narrowest `ignore_changes` you can and list it here together
with its reason and the provider issue.

## Verification record

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

No `tofu apply` was run, and nothing was written to Cloudflare or GitHub.

## CI: "Infra checks"

The job runs when `infra/`, `tools/infra-plan-summary/` or `.github/` changes
([`ci_changes.py`](../.github/scripts/ci_changes.py) output `infra`), and `CI gate` requires it. It
uses no Cloudflare token, no state and no plan. Steps:

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
  summary, and the `local_tfvars.py` tests.

The checks against the apps' configs ([`test_infra_config.py`](../.github/scripts/test_infra_config.py))
run in `Changes` on every push, so a `wrangler.toml` change that no longer matches `infra/` fails at
once.

## Next steps (P3 and P4)

### Owner, once (about 10 minutes)

Because nothing outside the boundary is managed, the tokens are much narrower than the general IaC
plan assumed. They need **no DNS, zone, tunnel or Email Routing permission**.

1. In Cloudflare Dashboard → My Profile → API Tokens, create:
   - **`CF_INFRA_READ_TOKEN`**:
     - Account → Access: Apps and Policies → Read
     - Account → D1 → Read
     - Account → Workers R2 Storage → Read
     - read access to the objects of the future `infra-state` bucket
   - **`CF_INFRA_TOKEN`**: the same permissions with Edit, plus read/write access to the objects of
     `infra-state`.
2. Store each token from your own terminal; paste the value at the prompt, never in chat:
   - `gh secret set CF_INFRA_READ_TOKEN --env infra-plan -R ziyixi/todofy`
   - `gh secret set CF_INFRA_TOKEN --env production -R ziyixi/todofy`
3. Recommended: generate a passphrase locally (`openssl rand -base64 32`) and keep a copy in your
   password manager. Store it as `INFRA_STATE_PASSPHRASE` in both environments with `gh secret set`.
   Without your own copy, the state can be decrypted only inside CI; if it is lost, rebuild it by
   importing again.
4. Store the non-secret values (`account_id` and the identity provider ids) as variables in the
   `infra-plan` environment. Store the two email lists as secrets there.

### P3 (agent, after the tokens exist)

- **Remote state.**
  - Create the private `infra-state` bucket.
  - Verify that the S3 credentials derived from the token work.
  - Test whether R2 honours `If-None-Match: *`; enable `use_lockfile` only if it does. Until then,
    rely on a GitHub `concurrency` group.
  - Uncomment the `backend "s3"` and `encryption` blocks and the `state_passphrase` variable
    **together**, then import again into the new encrypted state. The guard rejects a backend without
    an encryption block that enforces both state and plan encryption, wherever the backend is declared.
- **Plan job on branch pushes.** It uses the `infra-plan` environment and the read token, and runs
  `tofu plan -out` with stdout and stderr sent to `/dev/null`. Only the output of
  `summary.py --keys-from infra` goes to the step summary. No artifact is uploaded. A sentinel check runs against the job log.
- **Nightly drift.** Run `tofu plan -detailed-exitcode` and report through the redacted summary only.
  Fail on planned actions, not on "changed outside" entries (see [Drift signal](#drift-signal)).

### P4 (apply)

- Apply on `main` only, in a `concurrency: infra-production` group, after:
  - an encrypted state backup;
  - `summary.py --fail-on-destroy` (any delete, replace or forget blocks the apply unless a dispatch
    explicitly confirms it);
  - the resource-type allowlist.
- Remove the `import {}` blocks after the first apply.
- Add outputs (`access_aud[app]`, D1 ids, bucket names). CI then asserts that each `wrangler.toml`
  `ACCESS_AUDIENCE` equals the output. Outputs are left out today because a plan that adds them never
  becomes "No changes" until something is applied.
- The owner decides whether to rename the shared policies (this affects the self-hosted apps) and
  whether the backup app's application-scoped policy becomes reusable.
