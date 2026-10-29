# Handoff

Updated 2026-10-29 UTC. Current work describes in-flight and unreleased work in detail; released work moves to a
dated record under `docs/history/` and is linked here, without run-ID ledgers. Rules are in [AGENTS](AGENTS.md);
entry points in [README](README.md). Never put private content, credentials or raw production output here.

Archives (their waiting lists are not instructions): [October 29](docs/history/handoff-2026-10-29.md) (business
prompt clarity), [October 28](docs/history/handoff-2026-10-28.md) (the review
cleanup wave, the fixed K3s node address and DNS, the backups wave, Fleet node telemetry, the Newsletter researcher,
Brief's retirement),
[October 27](docs/history/handoff-2026-10-27.md) (Model Router
cutover, Codex gateway and 6.1 runtime, shared workspaces, Mailsort providers and intake, Tasks planning, GTD and
Goals, Mail Hero backup writes, the configuration-drift fix, Watch evidence),
[October 22](docs/history/handoff-2026-10-22.md) (Tasks UI refinement and approved interface),
[October 21](docs/history/handoff-2026-10-21.md) (the Private MCP, Boundary B, done steps in Plan, the Tasks PWA
features, the FlowDay retirement), [October 20](docs/history/handoff-2026-10-20.md),
[October 19](docs/history/handoff-2026-10-19.md), [October 18](docs/history/handoff-2026-10-18.md),
[October 11](docs/history/handoff-2026-10-11.md).

## Current work

### Verify after the October 28 releases (read-only)

The released notes are in the [October 28 archive](docs/history/handoff-2026-10-28.md).

- Newsletter researcher: after the next 07:00 Los Angeles run, the `feeds` node succeeded (or `partial_failure`
  with per-source codes in its artifact), its log line shows source/ok/failed/seed counts, discovery prompts carry
  only their own direction's seeds, and new 材料库 rows with 研究员订阅源 attribution appear only for pool
  candidates. Fix unreachable feed URLs in `newsletter/content-config/researcher.yaml`.
- Backups: Personal MCP's, Watch's and the links app's first backups (`latest.json` and one
  `backups/<start>/manifest.json` in each bucket, keys only); Home's tiles show `backup_age_seconds` with no
  `backup_stale` or `backup_failed`; the links Worker has no schedule and its `LinksBackup` Alarm runs at 05:25 UTC.
  After a day, each app's next natural run and Workers Free usage.
- Inventory and drift: with `LinksBackup` recorded and Brief torn down, the next "Infra drift" run, the
  account-inventory check, the Personal cloud reconcile and Home's 配置漂移 should all be clean.
- Fleet: the per-workload charts fill in now that the RBAC rule is applied, and the PID 1 `net/dev` mount keeps
  reporting the host's interfaces.

### Newsletter selection budget (released `8ceaeca8`; the bundle is published)

The 2026-10-28 07:00 Los Angeles run sent nothing. Selection, which cannot continue on error, reached its 150 second
content-config budget while its Router turn was still running (the day before it took about 58 seconds on the same
input size); nodes are never re-attempted, so no plan froze and the run stopped at `no_publishable_content`.

- Done: selection `timeout_seconds` 150 → 420 in `newsletter/content-config/workflow.yaml`, a test pinning it, and
  the production node budgets in `newsletter/docs/workflow.md`. The packaged `daily.yaml` baseline is unchanged.
- Local checks passed: Newsletter lock, lint, format, structure, mypy and the full pytest suite; the content-config
  bundle builds and validates offline.
- Expected selection (`ci_changes.py`): Newsletter and Platform checks and Contracts; a non-Markdown file under
  `newsletter/content-config/` also selects the Newsletter image, Platform publish and Platform deploy (the VPS
  release when enabled), although only configuration changed.

Release, in order, finished before 13:45 UTC on a run day (a Platform release suspends `newsletter-daily` and closes
admission until it reports ready):

1. Push, full green `CI gate`, fast-forward `main`. "CI and deploy" validates the bundle in the candidate image and
   releases it; the Platform release must reach ready with `newsletter-daily` unsuspended.
