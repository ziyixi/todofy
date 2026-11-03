# CI and deployment

[Bazel](bazel.md) owns code generation, builds, tests and release artifacts. [CI and deploy](../.github/workflows/ci.yml)
selects affected targets, checks them, then publishes their artifacts on `main`. Actions owns credentials, production
locks, deployment ordering and live verification.

## Workflows at a glance

| Workflow | Runs when | What it does |
| --- | --- | --- |
| [CI and deploy](../.github/workflows/ci.yml) | Every push; manual dispatch with `app` | Selected checks and artifacts; on `main`, the selected publications, the private application and Home |
| [Worker release](../.github/workflows/worker-release.yml) | Called by CI and by reconcile | One Worker's locked publication, verification and receipt |
| [Private Bazel](../.github/workflows/private-check.yml), [Private release](../.github/workflows/private-release.yml) | Called by CI (Private release also by Private operations) | Check and publish the pinned private source |
| [Personal cloud reconcile](../.github/workflows/personal-cloud-reconcile.yml) | After each successful `main` CI; daily (GitHub often starts it hours late); manual | Compares infrastructure, the VPS and resource registration, and in daily and manual runs every Worker; repairs only when asked or `PERSONAL_CLOUD_AUTO_REPAIR` is on; for any other infrastructure change, prints the Infra apply `expect` |
| [Newsletter Content Config](../.github/workflows/content-config.yml) | After each successful CI of a `main` push; manual | Validates the configuration in a released image and publishes the bundle when it changed (branch CI already validated it in the candidate image) |
| [Infra apply](../.github/workflows/infra-apply.yml) | Manual only | Applies one reviewed infrastructure plan |
| [Private operations](../.github/workflows/private-ops.yml) | Manual only | Private infrastructure, k3s, publication and verification operations |
| [Website release](../.github/workflows/website-release.yml) | CI's Website deploy, the relay Worker's daily dispatch, Home's 立即同步; manual | Notion snapshot, build, deploy and verification; unchanged content is not redeployed |

| I want to | Use |
| --- | --- |
| Release normally | Push to `main`; nothing to press |
| Republish one application | CI and deploy, `app=<name>` (`all` for every release, `both` for Todofy and Mail Hero) |
| Resume a held VPS release that CI started | CI and deploy, `app=platform` (`codex-gateway` for its own held release), `resume_vps_release` and the original `resume_source_sha` |
| Resume a held VPS repair that reconcile started | Personal cloud reconcile, `operation=resume` and its `resume_release` |
| Check or repair cloud drift | Personal cloud reconcile, `check` or `repair` (Fleet links it) |
| See the infrastructure plan | Personal cloud reconcile, `check`: its Infrastructure summary has the address table and the Infra apply `expect` |
| Apply an infrastructure change | Infra apply: `expect` from the Infrastructure summary of Personal cloud reconcile; `confirm_destructive` only for a reviewed delete, replace or forget; then reconcile `check` |
| Complete a Worker receipt | Personal cloud reconcile, `record` with `record_app` and `record_deployment_id` |
| Operate the private application | Private operations, choose `operation` |
| Update the website from Notion now | Home's 立即同步 |
| Recover or rebuild the website | Website release, `recovery` or `bootstrap` |
| Change Newsletter content | Edit `newsletter/content-config/` and push to `main`; after its CI passes, Newsletter Content Config publishes it when the bundle changed |
| Send the daily Newsletter | Nothing in Actions: the k3s `newsletter-daily` CronJob runs at 07:00 America/Los_Angeles |
| Know a delivery is done | CI for the `main` SHA is green (its release jobs verify each Worker they publish), and Personal cloud reconcile for that same SHA ran (not skipped because `main` moved on) and passed, including Require resolved infrastructure drift |

