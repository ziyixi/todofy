# Handoff

Updated 2026-10-21 UTC. Active work, open acceptance and dated compatibility only; move completed rollout detail to
a dated record and link it here. Rules are in [AGENTS](AGENTS.md); entry points in [README](README.md). Never put
private content, credentials or raw production output here.

Archives (their waiting lists are not instructions): [October 21](docs/history/handoff-2026-10-21.md) (the Private
MCP, done steps in Plan, the Tasks PWA features, the FlowDay retirement),
[October 20](docs/history/handoff-2026-10-20.md), [October 19](docs/history/handoff-2026-10-19.md),
[October 18](docs/history/handoff-2026-10-18.md), [October 11](docs/history/handoff-2026-10-11.md).

## Boundary B: Tasks owns mail conversion, GTD and task creation (`claude/boundary-b`)

**Committed locally, not pushed.** From `origin/main` `b9d18aba`, by the owner's decisions of 2026-10-21 (no waiting
window, flag, shadow phase or rollback machinery; [History](docs/history.md#todofys-task-writes-leave-decided-october-21)):

- Todofy writes no task. It keeps the mail ledger, the Gemini summaries and the mail inbox, and serves them on its
  private `Mail` entrypoint ([Mail API](todofy/docs/mail-api.md)). Its reminder, GTD ledger, task intents and the
  legacy per-mail task path are deleted; migration `0014` refuses to run while a row still needs them.
- Tasks converts mail itself (Tasks › Mail), keeps the Mail categories, the GTD counts and the Sunday review (its
  `TaskJobs` Durable Object), and serves `TaskInbox`, the create-only entry through which Home creates the daily
  digest task (only mail still awaiting a decision goes into the morning brief) and Watch its notifications. It backs
  itself up weekly into its own bucket `tasks-backups` ([backup](tasks/docs/backup.md)); Todofy binds no other app.
- `PlusService`, `MailReadinessService` and task-intent-v1 are retired (`proto/retired.json`); Mail Hero has no alert
  webhook or outbox. `legacy_mail_text` and Newsletter stay.

Two releases, in this order, with the steps below between them. Never push either on Sunday from 09:30 UTC to
Monday 08:00 UTC (Todofy's and Tasks' backups, and Tasks' Sunday review in US/Pacific).

- **Release 1** is the branch up to `44acc47b` (`feat(todofy)!: keep the mail category a conversion takes in Tasks
  alone`). It deploys Todofy (migration `0014` first), then Tasks (`0008`), then Watch and the Personal MCP, then
  Home; Mail Hero (no migration) deploys on its own. It changes `proto/tools/gen_py.py`, so it also publishes the
  Newsletter and Platform images, builds the VPS bootstrap bundle and, while `VPS_DEPLOY_ENABLED` is `true`, runs
  `VPS deploy`.
- **Release 2** is the tip. It deploys Todofy (`0015` drops the copied GTD days, reviews and Mail categories; then
  todofy-core without `TASKS`), Tasks (`BACKUPS`), Watch, Mail Hero (`0011` drops the outbox), the Personal MCP and
  Home. It reaches every app's checks (ops-v1 changed) but no Newsletter, Platform or VPS job.

Final local check on 2026-10-21 UTC, with `b9d18aba` still the tip of `origin/main`. At the tip (`ci_changes.py`
selects every check job) each passed on macOS: Changes' tests and the four generators' `--check`, Proto (no breaking
change against `b9d18aba` or `44acc47b`), Contracts, Shared packages, Infra (guards, `tofu fmt` and `validate`),
Todofy static (1248 host tests) and runtime (376 in one shard, completeness included), Tasks (the Worker's 71 unit and
129 runtime tests, the web's 60 unit tests, build and 129 Playwright tests, the tools' 37), Home (279 unit, 98
runtime, 163 UI), Watch, the Personal MCP, Mail Hero, Links, Mailsort, Recall, Brief, Fleet, Website, Newsletter's
engine steps (empty `HOME`) and Platform's contract steps. Release 1's commit `44acc47b` passed the same for Changes,
the generators, Proto, Contracts, Shared packages, Tasks, Infra, Todofy static and runtime, Watch, the Personal MCP,
Mail Hero and Home; the other apps differ from the tip only by two proto comments. Its Proto breaking check passes
against `b9d18aba` (CI's diff base: the merge base, or on `main` the last green main run); against its parent alone it
reports the removal of `MarkMailConvertedRequest.category_id`, which no release has shipped. Twice a job failed while
lanes ran in parallel and passed alone: Home's runtime suite (workerd failed to spawn) and Todofy's gateway CPU test
(hung). CI alone runs the Newsletter image, Platform's Linux steps, Mail Hero's GPG backup test, the decide step and
Todofy's runtime in three shards.

### Before release 1 (read-only)

1. From the repository root, with the lead's wrangler login, record the counts here:
   `tasks/worker/node_modules/.bin/wrangler d1 execute DB --remote --config todofy/wrangler.toml --json --command
   "SELECT (SELECT count(*) FROM mail_events WHERE state IN ('summarized','todo_sending','todo_unknown','todo_created')) AS legacy, (SELECT count(*) FROM task_intents WHERE state='pending') AS intents_pending, (SELECT count(*) FROM task_intent_tasks WHERE state NOT IN ('created','failed')) AS intent_tasks_open, (SELECT count(*) FROM summaries WHERE imported=0 AND triaged_at IS NULL AND task_id<>'') AS linked_pending"`.
   `legacy`, `intents_pending` and `intent_tasks_open` must be 0; settle any first (`0014` refuses them anyway).
   `linked_pending` is for information.
2. Home → Watch: `intents_open` is 0 and `notify_unsettled` is absent (Watch's outbox lives in its Durable Object).
3. `gh variable list --env production --repo ziyixi/todofy | grep -E 'TODOFY_(REMINDER|GTD_REVIEW)_ENABLED'`: if
   either is `false`, ask the owner (afterwards Home's task and Tasks' review have no switch).
4. From `mail-hero/cloudflare`: `npx wrangler secret list --config ../wrangler.toml` lists no `ALERT_WEBHOOK_TOKEN`.
   If it does, the owner deletes it (`npx wrangler secret delete ALERT_WEBHOOK_TOKEN --config ../wrangler.toml`) and
   re-saves the production secret `MAIL_HERO_WORKER_SECRETS` without that key; otherwise Mail Hero's release stops
   (`BINDING_UNDECLARED`, or `SettingError(MAIL_HERO_WORKER_SECRETS)`).
5. `gh variable list --repo ziyixi/todofy | grep VPS_DEPLOY_ENABLED`: if `true`, the owner OKs the VPS rollout of the
   Newsletter and Platform images, or sets it to `false` for this push and back afterwards.
6. Push release 1's commit, not the tip (`git push origin 44acc47b:refs/heads/claude/boundary-b`, or that commit after
   a rebase), wait for the complete gate (CI alone runs the Newsletter image and Platform's Linux steps) and
   fast-forward `main` to the same green SHA.

### After release 1

1. Todofy, Tasks, Watch, the Personal MCP, Home and Mail Hero deployed; Home's 配置漂移 shows nothing extra on
   `todofy-core`, `tasks` or `watch`. The Newsletter, Platform and bootstrap-bundle jobs passed (and `VPS deploy` if
   it ran; Home's Newsletter tile is healthy).
2. "Infra drift" shows exactly `create: 1` for `cloudflare_r2_bucket.app["tasks-backups"]`: dispatch "Infra apply"
   with that expect line, then confirm the verify plan says no changes.
3. Before the first Sunday 10:00 US/Pacific: `gh workflow run tasks-todofy-import.yml --repo ziyixi/todofy --ref main
   -f apply=false` (counts only), then `-f apply=true`, which must end with `--expect-none` passing. Record the counts
   and the Time Travel bookmark line here.
4. Owner UI, read-only: Tasks › Mail lists mail and its categories; Plan's weekly review shows the pending-mail count;
   Tasks › GTD shows the copied trend; Home's Tasks tile has `inbox_open` and `overdue` after the first 06:00 local
   alarm and no `gtd_stale`; Home's Todofy tile has no `todoist_paused` or `reminder_*`; Home's digest card says
   enabled; Watch has no `notify_unsettled`; Mail Hero's 提醒 card names Home's digest task; the MCP's `mail_list` and
   `mail_read` answer (never `mail_collect` on real mail).
5. The next UTC day: exactly one 运维摘要 task if that day had warning or critical items (the release day gets none).
6. Read the `TaskJobs` namespace ID (the Durable Object namespace with script `tasks`, class `TaskJobs`).
7. Delete the production variables `TODOFY_REMINDER_ENABLED`, `TODOFY_FORCE_PAUSE_TODOIST`,
   `TODOFY_GTD_REVIEW_ENABLED` and the secrets `TODOFY_TODOIST_DEFAULT_PROJECT_ID`, `TODOFY_TODOIST_OPS_PROJECT_ID`,
   `TODOFY_TODOIST_REVIEW_PROJECT_ID`; nothing reads them.

### Before release 2

1. Release 1 is live (else release 2's emptier `RETIRED_SERVICE_BINDINGS` stops safely on `REPAIR_MANUAL_REQUIRED`),
   and Home → Watch shows a check after release 1's Watch deploy (that alarm settled the rows the Todofy sink left).
2. The import's apply run passed `--expect-none`, and `npx wrangler r2 bucket info tasks-backups` finds the bucket;
   Tasks' release stops on a missing bucket.
3. Optional, in this push or a later one, with step 6's ID: set `config/resources.toml` `[durable_objects]
   "tasks-jobs" = "<id>"`, add `"TaskJobs": "tasks-jobs"` to `DO_KEYS` in `tools/cloud-release/cloudflare.py`, set
   `FIRST_DEPLOY_PENDING = set()` in `tools/service-catalog/inventory.py`, expect `unmatched` `[]` in
   `dashboard/worker/test/registry.test.ts`, and regenerate (`tools/cloud-config/generate.py`,
   `tools/service-catalog/inventory.py --generate`, `.github/scripts/drift_desired.py`). Until then Home lists
   `tasks-jobs` as unmatched.
4. Push the tip, wait for the complete gate, fast-forward `main` to the same green SHA.

### After release 2

1. Todofy (`0015` applied), Tasks, Watch, Mail Hero (`0011` applied), the Personal MCP and Home deployed; 配置漂移
   shows nothing extra on `todofy-core` or `tasks`.
2. Within about 30 minutes Home's tick brings Tasks' jobs Alarm forward and the first backup runs: the Tasks tile shows
   `backup_age_seconds` and no `backup_stale` or `backup_failed`; `latest.json` exists in `tasks-backups`.
3. Rehearse a restore with `PRIV=$(mktemp -d)` ([Rehearse locally](tasks/docs/backup.md#rehearse-locally)):
   `node tasks/tools/backup-restore.ts download --out "$PRIV/restore" --remote`, then `config`, migrations, `sql` and
   `verify` against `--local --persist-to "$PRIV/d1"`; expect `verify PASS`, then delete `$PRIV`.
4. After the next Sunday backup, Todofy's health page shows it complete with no `tasks` section.
5. Later, in a push that deploys those apps anyway: empty `RETIRED_SERVICE_BINDINGS` (next Todofy release), and reword
   `proto/buf.yaml`'s header comment, which still names the retired `todofy/taskintent/v1` (a change to that file
   alone deploys every app and the VPS).

## Open from earlier releases

- Owner, blocked secret operations: delete todofy-core's Worker secrets `TODOIST_API_KEY`,
  `TODOIST_DEFAULT_PROJECT_ID`, `TODOIST_OPS_PROJECT_ID` and `TODOIST_REVIEW_PROJECT_ID`, then their optional
  declarations in `todofy/app.toml`, and regenerate (`tools/cloud-config/generate.py`,
  `.github/scripts/drift_desired.py`).
- Set `INFRA_TFVARS` again from the complete private input without the FlowDay names, then empty `RETIRED_VALUES` in
  `infra/scripts/infra_state.py`.
- After 2026-10-25 10:00 UTC, confirm on Todofy's health page that the first Sunday backup after the FlowDay release
  completed.
- Owner: remove the installed FlowDay PWA from each device (optionally, with the owner's OK, its stopped Compose
  service and tunnel rule in `self-host-on-vultr`); by hand on the Mac, the Tasks PWA's Dock menu, a `?task=` link
  opening in the app window, the title-bar toggle, the mini timer and a real lock with Keep and Discard.
- Unconfirmed since October 20: delete the variable `TODOFY_PLUS_METADATA`; remove the `todoist-plus-v*` releases and
  the merged `codex/*` branches; the owner removes Todoist Plus from `chrome://extensions`.

## Open acceptance

The two scheduler observations the owner stopped on October 17 (email models, website daily sync) are kept
in [the October 18 archive](docs/history/handoff-2026-10-18.md#stopped-scheduler-observations); do not restart them.

### Owner decisions, 2026-10-15

Answered in chat; do not re-ask.

- Recall keeps its seven-day cloud file window. `de4d561` deployed at `2026-10-11T23:55Z`; after about 2026-10-18,
  verify the first production file removal and one Dropbox cold read, recording metadata only, never page content.
- GTD additions: the Waiting list, the weekly review checklist and the Sunday-commit fix. The one-card
  Clarify queue was not chosen, so the checklist only counts the mail project's unplanned tasks and links it.
- Native weekly rollover stays enabled; a commitment for an ended week reads as weekly in Tasks
  ([Tasks design](tasks/docs/design.md), [evidence](docs/tasks-plan-reliability-verification.md)).

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
- Brief still needs archive-day acceptance of source coverage, editorial quality and actual model cost (local checks
  used fakes). Preserve archive mode and $80; sending, shadow mode and Newsletter retirement are separate owner
  decisions, and topic `geo.earth` stays 熟悉. See [Brief design §16](brief/docs/design.md) and [README](brief/README.md).
- Home's account-audit change reporting was deployed at `a3705ed`; confirm a completed daily check shows a qualifying
  dashboard change once as 非 CI 改动
  ([recorded scope](docs/history/handoff-2026-10-11.md#in-flight-2026-10-06-claude-home-reports-account-changes-made-outside-ci)).
- Bootstrap and safe drift repair are verified in the existing environment. Empty-account / clean-VPS setup, DNS and
  host-entry recovery and full historical data recovery remain separate exercises; follow [rebuild](docs/rebuild.md)
  and [its verification table](docs/rebuild-verification.md).
- Not rechecked since: Watch's first real changed-watch digest, Newsletter's natural provider/send acceptance and
  Brief in Home's daily Worker inventory. Check fresh status before treating an old waiting item as open; do not
  restart Compose, replay a send or request credentials solely from an archived note.
- Recall: the cost estimates in [design §5.3](recall/docs/design.md#53-budgets) predate minute snapshots with
  screenshots. The phone still reports build 337, and the `page_probe_invalid_reply_type` cause is not established
  ([diagnostic evidence](docs/recall-diagnostic-verification.md#october-14-recurrence-and-repeated-installation-delay)).

## Operating boundaries

- Workers release independently from committed Wrangler configuration. `config/cloud.toml` is the public deployment
  profile; generated `config/resources.toml` records resource identities. Use the configuration/bootstrap tools and
  `infra/` for their declared resources. Preserve root mail records and unrelated resources.
- GitHub Actions deploys the Newsletter/Platform images by digest through the typed daemon API; it holds no SSH key
  or Kubernetes credential. Legacy Compose services stay stopped with their data; Newsletter remains an independent
  VPS service until the owner retires it.
- Mail Hero backs up natively through its DO Alarm and private R2 ([native backup](mail-hero/docs/native-backup.md)).
  Tasks backs itself up weekly into `tasks-backups` ([Tasks backup](tasks/docs/backup.md)), and Todofy backs up only
  its own D1 (both from release 2 of Boundary B).
- Brief's paid Claude calls can run in archive mode, but email is disabled. The stored $80 budget is distinct from
  the code's initial default and any Claude Console limit; preserve it. Owner-supplied Claude/Resend keys never
  pass through GitHub. Workers Free and existing application budgets remain in force.
- Keep Home's persistent alert dismissal. Historical unknown business outcomes are not automatic replay permission;
  follow current [dashboard-state semantics](docs/dashboard-state.md).

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

- [CI/CD](docs/ci-cd.md#where-to-change-the-pipeline): checks, release selection and failure navigation. Push a
  branch, wait for the complete gate, then promote the same green SHA. A rebase or new commits need new checks.
- [Rebuild](docs/rebuild.md), [Cloudflare bootstrap](tools/cloud-bootstrap/README.md),
  [VPS bootstrap/recovery](tools/vps-bootstrap/README.md), [infra](infra/README.md): current operating commands.
- [Documentation guide](docs/README.md), [architecture](docs/architecture.md), [service catalog](docs/service-catalog.md),
  [proto](proto/README.md), [contracts](contracts/README.md): canonical boundaries and application entry points.
- [History](docs/history.md) and the archived handoffs above: earlier releases and evidence.