2. The "Newsletter Content Config" push run defers (the commit also changes a test and docs); its `workflow_run` after
   that CI publishes the bundle to `published`, and config-sync activates it within 900 seconds unless a local pin
   holds the old one. Each run freezes the active bundle when it starts.
3. Verify read-only: config-sync status shows this revision active and no pin; the next run's selection succeeds and
   its issue is accepted. Then move this section to the dated history.

### Newsletter console (`claude/nl-console`, slices S1-S7; S1, S2 and S3 released)

Owner request 2026-10-29: a self-consistent Newsletter dashboard with each issue's full content, sources, model calls,
runs and failures, deliveries, config revision and Notion status, where Notion is shown only as an async backup of
Newsletter's own SQLite. Design: a check-only Worker app `newsletter-console/` on its own Access host reads a new
read-only listener inside the Newsletter process through the platform tunnel path `/api/newsletter/v1/*`. The owner's
Access application covers both destinations, so the Worker forwards the owner's own token and no new secret, service
token or owner step exists; the Worker's owner identity is Home's (`identity_from = "home"`).

- S2 (`newsletter.ui.v1` in `proto/newsletter/ui/v1/`) and S3 (console scaffold, `owner["newsletter-console"]` with
  the second destination, the tunnel path rule, `PATH_RULES` in `reconcile_policy.py`, CI wiring, `identity_from`)
  land here. Expected selection: every check, `dashboard_deploy` only; the console stays check-only.
- Release: "Infra drift" must show exactly create 1 (`owner["newsletter-console"]`), update 1 (the platform tunnel
  config), output changes 1 (`access_aud`), then "Infra apply" with that line; the verify plan is no-op. An anonymous
  request to the runtime path is redirected to Access; the Codex path and the daemon route are unchanged. The path
  answers an error after Access until S4's listener exists.
- S1 (engine observability gaps: per-call times, purpose, failure and Router request names; per-source feed counts;
  Notion progress time) released on 2026-10-29 after that day's run had finished; it releases the Newsletter and
  Platform images through the paired VPS release. Old usage rows keep their totals; the email bytes are unchanged.
  Verify after the next run: its collection and usage rows carry the new keys, and Notion rows get `progress_at`.
- Next: "Infra apply" above (still pending), then S4 (the listener; the image bakes the console AUD, so S4, S5 and the
  first-deploy commit land together after a 07:00 Los Angeles run has finished); S5 deploys the console (probe that Access accepts the forwarded token for the second destination); S6
  adds the remaining pages; S7 aligns Home and Fleet (engine row 「Newsletter 引擎」, no 「写入 Notion」 stage, links to the
  console) on top of the Newsletter config views already there.

### Architecture review follow-ups (2026-10-29)

The owner asked whether shared microservices could be extracted from the Workers. A read-only review found none
worth extracting: every external credential has one holder, and the existing shared services (Model Router, Tasks'
TaskInbox, Fleet's report ingest) each own a scarce resource or ledger with several callers. The complexity sits in
build-time registration and cloned release recipes, so the approved follow-ups subtract there:

- Released with this merge (no app deploys): Tasks, Watch and Personal MCP now refuse to ship past a selected
  upstream deploy that failed (the SELECTED_ONLY form Router edges use); `finalize.py` APPS, `DEPLOY_JOBS`, the
  wrapper map and Home's deploy-order test derive from configuration (the rebuild's finalize step listed 8 of 11
  Durable Object apps); `worker-release.yml` records Tasks' environment URL; docs no longer misdescribe the links
  backup schedule, the website sync triggers, Home's outbound bound or the infra object count.
- Released with the `claude/deploy-core` merge (deploys those seven Workers once, with byte-identical secrets
  files, wrangler arguments and Home desired state): one shared Worker deploy-vars core in
  `tools/cloud-config/worker-deploy.mjs` for links, watch, recall, mailsort, fleet, tasks and personal-mcp; each
  wrapper now declares its differences as data. Model Router, Mail Hero, Home, Todofy and the relay keep their own
  wrappers for now; the console migrates after its slices land. A core change is proven at each app's next release.
