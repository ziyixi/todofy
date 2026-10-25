# Tasks Goals rollout

The owner approved the Goals design, requested implementation with Plan/Task/Step links, and authorized importing
the current-year Notion OKR. Work uses `/private/tmp/todofy-tasks-design`, away from Claude's shared checkout.

## Implemented

Goals is part of the existing Tasks Worker, D1 and UI. Annual Objectives, KRs and dated progress use three tables;
current focus is a month range/text on a KR. Weekly Bets and Tasks can select a KR; Steps inherit their direct
parent's reference. Result milestones and completion are manual and independent of task execution. Goal history
loads only in Goals; the small catalog loads on Goals or explicit picker opening.

The owner API is generated from the root proto. New data/columns participate in weekly backup and restore; older
backups restore them empty. No new service, database resource, Notion token/sync, model call or schedule is added.
Behavior and operator commands are in [Goals](../tasks/docs/goals.md).

## Local evidence

- Backend: lint/typecheck, 72 unit tests and 142 real workerd/D1 runtime tests passed.
- UI: lint/typecheck, 96 unit/component tests, build and all 141 synthetic Chromium browser cases passed. A final
  three-case Goals rerun passed after adding the source-link fixture/layout.
- Shared planning: 327 tests and typecheck passed.
- Import/restore/deploy tools: 41 tests passed, including repeated Goal import preserving owner edits, progress
  and unrelated Tasks; archived Goal links and old backups round-trip.
- Existing list budgets remain 102/103 rows for the seeded first/later 50-row page, four for exact lookup;
  GetPlan remains three statements/nine rows. Existing ordinary-page request-count checks passed.
- Synthetic bounded Goal endpoints passed Workers Free CPU checks. The independent implementation run measured
  the worst first authenticated catalog at 8.15 ms and warm catalog at about 4.67 ms; these are local reference
  medians, not production latency guarantees.
- Production-config dry bundle: 164.0 KiB gzip within the unchanged 165 KiB app budget and 3 MiB platform limit.
  Goals UI is a separate 6.96 kB gzip lazy chunk. The entry plus shared runtime is approximately 343 kB gzip.

The completed-parent copy regression was reproduced and fixed before release. Independent review also corrected
manual refresh of related Tasks/Steps, stale reads after confirmed Goal saves, retained request identity for
toggle retries, and incorrect week-ended wording for unavailable KR selections. No general retry/rollback or
concurrency framework was introduced.

[Design QA](../tasks/design-qa.md#goals) passed after the Goal typography/layout correction. Its screenshots use
only synthetic definitions and progress. Native Chrome acceptance on the dedicated local preview saved a progress
note and completed a Step while keeping Goal milestone/completion state independent.

## Private import preparation

The source was freshly read through the existing Notion connection. Private conversion found four Objectives and
12 KRs, preserving all 27 original description/rule/target sections: ten Floor texts, eleven targets, and the
unscored exploration rule. Kinds are eight routines, three outcomes and one exploration. No actual progress was
available in the source, so the prepared input contains no milestones, focus choices, task links or completions.

The tested generator writes private INSERT-only SQL with stable source-derived identities. Its input/SQL are
outside Git with owner-only permissions. A D1 Time Travel bookmark was recorded before the schema release.
Destination-year preflight, application and API content/count readback remain pending. The source text, URL and
raw operator output must not be added to this public record.

## Release

The first candidate `46839255` reached 140 passing browser cases but its remaining Goals case stopped while writing
a QA screenshot to a Mac-only `/private/tmp` path on the Linux runner
([run 40170239106](https://github.com/ziyixi/todofy/actions/runs/40170239106)). No production release was attempted.
The screenshot now uses Playwright's standard per-test output path; the focused three-case journey passes again.
Full branch CI, same-SHA main Actions release, provider identity readback and private import acceptance are pending.
