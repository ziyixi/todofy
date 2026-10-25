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
The destination was confirmed empty for 2026 before applying the prepared SQL. Both pre-release and immediately
pre-import Time Travel bookmarks were recorded. The source text, URL and raw operator output are excluded from
this public record.

## Release

The first candidate `46839255` reached 140 passing browser cases but its remaining Goals case stopped while writing
a QA screenshot to a Mac-only `/private/tmp` path on the Linux runner
([run 40170239106](https://github.com/ziyixi/todofy/actions/runs/40170239106)). No production release was attempted.
The screenshot now uses Playwright's standard per-test output path; the focused three-case journey passes again.
The corrected implementation `fd4a82c109f9d25e903f9f058bd5e286a8b0ddc0` passed
[full branch CI 40171075047](https://github.com/ziyixi/todofy/actions/runs/40171075047) and the
[same-SHA main release 40171731163](https://github.com/ziyixi/todofy/actions/runs/40171731163).
Only Tasks and Personal MCP deployed; the latter receives the additive Tasks proto/client change, with no new
tool catalog or plugin-permission request.

| App | Verified GitHub Deployment | Cloudflare version |
| --- | --- | --- |
| Tasks | `7309929919` | `c19ef834-faef-4d3d-a567-febb33002e79` |
| Personal MCP | `7309935989` | `20548e78-102e-4fff-ba67-8e6c402bded9` |

Direct Cloudflare readback matched both build SHAs. Tasks retained database
`79a1f345-1183-46c3-bc6a-651be106f90c`, jobs namespace `7d90ef3fb1d44ac591a3b21c99fdcccc` and the existing
`tasks-backups` bucket. No persistent resource was replaced.

## Production import and UI proof

After deployment, the authenticated production GoalCatalog returned 2026 with zero Objectives/KRs. The committed
generator's private INSERT-only file was then applied. Wrangler returned successfully; its file-import console
format was not JSON despite the requested flag, so the local receipt parser stopped. The SQL was not repeated.
Actual owner API readback confirmed four Objectives and 12 KRs before acceptance continued.

All four full Objective definitions and all 12 full KRs were privately compared against the prepared source:
titles, descriptions, parent/year, Floor, target, rule/notes, kind and source URL matched with zero mismatches.
Every result was incomplete with no milestones or focus, and all 12 progress lists were empty. This imports
plans without inventing achievements or selecting priorities for the owner.

The canonical before/after Plan snapshots matched (Bets/text/etags/associations, lane orders and next-week choices).
Task counts and catalog IDs/revisions also matched. The importer changed no existing task or weekly plan.

The deployed Goals page showed four Objective tabs, accessible KR choices and source links without horizontal
overflow. The actual exploration view had neither bounds nor a result score. Opening Add task from Goals and its
picker showed 13 choices (12 KRs plus No goal); the draft was closed unsaved, so no production test task was
created. The production page's console had no errors. The proof image contains only the Goals/year header,
not private OKR text. The actual private Goal page is retained for the owner.

After readback, the owner-only plaintext input, SQL and bookmark files were deleted and the private temporary
directory removed. Original Notion content remains intact; ongoing definitions/progress live in Tasks. The first
natural production weekly backup containing Goals remains unobserved; local backup/restore coverage passed.
