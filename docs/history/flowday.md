# FlowDay (retired)

FlowDay was a daily execution board for solo work: today's queue of tasks, one timer (time blocks, Pomodoro, misc
time) and a review of where the time went. It came into the monorepo on 2026-09-30 from the standalone
`ziyixi/FlowDay` repository (commit `10a8f43`, without its history) and was ported to Workers Free: CI deployed it
from F2, it served a staging host in F3, and on 2026-10-01 (F4) it took over `flowday.ziyixi.science` from its old
container, whose SQLite data it imported into its D1 database. It mirrored Todoist, and Tasks from the native cutover
of 2026-10-17, read-only through a `read` binding of `TasksApi`. Plan and Focus used its queues and timer until Tasks
took them over (`tasks/migrations/0005_focus.sql`, `proto/tasks/ui/v1/focus.proto`).

The owner decided on 2026-10-20 to remove it completely, with no data migration: its own queues, timers, time
records and estimates were not copied anywhere. The release that merged `claude/retire-flowday` removed it. The last
commit with its source and documents is `777d5f01` (`git show 777d5f01:flowday/README.md`); its owner API
`flowday.ui.v1` is listed in `proto/retired.json`.

| Part | Successor or retirement outcome |
| --- | --- |
| The Worker `flowday`, its Next.js UI and owner API | Native Focus in Tasks and `focus.proto` |
| Day queues, the timer and time records in the D1 database `flowday` | Tasks' `day_steps`, `focus_timer` and `focus_entries`; FlowDay's rows were not migrated |
| Its estimate override and the one-time estimate backfill (`tasks/tools/estimate-backfill.ts`) | Each task's Tasks duration |
| The Tasks mirror (a `read` binding and the change feed) | Nothing. Tasks keeps the generic `read` access level and the change feed, which its Ops counter and backup read |
| `FlowDay checks`, `FlowDay deploy` and Home's FlowDay tile and manifest probe | Nothing; Home probes the website and the links app |
| The Access applications `flowday` and `flowday-bypass`, their two reusable policies and the D1 database | Deleted by "Infra apply" through `infra/retired.tf` ([Retiring an app](../../infra/README.md#retiring-an-app)) |
| The Worker script, its Custom Domain and secrets, and the GitHub `FLOWDAY_*` secrets | Retired with the application; this record is not a teardown command |

The one-time tools that read FlowDay or Todofy's planning store went with it: the estimate backfill, and the Tasks
planning import and planning-identity cutover (`tasks/tools/planning-import.ts`, `planning-cutover.ts` and the
workflow `tasks-planning-import.yml`; all at `777d5f01`).
