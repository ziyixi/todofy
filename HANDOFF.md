# Handoff

Updated 2026-10-20 UTC. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

Completed work is archived: the October 19 releases (Plan write reliability, whole-row drag, inline subtasks and Plan
completion) in [docs/history/handoff-2026-10-19.md](docs/history/handoff-2026-10-19.md), through October 18 (Tasks
refinement and cutover, VPS recovery, Recall, Mailsort) in
[docs/history/handoff-2026-10-18.md](docs/history/handoff-2026-10-18.md), earlier in
[docs/history/handoff-2026-10-11.md](docs/history/handoff-2026-10-11.md). Their waiting lists are not instructions.

## Current work

### Tasks performance: planning in Tasks (`claude/tasks-planning`)

**In progress, local only; not pushed.** A branch from `origin/main` `abd0da1a`, which holds the Plan and Focus
release. It implements the performance design in one release, by the owner's choice without flags, staged rollout
or a shadow phase: P0 front end, P1 planning facts in Tasks, the one-time import workflow, P2 Todofy cleanup
(Todofy stops serving planning and drops its FlowDay proxy). P3, dropping Todofy's planning tables, follows once the
import is verified.

- **P0 (2026-10-20 UTC), done.** Front end only, plus one Worker header.
  - The task dialog and Plan/Focus load with the app instead of on demand, which waited for their chunk and React's
    300ms Suspense reveal. Locally in Chromium (dev server, synthetic data, 5 runs each) the first dialog open went
    from 359-374 to 56-63 ms and Plan's shell from the Inbox from 329-333 to 19-21 ms. The main chunk grew from
    698 kB (223.3 kB gzip) to 895 kB (285.1 kB gzip) and its CSS from 29.9 to 90.1 kB; Mail (11.9 kB), the catalog
    editor (7.2 kB) and the description renderer (155.3 kB) still load on demand. The app's styles keep their old
    cascade order: every element's computed style on synthetic Inbox, task details, Plan and Focus pages was the
    same in both builds.
  - Completing a card in Plan reads Plan once (it read twice more: `useTaskActions` now keeps `planRevision` for
    the writes Plan did not issue), and switching between Plan and Focus reads nothing (`finishTask` changed
    identity with the route). The dialog reads a task's children only when GetTask counts some.
    `request-counts.spec.ts` guards these counts.
  - A tab running an older bundle asks for a reload: every authenticated Tasks answer names its `BUILD_SHA` in
    `x-tasks-build`, the web is built with the same commit, and a mismatch (or, where a build is unnamed, an
    unknown-route answer) shows "Tasks was updated." with Reload in place of the page and its errors. Tabs opened
    before this release do not have it yet; they need one manual reload after it. The Tasks Worker bundle was 130.8
    of its own 132 KiB gzip budget (the platform allows 3 MiB); P1 raised the budget.
  - **Checked locally on macOS.** `ci_changes.py` selects Changes, Tasks and Contracts. Tasks passed: the Worker's
    lint, typecheck, unit tests and 19 runtime files (82 tests, the new `build.test.ts` included), the web's lint,
    typecheck, 69 unit tests, build and all 105 Playwright tests (new: `request-counts.spec.ts`, `outdated.spec.ts`),
    and the tools' and deploy tests. Contracts passed, and so did Changes' test steps; its decide step needs
    GitHub's token, so `ci_changes.py` ran directly.
