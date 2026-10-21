# Handoff

Updated 2026-10-21 UTC. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

Completed work is archived: the October 20 notes (planning in Tasks and its import, the Tasks cleanup and Todoist Plus
removal, the Plan and Focus owner changes) in [docs/history/handoff-2026-10-20.md](docs/history/handoff-2026-10-20.md),
the October 19 releases (Plan write reliability, whole-row drag, inline subtasks and Plan completion) in
[docs/history/handoff-2026-10-19.md](docs/history/handoff-2026-10-19.md), through October 18 (Tasks refinement and
cutover, VPS recovery, Recall, Mailsort) in [docs/history/handoff-2026-10-18.md](docs/history/handoff-2026-10-18.md),
earlier in [docs/history/handoff-2026-10-11.md](docs/history/handoff-2026-10-11.md). Their waiting lists are not
instructions.

## Current work

### Boundary B: Tasks owns mail conversion, GTD and task creation (`claude/boundary-b`)

**In flight, not pushed.** A branch from `origin/main` `b9d18aba`, built in slices (plan: owner decisions of
2026-10-21: no waiting window, flag, shadow phase or rollback machinery; Home sends the daily digest task; the
morning brief carries only mail still awaiting a decision; the GTD history is copied once by a dispatched generator).
Release 1 is slices 1 to 5 and their two fixes (`39c29e52`, `44acc47b`), up to the commit `feat(todofy)!: keep the
mail category a conversion takes in Tasks alone` (`44acc47b`); release 2 is slice 6, this branch's tip. Push them as
two releases, in that order, with the steps below between them.

