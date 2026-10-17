# Tasks verification

## October 17 local implementation

All task content and credentials in tests are synthetic. Real Todoist was inspected without modifying tasks.
The task editor was compared with the logged-in Todoist interface and checked in Chrome against a separate
local Tasks instance.

- Tasks Worker: lint/type checks, 2 unit cases and 19 real workerd/D1 cases passed. These cover saved CRUD,
  exact request replay, reference checks, parent moves independent of insertion order, section moves,
  archive/delete semantics, ordinary/concurrent append order and real CPU measurements.
- Tasks web: lint/type checks, 8 unit cases and 8 disposable Chromium cases passed. Browser cases verify
  lost-response Quick Add, persisted edits/completion/reopen, nested tasks, recurrence preview, independent
  deadlines, timed-date changes across daylight saving, label selection, compact layout, real drag persistence,
  batch completion and PWA installation criteria.
- Desktop PWA: the real Chromium manifest/installability APIs report no errors. Offline reload shows a clear
  offline message, CacheStorage remains empty and reconnect/reload returns to Today. No owner Chrome profile
  was used by automated tests.
- Shared planning: 6 package cases passed; the unchanged extension host passed its 307 unit cases. The
  previously completed packaged-extension browser run passed 62 cases. Native task mutations now revalidate
  mounted planning content; no polling was added.
- Home: Worker types/lint and 268 unit cases passed. The full workerd run passed 93 cases; four old expected
  registry/count fixtures were updated and all 22 cases in the affected files then passed. Home web passed
  types/lint, 158 tests and production build.
- Repository guards: 453 cases passed, one skipped. Root proto formatting/lint, API lint for 71 files and
  generated schema checks passed. Bootstrap passed 38 cases, including a fresh-process CLI invocation.

These are local results, not a production release claim. After the last edits, affected checks must rerun
before the same green SHA is released through Actions. Private real-data export, import verification, source
activation and production UI/Plan/Focus acceptance remain separate steps.

## Provisioned resources

The infrastructure bootstrap created Tasks' empty D1 database and owner Access application. The following
read-only plan returned 41 no-ops. The application-specific GitHub production secret is configured; unrelated
credentials were retained. No task schema or real task data has been imported into that database yet.

## Pending acceptance

1. Finish and verify accessible Todoist archive/completion-history export privately.
2. Compare hierarchy, dates, labels, filters, completion counts and planning/time identities.
3. Pass branch CI and publish the same SHA; verify Access, build identity, Home status and PWA on the live host.
4. Pause/drain project-owned writers, perform the final import and in-place planning identity switch, then
   activate Tasks as the source for Todofy and FlowDay together.
5. Verify normal task, planning, timing and mail behavior without rewriting original Todoist data.

No source fallback or production cutover is implied by the new service's presence in the registry.

## First branch CI