- **P1 (2026-10-20 UTC), done except the import.** Planning facts, dependencies and Plan live in Tasks.
  - **Do not release P1 alone.** From its deploy nothing writes Todofy's planning store, and production rows show
    no planning facts until the one-time import runs. The import slice comes next: the generator
    (`tasks/tools/planning-import.ts`, `prepare-planning-import.ts`, `planning-import.test.mjs`) and
    `.github/workflows/tasks-planning-import.yml`, released with P1; then the design's cutover steps 2-5.
  - Todofy: `ReadWeeklyReview`, the weekly review's two facts (the newest review task of the week or the week
    before, the pending Mail count) in one D1 batch with no Tasks call; the gateway allows it.
  - Tasks: migration `0006_planning.sql` (planning columns on `tasks` and the partial `tasks_committed` index,
    `task_dependencies`, `weekly_bets`, `plan_board`); Task fields 31-38 and `plan.proto` (GetPlan,
    UpdateWeeklyBet, `ReorderTasks.lane_order`), all additive; the rules ported from Todofy's Python in
    `worker/src/planning.ts`; dependency writes as one set with their cycle, open-prerequisite and 300-edge checks
    inside the write's batch; backup and restore of the new columns and tables (a pre-0006 backup restores with
    the defaults).
  - planning-ui reads GetPlan beside the ListTasks pages and writes only to Tasks; Todofy answers only Mail and
    ReadWeeklyReview. The web reads planning with each row and with GetTask, saves content and planning in one
    UpdateTask, and lost the 30-second detail cache and the separate planning reads. The browser specs seed
    planning in the dev server's D1 through its API (`planning-stub.ts`); only Todofy's Mail and review facts
    are synthetic.
  - Deviations from the design: `UpdateWeeklyBetRequest.etag` is a request field (the shared HTTP client sends
    only the masked fields of a resource, so an etag inside `WeeklyBet` never arrived; `a83b4272`).
    `ListFocusDays`' days and `ReorderTasks.positions` stay REQUIRED, since the wire profile forbids dropping
    REQUIRED: empty days mean Tasks' today's week, and empty positions with a `lane_order` save only the lane.
  - Measured locally: the Tasks Worker bundle is 137.1 KiB gzip (was 130.8), budget raised to 165 KiB. The web's
    main chunk is 891.1 kB (285.4 kB gzip), from 895.8 (285.5). `cpu.test.ts`' first page of 100 planned tasks
    measured 8.62 reference ms against its bound of 10, and the fullest plan and a dependency write among 300
    stay under the file's bounds. `read-budget.test.ts`: a task with 5 dependencies reads 16 rows (2 without),
    GetPlan 3 statements and 9 rows, its next-week read through `tasks_committed`.
  - Todofy's weekly backup carries the new columns and tables; its runtime round trip seeds and compares them.
  - **Checked locally on macOS.** `ci_changes.py` selects every check job (the proto changed). Each passed:
    Changes' test steps (its decide step needs GitHub's token, so `ci_changes.py` ran directly), Proto, Shared
    packages, Contracts, Tasks (the Worker's lint, typecheck, 64 unit tests and 20 runtime files with 96 tests; the
    web's lint, typecheck, 53 unit tests, build and all 105 Playwright tests; the tools' 37 and deploy tests),
    Todofy static, Todofy runtime (all 512 tests in one shard, the completeness check included), FlowDay, Mail
    Hero, Home, Links, Watch, Mailsort, Recall, Brief, Fleet, Website and Platform's contract step. CI alone runs
    Platform's manifest compiler, AppArmor, image and k3s steps and Mail Hero's GPG backup test.

### Tasks cleanup and Todoist Plus removal (`claude/tasks-cleanup`)

**Ready to release.** A local branch from `f6c08aaf`, not pushed yet: the verified Tasks review fixes, Tasks' D1 in
Todofy's weekly backup, the Tasks duration as the only estimate, the Planning channel allowlist, and the removal of
the Todoist Plus extension and of every Todoist path in Todofy and FlowDay. It merges `origin/main` at `69ddb339`,
keeping Codex's already-released October 18-19 Tasks and Plan work (inline subtasks, whole-row drag, Plan
completion, the bounded native rollover) on the native-only path. By the owner's decision the end state ships at
once: no compatibility window, staged rollout, flag or rollback machinery.

Final local check on 2026-10-20 UTC, with `69ddb339` still the tip of `origin/main`: `ci_changes.py` selects every
check job for the branch, and each passed on macOS: Changes' tests, Todofy static and runtime (all 512 runtime tests
in one shard, the completeness check included), Tasks, FlowDay, Dashboard, Mail Hero, Links, Watch, Mailsort, Recall,
Brief, Fleet, Website, Newsletter, Contracts, Shared packages, Infra and Proto. CI alone runs what macOS cannot: the
Newsletter image (a linux/amd64 Docker build), Platform's kubectl checksum, AppArmor, runtime image and k3s steps
(its contract tests passed), Newsletter's CJK font install and Mail Hero's GPG backup test. Locally, Website's
export and Worker dry-run steps ran on another free port and Newsletter's steps with an empty `HOME`, as on a CI
runner. If `origin/main` moves before the push, merge it again and rerun the jobs `ci_changes.py` selects.