- **Slice 1** (`851823d2`..`24b7836c`): the IDL (`todofy.mail.v1`, `tasks.inbox.v1`, Tasks' Mail and GTD methods),
  `retired.json`'s `files` kind and the preflight fix for a new D1/R2 binding.
- **Slice 2** (`0df4c7a5`..`c1010d4e`): Todofy writes no task. It serves the `Mail` entry, migration
  `0014_retire_task_writes.sql` refuses to run while legacy mail rows or open task intents exist, and its gateway
  keeps `Intents`, `Planning` and `MailApi` as refusals for release 1 only.
- **Slice 3** (`fce5201b`..`02f848b4`): Tasks converts mail, keeps the Mail categories, the GTD counts and the Sunday
  review (`TaskJobs`), serves `TaskInbox`, and carries the one-time Todofy import (`tasks-todofy-import.yml`). Tasks
  deploys after Todofy; `tasks-backups` is declared ahead of its binding.
- **Slice 4** (`439b51b0`..`c2c62759`): Home creates the digest's one task a UTC day through `TaskInbox`
  (`dashboard/docs/design.md` §5.5); Watch creates its notifications through `TaskInbox` and deploys after Todofy and
  Tasks (`39c29e52`: a failed Todofy deploy leaves Tasks deploy skipped, not failed); the Personal MCP reads Todofy's
  read-only `Mail` entry and converts in Tasks; `PlusService`, `MailReadinessService`
  and `todofy.taskintent.v1` are retired (`contracts/task-intent-v1/` deleted); `RETIRED_SERVICE_BINDINGS` lists what
  release 1 removes from the live Workers.
- **Slice 5** (`7af15157`..`6e8d781f`): Mail Hero has no alert webhook or outbox (`ALERT_WEBHOOK_*` gone; its active
  alerts reach the owner through Home's digest task); its shed guard defers three jobs (`alert_history_purge` gone).
  `alert_notifications` stays, unused, until release 2: Mail Hero applies migrations while the old Worker serves.
  `44acc47b` then drops `category_id` from `MarkMailConvertedRequest` before it ships: the mail category a conversion
  takes stays in Tasks, and `summaries.category_id` is frozen.
- **Slice 6, release 2** (from `feat(todofy)!: back up only Todofy's own D1 and unbind Tasks` to this commit): Tasks
  backs itself up weekly into `tasks-backups` from its `TaskJobs` Alarm ([backup](tasks/docs/backup.md)) and its
  restore tool downloads from either bucket; `TasksApi.exportBackup` is gone and todofy-core binds no other app; the
  one-time import is deleted; Todofy's `0015_drop_copied_stores.sql` drops `gtd_daily`, `gtd_reviews`,
  `plan_categories` and `plan_settings` (`mail_reminders` stays for `tools/legacy_migration`); the gateway's refusals
  are deleted; Mail Hero's `0011_drop_alert_outbox.sql` drops the outbox; `RETIRED_SERVICE_BINDINGS` is
  `{"todofy": {"TASKS"}}`. Watch no longer settles the rows the Todofy sink left (release 1's Watch did that on its
  first alarm), so release 2 rebuilds Watch as well.

**Release 1 deploys** Todofy (migration `0014` first), then Tasks (migration `0008`), then Watch (after both), the
Personal MCP and Home, and Mail Hero (no migration). It also reaches every proto user's checks, and because it changes
`proto/tools/gen_py.py` (a path every Python proto user builds from), it also runs the Platform side: `Newsletter image
publish` and `Platform image` publish both GHCR images, `VPS bootstrap bundle` builds, and while the repository
variable `VPS_DEPLOY_ENABLED` is `true`, `VPS deploy` rolls both out on the VPS. Do not push it on Sunday from 09:30 UTC
until Monday 08:00 UTC, the end of Sunday in Tasks' `TIME_ZONE` (US/Pacific): Todofy's backup, and Tasks' first
Sunday review, which Tasks creates at any time on local Sunday from 10:00 when that ISO week has no `weekly_reviews`
row (Todofy's review of the same week lives only in Todofy, so a release then makes a second review task).

Before pushing release 1 (read-only):

1. The counts, with the lead's wrangler login, from the repository root:
   `tasks/worker/node_modules/.bin/wrangler d1 execute DB --remote --config todofy/wrangler.toml --json --command
   "SELECT (SELECT count(*) FROM mail_events WHERE state IN ('summarized','todo_sending','todo_unknown','todo_created')) AS legacy, (SELECT count(*) FROM task_intents WHERE state='pending') AS intents_pending, (SELECT count(*) FROM task_intent_tasks WHERE state NOT IN ('created','failed')) AS intent_tasks_open, (SELECT count(*) FROM summaries WHERE imported=0 AND triaged_at IS NULL AND task_id<>'') AS linked_pending"`.
   `legacy`, `intents_pending` and `intent_tasks_open` must be 0 (else settle them first; `0014` refuses them anyway).
   Record the counts here.
2. Home → Watch: `intents_open` is 0 and `notify_unsettled` is absent (Watch's outbox is in its Durable Object; a row
   still held by Todofy ends as `sink_retired` and raises `notify_unsettled`).
3. `gh variable list --env production --repo ziyixi/todofy | grep -E 'TODOFY_(REMINDER|GTD_REVIEW)_ENABLED'`: if either
   is `false`, ask the owner (after release 1 Home's task and Tasks' review have no switch).
4. From `mail-hero/cloudflare`: `npx wrangler secret list --config ../wrangler.toml` lists no `ALERT_WEBHOOK_TOKEN`. If
   it does, the owner deletes it before the push (`wrangler secret delete ALERT_WEBHOOK_TOKEN --config
   ../wrangler.toml`); a live secret the config no longer declares stops Mail Hero's release (`BINDING_UNDECLARED`).
   In that case (or if the owner ever set it), the owner also re-saves the GitHub production secret
   `MAIL_HERO_WORKER_SECRETS` without the `ALERT_WEBHOOK_TOKEN` key: the release uploads that map on every deploy, and
   `tools/cloud-config/worker-secrets.mjs` refuses a name Mail Hero no longer declares
   (`SettingError(MAIL_HERO_WORKER_SECRETS)`), or the map would upload the secret again. The map cannot be read back.
5. `gh variable list --repo ziyixi/todofy | grep VPS_DEPLOY_ENABLED`: if it is `true`, the owner either OKs the VPS
   rollout of the Newsletter and Platform images built from this push, or sets it to `false` for this push and back
   afterwards.
6. Push release 1's commit, not the tip (`git push origin 44acc47b:refs/heads/claude/boundary-b`, or that commit after
   a rebase), wait for the complete gate, including the branch run's `Newsletter checks`, `Newsletter image checks` and
   `Platform checks` (CI alone runs the Newsletter image and Platform's Linux steps), and fast-forward `main` to the same
   green SHA.

After release 1:

1. Todofy, Tasks, Watch, the Personal MCP and Home deployed; Home's 配置漂移 shows nothing extra on `todofy-core`,
   `tasks` or `watch`. `Newsletter image publish`, `Platform image` and `VPS bootstrap bundle` passed; if `VPS deploy`
   ran, it passed, and Home's Newsletter tile is still healthy.
2. "Infra drift" shows exactly `create: 1` for `cloudflare_r2_bucket.app["tasks-backups"]`: dispatch "Infra apply"
   with that expect line, then a no-change verify plan. Until release 2 binds the bucket, the daily account
   inventory reports it as unregistered.
3. Before the first Sunday 10:00 account-local time: `gh workflow run tasks-todofy-import.yml --repo ziyixi/todofy
   --ref main -f apply=false` (counts only), then `-f apply=true`; it must end with `--expect-none` passing. Record the
   counts and the Time Travel bookmark line here.
4. Owner UI, read-only: Tasks › Mail lists mail and its categories; Plan's weekly review shows the pending-mail count;
   Tasks › GTD shows the copied trend; Home's Tasks tile has `inbox_open` and `overdue` after the first 06:00 local
   alarm and no `gtd_stale`; Home's Todofy tile has no `todoist_paused` or `reminder_*`; Home's digest card says
   enabled; Watch has no `notify_unsettled`; the MCP's `mail_list` and `mail_read` answer (never `mail_collect` on
   real mail).
5. Mail Hero deployed; its settings page's 提醒 card names Home's digest task and shows no notification counts.
6. The next UTC day: exactly one 运维摘要 task if that day had warning or critical items (the release day gets none).
7. Read the `TaskJobs` namespace ID (read-only; the namespace list row with script `tasks`, class `TaskJobs`) for
   release 2's `config/resources.toml` line.
8. Delete the GitHub production variables `TODOFY_REMINDER_ENABLED`, `TODOFY_FORCE_PAUSE_TODOIST`,
   `TODOFY_GTD_REVIEW_ENABLED` and the secrets `TODOFY_TODOIST_DEFAULT_PROJECT_ID`, `TODOFY_TODOIST_OPS_PROJECT_ID`,
   `TODOFY_TODOIST_REVIEW_PROJECT_ID`; nothing reads them.

**Release 2 deploys** Todofy (migration `0015` first, then todofy-core without `TASKS`), then Tasks (`BACKUPS`; its first
backup starts at the next status call of Home's tick), then Watch (without the Todofy sink's one-time settling), Mail
Hero (migration `0011`), the Personal MCP (rebuilt only: `tasks_ui_service.proto` changed in a comment) and Home
(registry, resources, drift). It also reaches every app's checks (the ops-v1 contract changed), but no Newsletter,
Platform or VPS job. Do not push it on Sunday from 09:30 to 11:00 UTC (Todofy's and Tasks'
backups).

Before pushing release 2:

1. Release 1 is live: its deploys passed and Home's 配置漂移 shows nothing extra. Without it, release 2's emptier
   `RETIRED_SERVICE_BINDINGS` stops on release 1's leftovers (`REPAIR_MANUAL_REQUIRED`), a safe stop. Home → Watch
   shows a check after release 1's Watch deploy: that alarm settled the rows the Todofy sink left, which release 2's
   Watch no longer does.
2. The import's apply run (after-release-1 step 3) passed `--expect-none`, and "Infra apply" created `tasks-backups`
   (read-only: `npx wrangler r2 bucket info tasks-backups`); Tasks' release stops on a missing bucket.
3. Optional, in the same push or the next: the `TaskJobs` namespace line (after-release-1 step 7). With the ID, set
   `config/resources.toml` `[durable_objects] "tasks-jobs" = "<id>"`, add `"TaskJobs": "tasks-jobs"` to `DO_KEYS` in
   `tools/cloud-release/cloudflare.py`, set `FIRST_DEPLOY_PENDING = set()` in `tools/service-catalog/inventory.py`,
   expect `unmatched` `[]` in `dashboard/worker/test/registry.test.ts`, and regenerate (`tools/cloud-config/generate.py`,
   `tools/service-catalog/inventory.py --generate`, `.github/scripts/drift_desired.py`). Until then Home lists
   `tasks-jobs` as unmatched and the account inventory ignores Tasks' namespace.
4. Push the branch tip, wait for the complete gate, fast-forward `main` to the same green SHA.

After release 2:

1. Todofy (migration `0015` applied), Tasks, Watch, Mail Hero (migration `0011` applied), the Personal MCP and Home
   deployed; Home's 配置漂移 shows nothing extra on `todofy-core` or `tasks`.
2. Within about 30 minutes Home's tick brings Tasks' jobs Alarm forward and the first backup runs: the Tasks tile shows
   `backup_age_seconds`, no `backup_stale` or `backup_failed`; `latest.json` exists in `tasks-backups`.
3. Rehearse a restore locally ([Rehearse locally](tasks/docs/backup.md#rehearse-locally)) with `PRIV=$(mktemp -d)`:
   `node tasks/tools/backup-restore.ts download --out "$PRIV/restore" --remote`, then `config`, migrations, `sql`
   and `verify` against `--local --persist-to "$PRIV/d1"`; expect `verify PASS`, then delete `$PRIV`.
4. After the next Sunday backup, Todofy's health page shows it complete with no `tasks` section; the older Todofy
   backups that hold Tasks rotate out over six Sundays.
5. In the next natural Todofy release, empty `RETIRED_SERVICE_BINDINGS`.
6. In the next push that reaches every app anyway, reword `proto/buf.yaml`'s header comment: it still names the
   retired `todofy/taskintent/v1` among the cross-app contracts (now `ops/v1`, `tasks/inbox/v1` and `todofy/mail/v1`).
   It was left as is, because a change to that file alone deploys every app and runs the VPS deploy.

Owner item, a blocked secret operation: delete todofy-core's Worker secrets `TODOIST_DEFAULT_PROJECT_ID`,
`TODOIST_OPS_PROJECT_ID`, `TODOIST_REVIEW_PROJECT_ID` with `TODOIST_API_KEY`, then their optional declarations in
`todofy/app.toml`.

### Private MCP: released and accepted (`codex/personal-mcp`)

The implementation stayed in `/private/tmp/todofy-personal-mcp`; Claude's shared checkout was untouched.
The connection gate `422df6a0` passed real owner OAuth, signed subscription, actual Dots receipt, exact-request
replay and unsubscribe. The source bridge `44bb3ef5` passed branch `39565107285` and main `39566319560`.
The business release `f5386a9d70d711bedd865e3b6b5dfaec605b29dc` passed complete
[branch CI 39567087612](https://github.com/ziyixi/todofy/actions/runs/39567087612) and unchanged
[main publication 39568082826](https://github.com/ziyixi/todofy/actions/runs/39568082826).

The existing private Personal Cloud App/owner connection now exposes 18 tools and four business events plus the
synthetic connection event. Its same-identity plugin is `1.1.0`, includes the repo's `personal-cloud` GTD skill,
and remains private. App-owned description/tools were refreshed through Manage; source read-back preserved its
binding/presentation. Home's private Ops card was observed healthy in the real owner UI.

Actual Dots acceptance: four native subscriptions, live source checks without errors, one synthetic Inbox task,
two Steps, exact create/Step/delete replay, zero-result synthetic Recall search, and a real `task.must_start`
receipt `must_start_1` from the DO's normal minute Alarm. All four test subscriptions were then stopped, the
synthetic parent/two children soft-deleted and each confirmed NOT_FOUND. Final status at `08:33:59 UTC` on
October 21 had zero subscriptions/pending/failed and two accepted callbacks (the original test plus this event).
No existing task, real Mail collection/completion or Recall content was used as a fixture. Details and exact
limits are in [verification](docs/personal-mcp-verification.md).

Runtime is one Worker/SQLite DO, private generated Tasks/Mail/Recall/Home bindings, source polling only while
subscribed, current baselines and cursor/delivery atomic commits. Home events exclude MCP's own issues.
Source ownership and native receipts/eligibility stay in the applications; no new D1/Queue/Workflow/model call.
Local checks: MCP lint/types, 35 unit/five workerd/nine deploy tests, 14 binding/drift tests, four generators and
261.55 KiB gzip dry-run. Production acceptance does not cover natural date-only entry, real Mail collection,
real task completion, a Recall body or a new actual Home fault. Do not restart the stopped old scheduler monitors.

### Done steps stay in Plan's Week calendar (`claude/plan-done-steps`)

**Released** at `bf41ce60` (2026-10-21). A calendar step ticked in Plan › Week stays in its day,
done, after the open steps and outside the day's total; its title opens Tasks' dialog to reopen it; Focus is
unchanged ([interface](packages/planning-ui/docs/interface.md#week)). Reviewed: a repeating step dropped back on its
done day now shows open at once; a browser journey reopens a done step from Tasks' dialog. Deploys Tasks only. After
the rebase, `ci_changes.py` selects shared packages, contracts and Tasks; all three passed on macOS (planning-ui's 272
tests; the Worker's 65 unit and 97 runtime tests, the web's 55 unit tests, build and 109 Playwright tests, the tools' 31).

### Tasks desktop PWA features (`claude/pwa-features`)

**Released** with this branch's merge (rebased on `origin/main` `9a4f4b15`). Five owner-chosen features for the installed app in
Chrome on macOS ([README](tasks/README.md#interface), [design](tasks/docs/design.md),
[interface](packages/planning-ui/docs/interface.md)); no badge, notifications, offline writes or share target:

- Dock shortcuts: Quick add (`/?add=1`, the Add task dialog to Inbox), Today, Plan, Focus.
- Launch handling: `launch_handler` `focus-existing` plus a `launchQueue` consumer, so links into Tasks (Home, mail
  reminders, `?task=`, `?review=1`) open in the open app window without a reload; plain tabs behave as before.
- Window Controls Overlay: when the owner hides Chrome's title bar, search and refresh sit in the title bar.
- Focus mini timer (Document Picture-in-Picture) from the timer bar's quiet button; it keeps working on other pages.
- Pause when away (Focus › Day, count-up only): a lock, 10 minutes idle or a sleep pauses the session at the moment
  the owner left; on return "Away for N min — count it?" Keep / Discard. Additive API:
  `CommandFocusTimerRequest.effective_time`, `FocusTimer.pause_time`, migration `0007_timer_pause.sql` (backward
  compatible; the Tasks release applies it before the Worker).

Release deploys Tasks (the proto change runs every proto user's checks; only Tasks changes behaviour). After release:
Chrome picks up the manifest changes (shortcuts, launch handler, title-bar option) at its own update check of the
installed app, at most daily; no reinstall. The "Pause when away" toggle asks for Chrome's idle-detection permission
on its first use. By hand on the Mac: the Dock menu, a Gmail `?task=` link opening in the app window, the title-bar
toggle clear of the traffic lights, the mini timer's first size and look, and a real lock or lid close with Keep and
Discard checked in Focus' records.

### Retire FlowDay and drop Todofy's planning store (`claude/retire-flowday`)

**Released** at `468dceb8` (2026-10-21; its infra follow-ups `66341f98` and `8d8ce547`). A branch from `origin/main` `777d5f01`, which holds the Tasks
performance release, the one-time planning import (verified on 2026-10-20 with 0 pending) and the Plan and Focus
release. By the owner's decisions of 2026-10-20 it removes FlowDay completely, with no data migration, and drops
Todofy's planning tables at once: no waiting window, flag or rollback machinery. The commits, in order:

1. `chore(tasks)`: deletes the finished planning import workflow, its generator, its guard test and the
   planning-identity cutover tool ([record](tasks/docs/backup.md#one-time-planning-import)).
2. `feat(todofy)`: migration `0013_drop_plan_store.sql` drops `plan_task_state`, `plan_tasks`, `plan_edges`,
   `plan_marks`, `plan_notes`, `plus_weeks`, `plus_settings` and every `plan_settings` row but `todoist.mail`. The
   Mail categories stay (`plan_categories` and that row; `runtime/plan_store.py` reads them); nothing else in Todofy
   read the dropped tables. The weekly backup copies 17 Todofy tables; `tools/backup_restore.py` prints
   `SKIP <table> (retired)` for the dropped ones in an older backup.
3. `chore(release)`: todofy-core no longer declares `TODOIST_API_KEY`, and `RETIRED_SERVICE_BINDINGS` is empty.
4. `chore(tasks)`: deletes the one-time FlowDay estimate backfill; Tasks' runbooks no longer reset FlowDay's mirror.
5. `refactor!: retire FlowDay`: `flowday/` and `proto/flowday/` (`flowday.ui.v1` in `proto/retired.json`), its CI
   jobs and actions, every `ci_changes.py` entry (a dispatch of `app=flowday` is refused), the catalog, tool and
   bootstrap entries, Home's tile, Worker row and D1 resource (a tick makes 33 calls, two probes), and infra/:
   `infra/retired.tf` moves the two Access applications and the D1 database to undeclared addresses, with the same
   pairs in `RETIRED` of `.github/scripts/infra_guard.py` (managed objects 41 → 36); the two reusable policies keep
   their addresses (commit 9). Tasks' changes feed and its generic `read` access stay: its Ops counter and backup
   read the feed.
6. `docs`: the platform docs, Home's docs, edge-auth's SPEC and proto/README without FlowDay.
7. `docs` (optional): the links, watch, mailsort, Mail Hero and recall comments. It redeploys those five apps with no
   change in behaviour; drop it to keep their releases separate.
8. `docs`: [the FlowDay record](docs/history/flowday.md), [History](docs/history.md) and this HANDOFF.
9. `fix(infra)`: FlowDay's two policies leave with their resource block, not by a move, so the apply deletes them
   after the applications that use them (a move drops that order from the state, and Cloudflare refuses to delete a
   policy in use); the guard now refuses a moved Access policy ([Retiring an app](infra/README.md#retiring-an-app)).
10. `docs(links)`: corrects commit 7's registry sentence; it redeploys Links, so drop it together with commit 7.
11. `docs(todofy)`: two of Todofy's planning documents describe the self-hosted hosts in general terms only.
12. `docs`: Home's per-tick counts and pending checks, other leftovers of commits 5 and 6, and this HANDOFF.

Final local check on 2026-10-21 UTC, with `777d5f01` still the tip of `origin/main`: `ci_changes.py` selects every
check job and deploys Tasks, Todofy and Home (with commit 7 also Mail Hero, Links, Watch, Mailsort and Recall),
prints no `flowday_*` key and refuses `-f app=flowday`. Each job passed on macOS: Changes' tests (`.github/scripts`,
the cloud-config, cloud-release, cloud-bootstrap and service-catalog tests and the four generators' `--check`),
Shared packages, Proto (breaking against `777d5f01` with `flowday.ui.v1` retired), Contracts, Infra (guards,
`tofu fmt` and `tofu validate`; its plan needs the state), Todofy static (1887 host tests) and runtime (all 498 in
one shard, the completeness check included), Tasks (the Worker's 65 unit and 97 runtime tests, the web's 55 unit
tests, build and 107 Playwright tests, the tools' 29 tests), Home (268 unit and 97 runtime tests, the UI's 158),
Mail Hero, Links, Watch, Mailsort, Recall, Brief, Fleet, Website (every step, its export and Worker dry runs
included), Newsletter (its engine steps with an empty `HOME`) and Platform's contract steps. Two tests failed once
and passed when their job ran again, neither in code this branch changes: a Todofy runtime test (a plain `SELECT`
that local D1 answered with "internal error" under four workers) and Recall's 413 runtime case (`EPIPE` while the
client still wrote the large body). CI alone runs the Newsletter image, Platform's Linux steps, Mail Hero's GPG
backup test and Changes' decide step. Not verified here:
the plan against the real state of the three `moved` blocks and of the two policies that leave with their block
(step 1 below reads it; Lab's moves applied cleanly on 2026-10-07, but this is the first time a `from` names an
instance of a resource no block declares).


- **Before pushing**, in this order:
  1. Confirm that P2's Todofy release is live: its "Todofy deploy" job succeeded, or Home's 配置漂移 shows nothing
     `extra` on `todofy` or `todofy-core` (no `FLOWDAY_FOCUS`, `FLOWDAY_NATIVE_FOCUS`, `FLOWDAY_PUBLIC_URL`,
     `TASK_SOURCE`, `TODOIST_API_BASE` or `PLUS_METADATA`). The empty `RETIRED_SERVICE_BINDINGS` stops a release
     that still finds one (`REPAIR_MANUAL_REQUIRED`).
  2. This read-only check must print nothing (checked 2026-10-21: nothing):
     `gh secret list --env production --repo ziyixi/todofy | grep -E '^TODOFY_CORE_WORKER_SECRETS\s'`. (`FLOWDAY_WORKER_SECRETS`, if it exists, is read by nothing after
     the merge; step 6 below deletes it.)
  3. `TODOIST_API_KEY` stays declared as an optional manual secret of todofy-core (`todofy/app.toml`) until the live
     secret is deleted, so the release does not depend on that deletion. Nothing reads it. Afterwards: from `todofy/`,
     `npx wrangler secret delete TODOIST_API_KEY --config wrangler.toml`, then remove the declaration and regenerate
     (`tools/cloud-config/generate.py`, `.github/scripts/drift_desired.py`).
  4. The production `INFRA_TFVARS` secret still holds `flowday_policy_names` and `flowday_policy_options`.
     `infra_state.py` drops them (`RETIRED_VALUES`) instead of refusing the values, because the secret also holds
     values the local `~/.config/todofy-infra/local.tfvars` lacks, so it must not be regenerated from that file. When
     the secret is next set from the complete private input without the two names, remove them from `RETIRED_VALUES`.
  5. Release outside Sunday 09:30-11:00 UTC: Todofy's weekly backup starts at 10:00, and a job planned before
     `0013` fails on a dropped table (after 3 errors `storage_error`, retried 6 hours later).
- **Release.** Push, wait for the complete gate, then fast-forward `main` to the same green SHA. CI deploys Tasks
  (no migration), then Todofy (`0013` applies before core and gateway; only D1 Time Travel, 7 days, can undo it),
  then Home; with commit 7, Mail Hero, Links, Mailsort and Recall too, and Watch after Todofy. Nothing deploys
  Fleet, Brief, the website, the relay, Newsletter or Platform. Then: Todofy's health page is green; Tasks' Mail
  page lists the categories and their tags and a category edit saves; Home shows no FlowDay tile; reload Tasks once.
  If Todofy's deploy stops (a live `TODOIST_API_KEY` or retired binding), fix it and run
  `gh workflow run ci.yml --repo ziyixi/todofy --ref main -f app=todofy`, then the same with `-f app=dashboard`
  (and `-f app=watch` with commit 7).
FlowDay's retirement is complete (2026-10-21): main `468dceb8` released without it; the drift plan of `66341f98`
showed exactly the five retired objects; "Infra apply" run 39530077928 deleted both Access applications, their two
policies and D1 `flowday` (state backed up first; the verify plan said "No changes"). The Worker `flowday` and its
custom domain were already absent from the account. The GitHub secrets `FLOWDAY_CSRF_SIGNING_KEY` and
`FLOWDAY_CREDENTIAL_KEY` are deleted. This commit removes the applied `moved` blocks and `RETIRED` pairs.

Still open:
- `TODOIST_API_KEY` on todofy-core: delete the live secret, then its optional declaration in `todofy/app.toml`.
- `INFRA_TFVARS`: set it again from the complete private input without the FlowDay names, then empty `RETIRED_VALUES`
  in `infra/scripts/infra_state.py`.
- After the first Sunday backup after the release (2026-10-25 10:00 UTC), confirm on Todofy's health page that it
  completed.
10. Owner: remove the installed FlowDay PWA from each device. Optionally, in `self-host-on-vultr`, delete the stopped
    FlowDay container's Compose service and data and any leftover tunnel ingress rule for `flowday.ziyixi.science`;
    that repository is outside this one and needs the owner's OK.

### Carried forward from the October 20 archive (unconfirmed)

The [October 20 archive](docs/history/handoff-2026-10-20.md) lists these lead steps of the Tasks cleanup release.
Whether each is done was not confirmed when it was archived; check before acting.

- Delete the GitHub variable `TODOFY_PLUS_METADATA` (nothing reads it).
- Confirm the first Tasks backup ran after that release, and restore it locally as
  [Rehearse locally](tasks/docs/backup.md#rehearse-locally) says.
- Remove the `todoist-plus-v*` releases and the merged `codex/*` branches (the archive has the commands).
- Owner, on the Mac: remove Todoist Plus at `chrome://extensions` with its unpacked folder.
- Known limit: with all seven Review lanes at a 1440px window the step counts end in an ellipsis.

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
  first-request behavior is proved by real local Core/Tasks/D1 tests, not by production content writes
  ([evidence](docs/tasks-plan-reliability-verification.md)). With `claude/tasks-planning` it becomes Tasks' read
  rule (a commitment for an ended week reads as weekly, [Tasks design](tasks/docs/design.md)) and Todofy's job goes.

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
- Not rechecked since: Watch's first real changed-watch digest and Newsletter's natural provider/send acceptance. Check fresh status before treating an old waiting
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
  the old VPS collector is stopped. Tasks backs itself up weekly into `tasks-backups` from its jobs object's Alarm
  ([Tasks backup](tasks/docs/backup.md)), and Todofy backs up only its own D1 (from release 2 of Boundary B).
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
| Home and Todofy legacy owner routes | 2026-11-02 |
| Mailsort v1 owner routes | 2026-11-10 |

Keep Todofy core's `owner_api` RPC until the corresponding gateway compatibility window is complete. Dates permit a
reviewed follow-up; they do not schedule deletion or authorise changing frozen webhook bytes or migrations. Todofy's
retained host cutover snapshot stays through **2026-10-29**; deletion is a separate action
([verification](todofy/docs/verification.md)).

## Working and maintenance entry points

- [CI/CD](docs/ci-cd.md#where-to-change-the-pipeline): job/recipe ownership, checks, release selection and failure navigation.
  Push a branch, wait for the complete gate, then promote the same green SHA. Rebase or new commits require new checks.
- [Rebuild](docs/rebuild.md), [Cloudflare bootstrap](tools/cloud-bootstrap/README.md),
  [VPS bootstrap/recovery](tools/vps-bootstrap/README.md), [infra](infra/README.md): current operating commands.
- [Documentation guide](docs/README.md), [architecture](docs/architecture.md), [service catalog](docs/service-catalog.md),
  [proto](proto/README.md), [contracts](contracts/README.md): canonical boundaries and application entry points.
- [History](docs/history.md) and the handoff archives of [October 20](docs/history/handoff-2026-10-20.md),
  [October 19](docs/history/handoff-2026-10-19.md),
  [October 18](docs/history/handoff-2026-10-18.md) and [October 11](docs/history/handoff-2026-10-11.md): earlier
  releases and evidence. Move completed details there.
