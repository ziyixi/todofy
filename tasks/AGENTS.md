# Tasks

Read the root rules, [README](README.md), [design](docs/design.md) and [verification](docs/verification.md).

- The web app uses the generated Tasks UI client. The Worker owns D1, validation and recurrence advancement.
- Ordinary labels carry no GTD semantics. Native stages, areas, lead windows, flags and dependencies are task fields.
- TasksApi grants generic `read` or `read-write` binding access; TaskInbox grants create-only access per `source`
  (`home`, `watch`). Do not hardcode other caller app names. Mail conversion and the Mail categories are Tasks
  features over Todofy's Mail entry (`MAIL`); Todofy owns mail content and never writes a task.
- Tasks owns task content, planning facts, dependencies, Plan, Focus and time, the GTD days and the weekly review;
  Todofy owns mail. Share code
  only through `packages/` and contracts through root `proto/`. Never import another app's implementation.
- The installed PWA uses online task data. Do not add offline writes or private-data caching without a real need.
- Todoist is not a task source; no code reads or writes it.
- Preserve imported IDs, archived state, history and source completion counts. API access and a green build
  do not prove complete migration. Keep private snapshots outside the public repository.
- Todofy's weekly backup copies every table through `TasksApi.exportBackup`; a migration that adds a table or
  column updates `worker/src/backup.ts` (its runtime test compares the schema) and `tools/backup-restore.ts`.
  Restore only as [docs/backup.md](docs/backup.md) describes.
- Production data changes go only through the Tasks API (etag and request_id) or a committed, tested generator
  with a dry run (as the one-time planning and Todofy imports are; see [docs/backup.md](docs/backup.md#one-time-todofy-import)),
  whose SQL is applied with `wrangler d1 execute --remote --file`.
  Never run ad-hoc SQL against production. Note a Time Travel bookmark or take a backup first.
- Delete a generated secrets file right after the deploy that needed it. Private operator material (snapshots,
  exports, generated SQL) is worked on in a private directory outside the repository and deleted when the task
  ends; what must be kept lives only in encrypted private storage, never in a temporary directory.
- Use synthetic tasks for tests/screenshots. The local preview has ephemeral D1; do not use `--remote` for development.
- Dialog/popover changes need browser checks for first open, cached reopen and asynchronous data arrival.
  Check internal control positions, parent geometry and scroll position, not only the outer dialog height.
  User-requested expansion is intentional; loading and closing transitions must not cause a second layout jump.
- Follow the existing independent Actions release. Branch checks do not deploy. Record actual evidence and
  remaining cutover work in HANDOFF.
