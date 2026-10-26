# Planning readiness and task navigation

Plan Review uses the existing Parked area for work ready to arrange. A task appears there when all of its
prerequisites are complete, or its Deadline's start-ahead window has opened, including an overdue deadline.
An empty dependency list is not a trigger. Plan hides explicit Waiting/Blocked tasks and tasks with unfinished
prerequisites, including their descendants. They stay stored, with their stages and queues intact; there is no
Waiting column. Active tasks do not resurface. Existing recurrence completion semantics are unchanged.

This is derived from the same task read, without a scheduler, database migration or automatic task writes.
An existing planning stage remains saved, although the card appears in Parked until picked up. Its dates,
children, completion history and Focus queues are unchanged. A task satisfying both conditions has one card,
with its deadline taking precedence as the reason. Automatic cards appear before the manual backlog and
remain visible; only manual Parked cards fold after the first three. Waiting items are omitted from Review,
Week commitments, step/Quick trays and calendar cards. This is only Plan visibility; Focus retains its original
queues and records. A prerequisite completion makes the newly ready task visible in Parked on the next read.

Start acknowledges a surfaced task with the existing Active flag. Dragging it to a planning stage writes
that stage and Active together. The condition then stops surfacing it on reload. This uses the same
acknowledgement as the former Start now lane. A manual drop into Parked still sets the Parked flag and clears
the stage and Active; dragging a manually parked task out clears that flag. No separate Start now column is shown.

Focus's today view counts unarranged ready tasks by deadline or completed-prerequisite reason. A task counts
once, and not when it or an open descendant is in the displayed week's queues. Its hint opens Plan Review,
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
