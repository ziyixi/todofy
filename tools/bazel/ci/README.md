# Affected checks and releases

`plan.py` discovers public `:check` facades, expands their leaf tests, and reads release metadata from application
root BUILD files. Fixed Target Determinator compares the union in one native graph operation. It emits compatible
test groups and selected releases; it contains no file-to-application dependency map.

Each public release filegroup includes its real archive, own publication wrapper/action and shared release tooling:

```starlark
filegroup(
    name = "release",
    srcs = [":tasks", "//tasks/deploy:deploy_vars", "//tools/cloud-release:release_inputs"],
    tags = ["release:worker:tasks", "artifact://tasks:tasks"],
    visibility = ["//visibility:public"],
)
```

Release kinds are the ones CI currently uses: `worker`, `image`, `extension`, `website`. Independent Recall Worker/ZIP
and Website site/relay inputs have independent filegroups. Test and source dependencies remain in their actual
libraries; release groups add the execution inputs publication consumes.

`releases.py` supplies the Actions decisions: cumulative successful-main base, explicit application dispatch, existing
Newsletter/Platform pairing, held VPS resume and exact-SHA green branch artifact reuse. Reuse requires all producers
and their unexpired artifacts. It skips neither the current cumulative check plan nor production verification.

`run.py` executes one affected group with Bazel. Node/Python/Go checks run up to four at once; workerd, CPU, browser and container
groups run one at a time. CPU test results are not reused. Repository/action caches are separate by execution group
and platform. Browser environment preparation is an explicit CI step; owner browser profiles are never used.

```sh
python3 -m unittest discover -s tools/bazel/ci
python3 tools/bazel/ci/plan.py --output /tmp/bazel-plan.json
python3 tools/bazel/ci/run.py --plan /tmp/bazel-plan.json --group python
```

Manual dispatch uses `--app all`, `--app both` (Todofy and Mail Hero), or one catalog app. Its checks include that
application's public root plus shared proto/package/tool/audit/infra roots. Newsletter and Platform retain paired
checks; a Codex gateway resume also checks Platform source. `--resume-vps-release` excludes container tests and image
release facades before the TD comparison, so continuing a held release builds no replacement image. The full release
catalog remains available to the publication helper.

For release selection, resolve a cumulative base and pass `--base COMMIT` plus
`--release-input-query 'attr(tags, "release:", //...)'`. The root CI workflow contains the full invocation. A clean
checkout and the pinned Bazel/Target Determinator binaries are required. Current-graph failures stop planning;
a baseline predating the new roots selects all candidates rather than silently omitting them.

The real Git/Bazel/Target Determinator fixture verifies source-only, unused-document, release-input-only and image
changes, worker dispatch isolation and resume source checks. Its image actions deliberately fail if built, so the
resume acceptance also proves that no image action ran.
Other tests cover grouping, cumulative publication retry, paired images, resume and artifact reuse. See
[CI/CD](../../../docs/ci-cd.md) for publication gates and runtime verification.
