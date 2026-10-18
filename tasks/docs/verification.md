# Tasks verification

## Live native source, October 17

Native Tasks, FlowDay, Todofy and Home are running `86bb978621c81ce09b1355c4fd931b4f7e8e028e`.
The original Todoist account was read for migration and UI comparison, without modifying its tasks.

- [Full branch CI 39076491784](https://github.com/ziyixi/todofy/actions/runs/39076491784) passed.
- [Same-SHA main 39077273261](https://github.com/ziyixi/todofy/actions/runs/39077273261) released Tasks →
  FlowDay → Todofy → Home successfully. Its unrelated VPS job failed `UNAVAILABLE`; the whole run is not green.
- [Todofy-only 39078766543](https://github.com/ziyixi/todofy/actions/runs/39078766543) succeeded and restored the
  original maintenance, processing and source-write pauses to false. Live status independently confirmed them.
- The final private source snapshot has an empty post-export Sync delta. Production identities/digest match:
  22 projects, 3 sections, 27 labels, 12 filters, 2,644 task resources and 2,824 completion occurrences.
  Parent/project orphan counts are zero. Two historical label names have recovered native identities.
- Planning's final identity preflight matched zero rows, so no provider SQL was executed. FlowDay completed
  its bounded native sync. Queue and time-reference multisets are unchanged, including preexisting historical
  cache gaps. Initial cache size was 836; all 106 active external IDs were included.
- With owner permission, one synthetic production task was created, edited, reloaded and soft-deleted.
  Readback confirms exactly one such row and its soft-delete. Imported tasks were not edited for acceptance.
- The desktop PWA manifest is served behind owner Access. Disposable Chromium installability APIs pass;
  offline reload gives an honest notice, private CacheStorage stays empty and reconnect returns to Today.
  Installing into the owner's desktop remains a user action.

Source import count checks precede subsequent ordinary native mail creation. They describe that frozen
migration, not a permanently fixed task count. Private snapshots, SQL and API outputs remain outside GitHub.

## Current refinement, local evidence

This refinement has not yet been published. All local task content, mail and credentials are synthetic.

- Tasks Worker: lint/types, 2 units and 29 real workerd/D1 cases pass. Atomic duplication copies full text and
  active descendants, excludes completed descendants, sits below the original and replays one copy after a
  lost response. Atomic reordering verifies all supplied etags before changing any position; a stale or missing
  row leaves the whole batch unchanged. The 100-task/full-description CPU case remains within the existing budget.
- Tasks web: lint/types/build, 19 units and the final combined 29-case Chromium run pass.
  Coverage includes persisted CRUD,
  colors/property menus, right-click operations, complete/reopen inside a parent, dates across daylight saving,
  Markdown, chronological Upcoming, real drag persistence, search refresh without blank rows, responsive
  360–1440px editing/Plan and sidebar width persistence. The PWA case uses its own disposable profile.
- Shared planning UI: 14 cases pass; the legacy host's 308 units pass. Native host browser coverage uses
  same-origin synthetic planning replies: fixed-stage dragging with no label mapping, explicit Quick state,
  Settings, Focus timer and Mail summary. It proves UI/transport usage, not production writes.
- Native backend: actual Python Core → private TasksApi → real D1 cases verify planning-state CAS/replay,
  stages/areas/Quick, independent deadline and lead, attached estimated steps and controlled Monday rollover.
  Physical task labels and unrelated fields remain unchanged. A normal Cron was not used for the clock test.
- Native Mail pipeline tests use no Tasks binding: successful summarization saves a taskless Mail item and
  completes processing. Conversion tests create one Inbox task after an explicit request, even without a Plan
  configuration or Inbox project resource. Lost replies replay the same task. Deleting Mail retains linked
  tasks; long text keeps its full summary accessible through a deep link. Old already-frozen writes retain
  their reconciliation path. These are disposable runtime tests, not real-mail conversion or deletion.
- Native Watch intents, reminders and weekly review tasks use the generic Inbox default. Explicit/frozen
  project choices remain. Real D1 tests cover unknown-write lookup, producer routing and GTD Inbox scopes.
- The final combined Python host check passed 2,190 cases with one existing skip for the absent separate
  legacy `protos` checkout. Scoped native backend, Mail, producer and planning checks pass; the branch gate
  must validate their combined SHA.
- Repository checks: 456 cases pass, one skipped. Proto format/lint, schema and API lint pass for 71 files.
  Existing shared extension browser regressions remain in CI while ZIP publication is removed.

Actual Chrome was used for comparison with the logged-in Todoist. Only public menu names, palette options
and theme styles were recorded. The native 20-color order, checked state, menu rows and priority flags were
matched. In a separate ephemeral Tasks instance, normal Chrome confirmed saved project/task/subtask edits,
right-click menus and 245→320px sidebar dragging/reload. The color menu was visibly clipped to about 167px;
fixed positioning restores its full 272px list/280px popup, covered by a regression. Screenshots contain only
synthetic data; see [design](design.md).

The combined browser run also exposed a focus race: closing the Project popup could force focus back after
Priority had opened, dismissing the new menu. Normal property menus now use Base UI's default focus check;
explicit context-menu anchors retain their return target. The original failing keyboard/project/priority
sequence passes without added delays or diagnostic code.

## Native planning and Mail conversion to complete

The owner requires GTD status to be native planning facts, not hidden technical tags. `0009_native_plan.sql`
adds explicit state in Todofy. Public planning replies use stage/area/lead and fixed status fields; ordinary
Tasks labels stay separate. The native settings UI no longer offers label mappings or extension credentials.

Before release: prepare private metadata and conversion SQL; pause existing writers; publish the same green
SHA; seed planning state, retire only exact replaced native label/filter IDs, then mark initialization and
restore the recorded switches. A read-only preview finds 310 saved planning states, 19 technical labels and
11 replaced filters. The remaining filter does not reference those labels. Of the legacy Mail candidates,
186 have matching summaries and can stay visible for owner triage; unrelated or previously handled items are
not reopened. Existing tasks are retained. These preview counts must be rechecked in the final paused window.
New mail remains taskless until the owner converts it. Old Todoist is unchanged.

Also pending after migration 0002: copy source colors into the imported filters only where the new color is
empty. Do not re-import the snapshot after native owner writes.

## Earlier release corrections

The first branch `4895d4a5` failed integration enrollment, fixtures and a FlowDay cold codec path. Later checks
fixed those issues without reducing the existing CPU workload. The full `7eae7465` branch gate passed.

Main [39075576241](https://github.com/ziyixi/todofy/actions/runs/39075576241) uploaded Tasks version
`734fd419-398f-4d70-8feb-4e08e42636f0` after migration/build/Access probes. Its final declaration check failed:
Tasks' deploy wrapper had not been enrolled in the drift generator, so BUILD_SHA was undeclared. Release
inputs already merge the secret fields; they were not four separate Action verifier failures. Wrapper
registration fixes the comparison, with zero differences, and the next normal release recorded success.

Real D1 rejected the seven-way compound identity read (`too many terms in compound SELECT`); seven separate
per-table reads succeeded. The [import runbook](import.md) uses that verified approach. Source Activity also
required bounded seven-day windows. Neither local SQLite acceptance nor an endpoint read alone established
complete migration; the final private coverage, identity and digest checks did.
