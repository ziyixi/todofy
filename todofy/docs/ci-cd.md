# Todofy build and release

Todofy's public build entry is `//todofy`. It packages the Python core, TypeScript gateway, complete owner UI,
original Wrangler configs and migrations. `//todofy:check` is its full check closure; `//todofy:release` also declares
the scripts the publisher consumes. See the root [CI/CD guide](../../docs/ci-cd.md).

```sh
bazel build //todofy
bazel test //todofy:check
bazel test //todofy/tests/runtime:runtime_tests --local_test_jobs=1
bazel test //todofy/tests/runtime:test_routing
```

## Checks

Host tests cover the core, model fakes, contracts, migrations, production configuration and deploy values. The gateway
and UI keep their real typechecks, unit tests, runtime/CPU checks and original bundle budgets. Shared contract fixtures
retain their exact wire bytes and legacy validation verdicts.

Each Python workerd scenario file has a separate Bazel target. It starts the original gateway/core/Tasks harness with
real local D1, Durable Objects, alarms, cron, assets and synthetic upstreams. The pinned Node, workerd, Pyodide archive,
Python Worker SDK and compiled UI are declared inputs. There is no runtime `uv`/pnpm generation or live credential.

CI groups workerd tests serially and retains each test's native JUnit output. Collection/runtime skips fail these
runtime targets; a successful collect-only or warm-up is not a test pass. The former custom shard planner, duration
weights and JUnit merger are replaced by Bazel's named test targets and results. Existing assertions and timing
limits are unchanged.

## Publication

Only `main` can publish, after the same revision's CI gate, under `todofy-production`. Model Router releases first;
Todofy releases before Tasks, which binds its Mail entrypoint.

The shared Worker recipe checks source and actual configuration under the lock, then verifies/stages the tested
archive. Wrangler uploads the compiled core and gateway with `--no-bundle`; publication does not rebuild the UI or
regenerate Python modules. The core keeps the SDK version and artifacts in the existing `pylock.toml` contract.

The existing deploy wrapper still validates/injects operational variables and private inputs. Hostname guards run
before provider changes. D1 migrations and the core deploy precede the gateway; provider identity, machine-host health
and Access probes follow. A successful upload is insufficient: the matching main Personal cloud reconcile must
also pass.

The production sources remain `wrangler.toml` and `gateway/wrangler.toml`. Runtime tests use their existing local
configs. No build command applies production configuration. Recovery uses the shared recipe and last verified
source; data recovery remains in the [running guide](cloudflare-setup.md).
