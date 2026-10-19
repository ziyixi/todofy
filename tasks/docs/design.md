# Tasks architecture and interface

Tasks is the owner's desktop task application and installable PWA. It keeps the familiar Todoist layout:
sidebar navigation, compact task lists and a centered task editor. Plan and Focus reuse the shared planning
components; Mail has its own taskless inbox. Comments, files, reminders, collaboration, external calendars and voice are
outside the approved scope.

## Service boundaries

| Component | Owns | Interface |
| --- | --- | --- |
| Tasks web | Navigation, draft forms, selection and rendered views | Generated `TasksUiService` client, same-origin owner requests |
| Tasks Worker and D1 | Task/Subtask and Step content, effort, catalog, dates and completion history | Root `proto/tasks/ui/v1`, named `TasksApi`, read-only `Ops` |
| Todofy | Mail, weekly choices, Bets, task dependencies and operation receipts | Named `Planning` binding, limited to the planning and Mail methods Tasks calls |
| FlowDay | Daily queues, time blocks, timers and time records | Named native Focus binding (task list, day queues and timer only); read-only task mirror |
| Shared planning UI | Plan, Focus and the optional Mail shortcut editor | Caller-supplied typed transport and navigation callbacks |

Applications do not import each other's source or databases. `packages/planning-ui` compiles into
Tasks; `packages/task-dates` supplies the date parser used by the Tasks Worker and import tools. FlowDay
receives read-only access to Tasks. Todofy receives the provisioned task API; other bindings are rejected.

Source selection is explicit; Tasks is the live task source after the verified import and consumer cutover.
A native consumer does not fall back to Todoist after an error. Existing FlowDay task IDs and planning internal IDs must survive cutover.

## Task interface

Task and Subtask share `kind=task`; their hierarchy describes outcomes. An executable Step is a generic Task
resource with `kind=step` and a Task/Subtask parent. A Step cannot contain children. Only Steps and Tasks
explicitly marked Standalone action enter the day calendar. Adding an ordinary Subtask does not make it a Step.
The editor separates Subtasks and Steps, with completion, reopening, deletion and Step estimates in each list.
Quick implies Standalone: new writes enforce it, and existing Quick state is projected as standalone without
a database backfill. Clearing Quick retains Standalone until it is explicitly cleared.

Main lists also expose collapsed child branches. Expansion reads the existing parent query in bounded
pages; the same row actions work for children. Today/search children already present in the root result
are not duplicated. Ordinary lists/counts omit Steps; parent, explicit-ID and `all` reads retain them.
Completed visibility follows the current view. Child refreshes retain the rendered
rows until their replacement arrives; collapsed branches make no background reads.

Row metadata separates native `#...` properties from real labels with a divider and tag icons. Planning
facts use bounded ID batches (100 per request), separately from the detail cache; a reserved text line
prevents asynchronous flag arrival from changing row geometry. Opening a child branch reads only that branch.
Task fields, effort and Deadline remain visible if the planning service is unavailable.

The parent editor also saves Subtask and Step ordering on drag/drop within each group. The drop line
supports insertion before or after another child and changes only `sort_order`. It uses custom child
order independently of the main view's sort selection; dragging cannot convert a Subtask into a Step.
Lists and child editors use the existing dnd-kit version. A six-pixel mouse movement starts a drag from
the title or row surface; other controls keep their ordinary clicks. A floating preview follows the pointer
and animates on drop. The handle remains for keyboard use. Main-list row edges insert before/after at
the target's parent level; the middle moves under that task and opens its child branch. Known descendant
targets are disabled; the existing Worker rejects cycles. Only drop saves a narrow etag-checked update,
never pointer movement. No new backend method, schema or persistent drag state is needed.

Nested rows use indentation for parent context without repeating the parent title at the right. A normal
row has one completion circle, with a tick on hover/focus. Select task in the menu, or Ctrl/Cmd/Shift-click,
enters batch selection: its checkbox replaces that circle in the same slot. Clear exits selection.

