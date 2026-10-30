# CI and deployment

[Bazel](bazel.md) owns code generation, builds, tests and release artifacts. [CI and deploy](../.github/workflows/ci.yml)
selects affected targets, checks them, then publishes their artifacts on `main`. Actions owns credentials, production
locks, deployment ordering and live verification.

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
Go, browser, workerd, CPU, container and generic checks. It does not run an entire app because one test file changed.

Release targets include their production code, assets, static configuration and the publication scripts they use.
A test-only change does not publish the app. A deployment-script change selects its actual users. Independent units,
including Recall's ZIP and Website's relay, remain separate. There is no second path-to-application dependency map.

A branch compares with its merge base against `origin/main`. A `main` push compares with the newest successful main
workflow ancestor, so a failed publication remains in the next cumulative release diff. A manual dispatch checks the requested applications plus shared contract/tool/infrastructure roots, then selects
the requested publications. `all` checks the full graph. `both` means Todofy and Mail Hero; `all` means all declared
releases. Newsletter and Platform keep their paired image publication and VPS rollout.

Tests use Bazel's cache. CPU checks always execute when selected. Container probes, provider verification and live
publication checks execute each time; cached unit tests do not substitute for them. Browser archives, Python/Node
interpreters, generators, dependency resolutions and OCI bases are pinned. Ubuntu/Docker integration setup remains
an explicit CI environment requirement.

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
already-built ZIP bytes after checking the Chrome/Orion manifests and source identity.

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

Explicit VPS resume continues the daemon's held immutable release. It never builds or publishes replacement images.
The existing bootstrap, draining, admission and persistence rules continue to apply.

After merging the same green SHA, wait for its main publication **and** matching Personal cloud reconcile. A branch
check, image build or upload alone does not prove production is running the revision or that drift is resolved.

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
