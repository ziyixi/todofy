# Handoff

Updated 2026-10-30 UTC. Read [AGENTS](AGENTS.md), then the target application's README/rules.
Current work is unreleased; historical waiting lists are not instructions. Documentation entrypoints are in
[docs/README](docs/README.md).

## Current work: Bazel migration

Branch `codex/bazel-app-entrypoints`, [PR #10](https://github.com/ziyixi/todofy/pull/10).
The owner requested the entire monorepo's generation, builds, tests and packaging in Bazel, affected-target CI,
removal of superseded build/check code, and a concise audit of every doc/note/README. Application root BUILD files
must expose their complete final artifact. Do not narrow completion to the already released foundation.

Implemented:

- App root artifacts, public `:check`/`:config`/`:release` facades, internal import-based libraries, scoped proto
  generation, fixed toolchains and imported existing pnpm/uv/Go locks. No vendored third-party source or paid cache.
- One native Target Determinator comparison for affected test leaves and actual release inputs. Main publication
  remains cumulative after failed releases; independent units, image pairing, explicit resume and same-SHA artifact
  reuse are retained. Actions keeps credentials, per-app locks, dependency ordering and provider verification.
- Compiled Worker upload with no publisher rebuild; exact OCI/ZIP promotion; explicit prepared-content Website build;
  Bazel VPS bootstrap/operator entrypoints. Root CI now has check/artifact matrices and the existing production jobs.
- Old path classifier, application check Actions, separate validation workflow, duplicate generators, custom pytest
  shards/merger and Dockerfile build paths are replaced. Node/Makefile aliases use the canonical targets; native
  Linux container tests include the original isolated real-k3s SSA assertions, not a skipped fixture placeholder.

Local evidence so far:

- Proto's generated files, source wheel and Bazel wheel agree; schemas/wire/Python bytes remain unchanged. IDL comment
  cleanup changes only corresponding generated comments. Real materialization, generation determinism, lint/breaking
  negative cases and the proto check closure pass.
- All 38 Python workerd files: 365 cases passed, zero skips. Tasks' 37 browser files/158 cases pass. Other original
  unit/type/lint/runtime/CPU/bundle-limit checks have run; individual fixture/namespace omissions found by clean/Linux
  runs were corrected without loosening limits or production types.
- All 13 Worker application archives build together from a new output base. Three Linux OCI archives pass the original
  offline probes. Bootstrap outputs match the original renderer byte-for-byte, including the empty gateway case.
- Native repository/config/pipeline audits pass locally. Real Git/Bazel graph comparisons prove source-only,
  unconsumed-document and release-input-only selection. An isolated, frozen-lock Notion SDK upgrade selected only
  Website and shared audits, with no unrelated application tests or release; its synthetic unit tests also ran.
- All 558 original Node test/spec files and 258 Python test files map to actual runner invocations. All 930 current
  non-manual test targets are reachable from public check facades. Runtime prompts, frozen fixtures and limits stay.
- All 233 original doc/note/README entries were reviewed. Current runbooks and app READMEs are condensed, retired
  instructions removed, and dated evidence links to fixed originals. File and heading links and command labels were checked.
- The full native Linux run for the preceding core snapshot passed all eight check groups, seventeen artifacts and
  CI gate. Final cleanup, source-coverage fixes and the native k3s fixture still require the final branch gate.

Still required before completion:

1. Run native Linux CI on the final branch SHA, including the independent real-k3s fixture; fix genuine failures.
   The earlier green snapshot does not prove these last changes.
2. Merge the checked source, wait for all selected main publications and matching Personal cloud reconcile, and
   verify resolved drift. During this first cutover, old last-good revisions lack Bazel archives: if an app has not
   completed its first native publication, continue that normal release rather than rebuilding the old revision.
3. Archive completed migration detail only after acceptance. The goal remains active until the full scope is verified.

No installed Chrome/phone extension, private content, model selection, budget, operational switch or credential is
changed by this migration. Use synthetic fixtures; do not manually recompute business content for acceptance.

## Latest verified release

Bazel foundation `6368d063`: both check workflows and the matching main Personal cloud reconcile succeeded.
This verifies the foundation, not the unreleased full migration above. Earlier business releases and their dated
acceptance are in [October 29](docs/history/handoff-2026-10-29.md) and [history](docs/history.md).

## Separate acceptance and follow-ups

- Natural Newsletter/send/researcher runs, daily/weekly backup observations, Recall cold archive reads and a complete
  clean-account/clean-VPS historical restore remain distinct from this build migration. Follow their app verification
  pages and [rebuild verification](docs/rebuild-verification.md); do not infer them from uploads or replay real work.
- Recall phone acceptance is paused by the owner's choice. Existing stopped scheduler observations remain stopped.
  Do not ask for device reinstallation or restart retired Compose services for this task.
- Model Router's Ops implementation currently reports maintenance in `modes` while deriving health from request/backup
  signals; that differs from the general ops-v1 maintenance/down rule. Documentation records the difference. Any
  behavior correction is a separate change, not a hidden part of build/doc cleanup.

## Operating boundaries

The root [architecture](docs/architecture.md), [CI/CD](docs/ci-cd.md), [Bazel](docs/bazel.md), [resource catalog](docs/service-catalog.md)
and [rebuild](docs/rebuild.md) guides are current entrypoints. Application runbooks own their specific recovery and
runtime semantics. Historical releases are indexed in [history](docs/history.md).

Keep the dated [old-client compatibility windows](docs/history.md#owner-api-compatibility), frozen webhook/schema bytes,
resource identities and database migrations. Dates do not authorize automatic data deletion or early route removal.