- **Before pushing,** in this order:
  1. This read-only check must print nothing. If a map is listed, set it again without `TODOIST_API_KEY` and
     `CREDENTIAL_KEY` (`tools/cloud-bootstrap/bootstrap.py secrets`); the deploy wrappers now refuse those names.
     `gh secret list --env production --repo ziyixi/todofy | grep -E '^(TODOFY_CORE_WORKER_SECRETS|FLOWDAY_WORKER_SECRETS)\s'`
  2. `TODOIST_API_KEY` (todofy-core) and `CREDENTIAL_KEY` (flowday) stay declared as optional secrets in their
     `app.toml` until the live secrets are deleted, so the release does not depend on deleting them first. Nothing
     reads either. Delete them with `wrangler secret delete` (and the GitHub secret `FLOWDAY_CREDENTIAL_KEY`), then
     remove the two declarations and regenerate (`tools/cloud-config/generate.py`, `.github/scripts/drift_desired.py`).
- **Release.** Push, wait for the complete gate, then fast-forward `main` to the same green SHA. CI releases Tasks →
  FlowDay → Todofy → Home, and each works while the later apps still run the previous release. Migrations: Tasks
  `0004`, FlowDay `0005` (deletes the Todoist settings rows), Todofy `0012` (drops `plus_connections`, `plus_actions`).
  Todofy's release drops the gateway's `FLOWDAY_FOCUS` and the `TASK_SOURCE`, `TODOIST_API_BASE` and `PLUS_METADATA`
  vars under `RETIRED_SERVICE_BINDINGS` (`tools/cloud-release/control.py`); a later commit empties that entry.
- **Expected effects.** Until Home deploys, the old Home reports the two deleted secrets as missing. A
  ConvertMailItem or DeleteMailSummaries retry across the release with the same request ID is refused; a new request
  works. FlowDay drops `FocusEntrypoint` while the old gateway still binds it (nothing calls it). If Cloudflare
  refuses that upload, Todofy is skipped too, since it waits for FlowDay. Then deploy only Todofy, which drops the
  binding, and once it is green, FlowDay:
  `gh workflow run ci.yml --repo ziyixi/todofy --ref main -f app=todofy`, then the same with `-f app=flowday`.

The lead's production steps right after the release, in this order:

