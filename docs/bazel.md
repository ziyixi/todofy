# Bazel

Application roots are the public build interface. `bazel build //tasks` produces the complete Tasks release;
`bazel test //tasks:check` checks it. Frontend, Worker, shared-library and generated-code targets underneath retain
fine-grained dependencies for caching and affected-test selection.

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

Migration and release acceptance are recorded in [October 30 history](history/handoff-2026-10-30.md#full-bazel-migration).
[HANDOFF](../HANDOFF.md) tracks current work and separate business/recovery checks.
