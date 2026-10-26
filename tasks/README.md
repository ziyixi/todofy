# Tasks

Personal task management for the Todofy cloud. Tasks owns tasks, projects, sections, labels, filters and completion history; each task's planning facts (stage, area, start ahead, flags) and dependencies; Plan's weekly goals and lane orders; and Focus's day queues, the timer and time records; turning a mail into a task with the owner's Mail categories; and the GTD statistics and the Sunday weekly review. Todofy keeps the mail: its ledger, the summaries and the mail still awaiting a decision, read through Todofy's private Mail entry. Home and Watch create their tasks through TaskInbox, a create-only entry.

## Development status

Native Tasks and Todofy are live, with normal processing restored. Task/history import and native planning conversion are complete; the original Todoist account is unchanged. Plan and Focus need no extension connection. Mail holds summaries until you explicitly create a task. See the [verification record](docs/verification.md) for dated production evidence.

The current refinement separates Tasks/Subtasks from executable Steps and brings planning controls into the
ordinary task editor. Its release and acceptance evidence is tracked in [refinement verification](docs/refinement-verification.md).

## Interface

- Desktop Inbox, Today, Upcoming, search, nested projects, sections, labels and saved filters. The sidebar groups
  Inbox/Today/Upcoming/Mail under Tasks and Plan/Focus/GTD under Planning, with Favorites and a collapsible
  project tree below. Search and Add task stay above them; catalog, completed and archived browsing stay in the footer. In a filter,
  `#Inbox` matches tasks with no project as well as tasks in the Inbox project.
- Task editing, separate Steps and Subtasks lists with Add step/Add subtask in their headers, priority, dates,
  deadlines, structured repeat and completion history.
- Collapsed inline subtasks in main lists; expand to edit, complete or reorder children without opening their parent.
- Drag a task's title or row: the edges insert beside a task, the middle makes it a subtask. Drag Subtasks or Steps within their own list in the parent editor; the order is saved on drop.
- Each row normally has one completion circle. Select task in its menu, or Ctrl/Cmd/Shift-click, enters bulk selection with checkboxes in the same position.
- Save closes the task editor; saving a Subtask or Step opened from another task returns to that previous task. Description Done saves inline and immediately renders Markdown. Main-list subtasks can move to another parent or become independent; Steps stay in details and execution views.
- Drag to a sidebar project/Inbox to move, a label to add it, or Today to schedule. Native task properties appear separately from ordinary labels.
- Visible planning stage, context, Execution choice, independent Routine switch, start-ahead window and
  Deep/Shallow effort in task details.
- Plan and Focus reuse the existing planning components; Mail is a separate inbox that creates tasks only on request.
- Goals connects annual Objectives and Key Results to weekly Bets and Tasks. Set a multi-month focus, keep
  Floor/Ceiling text, confirm result milestones and record dated progress with evidence. Tasks/Subtasks can choose
  a KR; Steps inherit their direct parent's association. Completing work does not automatically complete the KR.
  Goal definitions load only on Goals or when its picker opens; ordinary task lists do not load goal history.
- GTD (`#/gtd`) reviews execution through Overview, Completion and Time: Task/Step completion, Routine separately,
  recorded time and current estimates. Week/Month and area filters are shared; a calendar day opens editable Focus
  records. See [GTD](docs/gtd.md) for metric definitions and historical limits.
- Plan keeps the candidate columns above a full-width Committed row, with horizontal cards and completion controls for outcomes and Steps. Waiting or dependency-blocked work stays outside Plan until ready; task data and Focus queues are retained.
- Plan and Focus cards drag by their whole row, like the task list (6px, or a 250ms hold on touch); Week's
  commitments reorder like Review's Committed row, and Focus reorders today's steps.
- Focus counts up by default: Start, work, then complete the step, which saves its time. Each step shows its logged
  time, which opens its records to change or add. Focus keeps daily execution and timing; Week/Month statistics
  live in GTD Time. A Completed checkbox shows the day's completed steps. The timer bar's Mini timer button floats the session in a
  small always-on-top window (Document Picture-in-Picture): the Step title, a steady clock, cumulative time against
  the estimate and visible Pause/Resume, Stop and Complete controls. The title remains visible at 64px high. It stays open on other pages and closes when the
  session ends. With Focus' Pause when away on (a per-device setting; Chrome asks for its permission on that click),
  a count-up pauses in Tasks at the moment the screen locked, input stopped for 10 minutes or the machine slept,
  whichever page the window shows, and on return asks "Away for N min — count it?" in the timer bar, on the step's
  Focus card and in the mini timer: Keep counts the time away, as if it never paused; Discard resumes from now. A
  pomodoro is never paused.
- A Step's planning panel edits its time estimate and can delete it after confirmation; Plan's Add steps gives each new Step a time (30 min unless
  another is chosen). In Week a click selects a commitment and a double-click opens it; elsewhere in Plan a click opens.
- Installable desktop PWA; an explicit offline page, with task data available online. The Dock icon's menu offers
  Quick add (Inbox, no date, over the current page), Today, Plan and Focus. Links into Tasks (Home, mail reminders,
  `?task=` links, the weekly review) open in the already-open app window without reloading it; a linked task waits
  for an open task dialog to close. With Chrome's title bar hidden (Window Controls Overlay), the search field and
  the page's refresh sit in the window's title bar.
- Owner-only Cloudflare Worker and D1, using the repository's proto API and authentication conventions.
- A verified Todoist import and coordinated native source for Todofy.

