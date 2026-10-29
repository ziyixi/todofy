# CI and releases

This is the detailed release reference moved from the root README. Start with
[HANDOFF](../HANDOFF.md) for work in flight and [architecture](architecture.md) for service boundaries.
The workflow and [ci_changes.py](../.github/scripts/ci_changes.py) own job names, dependencies and
reachability. The [service catalog](service-catalog.md) supplies the application inventory; this document
explains the release guarantees rather than maintaining another application or dependency map.

[Rebuild](rebuild.md) covers a new account/VPS. The reusable [Worker release](../.github/workflows/worker-release.yml)
keeps each application's checks, migration order, probes and release lock. A selected source checkout and
`BUILD_SOURCE_SHA` let repair publish the app's last verified revision. Release recipes install only from the root
workspace lock and read Node's version from the root `package.json`, so the selected revision must come from the
shared workspace (2026-10-25) or later. GitHub deployment success is recorded
after the actual provider version/configuration or VPS running identities pass verification.
The static website retains its independent content registry, release and rollback workflow.

[Personal cloud reconcile](../.github/workflows/personal-cloud-reconcile.yml) checks daily and after successful
main CI. Dispatch `check`, `repair` or an explicit VPS `resume`. Automatic routine repair requires
`PERSONAL_CLOUD_AUTO_REPAIR=true`. Sensitive infrastructure changes use a saved encrypted plan,
an `infra-review` reviewer gate, and the existing production secrets; no secrets are copied to the review
environment. The apply reacquires the infrastructure lock and refuses a changed SHA/state/plan.
An app before its first deploy has no verified deployment to compare: its Worker is in `FIRST_DEPLOY_PENDING`
([inventory.py](../tools/service-catalog/inventory.py)), which lets the inventory check accept that Worker and its
buckets absent and skip its namespaces (they have no id yet), and the reconcile matrix excludes the app. The commit
after that deploy records the namespace ids and removes both; a guard test keeps the two lists equal.

## Where to change the pipeline

- Change triggers, dependencies, permissions, timeouts and the CI gate in
  [ci.yml](../.github/workflows/ci.yml). Job names remain stable because same-SHA check reuse reads them.
- Change an application's checks in `.github/actions/check-<app>/action.yml`. Todofy retains separate static
  and runtime actions; the runtime shard index/count are passed by the caller. Recall and Mailsort retain
  their smoke steps and subsequent packaging in the workflow because composites cannot set step timeouts. Artifact names and retention
  belong to these steps, and downstream consumers continue to require the exact tested artifacts.
- Change an application's build, migration, secret-file creation and probes in
  `.github/actions/release-<app>/action.yml`. [worker-release.yml](../.github/workflows/worker-release.yml)
  owns one job: the application lock, source selection, preflight, selected action and verified Deployment record.
  CI and reconcile call this same workflow. A call shows one release job rather than eleven app jobs, ten skipped.
- Image publication and VPS packaging/deployment have their own actions (`publish-newsletter`, `publish-platform`,
  `package-vps`, `deploy-vps`). They retain separate jobs, permissions, locks and digest outputs. Website content
  publication remains in its independent workflow; `dispatch-website` only starts it.

The root checkout supplies orchestration; `.release-source` supplies the chosen app revision, including repair
of an older verified SHA. Keep that distinction when editing paths. Every composite run step names its directory
and uses `bash -e {0}`, matching the previous Ubuntu unspecified shell; adding `pipefail` would change behavior.
Composite actions receive explicit inputs for job-only context and secrets. Secrets become environment variables
only in the steps that use them. Do not move secrets to a job-wide environment or read production credentials in checks.

The `Changes` job runs the workflow guards. `workflow_sources.py` follows local action steps so the existing
command/credential/order assertions still inspect the executed recipes; `test_composite_actions.py` independently
checks the real caller boundaries, input wiring and single-job release structure. Keep both kinds of checks.
Native boundary assertions read YAML fields using pinned PyYAML, so indentation, quoting and key order do not
change their result. The existing expanded recipe/script tests still check commands and release behavior;
they are migrated only when touched. Install the root test dependencies from `.github/scripts/requirements.txt`.
On failure, open the failed job and its named composite step; application commands retain their original step names.

