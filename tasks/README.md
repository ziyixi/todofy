# Tasks

Personal task management for the Todofy cloud. Tasks owns tasks, projects, sections, labels, filters and completion history. Todofy keeps mail processing and planning facts; FlowDay keeps daily queues and time records.

## Development status

Implementation is in progress on `codex/tasks-native`. Tasks' empty D1 database and owner Access application have been created through the infrastructure bootstrap; the follow-up plan reports 41 no-ops. The independent Tasks deployment secret is configured. No real task data has been imported and no task writer has switched from Todoist. Release and migration acceptance are still pending.

## First release

- Desktop Inbox, Today, Upcoming, search, nested projects, sections, labels and saved filters.
- Task editing, subtasks, priority, due dates, deadlines, duration, recurrence and completion history.
- Existing Plan, Focus and Mail interfaces, shared with Todoist Plus during the transition.
- Installable desktop PWA; an explicit offline page, with task data available online.
- Owner-only Cloudflare Worker and D1, using the repository's proto API and authentication conventions.
- An explicit Todoist import and a coordinated switch of Todofy and FlowDay after data verification.

Comments, attachments, reminders, assignment, calendar integration and voice input are excluded. Mobile-specific layouts and offline writes are not part of this release.

The [design](docs/design.md) explains service boundaries and the interface. [Verification](docs/verification.md)
separates local results from the remaining release and migration work. [Import](docs/import.md) lists private
export and identity-check commands.

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

The web app depends on the public proto API, never database rows or another application's source. The Worker validates writes and owns recurrence advancement. Shared planning components take an explicit actions interface. A drag into a day changes the FlowDay queue, not the task's due date or deadline.

Lists are bounded and indexed. Completion history is separate from active tasks. Consumers use a paged change feed; the browser does not poll to animate a timer. Imports run in batches. There is no new queue, scheduler or multi-provider framework.

## Migration requirements

Keep imported task IDs so existing mail, planning and FlowDay references remain valid. Import active and archived projects, sections, labels, filters and accessible completion history. Repeated import must not duplicate objects. Report unavailable recurring occurrences and unsupported date rules explicitly. Ordinary CSV backups are not evidence of complete history.

Before cutover: compare source and destination counts, hierarchy, recurrence dates and existing references; verify real UI behavior; pause and drain project-owned task writes; perform the final import; switch consumers together. Preserve the original Todoist account. Do not maintain automatic bidirectional writes.

## Verification

Use synthetic data for local and CI checks and public screenshots. Verify CRUD persistence, request replay, editing conflicts, current recurrence patterns, migration identity, parent relationships, filtering, drag results and timer persistence. Run actual Worker/D1 requests and Chrome interaction checks; unit tests alone do not prove the deployed system.
