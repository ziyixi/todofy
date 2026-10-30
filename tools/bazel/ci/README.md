# Bazel migration validation

The planner discovers every public `:check` facade through Bazel visibility, covering app and package roots,
proto, tools and infra. Private worker/web suites stay behind their app's facade. It expands these roots to leaf
test targets before asking Target Determinator which leaves changed. CI runs only those affected leaves.
Apps continue through their existing CI until their complete Bazel checks replace it.
`ci.yml`, production credentials, tested release artifacts, deployment ordering and reconcile are unchanged.
The owner waits for both `CI gate` and `Bazel migration gate` during this stage.

`plan.py` delegates graph comparison to the fixed [Target Determinator v0.34.0](https://github.com/bazel-contrib/target-determinator/tree/v0.34.0)
binary. It does not maintain a path-to-application impact map. A branch uses its merge base with `origin/main`;
main uses the newest ancestor whose own Bazel check gate passed. A failed release does not invalidate that check
evidence. Missing evidence, dispatch, or a baseline without `MODULE.bazel` selects every current check leaf.
If the baseline query predates a newly added suite, Target Determinator also selects all checks. A current-graph
or comparison failure fails planning. Manual tests stay outside this workflow.

The selected tests run in groups: Node, Python, Go, browser, workerd, CPU, and generic build checks. Tags `cpu`,
`browser` and `workerd` take priority over the language. Each group uses one Bazel invocation with a target-pattern
file. Workerd, CPU and browser tests run one target at a time; the other groups run at most four tests together.
CPU tests always receive `--nocache_test_results`. Other tests use the Bazel action cache. Repository and
action caches are saved with the fixed dependency inputs and runner group in their key.

The workflow verifies fixed SHA-256 values for Bazel 9.3.1 and Target Determinator before execution. Its token is
read-only and only the planner uses Actions read access to find successful check evidence. Whole-module generation
lifecycle, determinism, mutation self-tests and the existing Git-base breaking gate remain in the original CI
during migration; the new `bazel run //proto:breaking -- BASE` entrypoint has also been checked locally.

Local entrypoints, with the two fixed binaries on `PATH`:

```sh
python3 -m unittest discover -s tools/bazel/ci
python3 tools/bazel/ci/plan.py --output /tmp/bazel-plan.json
python3 tools/bazel/ci/run.py --plan /tmp/bazel-plan.json --group python
```

Use `--base COMMIT` for a deliberate local comparison. Planning against an existing Bazel base requires a clean
checkout, as Target Determinator does. Both scripts accept `--bazel` and repeated `--bazel-startup-option` arguments
for isolated local servers.