The 2026-10-11 refactor passed [full branch CI](https://github.com/ziyixi/todofy/actions/runs/38134080448),
[same-SHA main publication](https://github.com/ziyixi/todofy/actions/runs/38134511298) and
[automatic reconcile](https://github.com/ziyixi/todofy/actions/runs/38134699837). The observed reconcile graph
fell from 128 jobs to 18, with all 11 Workers reporting no drift. VPS publication verified both running digests;
Worker uploads were not selected in that run. Detailed evidence and the next normal-release check are in HANDOFF.

## Before a release

- The owner must have authorised publication/deployment in the task. A design request is not permission to deploy.
- Push a branch, let its full `CI gate` pass, and merge that exact green SHA. A newer pending run is not green.
- Rebase means a new SHA: re-run every affected check. A green branch run may be reused only for that same SHA.
- Main deploys only affected applications from its cumulative successful-release base. PR checks use no production secrets.
- Production jobs use the `production` environment on main, scoped credentials and their own concurrency group.
- Update HANDOFF with the merge order, evidence obtained and post-deploy checks still outstanding.

## CI and deploy jobs

[CI and deploy](../.github/workflows/ci.yml) runs on pushes and manual dispatches. Actions are pinned by
commit SHA. The classifier derives `APPS` from `catalog.apps`; package, contract and proto reachability
still follows checked actual consumers rather than application names.

A direct `<app>/app.toml` change checks that application and the catalog without deploying it: metadata
is not bundled. Commit regenerated outputs together. A changed generated Home registry is ordinary
`dashboard/` source and can release Home. `config/` and its generator are also checked without silently
migrating an account; their changed committed Wrangler outputs follow the affected Worker's normal release.

The explicit `APP_TEST_DIRECTORIES` directories in `ci_changes.py` run the same checks without selecting production
releases. They are external test trees confirmed absent from runtime bundles/images; the source-import guard
rejects production imports from them. Newsletter test-only edits still check Newsletter and Platform, but do not
publish their images or deploy the VPS. Mixed changes containing production inputs still release normally.
Unknown paths, collocated test files, Website/extension paths, dependencies, Dockerfiles and build/deploy inputs
retain their existing release rules. Manual dispatch and the full-run fallback are unchanged.

`CHECK_ONLY` in the classifier explicitly freezes new applications before their resources are ready.
While Fleet is in that set, both Fleet and Home deploy outputs remain false, including dispatch, full-run
and same-SHA reuse. Complete the reviewed Access bootstrap, commit its real AUD/identity configuration and
remove that explicit freeze together before enabling those releases. A placeholder dry-run is not evidence
that the production identity exists. `CHECK_ONLY` currently holds only the Newsletter console (`newsletter-console`),
until "Infra apply" creates its Access application and its first-deploy commit records the AUD; Home does not bind
it, so Home deploys as usual. recall left the set with its go-live commit (2026-10-10).

| Job | Checks or release responsibility |
| --- | --- |
| `Changes` | Runs the `.github/scripts` tests (among them [app isolation](../.github/scripts/test_app_isolation.py): every catalog app's imports resolve only to itself, `proto/`, `contracts/`, `packages/`, and `tools/` from tests and build/deploy scripts; the website uses only `proto/`; no bare specifier climbs with `..`; the Todofy UI source never names `mail-hero`/`mail_hero`) and shared deployment-tool tests, validates catalog/public config, then classifies the cumulative diff. Locally use the root workspace: `uv run --locked --only-group ci python -m unittest discover -s .github/scripts`. Dispatch options, `CHECK_JOBS` and release conditions are tested against the workflow. |
| `Shared packages` | Locked install, typecheck and tests for the independent `packages/*/` consumers. |
| `Todofy static checks`, `Todofy runtime (1/3)`–`(3/3)`, `Todofy checks` | Host/gateway/UI checks, dry-runs and bundle/CPU budgets; real-binding tests in balanced shards with completeness and serial-test guards. All required shards must pass. |
| `Mail Hero checks`, `Dashboard checks`, `Links checks`, `Watch checks` | Each application's config/wrapper checks, lint/typechecks, synthetic unit and real-binding runtime tests, UI build and production-config dry-run. Existing app-specific CPU, bundle and query budgets stay in their own jobs/runbooks. |
| `Recall checks` | Worker lint/typecheck/unit and workerd runtime tests (a real SQLite DO and R2, CPU bounds), the UI's tests and build, the archive consumer's tests on the root Python 3.14 runtime (its rules against the generated schema), the smoke run (the extension's own upload through `wrangler dev` into an archive checked against `recall-archive-v1`), the dry run with the bundle budget, and the extension's checks and build, kept 30 days as the artifact `recall-extension-<sha>` (the extension is never deployed; `Recall extension release` publishes it). |
| `Fleet checks` | Worker and UI lint/typecheck/tests, real SQLite DO signed-receipt runtime tests, UI build, config/wrapper checks and dry-run bundle budget. The observer's Python tests run with Platform, not from a retired Fleet host executable. |
| `Newsletter console checks` | Config/wrapper checks (the owner identity is Home's, filtered to `ACCESS_OWNER`/`ACCESS_OWNER_ALIASES`), Worker lint/typecheck/unit tests and a workerd run with a synthetic Access issuer, the UI's lint/typecheck/tests and build with its JavaScript budget, and the dry run with the bundle budget. |
| `Website checks` | Synthetic Notion/source fixtures, static export and Playwright, relay/release tests and both Worker dry-runs; no production content or credentials. |
| `Contracts` | Generated schemas, frozen golden bytes, both sides' consumer tests and Home's generated Ops caller. Mail receipt legacy compatibility and Ops fixtures remain checked. Apps' own jobs run real-binding tests. |
| `Proto checks` | Pinned tools, format/lint/API lint, IDL and wire-profile breaking checks, deterministic generation, schema freshness, both language codecs and import reachability. `PROTO_READS`, `PROTO_USERS` and `PROTO_PACKAGES` are the checked trigger map, including Fleet's transitive Platform runtime descriptions and Platform's Python report/error codecs. Test-only/type-only files do not implicitly deploy consumers. See [proto](../proto/README.md). |
| `Infra checks` | Structural safety guards, `tofu fmt`, locked-provider initialization without backend credentials, `tofu validate`, plan-summary/local-values/export tests and static Wrangler/output consistency. No provider token, state or production plan is read. |
| `Newsletter checks`, `Newsletter image checks` | Locked engine/unit/synthetic model checks, build smoke checks, then build linux/amd64 and test the exact image ID/configuration. Save the tested image tar and identity/checksum manifest as a one-day artifact. |
| `Platform checks` | Locked Python lint/tests of daemon, observer and release/build tools; compile standard Kustomize assets, build linux/amd64 and test the exact image's dependencies, source identity and observer imports without network. Save that tested image and manifest as a one-day artifact. |
| `Codex gateway checks` | Locked Python lint and synthetic inference tests, followed by the independent linux/amd64 image build and offline source/dependency check. Archive `codex-gateway-image-<sha>` for checked-byte promotion; no login, credentials or real model call. |
| `CI gate` | Fails on any required failed/cancelled job. Unchanged jobs or explicitly verified same-SHA reuse may be skipped. **The one check to require on main.** |
| `Newsletter image publish`, `Platform image`, `Codex gateway image` | After main's gate and the required successful checks or verified same-SHA reuse, load and publish the tested artifacts to the catalog's image repositories. Publication does not rebuild or prove a VPS rollout. |
| `Recall extension release` | After main's gate, when `recall/extension/` or `recall/shared/` changed (`recall_extension_publish`; also a dispatch for recall or all, and a run of everything): publish the extension artifact `Recall checks` tested (from the reused run on same-SHA reuse) as the GitHub Release `recall-extension-v<version>` with its zip, the commit and the CI run; a version whose tag exists is skipped. The extension publication job with `contents: write`; it reads no secret, and no job needs it, so a failure delays no deploy (the failed run's diff is retried by the next push). |
| Cloudflare app deploy jobs | After main's gate and app checks: build the verified UI, write private values, dry-run, enforce hostname safety, apply only the app's required D1 migrations and deploy its committed config. Each app retains its production probes and concurrency group. |
| `Tasks deploy`, `Watch deploy` | Tasks waits for Todofy (its `MAIL` binding names Todofy's `Mail` entry); Watch waits for Tasks (its `TASKS` binding names Tasks' `TaskInbox`) and for Todofy, because a failed Todofy deploy leaves Tasks deploy skipped rather than failed. Each also proceeds when the jobs it waits for are skipped. |
| `Dashboard deploy` | Also waits for Todofy, Mail Hero, Tasks, links, Watch, Fleet, Mailsort, Recall, Personal MCP and website relay deploys to succeed or be skipped, and for a selected Router deploy to succeed. Its `FLEET`/`NEWSLETTER` service bindings require Fleet's `Ops`/`NewsletterOps` and `TASK_INBOX` Tasks' `TaskInbox`; selected providers deploy before Home in the same SHA's release. |
| `Newsletter console deploy` | After the gate and a `VPS deploy` this run made (Newsletter answers the console's reads) or skipped; `CHECK_ONLY` keeps it off until the console's Access application exists. Probes Access on the console's host and on Newsletter's read path. |
| `VPS deploy` | After both image publications and the gate, when `VPS_DEPLOY_ENABLED=true`: call the daemon's shared-proto release API and verify the durable result and fresh physical provenance. See the VPS section below. |
| `Codex gateway deploy` | After its image publication and any selected Fleet release, use one gateway target through the existing daemon API. Router waits for this executor release; the paired VPS/Newsletter release then waits for Router, so their rollouts stay ordered and do not overlap. A selected gateway release that does not succeed (with `VPS_DEPLOY_ENABLED=true`) stops Router, and a selected Router release that does not succeed stops Todofy, Mailsort, Home and the paired VPS release; only an unselected one may be skipped. Verify baked source, startup identity, digest and generation; retain Newsletter admission and trigger state. The gateway releases before the paired VPS release updates the Platform renderer: when a diff changes the gateway's rendered resources or that renderer, dispatch `app=codex-gateway` once after the paired release (reconcile's plan reports the leftover difference until then). |

On main, the diff base is the last successful push run of this workflow; failed/cancelled releases do not
lose their changes. Branch checks compare with the merge base against `origin/main`. No usable base runs
all checks and computes all releases, subject to bootstrap freezes and production enablement gates.
The first full run does not override those gates.

Main may reuse a green branch push run of the **same SHA** only when `Changes`, `CI gate` and every needed
check job succeeded, including every matrix shard. Its checked image publications also require both
same-SHA, non-expired artifacts, and the extension release its build artifact. An API error, missing/skipped
required check, missing artifact, different SHA or manual run runs checks again. Reuse changes neither deploy selection nor the cumulative main base.

A package change checks and deploys its actual `PACKAGE_USERS`. A root workspace change checks every member of that workspace. A pnpm
catalog version bump deploys only the members whose `package.json` lists the name (the VPS images only for
the proto toolchain's `dependencies`), and a root uv constraint only the Python members that declare it; a lock
follows the manifest changes beside it. The root `package.json`, any other workspace key, a lock changed alone
or a pin no member declares still deploys the whole workspace. Contract runtime values deploy only
`BUNDLED_BY` consumers; schemas and fixtures still trigger checks. Generic CI/check tooling checks applications without deploying them.
Explicit image build/publication/VPS release tooling changes publish the runtime pair and the gateway.
Newsletter or Platform changes release only that pair, and gateway-only source changes leave them untouched.
The bootstrap bundle includes the gateway image only when the same run built it; a fresh host bootstrapped
from a pair-only bundle gets the gateway with the next gateway release or an `app=codex-gateway` dispatch.
A Dashboard-only change does not redeploy its Ops providers. These rules are tested against dependencies/imports,
including proto import closure.

Documentation selects no app check, deploy or VPS release: Markdown anywhere (an app's README or AGENTS, a package
SPEC, a contract's notes) and any file in a `docs/` folder (the website's `doc/`) runs only `Changes`, whose tests
check the documents' links and references, and the gate; beside code, the code's own selection applies. The
exceptions in [ci_changes.py](../.github/scripts/ci_changes.py) are the Markdown a build ships (`RUNTIME_MARKDOWN`:
Mailsort's `prompts/`, the Newsletter wheel's package-data), which
releases its app like code, and the documents an app's checks read (`TESTED_DOCUMENTS`: test reads, and the
website's Markdown, which its `prettier --check .` formats), which check that app only. A guard scans Worker Text and
`?raw` imports, file reads, wheel package-data, image `COPY` sources, `public/` folders and prettier checks, and fails
when one of them reaches a path classified as documentation without selecting its reader.

Production job conditions retain `!cancelled()` and explicit successful dependency results. A reused check
can be skipped only with `checks_reused=true`; Home's upstream deploys may succeed or be skipped. Relying
on implicit `success()` would incorrectly skip deployments when an unrelated ancestor is skipped. The
workflow tests also enforce production concurrency, dispatch options and existing contract test paths.
[Document-reference tests](../.github/scripts/test_doc_references.py) catch nonexistent migration files.

## Cloudflare ownership and release protection

[Infra drift](../.github/workflows/infra.yml) is a read-only main/production plan using encrypted remote
state and `infra-production` concurrency. It fails on planned drift or public outputs inconsistent with
committed configuration. Its log is a redacted summary; it does not apply and is outside `CI gate`.
Three CI paths write Cloudflare objects and the state. Each runs on main in the `production` environment under
the same `infra-production` lock, backs up the encrypted state first, applies a saved plan and must then plan
clean:

1. [Infra apply](../.github/workflows/infra-apply.yml): a manual dispatch whose inputs name the exact reviewed
   actions and plan fingerprint; deletes, replaces and forgets need an explicit confirmation. New bootstrap
   credentials are encrypted before leaving the runner.
2. Routine repair in [Personal cloud reconcile](../.github/workflows/personal-cloud-reconcile.yml): only with the
   `repair` operation (dispatched, or automatic with `PERSONAL_CLOUD_AUTO_REPAIR=true`) and only when every planned
   change is an in-place update of the platform runtime CNAME or its tunnel's loopback ingress
   ([reconcile_policy.py](../infra/scripts/reconcile_policy.py)). `check`, the default, writes nothing.
3. Reviewed apply in the same workflow: a dispatch with `reviewed_apply=true` saves the plan, waits for the
   protected `infra-review` environment's approval and applies that plan only while the current plan still has
   its fingerprint.

Reconcile's final infrastructure gate requires `in_sync`, `repaired`, or a successful reviewed apply.
An unresolved/manual plan is a failed result even when detection completed successfully. Finish a deployment
handoff only after the matching main revision's reconcile verifies Workers, VPS, inventory and infrastructure.
Home's historical account operations are informational; they do not count as configuration differences.

Locally, the bootstrap writes only a missing state object and `rotate-passphrase` re-encrypts the state.
See [infra](../infra/README.md).

Every Worker has one committed production `wrangler.toml`, discovered from the catalog, with no `[env.*]`
or `keep_vars`. Static application configuration, routes, limits, bindings and migrations stay there.
The public [cloud profile](../config/cloud.toml) and [resource inventory](../config/resources.toml) generate
only declared account/Access/D1 identity fields, Home resource identities and Platform infra identity locals.
Commit those outputs; they never contain private owner settings or secrets. The generator does not create
provider resources, restore data or change application logic. See [rebuild](rebuild.md).

Deploy wrappers add private personal settings as Worker secrets via `--secrets-file`, operational switches
as vars and the exact `BUILD_SHA`. A deploy without a var deletes it, so wrappers refuse missing inputs,
unsupported configs, `--env` and `--keep-vars`. Fleet additionally refuses a missing/placeholder Access AUD
on a real deployment. Use the wrapper rather than a plain production `wrangler deploy`.
[Wrangler checks](../.github/scripts/test_wrangler_configs.py) enforce that check jobs never use production
secrets, a production environment, remote resources or a real deployment.

Every Custom Domain/route release first runs the read-only [hostname guard](../tools/cf-guard/README.md)
with that job's token. Wrangler treats each nonempty hostname/route category as a complete set; the guard
refuses unintended detachments or takeovers. Intentional removal/conflict exceptions name exact hosts in
the same reviewed commit. A pre-existing Tunnel CNAME cannot silently become a Worker Custom Domain;
its explicit removal is separate reviewed work. The new Platform HTTP Tunnel/DNS is owned only by its
specific infra resources; other tunnels, root MX/TXT/DKIM and Email Routing are not taken over.

Home's private drift state is generated from committed configs/wrappers and checked by
[test_drift_desired.py](../.github/scripts/test_drift_desired.py). Regenerate it in the same commit; it
contains names, types and flags rather than secret values. Local development uses local bindings and
D1 `--local`, never `--remote`, with each application's own `.dev.vars`.
Optional secret presence follows the same manifest policy as CI. Home invalidates an unfinished comparison
when the desired content changes, and its existing Cloudflare refresh can advance a bounded recheck on the
same day. Complete that check and verify its timestamp instead of treating an analytics refresh as a new result.

### Production environment

Production jobs use the `production` environment, restricted to main. Owner identities, receive addresses
and project IDs are secrets too: this public repository's Actions logs expose plain step variables.
The workflow is authoritative for optional inputs and their exact wiring.

Fresh bootstrap validates complete app secret maps from [worker-secrets.json](../tools/cloud-config/worker-secrets.json)
and sets the corresponding `<APP>_WORKER_SECRETS` production secrets. Existing deployments keep the individual
inputs below and preserve unreadable runtime secrets when no full map is supplied. A full map is an explicit
replacement input and must contain every declared required secret. [Bootstrap](../tools/cloud-bootstrap/README.md)
also initializes missing operational variables without overwriting existing pause or maintenance values.

Owner JSON APIs use exact Origin, `X-CSRF-Token: 1` and `application/json` after Access authentication.
They require no CSRF signing key or cookie. Existing encrypted GitHub maps may retain the retired
`CSRF_SIGNING_KEY` field: deploy parsers drop that exact field before validating the remaining map.
No other undeclared key is accepted. Release checks temporarily tolerate that old Worker binding;
the owner deletes the live key only after the keyless release is verified. New bootstrap maps omit it.

| Job | Variables | Secrets |
| --- | --- | --- |
| `Todofy deploy` | `TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED` (`TODOFY_REMINDER_ENABLED`, `TODOFY_FORCE_PAUSE_TODOIST` and `TODOFY_GTD_REVIEW_ENABLED` are read no more since 2026-10-21; delete them after that release) | `CF_API_TOKEN`, `TODOFY_ACCESS_OWNER`, `TODOFY_ACCESS_OWNER_ALIASES` (the `TODOFY_TODOIST_*_PROJECT_ID` secrets are read no more either) |
| `Mail Hero deploy` | `MAIL_HERO_FORCE_SEND_PAUSED`, `MAIL_HERO_MAINTENANCE_MODE`, `MAIL_HERO_NATIVE_BACKUP_ENABLED` | `MAIL_HERO_CF_API_TOKEN`, `MAIL_HERO_RECEIVE_ADDRESS`, `MAIL_HERO_ACCESS_OWNER`, `MAIL_HERO_ACCESS_OWNER_ALIASES` |
| Website release/relay | Website's settings stay in its workflow/config; optional `WEBSITE_BOOTSTRAP_APPROVAL` for an empty release registry | `CF_API_TOKEN`; release additionally uses `WEBSITE_NOTION_TOKEN`, `WEBSITE_NOTION_DATA_SOURCE_ID`; relay retains its existing Worker secrets |
| Links, Watch deploys | Committed app configuration; owner pause settings remain app-owned | `CF_API_TOKEN`, `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` |
| `Recall deploy` | Committed config and `BUILD_SHA` from the release commit; no switch | `CF_API_TOKEN`, `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES`; the machine tokens' digests are put from the owner's machine only, never through GitHub |
| `Fleet deploy` | Committed config and `BUILD_SHA` from the release commit | `CF_API_TOKEN`, `FLEET_ACCESS_OWNER`, `FLEET_ACCESS_OWNER_ALIASES`, `FLEET_REPORT_HMAC_KEY` |
| `Dashboard deploy` | Required boolean `DASHBOARD_CANARY_ENABLED` | `CF_API_TOKEN`, `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES`, `DASHBOARD_CF_ANALYTICS_TOKEN` (separate least-privilege read-only token; [setup](../dashboard/docs/setup.md) §4) |
| `VPS deploy` | `VPS_DEPLOY_ENABLED`; dispatch may explicitly select resume | `PLATFORM_ACCESS_CLIENT_ID`, `PLATFORM_ACCESS_CLIENT_SECRET`, `PLATFORM_DEPLOY_TOKEN`; no SSH or Kubernetes credential |

[Website release](../.github/workflows/website-release.yml) keeps its separate `website-production`
concurrency and publication identity/rollback flow. CI dispatches it after the gate; relay buttons and
scheduled reconciliation use that same path. Site publishing does not release unrelated applications.

Mail Hero's [native backup](../mail-hero/docs/native-backup.md) executes in its existing Cloudflare DO/R2
and ships through `Mail Hero checks/deploy`. Recovery tests require GnuPG and synthetic fixtures.
The v1 collector, its image and its workflow are retired; old GHCR images and existing v1 ciphertext are left in
place, and the offline tools still verify and restore v1 bundles.
Neither Newsletter nor the Platform observer claims backup coverage through process health.

recall builds no image: its Worker writes the archive to the owner's Dropbox itself (recall/docs/design.md §7.2), and
the NAS syncs it with its own Dropbox support. Its former NAS container and image workflow were removed on 2026-10-11
before they were ever published.

## VPS releases and runtime verification

Newsletter and the platform daemon are independent images built from the same release SHA.
`Newsletter image checks` and `Platform checks` save their tested image tar, source SHA, archive checksum
and local image ID. Main publishes exactly those artifacts with [image.py](../tools/container-release/image.py);
it does not rebuild during publication. Same-SHA branch reuse requires both non-expired artifacts.
A missing artifact runs fresh checks; disappearance after selection fails publication.

`VPS deploy` starts only after both digest publications and `CI gate`, on main, with repository variable
`VPS_DEPLOY_ENABLED=true`. [deploy.py](../tools/vps-release/deploy.py) calls the shared-proto daemon API through
Cloudflare Access. Production secrets are `PLATFORM_ACCESS_CLIENT_ID`, `PLATFORM_ACCESS_CLIENT_SECRET`
and `PLATFORM_DEPLOY_TOKEN`. No SSH key, cluster token, privileged kubeconfig or shell command is sent.
The stable release UUID binds frozen targets to a source SHA. API acceptance is only the start: the client
waits for a durable ready receipt and independently verifies fresh actual Pod/process provenance.
A held release fails Actions and stays visible in Fleet. A main dispatch for `platform`, `newsletter` or `codex-gateway`
may set `resume_vps_release=true` and `resume_source_sha` to that original release's full SHA. It checks the
current client source without rebuilding or publishing images, fetches the authenticated release's original
frozen targets and continues with its current etag. Physical verification still compares those original
digests/source/request identities. A normal release forbids `resume_source_sha`; repeated creation does not
silently resume or replace existing targets.

For paired releases, the daemon first suspends the daily trigger and freezes Newsletter's existing durable drain. Unknown
work requires investigation; no timeout forces a replacement or replay. It persists progress before
self-update, resumes active checkpoints on startup, applies the new version's standard Kustomize resources,
and verifies real image IDs, observed generations and baked process SHA/request identity. Only then does
it activate the resources, resume Newsletter and declare ready. A failure before resume preserves the
closed gate; a lost resume response can leave admission open, which is reported separately from the
held release rather than guessed or forcibly reversed.
Schema-incompatible rollback and an unstartable controller image remain explicit recovery operations.

Initial k3s/systemd installation requires one reviewed, pinned owner bootstrap with sudo; routine
application and observer releases use the API. GitHub's gated `Infra apply` creates only the new managed
Access identities and dedicated daemon HTTP Tunnel; the Kubernetes API is not routed. A one-time CMS
recipient encrypts bootstrap credentials before an artifact leaves the runner. Its private key stays with
the owner; no raw provider output or plaintext credential is uploaded. See [rebuild](rebuild.md).

[content-config.yml](../.github/workflows/content-config.yml) publishes independently validated editorial
bundles to `published`; the existing isolated config-sync process downloads those bundles. This is content
configuration, separate from executable/infrastructure deployment. The k3s daily CronJob is the configured
scheduled path, suspended until release verification completes. [newsletter-daily.yml](../.github/workflows/newsletter-daily.yml)
is an optional preparation-only caller, with no send schedule. It still requires a separately configured,
Actions-reachable HTTPS `NEWSLETTER_SERVICE_URL` and editor token. This migration does not connect or
verify that manual workflow: Newsletter's Service is internal ClusterIP, and the dedicated daemon Tunnel
exposes the runtime/release API, not Newsletter's `/v1/runs`. An old URL cannot be assumed to keep working.
Newsletter retains its locked external wire runtime and private drain/monitor JSON adapters;
its generic runtime API uses the root proto. Service migration and live provider acceptance are recorded
separately in HANDOFF, not inferred from a successful image build.

## Other release paths

Neither a published image nor a successful Worker upload proves a VPS update, a complete backup or live business
success. Release probes share [production.sh](../tools/deploy-probes/production.sh) and
[access.sh](../tools/deploy-probes/access.sh), with each application retaining its own config, credentials, wrapper and expected paths.

The old generated-config rollback procedure is retained in [history](history.md#committed-config-rollback).
Follow the current application runbook and HANDOFF before attempting a rollback.

Tasks' deploy waits for Todofy's when both changed: Todofy serves the Mail entry Tasks binds, and stops calling Tasks
before Tasks stops serving the call.