1. The one-time FlowDay estimate backfill, all of it, as soon as the release is live:
   [commands and checks](tasks/docs/backup.md#one-time-flowday-estimate-backfill). FlowDay's saved estimates were not
   exported before the push (the session could not read production D1); the new FlowDay replaces one only when its
   task changes in Tasks, so export FlowDay first and the tasks changed meanwhile are the only loss.
2. Delete what nothing reads any more, then refresh Home's drift check and expect no differences. The owner may also
   revoke the Todoist API token; nothing uses it.
   ```sh
   gh secret delete FLOWDAY_CREDENTIAL_KEY --env production --repo ziyixi/todofy
   gh variable delete TODOFY_PLUS_METADATA --env production --repo ziyixi/todofy
   ```
3. Confirm the first Tasks backup, taken at Todofy's first alarm after the release: its time on Todofy's health page
   or Home is newer than the release. Restore it locally as [Rehearse locally](tasks/docs/backup.md#rehearse-locally) says.
4. Remove the Plus releases and the merged branches. `git branch -r --merged origin/main | grep codex/` lists exactly
   these fourteen; the three unmerged Recall experiment branches stay by the owner's earlier decision. Git refuses to
   delete a branch a worktree has checked out, so remove the worktree first (`git worktree list`).
   ```sh
   for t in $(gh release list --repo ziyixi/todofy --limit 100 --json tagName \
       --jq '.[].tagName | select(startswith("todoist-plus-v"))'); do
     gh release delete "$t" --cleanup-tag --yes --repo ziyixi/todofy
   done
   git push origin --delete codex/cloud-recovery-tasks codex/plan-write-reliability codex/plan-write-verification \
     codex/plus-ui-refinement codex/plus-ui-refinement-verification \
     codex/tasks-dependency-layout codex/tasks-details-polish codex/tasks-layout-verification codex/tasks-native \
     codex/tasks-read-efficiency codex/tasks-read-verification codex/tasks-refinement-verification \
     codex/tasks-workflow-refinement codex/vps-release-recovery claude/tasks-cleanup
   git worktree remove <its path>   # or `git worktree prune` once its directory is gone
   git branch -d claude/tasks-cleanup
   ```
5. Owner, on the Mac: remove Todoist Plus at `chrome://extensions` with its unpacked folder, and delete the cutover's
   temporary operator files listed in the private notes.

### Plan and Focus owner changes (`claude/plan-focus-ui`)

**Done, local only; not pushed.** A branch from `origin/main` `b7b52e75` for the owner's ten Plan and Focus
changes of 2026-10-19, which ship in one release. Slices, in order: A (card layout and area colours), B (the Step
panel and double-click), C (whole-row drag in Plan), D1 (Tasks' Focus backend), D2 (planning-ui and the Tasks host
switch to it) and D3 (Focus reorder, Completed and the Day/Week/Month views) are all done. FlowDay keeps running
untouched, nothing new uses it, and its queue and time data are not migrated (owner decision). To ship: merge
`origin/main` again if it has moved, rerun the jobs `ci_changes.py` selects (every check, since D1 changed the Tasks
API and D2 `.github/scripts`), push, wait for the complete gate and fast-forward `main` to the same green SHA. CI
deploys Tasks (migration `0005` first), then FlowDay, then Todofy. FlowDay and Todofy redeploy only because they use
the additive `proto/tasks/ui/` (and Todofy's tests and docs changed); neither changes what it does. If FlowDay's
deploy fails, Todofy is skipped, since it waits for FlowDay, and Tasks keeps working with the previous Todofy.

Final local check on 2026-10-20 UTC, with `b7b52e75` still the tip of `origin/main`: `ci_changes.py` selects every
check job for the branch, and each passed on macOS: Changes' tests, Shared packages, Todofy static and runtime (all
512 runtime tests in one shard, the completeness check included), Tasks (81 Worker runtime tests; the web's 65 unit
and 102 Playwright tests), FlowDay, Mail Hero, Home, Links, Watch, Mailsort, Recall, Brief, Fleet, Website,
Newsletter (its engine steps with an empty `HOME`, as on a runner), Infra, Proto and Contracts. CI alone runs what
macOS cannot: the Newsletter image build (its source audit passed), Platform's kubectl, AppArmor, image and k3s steps
(its contract tests passed), Newsletter's CJK font install, Mail Hero's GPG backup test and Changes' decide step
(`ci_changes.py` ran directly).

- **Slice A (2026-10-20 UTC).** Plan and Focus cards are coloured by area (Work slate, Personal ochre, Unassigned
  none) with legend dots; outcome cards are 77px with one left-aligned meta line, the deadline first in a two-part
  status; Next steps cards are 60px; Quick chips share a 150px-minimum grid with "N more" by the heading; cut titles
  show in full in a bubble on hover or keyboard focus. Week's Committed already showed every commitment; a unit and a
  browser test now guard it. Behaviour: `packages/planning-ui/docs/interface.md`.
- **Slice B (2026-10-20 UTC).** A Step opens a panel that sets only its time (15/30/60/90 min or 1-1440 typed); the
  choice shows at once and the saved duration Tasks answers (`updateEstimate` returns `{ estimate }`) merges without
  a re-read. Week's Add steps has a time select beside its input (30 min by default), sent as `estimated_minutes`;
  the task panel's "Steps & timing" uses the same times without "Not estimated". A click on a Week commitment
  selects it and a double-click opens it; elsewhere the dialog swallows a double-click's second press and click for
  600ms after it opens, and focus returns to the opener when it closes.
- **Slice C (2026-10-20 UTC).** Plan's cards drag by their whole row like the task list: 6px with a mouse, a 250ms
  hold on touch, never from complete, Start or remove (`packages/planning-ui/src/row-drag.ts`, in Review's and
  Week's providers). Next steps, Quick and calendar grips are 14px overlays shown on hover or keyboard focus, so
  titles never move; outcome grips stay shown. Week's commitments reorder as Review's Committed lane through the
  shared `useLaneReorder` (ReorderTasks, lane `committed`), with Review's grip, a 2px line and "Committed,
  position N". Insertion lines are 2px and a dragged card fades to 0.3. D3's Focus provider reuses the sensors.
- **Checked locally on macOS** for slice A: `ci_changes.py` selects Changes, Shared packages, Contracts and Tasks.
  Shared packages, Contracts and Tasks passed (Tasks' worker lint, typecheck, unit and runtime suites; its web lint,
  typecheck, unit tests, build and all 89 Playwright tests, with the new `plan-layout.spec.ts` at 1440, 1024, 800 and
  680px). Changes' test steps passed; its decide step needs GitHub's token, so `ci_changes.py` ran directly.
  For slice B the same four jobs ran again on macOS and passed: Shared packages (planning-ui's 240 unit tests),
  Contracts, and Tasks with all 92 Playwright tests, including the new Step panel, timed Add steps and
  double-click journeys in `planning-journeys.spec.ts`; Changes' test steps passed and its decide step again could
  not run locally.
  For slice C the same four jobs passed again on macOS: Shared packages (planning-ui's 245 unit tests), Contracts,
  and Tasks with all 98 Playwright tests, including the six new `planning-drag.spec.ts` journeys (each card type
  drags by its body, one commitment selects, opens and moves, its keyboard reorder keeps focus on the grip, small
  grips show only on hover or focus, and Chromium touch input through CDP drags only after a 250ms hold while a
  quick swipe scrolls); Changes' test steps passed and its decide step again could not run locally.
  For slice D1 `ci_changes.py` selects every proto user's checks, because the Tasks API changed. On macOS these
  passed: Proto checks (buf lint, api-linter, breaking against `b7b52e75`, generation and both codecs), Shared
  packages, Contracts, Tasks (18 worker runtime files with the new Focus, write-budget, read-budget and CPU tests;
  the web's unit tests and all 98 Playwright tests), FlowDay (its Worker bundle 125.7 of 140 KiB), Todofy static
  and all 512 Todofy runtime tests (the weekly backup's round trip now carries Focus rows), Mail Hero, Home, links,
  watch, mailsort, recall, brief and fleet. The website's export and Worker dry runs passed on a free port
  (another session holds 4173). Platform's contract step passed; its manifest compiler, AppArmor, image and k3s
  steps need Linux. Changes' test steps and the 453 `.github/scripts` tests passed; its decide step again could not
  run locally.
  For slice D2 `ci_changes.py` selects every check, because `.github/scripts` changed. D2 touches planning-ui, Tasks
  and the CI map only, so these ran on macOS and passed: Shared packages (planning-ui's 249 unit tests), Contracts,
  Tasks (the Worker's runtime suite of 18 files and 80 tests, the CPU and budget tests included; the web's 65 unit
  tests, build and all 98 Playwright tests against the dev server's Focus) and Changes' test steps (453
  `.github/scripts` tests); its decide step again could not run locally. The other apps' code is unchanged since
  the D1 runs above. The Tasks Worker bundle stays 130.5 of 132 KiB. The web's shared `api` chunk (124 kB) folded
  into its index (590 to 698 kB); the two together went from 714 to 698 kB, 230 to 223 kB gzip.
  For slice D3 `ci_changes.py` selects Changes, Shared packages, Contracts and Tasks for its own commits (D3 touches
  planning-ui, Tasks' browser tests and docs). On macOS these passed: Shared packages (planning-ui's 266 unit tests
  in 37 files), Contracts, and Tasks (the Worker's 18 runtime files and 80 tests unchanged; the web's lint,
  typecheck, 65 unit tests, build and all 102 Playwright tests, including the new `focus-time.spec.ts` and the Focus
  reorder journey in `planning-drag.spec.ts`). Changes' test steps and the 453 `.github/scripts` tests passed; its
  decide step again could not run locally. The count-up journey waits past a minute, because Tasks saves only a
  session of a minute or more. Plan and Focus's lazy chunk grew from 118.9 to 137.3 kB (37.3 to 43.0 kB gzip) and its
  CSS from 43.9 to 51.5 kB; the main chunk is unchanged at 698 kB.
  For the review fixes `ci_changes.py` selects Shared packages, Contracts, Tasks and Todofy (for its planning API
  doc). On macOS Shared packages (planning-ui's 268 unit tests), Contracts and Todofy static passed. Tasks passed
  its Worker lint, typecheck, unit and 18 runtime files (81 tests, CPU and budgets included), the web's lint,
  typecheck, 65 unit tests and build, and 101 of 102 Playwright tests; the one failure was a wrong assertion in the
  new Week check (`Set` has no length), fixed and rerun with `focus-time.spec.ts` and `planning-drag.spec.ts` (10
  passed). `.github/scripts/test_doc_references.py` passed. Todofy's runtime shards were not rerun: only a Todofy
  doc changed.
- **Slice D1 (2026-10-20 UTC).** Tasks owns Focus; nothing calls it until D2. Migration `0005_focus.sql` adds day
  queues (`day_steps`), time records (`focus_entries`) and the one timer row (`focus_timer`), never hard-deleted.
  `proto/tasks/ui/v1/focus.proto` and seven methods: `ListFocusDays` (1-7 days, their records, every task they name
  and Tasks' today), `MoveFocusStep` (`focusDays:moveStep`: add, remove, reorder or move one step), `GetFocusTimer`,
  `CommandFocusTimer` (start, pause, resume, stop, finish; a session of a minute or more becomes one record) and
  Create/Update/Delete `FocusEntry`. `CompleteTask.focus_day` (empty: Tasks' today) settles the queue and a related
  session in the completion's own batch, and `ReopenTask` opens those rows again. A day holds 20 steps and 30
  records, an active session holding one place: the spec's 30 and 40 put an isolate's first read of the fullest
  week at 9.7-10.7 reference ms, now 8.5-8.9. The weekly backup exports the three tables; the restore tool also
  restores older backups, with empty Focus tables and an idle timer (`tasks/docs/backup.md`). The Tasks Worker
  bundle grew from 122.0 to 130.5 KiB gzip, of its 132 KiB budget.
- **Slice D2 (2026-10-20 UTC).** Plan and Focus use Tasks' Focus API: `createPlanningActions({ plus, tasks })`
  reads a week and Tasks' today with `ListFocusDays`, writes each queue change as one `MoveFocusStep`, runs the
  timer through `GetFocusTimer`/`CommandFocusTimer`, and has `readFocus` (a month in reads of at most 7 days) and the
  record writes for D3. `completeTask` is the host's: one Tasks `CompleteTask` with `focus_day` (a calendar card's
  own day, else Focus's; the task list sends none, meaning Tasks' today) settles the queue and a related timer in
  the same batch, so the FlowDay settlement and its "Focus could not confirm" warning are gone. A completion keeps
  its first request ID and day until confirmed. Plan still counts from Todofy's today (`PlanState.today`), Focus
  from Tasks'. Count-up shows at most 4 hours, as Tasks saves it. The Worker no longer forwards
  `/api/plus/flowday/*` (404), and `ci_changes.py` no longer lists Tasks as a user of `proto/flowday/ui/`. No code
  in `tasks/` or `packages/planning-ui/` uses FlowDay; the one-time estimate backfill (`tasks/tools/estimate-backfill.ts`
  and its `backup.md` section) stays until it has run, and `backup.md`'s FlowDay mirror reset stays while FlowDay
  runs. Browser journeys keep Focus in the dev server's D1 (`planning-stub.ts` `seedFocus`).
- **Slice D3 (2026-10-20 UTC).** Focus has Day, Week and Month tabs with previous/next and Today; the page
  header follows the view and date, and Focus always opens on today's Day. Count up is the default timer and Start
  sends the step's area. Each card's one time number is its logged time ("Est. 30m · 35m logged", ticking as a
  clock while its session runs, inside a small `LoggedTime`), which opens the day's records (`FocusEntries.tsx`):
  change whole minutes, add time or delete, each write through the App's queue (`pendingEntry`). Other days are
  read-only, though today's and past days' records still change. A header checkbox shows the day's completed steps
  after the open ones, off on every visit. Week shows logged time by area, steps done, time against the estimate, a
  bar a day stacked by area and where the time went (grouped by each step's parent); Month a shaded calendar of its
  days (`focus-stats.ts`). Other ranges are read with `readFocus`, kept while Focus is open and read again after
  each confirmed write. Today's open steps reorder by their whole row (one `MoveFocusStep` within the day).
- **Review fixes (2026-10-20 UTC).** A Focus step's grip starts its drag (it was missing from the row sensors'
  surfaces), its drag preview is as wide as the row, and a grip that cannot be used stays hidden until hover (the
  shared dimmed `button:disabled` showed it on the timed card and flashed it on every card during a write). A day's
  records of steps that left its queue (moved on or removed) show read-only under "Other time", so the summary
  adds up and every record stays editable. Week and Month count a recurring step's estimate once per completion.
  Where the time went has one bar track, and Week's day labels are always two lines. Deleting a task, project or
  section takes its steps off every day queue in the same batch, so they no longer fill a day's 20-step cap.
- **Owner, with this release (D1-D3):** stop any FlowDay timer that is running before it. After the release,
  reload every open Tasks window, the installed app too: a window from before it still calls FlowDay's old Focus
  paths, which now answer 404, so Plan and Focus show errors until it reloads (no data is at risk). Afterwards this
  week's day queues are empty, because nothing is migrated: arrange the week once in Plan › Week. Focus now counts up
  by default: Start, work, then ✓ saves the time; each step's logged time opens its records. Focus cards drag by
  their whole row. FlowDay's own site keeps working until its decommission; nothing reads it any more.
- **Next, after this release.** Two follow-ups, in order; neither moves any data.
  1. **Todofy cleanup release**, right after: nothing calls these any more, so retire them. In
     `todofy/gateway/src/plus.ts`, CompleteTask in `NATIVE_METHODS`, the `/api/plus/flowday` proxy with
     `FOCUS_METHODS`, `settleCompleted` and the `flowday_url` injection; the `FLOWDAY_NATIVE_FOCUS` binding and
     `FLOWDAY_PUBLIC_URL` var (`gateway/src/env.ts`, `wrangler.toml`); the frozen focus claim in
     `worker/todofy/runtime/plus_receipts.py` and `coordinator.py`; Todofy's CompleteTask handler and RPC, reserved
     with its messages through `proto/retired.json`, and `Plan.flowday_url` reserved the same way; their tests and
     `todofy/docs` (`planning-api.md` already says these have no caller).
  2. **FlowDay decommission**, an owner action after the performance pass. Its checklist is this command, run again
     then: `git grep -l -i flowday -- . ':!flowday' ':!proto/flowday' ':!docs/history'` (FlowDay's app and proto,
     its CI jobs and `ci_changes.py` entries, infrastructure, tools, Home's registry and drift files, other apps'
     mentions and the root docs).
- **Known limit.** With all seven Review lanes at a 1440px window (six cards a row, about 155px each) the step counts
  end in an ellipsis; the cards keep their 77px.

## Open acceptance

The two scheduler observations the owner stopped on October 17 (email models, website daily sync) are kept
in [the October 18 archive](docs/history/handoff-2026-10-18.md#stopped-scheduler-observations); do not restart them.

### Owner decisions, 2026-10-15

Answered in chat; do not re-ask.

- Recall keeps its seven-day cloud file window. `de4d561` deployed at `2026-10-11T23:55Z`; after about 2026-10-18,
  verify the first production file removal and one Dropbox cold read, recording metadata only, never page content.
- GTD additions: the Waiting list, the weekly review checklist and the Sunday-commit fix. The one-card
  Clarify queue was not chosen, so the checklist only counts the mail project's unplanned tasks and links it.
- Native weekly rollover remains enabled. Limited October 19 metadata confirms the current week and zero
  expired memberships. Its five-item legacy batching defect is fixed and released; the 32-member
  first-request behavior is proved by real local Core/Tasks/D1 tests, not by production content writes.
  [Evidence](docs/tasks-plan-reliability-verification.md) and
  [controls](todofy/docs/planning-api.md#weekly-rollover-and-controls).

### Waiting for the owner

- Install Recall Orion `2026.1015.451` on the phone; renewed phone acceptance follows it.
- Brief's sender `onboarding@resend.dev` delivers only to the Resend account's own address; change it before sending.
- Check the Claude Console workspace spend limit against Brief's stored $80 budget (unverified; $50 was suggested).
- Dedicated Cloudflare tokens for the infra workflows and a fresh deploy token; the infra workflows have not switched
  yet ([replacing the token](infra/README.md#replacing-the-token)).

### Remaining observations and separate follow-ups

- `5134232` removed the direct `vars` expressions from the release composites. Todofy and Home uploaded through them
  in [run 38469896460](https://github.com/ziyixi/todofy/actions/runs/38469896460); the Mail Hero, Brief, Links, Watch,
  Fleet and website-relay composites have not been loaded by a real upload since the `dd7a6e8` refactor. Check the
  first natural release of each; a preflight/no-op does not load the skipped composite.
- Brief's fresh Ops status and Actions inventory passed, but Home's daily REST Worker list still predates its first
  deploy. Observe the normal inventory starting **2026-10-12 02:00 UTC / October 11 19:00 PDT**; it should add Brief
  before the per-Worker checks finish. A usage refresh alone does not refresh this list.
- Brief still needs archive-day acceptance of source coverage, editorial quality and actual model cost (local checks
  used fakes). Preserve archive mode and $80; sending, shadow mode and Newsletter retirement are separate owner
  decisions, and topic `geo.earth` stays 熟悉. See [Brief design §16](brief/docs/design.md) and [README](brief/README.md).
- Home's account-audit change reporting was deployed at `a3705ed`; the recorded follow-up is to confirm a completed
  daily check shows a qualifying dashboard change once as 非 CI 改动. The old handoff contains no final observation.
  [Recorded scope](docs/history/handoff-2026-10-11.md#in-flight-2026-10-06-claude-home-reports-account-changes-made-outside-ci).
- Bootstrap and safe drift repair are verified in the existing environment. Empty-account / clean-VPS setup, DNS and
  host-entry recovery and full historical data recovery remain separate exercises; follow [rebuild](docs/rebuild.md)
  and [its verification table](docs/rebuild-verification.md), which supersede the October 3 audit's gaps.
- Not rechecked since: Watch's first real changed-watch digest, FlowDay's owner setup/device check before F6
  retirement, and Newsletter's natural provider/send acceptance. Check fresh status before treating an old waiting
  item as open; do not restart Compose, replay a send or request credentials solely from an archived note.
- Mail Hero (`mail-hero/docs/todofy-integration.md`, `cloudflare-setup.md`, `ci-cd.md`) and Watch (`README.md`,
  `docs/design.md`) docs still say Todoist. Todofy writes Tasks, and mail stays a summary until it is converted.
  A docs edit there redeploys the app, so update them with each app's next natural release.
- Recall: the cost estimates in [design §5.3](recall/docs/design.md#53-budgets) predate minute snapshots with
  screenshots. The phone still reports build 337, and the `page_probe_invalid_reply_type` cause is not established
  ([diagnostic evidence](docs/recall-diagnostic-verification.md#october-14-recurrence-and-repeated-installation-delay)).

## Operating boundaries

- Workers release independently from committed Wrangler configuration. `config/cloud.toml` is the public deployment
  profile; generated `config/resources.toml` records resource identities. Use the configuration/bootstrap tools and
  `infra/` for their declared resources. Preserve root mail records and unrelated resources.
- GitHub Actions actively deploys the Newsletter/Platform images by digest through the typed daemon API.
  It holds no SSH key or Kubernetes credential. All legacy Compose services are stopped; keep their retained data
  and do not restart their triggers. Newsletter remains an independent VPS service until the owner retires it.
- Mail Hero backs up natively through its DO Alarm and private R2 ([native backup](mail-hero/docs/native-backup.md));
  the old VPS collector is stopped. Todofy's weekly job backs up Tasks' D1 with its own ([Tasks backup](tasks/docs/backup.md)).
- Brief's paid Claude calls can run in archive mode, but email is disabled. The stored $80 budget is distinct from
  the code's initial default and any Claude Console limit; preserve it. Owner-supplied Claude/Resend keys never
  pass through GitHub. Workers Free and existing application budgets remain in force.
- Keep Home's persistent alert dismissal. Historical unknown business outcomes are not automatic replay permission;
  read-only Newsletter timeout rows were settled by their explicit migration. Follow current
  [dashboard-state semantics](docs/dashboard-state.md), not the archive's earlier alert instructions.

## Dated compatibility and retained data

The authoritative [compatibility table](docs/history.md#owner-api-compatibility) defines the old-client responses:

| Surface | Earliest removal |
| --- | --- |
| Mail Hero legacy owner routes | 2026-11-01 |
| Home, FlowDay and Todofy legacy owner routes | 2026-11-02 |
| Mailsort v1 owner routes | 2026-11-10 |

Keep Todofy core's `owner_api` RPC until the corresponding gateway compatibility window is complete. Dates permit a
reviewed follow-up; they do not schedule deletion or authorise changing frozen webhook bytes or migrations. Todofy's
retained host cutover snapshot stays through **2026-10-29**; deletion is a separate action
([verification](todofy/docs/verification.md)). FlowDay F6 teardown also remains an explicit owner action.

## Working and maintenance entry points

- [CI/CD](docs/ci-cd.md#where-to-change-the-pipeline): job/recipe ownership, checks, release selection and failure navigation.
  Push a branch, wait for the complete gate, then promote the same green SHA. Rebase or new commits require new checks.
- [Rebuild](docs/rebuild.md), [Cloudflare bootstrap](tools/cloud-bootstrap/README.md),
  [VPS bootstrap/recovery](tools/vps-bootstrap/README.md), [infra](infra/README.md): current operating commands.
- [Documentation guide](docs/README.md), [architecture](docs/architecture.md), [service catalog](docs/service-catalog.md),
  [proto](proto/README.md), [contracts](contracts/README.md): canonical boundaries and application entry points.
- [History](docs/history.md) and the handoff archives of [October 19](docs/history/handoff-2026-10-19.md),
  [October 18](docs/history/handoff-2026-10-18.md) and [October 11](docs/history/handoff-2026-10-11.md): earlier
  releases and evidence. Move completed details there.
