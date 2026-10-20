# Tasks

Personal task management for the Todofy cloud. Tasks owns tasks, projects, sections, labels, filters and completion history, and Focus's day queues, the timer and time records. Todofy keeps mail processing and planning facts.

## Development status

Native Tasks, Todofy and FlowDay are live, with normal processing restored. Task/history import and native planning conversion are complete; the original Todoist account is unchanged. Plan and Focus need no extension connection. Mail holds summaries until you explicitly create a task. See the [verification record](docs/verification.md) for dated production evidence.

The current refinement separates Tasks/Subtasks from executable Steps and brings planning controls into the
ordinary task editor. Its release and acceptance evidence is tracked in [refinement verification](docs/refinement-verification.md).

## Interface

- Desktop Inbox, Today, Upcoming, search, nested projects, sections, labels and saved filters. In a filter,
  `#Inbox` matches tasks with no project as well as tasks in the Inbox project.
- Task editing, separate Subtask and Step lists, priority, dates, deadlines, structured repeat and completion history.
- Collapsed inline subtasks in main lists; expand to edit, complete or reorder children without opening their parent.
- Drag a task's title or row: the edges insert beside a task, the middle makes it a subtask. Drag Subtasks or Steps within their own list in the parent editor; the order is saved on drop.
- Each row normally has one completion circle. Select task in its menu, or Ctrl/Cmd/Shift-click, enters bulk selection with checkboxes in the same position.
- Existing editors stay open after Save. Main-list subtasks can move to another parent or become independent; Steps stay in details and execution views.
- Drag to a sidebar project/Inbox to move, a label to add it, or Today to schedule. Native task properties appear separately from ordinary labels.
- Visible planning stage, context, task options, start-ahead window and Deep/Shallow effort in task details.
- Plan and Focus reuse the existing planning components; Mail is a separate inbox that creates tasks only on request.
- Plan keeps the candidate columns above a full-width Committed row, with horizontal cards and completion controls for outcomes and Steps.
- Plan and Focus cards drag by their whole row, like the task list (6px, or a 250ms hold on touch); Week's
  commitments reorder like Review's Committed row, and Focus reorders today's steps.
- Focus counts up by default: Start, work, then complete the step, which saves its time. Each step shows its logged
  time, which opens its records to change or add; Day, Week and Month views show where the time went, and a
  Completed checkbox shows the day's completed steps.
- A Step's planning panel shows only its time estimate; Plan's Add steps gives each new Step a time (30 min unless
  another is chosen). In Week a click selects a commitment and a double-click opens it; elsewhere in Plan a click opens.
- Installable desktop PWA; an explicit offline page, with task data available online.
- Owner-only Cloudflare Worker and D1, using the repository's proto API and authentication conventions.
- A verified Todoist import and coordinated native source for Todofy and FlowDay.

Comments, attachments, reminders, assignment, calendar integration and voice input are excluded. Mobile-specific layouts and offline writes are not part of this release.

The [design](docs/design.md) explains service boundaries and the interface. [Verification](docs/verification.md)
separates local results from the remaining release and migration work. [Import](docs/import.md) lists private
export and identity-check commands. [Backup](docs/backup.md) describes the weekly backup through Todofy, Time
Travel, the restore into a new database and the one-time copy of FlowDay's older estimates into Tasks.

A Task or Subtask describes an outcome. Add a Step beneath it to arrange an executable action in the week,
or select Standalone action to schedule the Task itself. Only these executable items expose a clock time
and estimate. Quick actions are always standalone, including existing Quick tasks; no second checkbox is needed.
A Step cannot contain children. Task details can add, complete, reopen or delete either kind
of child. A dependency names its prerequisite; Blocked is derived from unfinished prerequisites.

Completing a task completes its open children, recurring ones included. Completing a recurring task records
one occurrence, moves its date and deadline to the next one and reopens its Subtasks and Steps for that cycle,
as Todoist does. Reopening a child also reopens its completed parents; a child under a completed parent stays
editable.

Repeat uses frequency, interval and calendar controls; imported custom rules remain intact until replaced.
A monthly or yearly rule anchored after the 28th uses the month's last day when that date does not exist, and
task rows show every rule in words.
Date keeps Time and Repeat collapsed until selected; existing settings remain visible as compact summaries.
Start ahead uses days or weeks before the real Deadline and places the task in Plan Review's Start now lane.
It does not send a timed notification. Effort is a task property, so it needs no technical label.

## Local development

From the repository root, install the shared packages and the app:

```sh
npm ci --prefix packages/planning-ui
npm ci --prefix packages/task-dates
npm ci --prefix tasks/worker
npm ci --prefix tasks/web
npm run build --prefix tasks/web
cd tasks/worker
node test/runtime/dev-server.ts
```

The synthetic preview uses an ephemeral local D1 at `http://127.0.0.1:8798`; stopping it discards its data.
It does not read production bindings. Run the Worker's `lint`, `typecheck`, `test` and `test:runtime`; then run
the web app's `lint`, `typecheck`, `test`, `build` and `test:browser` from their own directories.

## Boundaries

The web app depends on the public proto API, never database rows or another application's source. The Worker validates writes and owns recurrence advancement. Shared planning components take an explicit actions interface. A drag into a day changes Tasks' day queue (one MoveFocusStep), not the task's due date or deadline.

Completing a task is one Tasks write: it saves the occurrence, marks the task and its Steps done in the
day's Focus queue (Plan and Focus send their day; the task list none, which means Tasks' today), and saves
a related running or paused timer session as a record on that session's own day. An unrelated timer keeps
running. Reopening opens those queue rows again.

Lists are bounded and indexed. Completion history is separate from active tasks. Consumers use a paged change feed; the browser does not poll to animate a timer. Imports run in batches. There is no new queue, scheduler or multi-provider framework.

## Migration requirements

Keep imported task IDs so existing mail, planning and FlowDay references remain valid. Import active and archived projects, sections, labels, filters and accessible completion history. Repeated import must not duplicate objects. Report unavailable recurring occurrences and unsupported date rules explicitly. Ordinary CSV backups are not evidence of complete history.

Before cutover: compare source and destination counts, hierarchy, recurrence dates and existing references; verify real UI behavior; pause and drain project-owned task writes; perform the final import; switch consumers together. Preserve the original Todoist account. Do not maintain automatic bidirectional writes.

## Verification

Use synthetic data for local and CI checks and public screenshots. Verify CRUD persistence, request replay, editing conflicts, current recurrence patterns, migration identity, parent relationships, filtering, drag results and timer persistence. Run actual Worker/D1 requests and Chrome interaction checks; unit tests alone do not prove the deployed system.
