# Tasks

Read the root rules, [README](README.md), [design](docs/design.md) and [verification](docs/verification.md).

- The web app uses the generated Tasks UI client. The Worker owns D1, validation and recurrence advancement.
- Ordinary labels carry no GTD semantics. Native stages, areas, lead windows and flags live in Todofy’s planning store.
- TasksApi grants generic `read` or `read-write` binding access; do not hardcode caller app names or mail/category behavior.
- Tasks owns task content; Todofy owns planning/mail and FlowDay owns queues/timing. Share code only through
  `packages/` and contracts through root `proto/`. Never import another app's implementation.
- The installed PWA uses online task data. Do not add offline writes or private-data caching without a real need.
- Keep native source activation separate from deployment. Import coverage and planning/FlowDay identities
  must be checked before switching writers. Never fall back to Todoist after a native operation fails.
- Preserve imported IDs, archived state, history and source completion counts. API access and a green build
  do not prove complete migration. Keep private snapshots outside the public repository.
- Todofy's weekly backup copies every table through `TasksApi.exportBackup`; a migration that adds a table or
  column updates `worker/src/backup.ts` (its runtime test compares the schema) and `tools/backup-restore.ts`.
  Restore only as [docs/backup.md](docs/backup.md) describes, and reset FlowDay's mirror after any restore.
- Use synthetic tasks for tests/screenshots. The local preview has ephemeral D1; do not use `--remote` for development.
- Dialog/popover changes need browser checks for first open, cached reopen and asynchronous data arrival.
  Check internal control positions, parent geometry and scroll position, not only the outer dialog height.
  User-requested expansion is intentional; loading and closing transitions must not cause a second layout jump.
- Follow the existing independent Actions release. Branch checks do not deploy. Record actual evidence and
  remaining cutover work in HANDOFF.
