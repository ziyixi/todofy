# Planning readiness and task navigation

Plan Review uses the existing Parked area for work ready to arrange. A task appears there when all of its
prerequisites are complete, or its Deadline's start-ahead window has opened, including an overdue deadline.
An empty dependency list is not a trigger. Plan hides explicit Waiting/Blocked tasks and tasks with unfinished
prerequisites, including their descendants. They stay stored, with their stages and queues intact; there is no
Waiting column. Active tasks do not resurface. Existing recurrence completion semantics are unchanged.

This is derived from the same task read, without a scheduler, database migration or automatic task writes.
An existing planning stage remains saved, although the card appears in Parked until picked up. Committed work
is the exception: it stays in Committed with the same status and Start, as Week's commitments list it. Its dates,
children, completion history and Focus queues are unchanged. A task satisfying both conditions has one card,
with its deadline taking precedence as the reason. Automatic cards appear before the manual backlog and
remain visible; only manual Parked cards fold after the first three. Waiting items are omitted from Review,
Week commitments, step/Quick trays and calendar cards. This is only Plan visibility; Focus retains its original
queues and records. A prerequisite completion makes the newly ready task visible in Parked on the next read.

Start acknowledges a surfaced task with the existing Active flag. Dragging it to a planning stage writes
that stage and Active together. The condition then stops surfacing it on reload. This uses the same
acknowledgement as the former Start now lane. A manual drop into Parked still sets the Parked flag and clears
the stage and Active; dragging a manually parked task out clears that flag, and adds Active in the same write
when its window has opened or its prerequisites are complete, so it does not come straight back. No separate
Start now column is shown.

Focus's today view counts unarranged ready tasks by deadline or completed-prerequisite reason, among the tasks
Plan shows (not under a waiting task). A task counts once, and not when it or an open descendant is in the
displayed week's queues. Its hint opens Plan Review,
shows all areas and focuses Parked. The hint does not schedule work or send a timed notification.

Task details keep editable Depends on and add read-only Dependents. Clicking a dependent opens it. The native
GetTask reply includes the active, unarchived dependent IDs and titles through the existing prerequisite index;
ListTasks does not expand reverse links, and the section performs no additional request. Plan reuses its
already-loaded dependency graph. Removed edges and deleted, completed or archived dependent tasks are not shown.

Explicit Save closes a task opened from a main view. Saving a task, Subtask or Step opened from another task
returns to that previous task with a fresh read. Only one editor is mounted. Description Done saves inline;
an unchanged explicit Save does not write. Failed saves keep the editor and draft. A delayed reply from an
editor already closed cannot close or replace a newer editor.

Verification uses synthetic tasks: readiness before/after the last prerequisite, deadline boundaries,
one-card deduplication, acknowledgement after reload, unchanged dates/queues, read-only reverse links and
Save return navigation. Tests live in the shared planning suite, Tasks' real D1 planning/copy/read-budget
tests and `tasks/web/test/browser/planning-readiness.spec.ts` plus `task-editor-save.spec.ts`.

Steps, Standalone and Quick share the estimate panel in Plan and Focus. Each also exposes its optional
estimate in task details; a save keeps the same execution kind, parent, flags and calendar clock.
Quick's configured date/time remains editable; calendar
cards show the configured wall-clock time in the task's timezone (otherwise the account timezone), else the
estimate. An untimed Quick without an estimate shows Quick instead of an unknown duration, and missing Quick
estimates do not count as unknown.
No default duration is invented, and stored estimates, queue dates and recorded time remain intact.

Task deletion confirmations focus their Delete action: Enter activates that button, Escape cancels the
confirmation and returns focus to its trigger. These keys are scoped to the confirmation, so they do not
submit the underlying task form or close its editor. Pointer deletion keeps the same confirmation.

This behavior is deployed from `f3a689fa519977f824b3045b4649fff6d9c5cc94`. The complete branch gate,
same-source production release and matching configuration reconcile passed. Dated evidence is in
[refinement verification](refinement-verification.md#2026-10-26-planning-and-task-details).

Tasks was subsequently republished with the same behavior in monorepo source `42897d14`. The
[main release](https://github.com/ziyixi/todofy/actions/runs/40259875945) and
[matching reconcile](https://github.com/ziyixi/todofy/actions/runs/40260037384) passed; verified Worker version
is `f9b85a6d-6e94-4e1f-a3ce-beca97913e3d`.
