# Tasks architecture and interface

Tasks is the owner's desktop task application and installable PWA. It keeps the familiar Todoist layout:
sidebar navigation, compact task lists and a centered task editor. Plan, Focus and Mail use the same
components as Todoist Plus. Comments, files, reminders, collaboration, external calendars and voice are
outside the approved scope.

## Service boundaries

| Component | Owns | Interface |
| --- | --- | --- |
| Tasks web | Navigation, draft forms, selection and rendered views | Generated `TasksUiService` client, same-origin owner requests |
| Tasks Worker and D1 | Tasks, projects, sections, labels, filters, dates and completion history | Root `proto/tasks/ui/v1`, named `TasksApi`, read-only `Ops` |
| Todofy | Mail, weekly choices, Bets, task dependencies and operation receipts | Named `Planning` binding, explicitly selected task source |
| FlowDay | Daily queues, time blocks, timers and time records | Named native Focus binding; read-only task mirror |
| Shared planning UI | Existing Plan, Focus and Mail interactions | Caller-supplied typed transport and navigation callbacks |

Applications do not import each other's source or databases. `packages/planning-ui` compiles into both
hosts; `packages/task-dates` supplies the date parser used by the Tasks Worker and import tools. FlowDay
receives read-only access to Tasks. Todofy receives the provisioned task API; other bindings are rejected.

The new adapters remain inactive until data and identity verification finish. Source selection is explicit.
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

Managed planning labels and replacement favorites are hidden by confirmed IDs. The underlying identities
remain available in settings and task editing. Tasks does not guess a mapping from translated names.
Dragging a task into a planning day changes the FlowDay queue, preserving its task date and real deadline.
Native task edits invalidate the mounted planning snapshot through the existing refresh path.

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
![Upcoming with synthetic tasks](images/tasks-upcoming-synthetic.png)

Import commands and the remaining real-data boundaries are in [import.md](import.md). Actual verification,
including what has not been deployed or migrated, is in [verification.md](verification.md).