Main-list subtasks can also be detached as independent tasks. Sidebar drops move to an active project or
Inbox, add a chosen label, or schedule Today. They read a fresh task etag and use existing narrow updates;
project moves preserve descendants. Saved filters have no inferred drop semantics.

Title, description and visible planning options stay in the main editor. Project, Date, Deadline, Start ahead,
priority, labels and Effort occupy the narrow property rail. Start ahead accepts days or weeks before the
Deadline and feeds Plan Review's Start now lane; it does not schedule a notification. `effort` is empty, `deep`
or `shallow` in Tasks and does not change ordinary labels. Clock time and estimate controls appear only for
executable items. Untouched imported timed values remain stored.

Date's Repeat controls select frequency, interval, weekdays, month day, annual month/day and whether an interval
counts from completion. They serialize into the existing recurrence field; the Worker still advances dates.
An imported rule the controls cannot represent stays unchanged until the owner chooses a replacement.
Completed children remain visible. Moving an existing timed date retains its clock time in the task's
timezone, including daylight-saving changes. Context-menu date text saves ordinary Tasks as calendar dates
and points to task details for explicit executable timing; Steps retain the entered time.

Existing descriptions render Markdown and bare links; Edit description opens the draft and Done returns to
the preview. Save changes persists the draft. The renderer loads in its own chunk, omits remote images and
raw HTML, and opens links only on a user click. A failed completion shows its reason inside the open editor.
Existing saves keep the editor open with the returned write baseline and unchanged frame/scroll; an
unchanged save writes nothing. Creation, completion and deletion retain their existing close behavior.

Quick Add opens with `Q`; `Ctrl/Cmd+Enter` saves, Escape and backdrop close the dialog. Create actions retain
their request identity after a lost response. Lists support selection, batch completion/move and custom
order. A normal new task appends to its sibling list inside the D1 transaction; explicit positions remain
available for planning writes. Cross-project moves preserve descendants and update parents before children.

Native planning stages, areas, lead windows and status flags belong to Todofy’s `plan_task_state`. Ordinary
labels remain content classifications in Tasks. The ordinary editor saves generic task fields first, reads a
fresh planning etag and then saves changed planning fields. These are separate service writes: a planning
failure does not roll back saved task content. Dependencies name prerequisite task IDs and derive Blocked
from their completion state; there is no independent Blocked checkbox.

The one-time private conversion keeps each imported choice,
removes its technical label membership and soft-retires the exact replaced labels and filters. Native planning
does not require label mapping. The retired Todoist adapter keeps its frozen role
projection internally; it does not define the native public label catalog.
Dragging a task into a planning day changes the FlowDay queue, preserving its task date and real deadline.
Native task edits invalidate the mounted planning snapshot through the existing refresh path.
Plan keeps the candidate columns vertically stacked within their existing desktop row. Committed alone
spans the row below, with horizontal cards aligned to those columns; narrow layouts keep the existing
paired/single-column behavior. Review cards, the commitment overview, next Steps, Quick and scheduled
Steps reuse the existing completion operation. A calendar completion supplies its actual FlowDay date.
The Tasks host reuses the generic list completion path: original etag/request proof, descendant timer
settlement on its own day, and count/cache invalidation even if Focus subsequently warns. Repeated queued
commands retain their first task revision; a finish operation cannot become a Reopen after a fresh read.

## Focus completion

Focus uses FlowDay's existing persisted timer session, pause/resume and elapsed-time rules. Completing from
an ordinary task list or parent detail first commits through the generic Tasks API. The same completion
request ID and original task etag then prove that occurrence to Todofy, which reuses the existing FlowDay
settlement path. A related running or paused descendant timer keeps its original flow day during settlement;
an unrelated timer is left alone. Without a related timer, only an existing entry in today's queue is settled.
Completing an unplanned task does not add it to the queue.

