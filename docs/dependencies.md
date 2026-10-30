# Workspace dependencies

Applications select their own dependencies. Common versions and resolution live at the repository root; Bazel
imports those locks for builds and tests. Third-party source is downloaded with integrity checks, not vendored.

| Ecosystem | Version declaration | Lock |
| --- | --- | --- |
| Node | Root pnpm catalog, Node 26.9.0, pnpm 11.25.0 | `pnpm-lock.yaml` |
| Python | Root uv workspace/constraints, Python 3.14.7 | `uv.lock` |
| Go API linter | Its existing `go.mod` | `go.sum` |
| Bazel and rules | `.bazelversion`, `MODULE.bazel` | `MODULE.bazel.lock` |

Node members use `catalog:` for external packages and `workspace:*` for shared repository packages. Python members
declare only the dependencies/extras they need. Do not add member lock files. The Python Worker retains its existing
`pylock.toml` runtime SDK contract; the VPS executor alone owns the subscribed Codex runtime.

## Build and check

With Bazelisk or the pinned Bazel binary on `PATH`:

```sh
bazel build //tasks
bazel test //tasks:check
bazel test //newsletter:check
bazel test //proto:check
```

These commands use declared toolchains and dependencies. A local Node install, Python virtualenv or browser profile
is not required for the builds/tests. The [Bazel guide](bazel.md) lists release targets and CI execution groups.

For raw-source development tools that need `node_modules` or an editable Python environment, installation still uses
the authoritative workspace locks:

```sh
pnpm install --frozen-lockfile
uv sync --locked --all-packages --all-extras
node proto/tools/ensure.mjs
```

The last command only materializes the existing Bazel-generated development files. Python's build backend consumes
the same providers; it does not run a second Buf/protoc generation chain. Production artifacts consume generated
providers directly. Release-tool installation disables lifecycle scripts and does not rebuild an application.

## Upgrade a dependency

For Node, edit the catalog and update `pnpm-lock.yaml` with pnpm. For Python, edit the root constraint and run
`uv lock`. Review the lock diff and run the affected Bazel checks. Keep member dependency lists accurate rather than
installing everything into every application.

For Bazel/rule upgrades, update the explicit pin, refresh with `bazel mod deps --lockfile_mode=update`, and commit the
module lock. Ordinary builds use `--lockfile_mode=error`. Browser/runtime executable downloads and OCI bases retain
explicit checksums/digests.

CI follows native dependency edges through these imported packages. It does not maintain a second manual version or
file-to-application map. Each production image is checked and published independently; runtime identity comes from
its release receipt and observed workload, not from a lock file alone.