Beyond the reconcile's routine repair, Infra apply is the only write of `infra/` resources; see the
[infra README](../infra/README.md#apply-p4).

## Application entrypoints

Each application root BUILD exposes:

- `//tasks` (equivalently `//tasks:tasks`): the complete compiled release archive.
- `//tasks:check`: the application's test closure. Internal Worker/frontend targets stay inside the app.
- `//tasks:config`: committed deployment configuration and migrations.
- `//tasks:release`: the archive and the actual scripts/workflow used to publish it.

The same convention applies to the other applications. Recall has independent Worker and extension release inputs;
Website separates its prepared-content export from the relay Worker. Shared packages expose libraries and checks.
Building a configuration target never applies infrastructure or changes a running service.

## What runs

The Changes job discovers public `:check` facades and tagged release inputs. Fixed Target Determinator compares their
Bazel dependency graphs with the selected Git base. CI runs the affected **leaf tests**, grouped by Node, Python,
browser, workerd (three shards), CPU, container and generic checks. It does not run an entire app because one test file
changed.

Release targets include their production code, assets, static configuration and the publication scripts they use.
A test-only change does not publish the app. A deployment-script change selects its actual users. Independent units,
including Recall's ZIP and Website's relay, remain separate. There is no second path-to-application dependency map.

A branch compares with its merge base against `origin/main`. A `main` push compares with the newest successful main
workflow ancestor, so a failed publication remains in the next cumulative release diff. A manual dispatch checks the requested applications plus shared contract/tool/infrastructure roots, then selects
the requested publications. `all` checks the full graph. `both` means Todofy and Mail Hero; `all` means all declared
releases. Newsletter and Platform keep their paired image publication and VPS rollout.

Tests use Bazel's cache, which only `main` pushes save. CPU checks always execute when selected. Container probes,
provider verification and live publication checks execute each time; cached unit tests do not substitute for them.
Browser archives, Python/Node interpreters, generators, dependency resolutions and OCI bases are pinned.
Ubuntu/Docker integration setup remains an explicit CI environment requirement.

## Private checks

The reusable [Private Bazel](../.github/workflows/private-check.yml) workflow runs alongside public checks and is
required by `CI gate` for builds with private access. It checks out the exact `private/` gitlink recorded by the
parent revision, then builds `@private//:private` and tests `@private//:check` from the parent repository. Push the
private commit before updating the parent gitlink. Fork builds without private access skip this job; public checks
use the same public graph without an initialized submodule.

The private job restores the public Bazel cache but never saves a cache or uploads build/test artifacts. Public
cache producers run without the private checkout. Its Bazel output stays in a file on the runner because it names
private targets and prints failing test logs; the public log shows only fixed `PRIVATE_*` error codes for the
baseline, build, test and selection steps. Reproduce a failure locally with `bazel test @private//:check`.

Normal private publication is part of the main workflow. The pinned private check uses the same Target Determinator
and its release dependency graph to select it; documentation changes do not select publication. After the gate and
selected public publications pass, [Private release](../.github/workflows/private-release.yml) runs, then Home
publishes once. A private-only selection builds Home's public archive without private credentials. Branch checks
never deploy. An explicit `all` dispatch follows the same order; app-specific dispatches retain their scope.

Home and resource reconciliation generate their private catalogue from the selected source's exact gitlink.
The temporary file stays on the runner, is validated by Home's parser and is deleted afterwards. No catalogue
Secret update or second Home dispatch is required. Private source, configuration and build output remain outside
public artifacts and logs. Successful publication records its verified identity through GitHub Deployments.
The main-only `Private operations` workflow remains available for recovery and explicit operating commands.
Private infrastructure has its own reviewed plan/apply path; public resources keep their existing publication and
reconciliation owners.

## Checked artifacts

The credential-free artifact matrix builds only selected Worker archives, Linux OCI images and extension ZIPs.
Git identities enter terminal outputs; libraries and ordinary tests remain unstamped.

The `CI gate` requires Changes and every selected check/artifact group to succeed. Failure, cancellation or a skipped
required producer does not pass. On `main`, an exact-SHA green branch run can supply its still-available artifacts;
main still computes its cumulative check graph and uses Bazel's test cache. Missing or expired artifacts are built
again instead of being treated as reusable.

Worker archives contain compiled modules, all additional text modules, complete static assets, original Wrangler
configs and migrations. The publisher verifies the source identity, checksum and original config, then uses the
existing deploy wrapper with Wrangler `--no-bundle`. It does not rebuild the UI or recompile the Worker. Operational
variables and private inputs keep their existing injection paths. Unnamed provider/Gmail secrets remain untouched.

Each image publisher loads and verifies the exact tested archive before pushing it, then records a registry digest.
A Docker image ID is not a pullable registry digest. VPS releases receive the pullable digest. Recall publishes its
already-built ZIP bytes after checking the Chrome/Orion manifests and source identity, unless only the stamped version
differs from the latest release.

Website's separate release workflow reads and validates the current public content snapshot. Its Bazel root requires
that snapshot explicitly; an unconfigured build cannot silently produce an empty production site. No-change checks
skip publication. Artifact verification, live route/identity verification, release records and rollback remain in
that workflow. Its component code SHA follows the source/build closure declared by Bazel.

## Production ordering and recovery

Publishing is restricted to `main`, after the gate, under each application's existing production lock. Model Router
precedes its callers; Todofy precedes Tasks; Tasks precedes Watch; Home waits for the Ops/service entrypoints it binds.
Newsletter's independent image and Platform's image finish before their paired VPS release. The Codex gateway can
release independently. Website keeps its own content/publication lock.

The shared [Worker release recipe](../.github/workflows/worker-release.yml) selects source under the lock, compares
actual configuration, preserves owner pauses, runs hostname guards, applies the existing migrations, publishes and
verifies provider identities. Drift repair uses the last verified source and the same recipe; it can rebuild that
fixed source with Bazel without relying on an old Actions artifact still being retained.

Each app's `release-<app>` action writes and removes its own secrets file and runs only the probes that app alone has.
The steps the apps share (workspace install and config read in `worker-prepare`; dry run and bundle budget, hostname
guard, migrations and deploy, version and Access probes in `worker-deploy`) take the app's differences as literal
inputs. Todofy's two Workers and the website relay keep their own recipes, and the three VPS images share
`publish-image`.

Explicit VPS resume continues the daemon's held immutable release. It never builds or publishes replacement images.
The existing bootstrap, draining, admission and persistence rules continue to apply.

After merging the same green SHA, wait for its main publication **and** matching Personal cloud reconcile. A branch
check, image build or upload alone does not prove production is running the revision or that drift is resolved.
The reconcile after CI does not compare Workers: CI's release jobs verify the Workers it publishes, and every Worker is
compared in the daily run or a manual `check`.

## Local use

With the fixed Bazel version available on `PATH`:

```sh
bazel test //tasks:check
bazel build //tasks
bazel test //proto:check
bazel test //newsletter:check
```

For the affected plan, place fixed Target Determinator on `PATH` as well:

```sh
python3 tools/bazel/ci/plan.py --output /tmp/bazel-plan.json
python3 tools/bazel/ci/run.py --plan /tmp/bazel-plan.json --group node
```

The [dependency guide](dependencies.md) describes upgrades and the authoritative locks. Application runbooks describe
runtime behavior and recovery; they are not additional build/configuration sources.