[Run 39070976415](https://github.com/ziyixi/todofy/actions/runs/39070976415) checked `4895d4a5`.
Tasks and the shared UI consumers passed their own checks. The full gate failed on missing fixture/deployment
enrollment, two outdated proto self-test edit anchors, HCL alignment, native test dependency installation and
FlowDay's first native decode CPU. These have local fixes and need a new full CI run. The CPU test keeps the
same 100-task workload and limit; the existing startup warm-up now includes the native read codecs.

Further native regressions found and fixed an incorrectly placed budget bypass, stale Todoist auth/throttle
state affecting native operations, and loss of the local date for late-evening tasks. The final Python unit
run passed 1,994 cases. Root guards passed 453 with one skip; proto self-tests report zero unexpected verdicts.

Read-only real-source preparation validated full-project and archived-section response shapes. A full-span
Activity request returned 400; an otherwise identical seven-day request returned a paged result. Export now
uses bounded windows and includes separately archived-section tasks. No real source task was changed. A
complete private snapshot and its import validation are still pending; successful endpoint reads do not
establish migration completion.

## Second branch CI and source preflight

[Run 39071963810](https://github.com/ziyixi/todofy/actions/runs/39071963810) checked `865ac940`.
Every application check, all Python runtime shards, infrastructure and contracts passed. The remaining
failure was one explicit app list in the proto test, now extended with Tasks and verified by its 20 cases.
The complete gate must pass on the next SHA before release.

A private source snapshot was saved locally with owner-only permissions; the one-off loopback exporter was
stopped afterwards. Its original API values and all data remain outside GitHub. Preflight now preserves two
historical label names whose original IDs are no longer available, supports the actual next-N-days filters,
and treats completed state snapshots separately from Activity occurrences to avoid duplicate history.
Unsafe numeric Activity IDs are read losslessly using Node's native JSON parser context.

Reference, filter and coverage checks pass. The February policy for `every 30th` was subsequently resolved
by the owner and verified below. No real data has been imported or source switched. Two other observed
recurrence forms have focused date-package regressions. Tasks UI now passes ten actual browser scenarios;
Markdown renders in a separate 46.41 KiB gzip chunk, and the initial application bundle remains about 117 KiB.

## Final source preflight

The owner selected February's last day for `every 30th`, returning to day 30 in other months. Preview,
leap-year and advancement cases pass. The private snapshot now has zero import issues and zero coverage
gaps. Its prepared SQL imports into a private local SQLite database, repeats without duplicates and has no
orphan parent references. This is a local data check, not production D1 acceptance. Plan identity preflight
also reports no issues; all currently active FlowDay external IDs are included in the imported identities.

The earlier pending date-policy question is resolved. Source data remains unchanged and production is not
switched. A fresh snapshot is still required in the controlled final migration window. The extension's CI
reload failure was a real early-render race: delayed preferences now load before the first Plan render.
Its deterministic mount regression and all 62 packaged browser cases pass. Native Plan view/checklist state
also persists locally using the shared bounded validator. Proto's remaining Python app-list assertions were
updated; all 113 Python cases pass.

Upcoming date headings now sort chronologically, with undated groups last and each day retaining the chosen
task order. A real D1/browser case reproduced the reversed headings before the fix, then passed after it;
all 12 UI unit cases, types, lint and build pass.

The final complete Tasks browser run passes all 11 cases against ephemeral workerd/D1 and disposable Chromium.

## Staged main release

[Full branch CI 39074838356](https://github.com/ziyixi/todofy/actions/runs/39074838356) passed on `7eae7465`.
[Same-SHA main 39075576241](https://github.com/ziyixi/todofy/actions/runs/39075576241) uploaded Worker
`734fd419-398f-4d70-8feb-4e08e42636f0`; migration, provider build identity and unauthenticated Access probes
passed. The final configuration check correctly refused four undeclared fields because the drift generator
had not enrolled the Tasks deployment wrapper. Adding those standard declarations makes an independent live
comparison report zero differences; the next normal Actions release must record the verified deployment.
The same main run also failed its automatically triggered VPS release with `UNAVAILABLE`. This is separate
from the Cloudflare task-source cutover, and the entire main run is not green.

Todofy confirms the staged SHA and all three existing migration pauses, with no active work or reserved
tokens. The final read-only source export is running. Native source activation and live migration acceptance
remain pending.

## Final production import

The final paused read-only export passed coverage/reference/date/filter checks and a subsequent source Sync
delta contained no changes. The prepared file's largest statement is 4,774 bytes. The locked Wrangler file
import completed against the confirmed empty Tasks D1, with diagnostics kept privately.

Separate production queries exactly match the frozen import digest and every expected identifier: 22
projects, 3 sections, 27 labels (including 2 recovered historical names), 12 filters, 2,644 task resources
and 2,824 completion occurrences. Parent/project orphan counts and non-import request counts are zero.
The final planning metadata dry run reports zero matched rows and zero issues, so no provider SQL was run.
All active FlowDay external IDs are included; its 55 distinct queue and 28 distinct timing task references
match the earlier baseline. Preexisting historical references without cached task rows are retained.

The seven-way compound identity query was refused by real D1 (`too many terms in compound SELECT`); separate
per-table reads pass. The runbook uses the seven separately verified locked-Wrangler commands, with every
result kept privately. The loopback exporter was stopped and its in-memory credential released. No original
Todoist task was modified. Native consumer activation and post-switch acceptance remain pending.
