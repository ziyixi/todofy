# Tasks architecture and interface

Tasks is the owner's desktop task application and installable PWA. It keeps the familiar Todoist layout:
sidebar navigation, compact task lists and a centered task editor. Plan and Focus reuse the shared planning
components; Mail has its own taskless inbox. Comments, files, reminders, collaboration, external calendars and voice are
outside the approved scope.

## Service boundaries

| Component | Owns | Interface |
| --- | --- | --- |
| Tasks web | Navigation, draft forms, selection and rendered views | Generated `TasksUiService` client, same-origin owner requests |
| Tasks Worker and D1 | Tasks, projects, sections, labels, filters, dates and completion history | Root `proto/tasks/ui/v1`, named `TasksApi`, read-only `Ops` |
| Todofy | Mail, weekly choices, Bets, task dependencies and operation receipts | Named `Planning` binding, explicitly selected task source |
| FlowDay | Daily queues, time blocks, timers and time records | Named native Focus binding; read-only task mirror |
| Shared planning UI | Plan, Focus and the optional Mail shortcut editor | Caller-supplied typed transport and navigation callbacks |

Applications do not import each other's source or databases. `packages/planning-ui` compiles into both
hosts; `packages/task-dates` supplies the date parser used by the Tasks Worker and import tools. FlowDay
receives read-only access to Tasks. Todofy receives the provisioned task API; other bindings are rejected.

Source selection is explicit; Tasks is the live task source after the verified import and consumer cutover.
A native consumer does not fall back to Todoist after an error, and the old extension cannot write after
the native source is activated. Existing FlowDay task IDs and planning internal IDs must survive cutover.

## Task interface

The task editor keeps title, description and subtasks together. Project, date, deadline, priority and labels
are in a narrow property rail. Label search opens on demand; additional time, duration and repeat controls
sit under Schedule options. Completed subtasks remain visible. Moving a timed date retains the local
clock time in the task's timezone, including daylight-saving changes.

Existing descriptions render Markdown and bare links; Edit description opens the draft and Done returns to
the preview. Save changes persists the draft. The renderer loads in its own chunk, omits remote images and
raw HTML, and opens links only on a user click. A failed completion shows its reason inside the open editor.

Quick Add opens with `Q`; `Ctrl/Cmd+Enter` saves, Escape and backdrop close the dialog. Create actions retain
their request identity after a lost response. Lists support selection, batch completion/move and custom
order. A normal new task appends to its sibling list inside the D1 transaction; explicit positions remain
available for planning writes. Cross-project moves preserve descendants and update parents before children.

Native planning stages, areas, lead windows and status flags belong to Todofy’s `plan_task_state`. Ordinary
labels remain content classifications in Tasks. The one-time private conversion keeps each imported choice,
removes its technical label membership and soft-retires the exact replaced labels and filters. Native planning
does not require label mapping or an extension connection. The retired Todoist adapter keeps its frozen role
projection internally; it does not define the native public label catalog.
Dragging a task into a planning day changes the FlowDay queue, preserving its task date and real deadline.
Native task edits invalidate the mounted planning snapshot through the existing refresh path.

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

New native planning, filing and order writes use generated Tasks method/body requests. The source-specific
Sync converter is limited to unfinished historical receipts. Old Todoist mode stays isolated; there is no
fallback from a failed native operation to the old account. A binding grants `read` or `read-write` access,
so the Tasks implementation does not enumerate application names or understand mail categories.

Bulk order updates use one Tasks request, one receipt and a bounded D1 transaction for all supplied etags.
They avoid one service call per task. Cloudflare documents a finite invocation chain for
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits).

## Performance and Cloudflare

Task pages are limited to 100 rows. Lists return a short description preview; full descriptions load when
a task opens. Indexed keyset pagination serves tasks, changes and history. Consumers advance their own
change cursor. Plan/Focus code loads separately from the everyday task list. Timer rendering needs no
server polling.

D1 batches atomically store each write with its request receipt; updates carry masks and current etags.
Resource references are checked again by database triggers. A task family is limited to 32 hierarchy levels;
moves batch by depth to stay below Workers Free's D1 query limit. No new queue, DO or cron is needed.

Owner requests validate Access before reading the body and validate Origin/CSRF before mutation decoding.
API responses, HTML, manifest and service worker use private no-store headers. Hashed JS/CSS can use the
browser's private immutable cache. The service worker only supplies a clear offline page; it does not cache
private tasks, credentials or writes. The installed PWA needs a connection to use task data.

## Synthetic interface references

These images contain only local synthetic data. The shared planning interface is documented in
[planning-interface.md](../../todoist-plus/docs/planning-interface.md).

![Today with synthetic tasks](images/tasks-today-synthetic.png)
![Task details with synthetic subtasks](images/tasks-detail-synthetic.png)
![Current native menus and subtask editor](images/tasks-detail-current-synthetic.png)
![Current named palette](images/tasks-color-current-synthetic.png)
![Mail before task creation](images/tasks-mail-current-synthetic.png)
![Mail in a narrow window](images/tasks-mail-narrow-synthetic.png)
![Upcoming with synthetic tasks](images/tasks-upcoming-synthetic.png)

Import commands and the remaining real-data boundaries are in [import.md](import.md). Actual verification,
including what has not been deployed or migrated, is in [verification.md](verification.md).
