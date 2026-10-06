# CI and releases

This is the detailed release reference moved from the root README. Start with
[HANDOFF](../HANDOFF.md) for work in flight and [architecture](architecture.md) for service boundaries.
The workflow and [ci_changes.py](../.github/scripts/ci_changes.py) own job names, dependencies and
reachability. The [service catalog](service-catalog.md) supplies the application inventory; this document
explains the release guarantees rather than maintaining another application or dependency map.

[Rebuild](rebuild.md) covers a new account/VPS. The reusable [Worker release](../.github/workflows/worker-release.yml)
keeps each application's checks, migration order, probes and release lock. A selected source checkout and
`BUILD_SOURCE_SHA` let repair publish the app's last verified revision. GitHub deployment success is recorded
after the actual provider version/configuration or VPS running identities pass verification.
The static website retains its independent content registry, release and rollback workflow.

[Personal cloud reconcile](../.github/workflows/personal-cloud-reconcile.yml) checks daily and after successful
main CI. Dispatch `check`, `repair` or an explicit VPS `resume`. Automatic routine repair requires
`PERSONAL_CLOUD_AUTO_REPAIR=true`. Sensitive infrastructure changes use a saved encrypted plan,
an `infra-review` reviewer gate, and the existing production secrets; no secrets are copied to the review
environment. The apply reacquires the infrastructure lock and refuses a changed SHA/state/plan.

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

`CHECK_ONLY` in the classifier explicitly freezes new applications before their resources are ready.
While Fleet is in that set, both Fleet and Home deploy outputs remain false, including dispatch, full-run
and same-SHA reuse. Complete the reviewed Access bootstrap, commit its real AUD/identity configuration and
remove that explicit freeze together before enabling those releases. A placeholder dry-run is not evidence
that the production identity exists.