Comments, attachments, reminders, assignment, calendar integration and voice input are excluded. Mobile-specific layouts and offline writes are not part of this release.

The [design](docs/design.md) explains service boundaries and the interface. [Verification](docs/verification.md)
separates local results from the remaining release and migration work. [Import](docs/import.md) lists private
export and identity-check commands. [Backup](docs/backup.md) describes Tasks' own weekly backup, Time Travel, the
restore into a new database and the one-time copy of what Todofy kept for Tasks.

A Task or Subtask describes an outcome. Execution selects Steps, Standalone or Quick in both task editors:
Steps arranges the actions beneath the task, Standalone schedules the task itself, and Quick makes it a short
standalone action. Routine is independent of that choice. Steps, Standalone and Quick share the same estimate
panel in Plan and Focus, and all expose optional clock time and estimate fields in task details. Quick's
calendar cards show its configured time, or Quick when no time is set, without an unknown-estimate marker. A Quick action
with a Deadline stays out of the Quick tray until its start-ahead window opens, unless already active; zero lead opens
on the Deadline day.
Task editors no longer offer manual In progress, Waiting, On hold or Parked controls. Their saved flags still
affect planning and survive unrelated edits; choosing a planning stage still takes a task out of Parked.
A Step cannot contain children. Task details can add, complete, reopen or delete either kind
of child. A dependency names its prerequisite; Blocked is derived from unfinished prerequisites. A task waits
for at most 5 tasks, the account holds at most 300 dependencies, and none may close a cycle.

[Goals](docs/goals.md) describes the annual view, the optional associations and the one-time private Notion import.
Routine and exploration goals keep their own notes; exploration has no required metrics or completion score.

Completing a task completes its open children, recurring ones included. Completing a recurring task records
one occurrence, moves its date and deadline to the next one and reopens its Subtasks and Steps for that cycle,
as Todoist does. Reopening a child also reopens its completed parents; a child under a completed parent stays
editable.

Repeat uses frequency, interval and calendar controls; imported custom rules remain intact until replaced.
A monthly or yearly rule anchored after the 28th uses the month's last day when that date does not exist, and
task rows show every rule in words.
Date keeps Time and Repeat collapsed until selected; existing settings remain visible as compact summaries.
Start ahead uses days or weeks before the real Deadline. Its open window and completed prerequisites surface
the task in Plan Review's Parked area, ready to arrange. This does not send a timed notification or change dates.
[Readiness and task navigation](docs/planning-readiness.md) describes acknowledgement and reverse dependencies. Effort is a task property, so it needs no technical label.

## Local development

From the repository root, install the shared packages and the app:

```sh
pnpm install --frozen-lockfile
npm run build --prefix tasks/web
cd tasks/worker
node test/runtime/dev-server.ts
```

The synthetic preview uses an ephemeral local D1 at `http://127.0.0.1:8798`; stopping it discards its data.
It does not read production bindings. Run the Worker's `lint`, `typecheck`, `test` and `test:runtime`; then run
the web app's `lint`, `typecheck`, `test`, `build` and `test:browser` from their own directories.

## Boundaries

The web app depends on the public proto API, never database rows or another application's source. The Worker validates writes and owns recurrence advancement and the planning rules (the stage rollover, Review's lane, must start). A task, its planning facts and its dependencies are one resource with one etag: the task list and its details read them with the task, and one UpdateTask writes any of them. Plan is GetPlan (the weekly goals of three weeks, the arranged lanes and next week's commitments) beside the list of open tasks. Shared planning components take an explicit actions interface. A drag into a day changes Tasks' day queue (one MoveFocusStep), not the task's due date or deadline.

Completing a task is one Tasks write: it saves the occurrence, marks the task and its Steps done in the
day's Focus queue (Plan and Focus send their day; the task list none, which means Tasks' today), and saves
a related running or paused timer session as a record on that session's own day. An unrelated timer keeps
running. Reopening opens those queue rows again.

Lists are bounded and indexed. Completion history is separate from active tasks. Consumers use a paged change feed; the browser does not poll to animate a timer. Imports run in batches. The one scheduler is the TaskJobs Durable Object's own Alarm (the GTD day and the weekly review); there is no queue, cron or multi-provider framework.

Machine callers bind one of two entrypoints. `TasksApi` gives generic `read` or `read-write` access over the owner API's messages (the Personal MCP). `TaskInbox` only creates: one task with up to 30 subtasks per call, at most 20 a day per source (`home`, `watch`), in the project routed for the source or the Inbox. Mail conversion and the categories are Tasks features over Todofy's Mail entry (`MAIL`): the task's ID is derived from the mail, so a retry never makes a second task.

## Migration requirements

Keep imported task IDs so existing mail and planning references remain valid. Import active and archived projects, sections, labels, filters and accessible completion history. Repeated import must not duplicate objects. Report unavailable recurring occurrences and unsupported date rules explicitly. Ordinary CSV backups are not evidence of complete history.

Before cutover: compare source and destination counts, hierarchy, recurrence dates and existing references; verify real UI behavior; pause and drain project-owned task writes; perform the final import; switch consumers together. Preserve the original Todoist account. Do not maintain automatic bidirectional writes.

## Verification

Use synthetic data for local and CI checks and public screenshots. Verify CRUD persistence, request replay, editing conflicts, current recurrence patterns, migration identity, parent relationships, filtering, drag results and timer persistence. Run actual Worker/D1 requests and Chrome interaction checks; unit tests alone do not prove the deployed system.
