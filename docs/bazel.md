# Bazel migration

Bazel is being introduced for the repository's builds, tests, generators and packages. Actions continues to own
production credentials, publication, deployment ordering and reconcile. Existing checks remain authoritative for
an application until its complete Bazel path is verified and replaces them.

## Dependencies

Third-party source is not vendored. Node dependencies keep the root pnpm catalog and lock; Python dependencies keep
the root uv workspace and lock. Bazel imports these resolutions. Go's API linter keeps its existing module sums.
The fixed Bazel version is in `.bazelversion`; rule versions and module resolution are committed in `MODULE.bazel`
and its lock. Base images use digests. A normal check must not resolve new versions or rewrite locks.

The first implementation preserves Node 26.9.0, pnpm 11.25.0, TypeScript 6.0.3 and Python 3.14.7. Python's standalone
toolchain explicitly selects the official 3.14.7 archives and checksums because the rule's default version table no
longer includes that patch. It does not use the developer's Python installation. The OCI rule is fixed at the
registry's 2.3.0 release; the initially proposed GitHub 2.3.3 release was not available in that registry.

Upgrade the existing dependency declaration and its lock together, then run the affected targets. Update Bazel
rules explicitly, refresh their lock with `bazel mod deps --lockfile_mode=update` and commit it with them. Ordinary
commands use `--lockfile_mode=error` so checks cannot silently update module resolution. No automatic dependency upgrades, extra dependency mirror,
remote execution service or paid cache is introduced.

## Target boundaries

An application's root BUILD is its public entry point. For Tasks, `bazel build //tasks` creates the complete
release archive; `//tasks:config` exposes committed deployment inputs and `//tasks:check` collects its declared
tests. Worker and frontend implementation targets stay inside the application. CI selects affected leaves from
that check closure instead of unconditionally executing the whole suite. Building configuration never applies it
to Cloudflare or the VPS; publication remains an Actions operation.

Libraries follow actual imports. Existing circular imports stay in one library rather than being changed during
the build migration. Individual unit-test files depend on their source closure; runtime tests that bundle a whole
Worker correctly depend on that whole bundle. A frontend bundle remains one final application build.

Proto targets belong to their IDL package. They read that package's descriptor/import closure and write generated
files into Bazel outputs. The custom wire profile, Python dataclasses, HTTP metadata and frozen contract bytes are
preserved. Consumers assemble only the proto runtime and packages they use under the existing npm import paths.

Source libraries and declaration outputs are distinct where TypeScript crosses package boundaries. Tests and build
actions declare their fixtures, configuration, assets, npm links and native tools; they do not read a local
`node_modules` or virtualenv. Bazel's test adapters preserve the existing Vitest/pytest configuration and sandbox file
semantics without changing production loaders.

The following paths have run successfully during the migration:

```sh
bazel test //proto:tests
bazel test //packages/task-dates:dates_test
bazel test //tasks/worker:planning_test
bazel test //tasks/worker:runtime_tasks_test
bazel test //tasks/web:src__dates_test
bazel test //newsletter:tests //platform:tests //codex-gateway:tests //todofy:tests
```

The last command currently covers the declared offline Python tests, including Todofy's host unit tests. It does
not replace Todofy's workerd checks or prove a VPS image or production release. The original non-Bazel proto
generation entry remains available while applications migrate.

## Checks and caches

The migration workflow has no production credentials or release steps. It groups affected tests by execution
environment rather than starting a runner for each file. Target Determinator compares Bazel graphs between Git
revisions; the planner only selects the baseline and groups its result. A baseline without a Bazel graph checks all
targets currently covered by that workflow. A failed deployment does not invalidate an otherwise successful Bazel
check baseline.

Actions retains the pinned tool downloads and Bazel disk/repository caches. macOS and Linux caches stay separate.
CPU tests are selected with the `cpu` tag and execute without reusing test results; `workerd` and `browser` identify
their integration environments. Publication and live-state checks always execute. Git identities enter the final
release layer, not every library or ordinary test.

## Migration status

The toolchain/proto foundation has passed Linux CI and the matching main reconcile. Application roots and release
archives are implemented, with the existing unit, runtime, browser and container checks moving into their check
closures. Worker archives have been dry-run locally without rebuilding; website content remains an explicit input.

The legacy workflow is still active while website/extension checks, Python workerd coverage and repository audits
finish. The remaining cutover connects Bazel's exact artifacts to the existing publication gates, then removes the
superseded build/check recipes. [HANDOFF](../HANDOFF.md) records current work and verified boundaries.

Each application's cutover must pass its main release and matching reconcile. A successful local target, a successful
image build and an observed production rollout remain separate evidence.
