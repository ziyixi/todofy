# Bazel

Application roots are the public build interface. `bazel build //tasks` produces the complete Tasks release;
`bazel test //tasks:check` checks it. Frontend, Worker, shared-library and generated-code targets underneath retain
fine-grained dependencies for caching and affected-test selection.

## Package ownership

Each directory keeps its main interface. Implementation targets live beside the sources, tests or scripts they own:

```text
tasks/BUILD.bazel          tasks, check, config, release
tasks/web/BUILD.bazel      bundle, lib, typecheck, check
tasks/web/src/BUILD.bazel  source modules and colocated unit tests
tasks/worker/BUILD.bazel   lib, compiler/configuration inputs, check
tasks/worker/src/BUILD.bazel
tasks/worker/test/BUILD.bazel
```

Parent targets aggregate child targets through explicit labels. Related modules with a dependency cycle stay in one
source target. Generated proto outputs remain with their generator packages; output path components do not create
source packages. Existing public build and operator entrypoints stay available.

The shared definitions in `tools/bazel/` cover Python test runners, project-scoped JS/browser tests, Wrangler archives,
source copies and public source audits. BUILD files still declare business dependencies, fixtures and execution limits.
Test helpers' `project` is the original runtime working directory, independent of the test target's owning package.

Cross-package JS inputs use owning libraries or `copied_source_files`; the latter retains declaration files as data.
Compiler configs use owning `ts_config` providers. Public test aggregates use native `test_suite` targets. Audit groups
remain raw source collections and explicitly include child audits across package boundaries.

## Setup and dependencies

Install Bazelisk, or put the official Bazel version from `.bazelversion` on `PATH`. Bazelisk uses that version file.
The repository imports third-party dependencies rather than vendoring their source:

- Node versions live in the root pnpm catalog and `pnpm-lock.yaml`.
- Python versions live in the root uv workspace and `uv.lock`.
- The Go API linter keeps its module file and sums.
- Bazel/rules/toolchain versions live in `.bazelversion`, `MODULE.bazel` and `MODULE.bazel.lock`.
- Downloaded executables, browsers, runtime archives and OCI bases have fixed checksums/digests.

Ordinary commands use `--lockfile_mode=error`; they do not update dependency resolution. Upgrade a declaration and its
existing lock together. Rule upgrades explicitly refresh the module lock with
`bazel mod deps --lockfile_mode=update`. There is no paid remote execution service or extra dependency mirror.

Node remains 26.9.0 and Python 3.14.7. Python uses the pinned standalone archive, not a developer virtualenv. The Python
Worker keeps its own existing `pylock.toml` runtime contract. Package installation is separate from Bazel execution;
checks do not depend on a local `node_modules` or `.venv`.

## Targets

| Target | Result |
| --- | --- |
| `//tasks`, `//mailsort`, other Worker app roots | Compiled Worker, assets and deployment inputs in a release archive |
| `//newsletter`, `//platform`, `//codex-gateway` | Independent Linux OCI image archives |
| `//recall:worker_artifact` | Recall Worker/owner UI archive |
| `//recall:extension_artifact` | Chrome and Orion builds and their ZIPs |
| `//website` | Static export from an explicitly supplied prepared-content repository |
| `//website:relay` | Independent relay Worker archive |
| `//platform:bootstrap_bundle` | Fixed-source VPS installation bundle using published image digests |
| `//proto:materialized` | Existing generated TS/Python development files, from Bazel providers |
| `<app>:check` | Application check closure |
| `<app>:config` | Static configuration; no provider writes |
| `<app>:release` | Actual artifact plus its publication inputs, for CI selection |

Build images for the VPS with `--platforms=//tools/bazel/images:linux_amd64`. Actions stamps release outputs with the
checked source SHA. Ordinary local builds remain unstamped. Website publication supplies its validated snapshot;
the default unconfigured input deliberately fails when someone tries to build a production site without content.

Libraries follow actual imports. Existing circular imports stay together. Test files declare their source closure,
fixtures, config and tools; whole-Worker runtime tests depend on the whole Worker they execute. Tests keep their
original assertions and limits. Package-scoped proto providers preserve the wire profile and frozen contract bytes;
raw developer materialization and Python wheels consume those providers rather than running another generator.

## CI and caches

[CI/CD](ci-cd.md) describes publication. Changes discovers public check facades and compares native Bazel graphs with
fixed Target Determinator. Work is grouped into a small execution matrix. There is no handwritten file-to-app map.

Bazel caches reusable test/build actions; CPU and live integration checks execute as required. Source identities are
terminal inputs. Actions keeps repository/action caches by platform and execution group. Native browser tests use
declared browser archives and synthetic loopback fixtures, not the owner's installed browser or profile.

Host integration prerequisites, including Docker and the CI runner's kernel-policy check, are outside the app build
cache. Provider credentials, deployment locks, infrastructure apply, production verification and repair remain
Actions/operator operations. A successful build does not prove a live rollout.

The initial migration is recorded in [October 30 history](history/handoff-2026-10-30.md#full-bazel-migration);
[October 31 history](history/handoff-2026-10-31.md#bazel-package-ownership-and-shared-build-recipes) covers package ownership
and build-equivalence checks.
[HANDOFF](../HANDOFF.md) tracks current work and separate business/recovery checks.