If Focus cannot confirm settlement, the task stays completed and the UI warns the owner to open Focus and
refresh. The failure does not repeat or undo the generic completion. Tasks owns the completion receipt;
Todofy coordinates planning and settlement; FlowDay owns the timer and time records.

## Native Mail and planning calls

Mail is Todofy's inbox, displayed in Tasks without first creating task records. A successful native summary
finishes its existing event and saves a summary with an empty task link. The owner chooses Create task;
Todofy then sends a generic Tasks CreateTask into the default Inbox and records the confirmed link. Existing
linked mail tasks keep their IDs. Deleting a Mail summary does not delete a linked task. The full stored
summary is available through `/?mail=<eventId>#/mail`, including after filing; a long Task description links
back to it rather than discarding the tail.

The Mail page reads only its bounded mail API and summaries expanded by the owner. It does not load Plan,
FlowDay or a task-project snapshot to discover mail. Optional tag/priority shortcuts are ordinary Tasks
labels, separate from planning flags. Weekly review and GTD carryover count the pending Mail collection.

Planning, filing and order writes use generated Tasks method/body requests; no Todoist path or fallback
remains. A binding grants `read` or `read-write` access,
so the Tasks implementation does not enumerate application names or understand mail categories.

Bulk order updates use one Tasks request, one receipt and a bounded D1 transaction for all supplied etags.
They avoid one service call per task. Cloudflare documents a finite invocation chain for
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits).

## Performance and Cloudflare

Task pages are limited to 100 rows. Lists return a short description preview; full descriptions load when
a task opens. Indexed keyset pagination serves tasks, changes and history: a task cursor compares a row value
and a task-ID lookup joins `json_each`, so both seek an index. Consumers advance their own change cursor.
Plan/Focus code loads separately from the everyday task list. Timer rendering needs no server polling.

Migration 0004 keeps reads independent of history. An open-roots index serves the Inbox and project roots
without completed tasks, and a partial index counts only native completions, not imported occurrences.
Section and project visibility triggers run only when `archived` (or a project's parent) changes, so a
rename or recolour touches no task and leaves list etags valid. A label rename writes its catalog change
before its task changes, so a paged change reader refreshes the catalog first. `read-budget.test.ts` holds
these row counts.

Todofy's weekly backup reads every table through the machine-only `TasksApi.exportBackup` (read-write
bindings only, no HTTP route): rowid pages below each table's max rowid at plan time, bounded to half a MiB of
row JSON so a page stays within Workers Free's CPU. [backup.md](backup.md) has the restore.

D1 batches atomically store each write with its request receipt; updates carry masks and current etags.
Resource references are checked again by database triggers. A task family is limited to 32 hierarchy levels;
moves batch by depth to stay below Workers Free's D1 query limit. No new queue, DO or cron is needed.

Owner requests validate Access before reading the body and validate Origin/CSRF before mutation decoding.
The CSRF token and cookie last 168 hours, the Access session's length, so a PWA left open overnight can still
save its first edit without a refresh.
API responses, HTML, manifest and service worker use private no-store headers. Hashed JS/CSS can use the
browser's private immutable cache. The service worker only supplies a clear offline page; it does not cache
private tasks, credentials or writes. The installed PWA needs a connection to use task data.

## Synthetic interface references

These images contain only local synthetic data. The shared planning interface is documented in
[the planning UI interface guide](../../packages/planning-ui/docs/interface.md).

![Today with synthetic tasks](images/tasks-today-synthetic.png)
![Task details with synthetic subtasks](images/tasks-detail-synthetic.png)
![Current native menus and subtask editor](images/tasks-detail-current-synthetic.png)
![Current named palette](images/tasks-color-current-synthetic.png)
![Mail before task creation](images/tasks-mail-current-synthetic.png)
![Mail in a narrow window](images/tasks-mail-narrow-synthetic.png)
![Upcoming with synthetic tasks](images/tasks-upcoming-synthetic.png)

Import commands and the remaining real-data boundaries are in [import.md](import.md). Actual verification,
including what has not been deployed or migrated, is in [verification.md](verification.md).
