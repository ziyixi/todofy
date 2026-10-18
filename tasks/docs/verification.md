# Tasks verification

## Native refinement and conversion, October 18

Implementation `77edb46915f6939675fa98e011dd21516738fdff` passed the complete
[branch CI 39086347716](https://github.com/ziyixi/todofy/actions/runs/39086347716). The
[same-SHA main 39086983750](https://github.com/ziyixi/todofy/actions/runs/39086983750) verified the Cloudflare
releases, including Tasks → FlowDay → Todofy → Home. The whole main run failed its separate VPS job at
`RELEASE_HELD`, following the earlier `UNAVAILABLE`; the held server release was not resumed.

The [old-version maintenance release 39085839713](https://github.com/ziyixi/todofy/actions/runs/39085839713)
completed before final metadata capture. All three live pause switches were true, and the in-flight Mail
write count was zero. Actual Tasks, FlowDay, Core and gateway build identities and migrations were checked
before applying the private conversion files.

- Every planning-state row matches the frozen original choices, field by field. There are no orphan state rows.
- Exactly the planned technical labels and replaced filters were soft-retired. Their task memberships were
  removed; the ordinary labels and filter remain. The task count was unchanged across conversion.
- Imported filter colors were filled only where empty, including the retained historical filter rows.
- Every matched, still-pending legacy Mail entry remains visible. Already handled legacy summaries were marked
  triaged; existing task IDs were retained. New native processing saves a taskless summary; conversion is an
  explicit owner action. No real Mail was converted or deleted for acceptance.
- In actual owner Chrome, FlowDay showed **Tasks connected**, **no API key needed** and **Sync complete**.
  The native pending-feed marker was absent and its cursor present. Every queue row, completed-queue row
  and time reference matches the private pre-conversion baseline, including ordering and timestamps.
- Actual Tasks settings show an enabled native plan with no connection inputs or mapping confirmation. Plan
  and Focus load without errors. Mail loads its first 50 rows, offers pagination and has no task checkboxes.
  These checks did not edit real tasks, move cards, start timers or open real mail summaries.

[Todofy-only restoration 39087810767](https://github.com/ziyixi/todofy/actions/runs/39087810767) passed in full,
Deployment `7148606156`. The three actual switches are back to their recorded false values. Independent
provider comparison verified the declarations and persistent resources of all five Workers. Owner
`serviceStatus` returned build `77edb469`, zero active jobs and an armed future Alarm; `VerifyPlanStore` returned
the expected state rows and zero orphans. The authenticated old `/plus` bookmark redirects to Tasks settings.

| Worker | Verified version after restoration |
| --- | --- |
| Tasks | `2e13fcad-76f2-49a7-8272-56a40fee77df` |
| FlowDay | `d64d3066-3014-47f2-83dd-060f597634b0` |
| Todofy Core | `7b24c25b-c43d-40cd-9757-2059a510d98a` |
| Todofy gateway | `e0b7e560-45ef-47ec-9366-7fcd44958956` |
| Home | `884554ee-e99a-4561-977f-2b987ee50588` |

No post-resume natural taskless summary had completed at this metadata observation. The taskless pipeline
has actual isolated Worker/D1 coverage; it is not reported as real incoming-mail acceptance. No mail was
manually injected, recomputed or converted to create that evidence.

The local evidence below uses synthetic data. Desktop installation of the PWA remains the owner's browser
action; browser installability and reconnect/offline behavior passed in an isolated profile.

## Initial native source, October 17

The initial native Tasks, FlowDay, Todofy and Home release ran `86bb978621c81ce09b1355c4fd931b4f7e8e028e`.
The original Todoist account was read for migration and UI comparison, without modifying its tasks.

- [Full branch CI 39076491784](https://github.com/ziyixi/todofy/actions/runs/39076491784) passed.
- [Same-SHA main 39077273261](https://github.com/ziyixi/todofy/actions/runs/39077273261) released Tasks →
  FlowDay → Todofy → Home successfully. Its unrelated VPS job failed `UNAVAILABLE`; the whole run is not green.
- [Todofy-only 39078766543](https://github.com/ziyixi/todofy/actions/runs/39078766543) succeeded and restored the
  original maintenance, processing and source-write pauses to false. Live status independently confirmed them.
- The final private source snapshot has an empty post-export Sync delta. Every project, section, label, filter,
  task resource and completion occurrence matches it by identity and digest. Parent/project orphan counts are
  zero. Historical label names no longer in the source catalog have recovered native identities.
- Planning's final identity preflight matched zero rows, so no provider SQL was executed. FlowDay completed
  its bounded native sync. Queue and time-reference multisets are unchanged, including preexisting historical
  cache gaps. The initial cache included every active external ID.
- With owner permission, one synthetic production task was created, edited, reloaded and soft-deleted.
  Readback confirms exactly one such row and its soft-delete. Imported tasks were not edited for acceptance.
- The desktop PWA manifest is served behind owner Access. Disposable Chromium installability APIs pass;
  offline reload gives an honest notice, private CacheStorage stays empty and reconnect returns to Today.
  Installing into the owner's desktop remains a user action.

Source import count checks precede subsequent ordinary native mail creation. They describe that frozen
migration, not a permanently fixed task count. Private snapshots, SQL and API outputs remain outside GitHub.

## Refinement local evidence

These are the local checks behind the October 18 release. All local task content, mail and credentials are synthetic.

- Tasks Worker: lint/types, 2 units and 29 real workerd/D1 cases pass. Atomic duplication copies full text and
  active descendants, excludes completed descendants, sits below the original and replays one copy after a
  lost response. Atomic reordering verifies all supplied etags before changing any position; a stale or missing
  row leaves the whole batch unchanged. The 100-task/full-description CPU case remains within the existing budget.
- Tasks web: lint/types/build, 19 units and the final combined 30-case Chromium run pass in a UTC browser.
  Coverage includes persisted CRUD,
  colors/property menus, right-click operations, complete/reopen inside a parent, dates across daylight saving,
  Markdown, chronological Upcoming, real drag persistence, search refresh without blank rows, responsive
  360–1440px editing/Plan and sidebar width persistence. The PWA case uses its own disposable profile.
- The first branch CI caught the account/browser timezone boundary after UTC midnight. Quick Add, Upcoming
  and date labels now use the account calendar. A new UTC-browser/Pacific-account case verifies the stored
  task date and Upcoming request, alongside the existing persisted CRUD scenario. It releases the real catalog
  response only after Quick Add starts, so the editor cannot freeze a browser-local date during startup.
  The combined 30-case run passes in 36 seconds.
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

## Native planning and Mail conversion method

The owner requires GTD status to be native planning facts, not hidden technical tags. `0009_native_plan.sql`
adds explicit state in Todofy. Public planning replies use stage/area/lead and fixed status fields; ordinary
Tasks labels stay separate. The native settings UI no longer offers label mappings or extension credentials.

The operator sequence was: pause existing writers; capture final private metadata and conversion SQL; publish the same green
SHA; seed planning state, retire only exact replaced native label/filter IDs, then mark initialization and
restore the recorded switches after verification. The read-only preview listed the saved planning states, the technical
labels and the replaced filters. The remaining filter does not reference those labels. Legacy Mail candidates
with matching summaries stay visible for owner triage; unrelated or previously handled items are not reopened.
The final capture's matched entries are verified above. Existing tasks
are retained. New mail remains taskless until the owner converts it. Old Todoist is unchanged.

After migration 0002, source colors were copied into imported filters only where the new color was empty.
The source snapshot was not re-imported over native owner writes.

## Earlier release corrections

Refinement branch [39085010635](https://github.com/ziyixi/todofy/actions/runs/39085010635) was held before
production. Its protocol guard rejected relaxing old required inputs; three additive native Mail RPCs now
reuse the existing handlers and receipts while retaining those contracts. It also found an old FlowDay binding
assertion, two retired-host Mail fixtures affected by omitted empty fields, temporary macOS screenshot paths,
and the calendar mismatch above. Follow-up [39085815272](https://github.com/ziyixi/todofy/actions/runs/39085815272)
confirmed the old contracts and Mail cases, then exposed the still-early Quick Add and the gateway's 86 KiB
review budget. Quick Add now awaits missing account settings; the native Mail schema measures 86.2 KiB gzip,
so the reviewed budget is 87 KiB, with no platform-limit change. A new full branch gate is required.

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
