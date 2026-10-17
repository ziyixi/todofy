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