| Job | Checks or release responsibility |
| --- | --- |
| `Changes` | Runs the `.github/scripts` tests (among them [app isolation](../.github/scripts/test_app_isolation.py): every catalog app's imports resolve only to itself, `proto/`, `contracts/`, `packages/`, and `tools/` from tests and build/deploy scripts; the website uses only `proto/`) and shared deployment-tool tests, validates catalog/public config, then classifies the cumulative diff. Python 3.11+ is required; locally use `uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts`. Dispatch options, `CHECK_JOBS` and release conditions are tested against the workflow. |
| `Shared packages` | Locked install, typecheck and tests for the independent `packages/*/` consumers. |
| `Todofy static checks`, `Todofy runtime (1/3)`–`(3/3)`, `Todofy checks` | Host/gateway/UI checks, dry-runs and bundle/CPU budgets; real-binding tests in balanced shards with completeness and serial-test guards. All required shards must pass. |
| `Mail Hero checks`, `Dashboard checks`, `Lab checks`, `FlowDay checks`, `Links checks`, `Watch checks` | Each application's config/wrapper checks, lint/typechecks, synthetic unit and real-binding runtime tests, UI build and production-config dry-run. Existing app-specific CPU, bundle and query budgets stay in their own jobs/runbooks. |
| `Fleet checks` | Worker and UI lint/typecheck/tests, real SQLite DO signed-receipt runtime tests, UI build, config/wrapper checks and dry-run bundle budget. The observer's Python tests run with Platform, not from a retired Fleet host executable. |
| `Website checks` | Synthetic Notion/source fixtures, static export and Playwright, relay/release tests and both Worker dry-runs; no production content or credentials. |
| `Contracts` | Generated schemas, frozen golden bytes, both sides' consumer tests and Home's generated Ops caller. Mail receipt legacy compatibility, task-intent value rules and Ops fixtures remain checked. Apps' own jobs run real-binding tests. |
| `Proto checks` | Pinned tools, format/lint/API lint, IDL and wire-profile breaking checks, deterministic generation, schema freshness, both language codecs and import reachability. `PROTO_READS`, `PROTO_USERS` and `PROTO_PACKAGES` are the checked trigger map, including Fleet's transitive Platform runtime descriptions and Platform's Python report/error codecs. Test-only/type-only files do not implicitly deploy consumers. See [proto](../proto/README.md). |
| `Infra checks` | Structural safety guards, `tofu fmt`, locked-provider initialization without backend credentials, `tofu validate`, plan-summary/local-values/export tests and static Wrangler/output consistency. No provider token, state or production plan is read. |
| `Newsletter checks`, `Newsletter image checks` | Locked engine/unit/synthetic model checks, build smoke checks, then build linux/amd64 and test the exact image ID/configuration. Save the tested image tar and identity/checksum manifest as a one-day artifact. |
| `Platform checks` | Locked Python lint/tests of daemon, observer and release/build tools; compile standard Kustomize assets, build linux/amd64 and test the exact image's dependencies, source identity and observer imports without network. Save that tested image and manifest as a one-day artifact. |
| `CI gate` | Fails on any required failed/cancelled job. Unchanged jobs or explicitly verified same-SHA reuse may be skipped. **The one check to require on main.** |
| `Newsletter image publish`, `Platform image` | After main's gate and the required successful checks or verified same-SHA reuse, load and publish the tested artifacts to the catalog's image repositories. Publication does not rebuild or prove a VPS rollout. |
| Cloudflare app deploy jobs | After main's gate and app checks: build the verified UI, write private values, dry-run, enforce hostname safety, apply only the app's required D1 migrations and deploy its committed config. Each app retains its production probes and concurrency group. |
| `Dashboard deploy` | Also waits for Todofy, Mail Hero, Lab, Watch and Fleet deploys to succeed or be skipped. Its `FLEET`/`NEWSLETTER` service bindings require Fleet's `Ops`/`NewsletterOps`; the bootstrap freeze prevents deploying these before Fleet exists. |
| `VPS deploy` | After both image publications and the gate, when `VPS_DEPLOY_ENABLED=true`: call the daemon's shared-proto release API and verify the durable result and fresh physical provenance. See the VPS section below. |

On main, the diff base is the last successful push run of this workflow; failed/cancelled releases do not
lose their changes. Branch checks compare with the merge base against `origin/main`. No usable base runs
all checks and computes all releases, subject to bootstrap freezes and production enablement gates.
The first full run does not override those gates.

Main may reuse a green branch push run of the **same SHA** only when `Changes`, `CI gate` and every needed
check job succeeded, including every matrix shard. Its checked image publications also require both
same-SHA, non-expired artifacts. An API error, missing/skipped required check, different SHA or manual run
runs checks again. Reuse changes neither deploy selection nor the cumulative main base.

A package change checks and deploys its actual `PACKAGE_USERS`; a Markdown-only package change checks
those consumers without deploying. Contract runtime values deploy only `BUNDLED_BY` consumers; schemas
and fixtures still trigger checks. Generic CI/check tooling checks applications without deploying them.
Explicit image build/publication/VPS release tooling changes release the paired Newsletter and Platform
images. A Dashboard-only change does not redeploy its Ops providers. Root documentation alone runs
`Changes` and the gate. These rules are tested against dependencies/imports, including proto import closure.

Production job conditions retain `!cancelled()` and explicit successful dependency results. A reused check
can be skipped only with `checks_reused=true`; Home's upstream deploys may succeed or be skipped. Relying
on implicit `success()` would incorrectly skip deployments when an unrelated ancestor is skipped. The
workflow tests also enforce production concurrency, dispatch options and existing contract test paths.
[Document-reference tests](../.github/scripts/test_doc_references.py) catch nonexistent migration files.

## Cloudflare ownership and release protection

[Infra drift](../.github/workflows/infra.yml) is a read-only main/production plan using encrypted remote
state and `infra-production` concurrency. It fails on planned drift or public outputs inconsistent with
committed configuration. Its log is a redacted summary; it does not apply and is outside `CI gate`.
[Infra apply](../.github/workflows/infra-apply.yml) is the sole infrastructure writer: a manual main dispatch
with the same environment/concurrency, exact reviewed actions and plan fingerprint, applying the saved
plan. New bootstrap credentials are encrypted before leaving the runner. See [infra](../infra/README.md).

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

### Production environment

Production jobs use the `production` environment, restricted to main. Owner identities, receive addresses
and project IDs are secrets too: this public repository's Actions logs expose plain step variables.
The workflow is authoritative for optional inputs and their exact wiring.

Fresh bootstrap validates complete app secret maps from [worker-secrets.json](../tools/cloud-config/worker-secrets.json)
and sets the corresponding `<APP>_WORKER_SECRETS` production secrets. Existing deployments keep the individual
inputs below and preserve unreadable runtime secrets when no full map is supplied. A full map is an explicit
replacement input and must contain every declared required secret. [Bootstrap](../tools/cloud-bootstrap/README.md)
also initializes missing operational variables without overwriting existing pause or maintenance values.

| Job | Variables | Secrets |
| --- | --- | --- |
| `Todofy deploy` | `TODOFY_REMINDER_ENABLED`, `TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED`, `TODOFY_FORCE_PAUSE_TODOIST`, `TODOFY_GTD_REVIEW_ENABLED` | `CF_API_TOKEN`, `TODOFY_ACCESS_OWNER`, `TODOFY_ACCESS_OWNER_ALIASES`, `TODOFY_TODOIST_DEFAULT_PROJECT_ID`; optional `TODOFY_TODOIST_OPS_PROJECT_ID`, `TODOFY_TODOIST_REVIEW_PROJECT_ID` |
| `Mail Hero deploy` | `MAIL_HERO_FORCE_SEND_PAUSED`, `MAIL_HERO_MAINTENANCE_MODE`, `MAIL_HERO_NATIVE_BACKUP_ENABLED` | `MAIL_HERO_CF_API_TOKEN`, `MAIL_HERO_RECEIVE_ADDRESS`, `MAIL_HERO_ACCESS_OWNER`, `MAIL_HERO_ACCESS_OWNER_ALIASES` |
| Website release/relay | Website's settings stay in its workflow/config; optional `WEBSITE_BOOTSTRAP_APPROVAL` for an empty release registry | `CF_API_TOKEN`; release additionally uses `WEBSITE_NOTION_TOKEN`, `WEBSITE_NOTION_DATA_SOURCE_ID`; relay retains its existing Worker secrets |
| Lab, FlowDay, Links, Watch deploys | Committed app configuration; owner pause settings remain app-owned | `CF_API_TOKEN`, `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES`; respectively `LAB_CSRF_SIGNING_KEY`, `FLOWDAY_CSRF_SIGNING_KEY` + `FLOWDAY_CREDENTIAL_KEY`, `LINKS_CSRF_SIGNING_KEY`, `WATCH_CSRF_SIGNING_KEY` |
| `Fleet deploy` | Committed config and `BUILD_SHA` from the release commit | `CF_API_TOKEN`, `FLEET_ACCESS_OWNER`, `FLEET_ACCESS_OWNER_ALIASES`, `FLEET_REPORT_HMAC_KEY` |
| `Dashboard deploy` | Required boolean `DASHBOARD_CANARY_ENABLED` | `CF_API_TOKEN`, `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES`, `DASHBOARD_CSRF_SIGNING_KEY`, `DASHBOARD_CF_ANALYTICS_TOKEN` (separate least-privilege read-only token; [setup](../dashboard/docs/setup.md) §4) |
| `VPS deploy` | `VPS_DEPLOY_ENABLED`; dispatch may explicitly select resume | `PLATFORM_ACCESS_CLIENT_ID`, `PLATFORM_ACCESS_CLIENT_SECRET`, `PLATFORM_DEPLOY_TOKEN`; no SSH or Kubernetes credential |

[Website release](../.github/workflows/website-release.yml) keeps its separate `website-production`
concurrency and publication identity/rollback flow. CI dispatches it after the gate; relay buttons and
scheduled reconciliation use that same path. Site publishing does not release unrelated applications.

Mail Hero's [native backup](../mail-hero/docs/native-backup.md) executes in its existing Cloudflare DO/R2
and ships through `Mail Hero checks/deploy`. Recovery tests require GnuPG and synthetic fixtures.
The [legacy collector image workflow](../.github/workflows/mail-hero-backup-image.yml) is manual-only;
no push automatically publishes a VPS collector. Existing v1 ciphertext and recovery tools remain compatible.
Neither Newsletter nor the Platform observer claims backup coverage through process health.

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
A held release fails Actions and stays visible in Fleet. A main dispatch for `platform` or `newsletter`
may set `resume_vps_release=true` and `resume_source_sha` to that original release's full SHA. It checks the
current client source without rebuilding or publishing images, fetches the authenticated release's original
frozen targets and continues with its current etag. Physical verification still compares those original
digests/source/request identities. A normal release forbids `resume_source_sha`; repeated creation does not
silently resume or replace existing targets.

The daemon first suspends the daily trigger and freezes Newsletter's existing durable drain. Unknown
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

Mail Hero's collector image is likewise independent from its Worker. Neither a published image nor a successful
Worker upload proves a VPS update, a complete backup or live business success. Release probes share
[production.sh](../tools/deploy-probes/production.sh) and [access.sh](../tools/deploy-probes/access.sh), with each
application retaining its own config, credentials, wrapper and expected paths.

The old generated-config rollback procedure is retained in [history](history.md#committed-config-rollback).
Follow the current application runbook and HANDOFF before attempting a rollback.