- Released with the `claude/ci-base-ancestry` merge (one website rebuild, same content): a push to main now diffs
  from the newest green ancestor through every parent (`git rev-list --date-order <push>^@`), not the first-parent
  line. Landings that merged main into the branch and fast-forwarded main had sent the base back to the branch's
  old base, so `ee7c0e2f` and `26dab066` redeployed nine Workers and the paired VPS release for small changes.
  The website release's green-commit pick had the same flaw when main's head was not green yet. Land with main as
  the first parent anyway (`git merge --no-ff <branch>` on top of origin/main), which keeps `--first-parent` logs
  readable. Verify: the next main push's Changes job prints the previous main head as its base.

## Latest verified release

`7f8f4c3b`, Newsletter configuration activation visible through Fleet and Home:
[main release](https://github.com/ziyixi/todofy/actions/runs/40835158998). Its matching Personal cloud reconcile
passed with resolved drift, resource registration and VPS gates. A fresh new observer report carried real
configuration identities and source poll times; Fleet and Home showed the same times through existing read-only
interfaces. [Acceptance](docs/history/handoff-2026-10-29.md#newsletter-configuration-visibility-released-7f8f4c3b).
Per-app identities are in GitHub production Deployments.

## Verify after deploy

- Model Router's daily 04:47 UTC backup: the next natural run. A fresh-account cloud restore is a separate exercise
  ([backup](model-router/docs/backup.md)).
- Mail Hero's daily 04:17 UTC backup after the write reduction (`d1a6e526`): the next natural run and its daily
  usage ([backup write verification](mail-hero/docs/backup-write-verification.md)).
- Sunday backups: Tasks' weekly backup now holding the GTD and Goals tables, and Todofy's first Sunday backup after
  Boundary B and the FlowDay release (its health page shows it complete with no `tasks` section).
- Merged ahead of the Router releases without a publication record of their own: Tasks' Sunday-first week and shared
  estimate editing (`a048ba34` to `f5cd8bbe`), Mailsort's recent read Inbox intake (`7427565d`). Confirm the `deploy:tasks` and
  `deploy:mailsort` Deployments are at or after those commits and check the behaviour read-only. A natural Mailsort
  batch through the Router has not been observed.
- Native hourly Work review: catalog refresh and Work event continuation passed in the owner's existing Dot
  ([evidence](docs/work-memory-verification.md)); the first natural run of the
  saved shared review is unverified (the host's next-run field is null). Do not substitute a Codex heartbeat, an
  accepted delivery count or a local fake callback for client execution. Existing user Watches and the old stopped
  automations stay as they are.
- Recall: the first production file removal after seven days and one Dropbox cold read, recording metadata only.
  The phone still reports build `337`; `451` needs phone acceptance, and the cause of `page_probe_invalid_reply_type`
  is not established ([verification](recall/docs/verification.md#phone-evidence)). The cost estimates in
  [design §5.3](recall/docs/design.md#53-budgets) predate minute snapshots with screenshots.
- Links and the website relay have not released through their composites since `dd7a6e8` removed the direct `vars`
  expressions; check each one's first natural release (a preflight or no-op does not load the composite).
- Not rechecked since: Watch's first real changed-watch digest and Newsletter's natural provider/send acceptance.
  Check fresh status before treating an old waiting item as open; do not restart Compose, replay a send or request
  credentials solely from an archived note.
- Bootstrap and safe drift repair are verified in the existing environment. Empty-account / clean-VPS setup, DNS and
  host-entry recovery and full historical data recovery remain separate exercises; follow [rebuild](docs/rebuild.md)
  and [its verification table](docs/rebuild-verification.md).
- The two scheduler observations the owner stopped on October 17 (email models, website daily sync) stay stopped
  ([October 18 archive](docs/history/handoff-2026-10-18.md#stopped-scheduler-observations)).

## Code follow-ups

- Mailsort's `AI` binding removal was confirmed by provider readback ([verification](mailsort/docs/verification.md#claude-provider)):
  drop `AI` from Mailsort's `RETIRED_BINDINGS` entry in `tools/cloud-release/control.py` in a push that deploys
  Mailsort anyway.
- Boundary B ([archive](docs/history/handoff-2026-10-21.md#boundary-b-released-claudeboundary-b)): once Todofy's
  Sunday backup above is confirmed, in a push that deploys them anyway, drop the completed `TASKS` name from Todofy's
  `RETIRED_BINDINGS` entry in `tools/cloud-release/control.py` and reword `proto/buf.yaml`'s header comment, which
  still names the retired `todofy/taskintent/v1` (a change to that file alone deploys every app and the VPS).

## Owner items

- Install Recall Orion `2026.1015.451` on the phone; renewed phone acceptance follows it.
- Read-only checks for Boundary B: Tasks › Mail lists mail and its categories; Plan's weekly review shows the
  pending-mail count; Tasks › GTD shows the copied trend; Mail Hero's 提醒 card names Home's digest task.
- Remove the installed FlowDay PWA from each device (optionally, with the owner's OK, its stopped Compose service and
  tunnel rule in `self-host-on-vultr`). By hand on the Mac: the Tasks PWA's Dock menu, a `?task=` link opening in the
  app window, the title-bar toggle, the mini timer and a real lock with Keep and Discard.
- Remove Todoist Plus from `chrome://extensions` (its variable, releases and merged branches are gone).
- Decided 2026-10-15, do not re-ask: Recall keeps its seven-day cloud file window, and native weekly rollover stays
  enabled; a commitment for an ended week reads as weekly in Tasks ([Tasks design](tasks/docs/design.md)).
- Home host, whenever convenient (it runs headless; no login screen):
  `sudo systemctl set-default multi-user.target`, `sudo systemctl stop gdm`, `sudo systemctl restart polkit`. Then
  Fleet's memory reading and swap use should drop.
- Brief is retired (2026-10-28); Newsletter is the one daily briefing. If the private bootstrap input still holds
  `worker_secrets.brief` or `BRIEF_*` entries, delete them before the next bootstrap (a leftover
  `worker_secrets.brief` makes it fail); `private_input.py` keeps ignoring an old `BRIEF_CSRF_SIGNING_KEY`.

## Operating boundaries

- Workers release independently from committed Wrangler configuration. `config/cloud.toml` is the public deployment
  profile; generated `config/resources.toml` records resource identities. Use the configuration/bootstrap tools and
  `infra/` for their declared resources. Preserve root mail records and unrelated resources.
- GitHub Actions deploys the Newsletter/Platform images by digest through the typed daemon API; it holds no SSH key
  or Kubernetes credential. Legacy Compose services stay stopped with their data; Newsletter remains an independent
  VPS service until the owner retires it.
- Mail Hero backs up natively through its DO Alarm and private R2 ([native backup](mail-hero/docs/native-backup.md)).
  Tasks backs itself up weekly into `tasks-backups` ([Tasks backup](tasks/docs/backup.md)), and Todofy backs up only
  its own D1 (both from release 2 of Boundary B). Model Router backs up request metadata and retained bodies daily
  into its private bucket ([backup](model-router/docs/backup.md)). With the backups wave, Mailsort, Personal MCP, Watch
  and the links app each back up daily into their own private bucket (see Current work).
- Provider keys are Router secrets and never pass through GitHub; spending is capped at the provider. Application
  budgets stay as they are; Workers Free remains in force.
- Keep Home's persistent alert dismissal. Historical unknown business outcomes are not automatic replay permission;
  follow current [dashboard-state semantics](docs/dashboard-state.md).

## Dated compatibility and retained data

The authoritative [compatibility table](docs/history.md#owner-api-compatibility) defines the old-client responses:

| Surface | Earliest removal |
| --- | --- |
| Mail Hero legacy owner routes (and `GET /api/csrf`) | 2026-11-01 |
| Home and Todofy legacy owner routes (and their `GET /api/csrf`) | 2026-11-02 |
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
