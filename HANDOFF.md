# Handoff

Updated 2026-10-27 UTC. Current work describes in-flight and unreleased work in detail; released work moves to a
dated record under `docs/history/` and is linked here, without run-ID ledgers. Rules are in [AGENTS](AGENTS.md);
entry points in [README](README.md). Never put private content, credentials or raw production output here.

Archives (their waiting lists are not instructions): [October 27](docs/history/handoff-2026-10-27.md) (Model Router
cutover, Codex gateway and 6.1 runtime, shared workspaces, Mailsort providers and intake, Tasks planning, GTD and
Goals, Mail Hero backup writes, the configuration-drift fix, Watch evidence),
[October 22](docs/history/handoff-2026-10-22.md) (Tasks UI refinement and approved interface),
[October 21](docs/history/handoff-2026-10-21.md) (the Private MCP, Boundary B, done steps in Plan, the Tasks PWA
features, the FlowDay retirement), [October 20](docs/history/handoff-2026-10-20.md),
[October 19](docs/history/handoff-2026-10-19.md), [October 18](docs/history/handoff-2026-10-18.md),
[October 11](docs/history/handoff-2026-10-11.md).

## Current work

### Review cleanup wave (integrated, not yet pushed)

The owner approved fixing the October 25-27 review findings within these limits: backups stay as complete and
recoverable as before (Model Router request bodies stay in its backups), no backup scope, retention or restore tool
is reduced, no stored production data is deleted and the privacy pages are not changed. Dated 410 routes and old
core RPCs stay until their recorded dates; legacy contract schemas, fixtures and frozen bytes stay unchanged;
`platform/src/personal_cloud/deployment/` is frozen.

Nine package branches started from `origin/main` `4ed50919` and were reviewed separately. `claude/wave-integrated`
merges them in the order ci, telemetry, watchmcp, router, mailsort, tasks, home, apps, docs (one merge commit each),
then adds the cross-package fixes below. Nothing is pushed or deployed. Landing: push the integrated branch, wait for
the complete `CI gate`, promote the same green SHA to `main`, then wait for the matching Personal cloud reconcile and
a current Home check before delivery. When it lands, record the release here and move this section to a dated archive.

Next, in order: a backups wave, then the owner's secret cleanup and its small code follow-up (both tracked in
private notes).

Results by branch:

- `claude/wave-ci`: the Router release chain fails closed; the Codex gateway releases only when its own inputs
  change; a root dependency bump deploys only the members it reaches; the pre-workspace install fallbacks, member
  `engines` blocks and `.nvmrc` files are gone (the Node version comes from the root `package.json`); other apps'
  proto packages stay out of the website's code identity; a fresh bootstrap creates `MODEL_ROUTER_MAINTENANCE_MODE`
  and `BRIEF_MODE`. Release repair or rollback can now rebuild only revisions from the shared workspace onward.
- `claude/wave-telemetry`: the Codex gateway monitor is retired and the Model Router is the one Codex usage
  ledger (`codex.monitor.v1`, `OpsStatus.codex_inference` and `WorkloadStatus.inference_status` retired; the gateway's
  `/healthz` is liveness only; Home's gateway row opens the Router console). Newsletter no longer mounts the Codex
  login. ops-v1 is app-agnostic (`OpsStatus.app` is a format, not a list), `OpsDigestService`/`OpsReport` are
  retired, each app checks only its own deployment modes, and website sync evidence moved off `OpsStatus` to the
  relay's own `WebsiteSync` entrypoint: Home's `NOTION_PUBLISH` binding targets the relay's `Ops`, `WEBSITE_SYNC`
  its `WebsiteSync`. Home routes Ops calls through the registry's binding map.
- `claude/wave-watchmcp`: Watch compares evidence by its masked title, Markdown and image hash only, no longer
  captures the accessibility tree (`Snapshot.structure_json` retired) and drops rule confirmations from the private
  feed (`KIND_CHANGE_CONFIRMED`, `WatchEvent.change` retired); a too-short browser render fails again; an evidence
  storage error no longer fails the check. Personal MCP reads the Watch feed in pages, recovers from an expired cursor
  with one gap report per open Work, and keeps its Dot-facing rules in `SKILL.md` and the tool descriptions.
- `claude/wave-router`: the Newsletter identity may call Codex models only; failures carry the shared reason
  contract (provider 400/413/422 are `MODEL_INVALID_REQUEST`, the Router's own deadline is `MODEL_TIMEOUT`, a credit
  balance refusal is `MODEL_SPEND_LIMIT`, output limits are code 13 from every provider, a rejected Gemini key or
  account stays a configuration error); stuck `running` rows are
  closed by the daily cleanup; context expiry is left to the gateway; the dead `/api/session` endpoint and the
  unused `conversations` table go (migration 0004); the console is light-only. Brief keeps its reservation rates
  itself, stops spending attempts and budget on Router outages, and its README records it as stopped.
- `claude/wave-mailsort`: the Workers AI path, new learning examples (historical ones stay), breaker, the
  one-time rechecks, label consolidation, prompt-cache hints and the Codex usage ledger are retired; model failures
  follow the Router contract (a Codex spend limit holds hourly, Claude's waits for the next month) and a failed mail
  is retried alone; Codex is the default provider for a settings row without one; the
  recent read intake skips sent copies; bundled prompts carry no personal details. The two recheck request fields
  stay `deprecated` (an old page still gets `RELOAD_REQUIRED`), and the consolidation RPCs answer `RELOAD_REQUIRED`
  for a restored unfinished job.
- `claude/wave-tasks`: Plan and Focus lost code from retired lanes and views; committed ready work stays in
  Committed; parked pickups are acknowledged; Quick estimates show; task details can clear a saved Waiting or On
  hold; the GTD page no longer lists tasks; `ListGtdDays` and `ListWeeklyReviews` are retired (the daily counts stay
  in D1); GTD task rates are judged per week. Dated QA captures and ledgers became
  [approved interfaces](tasks/design-qa.md) and one [verification record](tasks/docs/verification.md).
- `claude/wave-home`: every drift check reads at least the last day of account writes (a write may appear in two
  checks within a day); stale CSRF-cookie comments are fixed; the token setup text is neutral; local installs use the
  root workspace. Home's static `GET /api/csrf` is dated to the 2026-11-02 cutoff with its old routes.
- `claude/wave-apps`: Newsletter has one default model and no `codex` extra; Todofy stores native model IDs
  (migration 0017, data-only and idempotent; restoring an older weekly backup replays it) and explains the cost of
  each model choice; Todofy's and Mail Hero's `GET /api/csrf` is dated to their cutoffs (a cached pre-keyless UI fetches it before its
  first write, so it stays until then);
  Mail Hero's v1 collector endpoints, container, Dockerfile and image workflow are retired, while the native backup,
  its artifact downloads, `writers`/`reconcile-writer` and the offline v1/v2 restore tools stay.
- `claude/wave-docs`: HANDOFF keeps in-flight work only and the released sections moved to the
  [October 27 archive](docs/history/handoff-2026-10-27.md); one-off verification ledgers moved into their
  applications ([Mailsort](mailsort/docs/verification.md), [Model Router](model-router/docs/verification.md),
  [Recall](recall/docs/verification.md), [Personal MCP](personal-mcp/docs/verification.md),
  [website](website/docs/verification.md), Todofy's Gemini section) and the Codex monitor record to
  [history](docs/history/codex-monitor.md); public docs no longer describe credential custody or open gaps.

Integration fixes: one `fields` retirement kind in `proto/tools/retired.py` (by full field name and number; a kept
file's import used only by retired fields leaves the base with them) serves all five retired fields, with combined
tests and 76 self-test cases; `proto/retired.json` unions every branch's entries; the
[architecture](docs/architecture.md#home) Home paragraph matches `dashboard/wrangler.toml`; archived handoffs link
the condensed Tasks and Work-memory records; CI/CD and architecture docs no longer describe a Mail Hero collector
image; the compatibility tables name each app's dated `GET /api/csrf` (Todofy's and Mail Hero's restored, since a
pre-keyless tab fetches it before its first write and would otherwise get no reload prompt); the audit
window comments say "at least the last day"; the Mailsort and Recall bundle budgets follow the smaller bundles.

Release effects to expect (one push deploys every Worker and the VPS images):

- Order: the website relay deploys before Home (its old `Ops` no longer serves sync); for the few minutes between
  them the old Home shows no sync evidence and an owner 立即同步 tap ends unconfirmed (a later tap works).
- Fleet may reject host reports and show host_stale for up to about 15 minutes, until the new gateway Pod and
  Platform status daemon stop sending `inference_status`. If the VPS release is skipped or fails, Fleet stays stale
  until a gateway or Platform release lands; rolling back means redeploying the previous Fleet.
- The Router chain now fails closed: this run selects the gateway, so a failed gateway VPS release also holds the
  Model Router and, behind it, Todofy, Mailsort, Brief, Home and the Platform/Newsletter VPS release. Re-run the
  failed jobs after fixing the gateway rather than dispatching single apps out of order.
- Each evidence-enabled watch writes one new snapshot and one EVIDENCE_CHANGED event on its first capture (the
  comparison hash changed), so each linked open Work gets one progress report. Old and new `content_sha256` values
  are not comparable.
- Migrations: Todofy 0017 rewrites stored legacy model IDs; Model Router 0004 drops the unused `conversations` table,
  whose content-free bookkeeping rows were already past their own one-day cleanup. Request history is unchanged.
- Every Node app redeploys once (manifests changed) and the website code identity changes once.

Owner follow-ups after the release:

- Press Refresh tools in the existing Personal Cloud App (`watch_read` lost its `representation` input) and
  republish the plugin skill from `personal-mcp/plugin/skills/personal-cloud/SKILL.md` through the usual separately
  authorized account update.
- Refresh Home's Cloudflare check after deploy: its desired config gained the `NOTION_PUBLISH` binding.
- Read-only checks: Home's 网站同步 panel shows evidence after the first tick or refresh; Fleet, Newsletter and the
  gateway tiles return to fresh; Todofy's model settings show native IDs.
- After the first green `main` run: the new `retired.json` entries may be removed (the `reserved` lines stay). The
  `RETIRED_BINDINGS` entries stay until their own verified-release rule allows removal.
- On or after 2026-11-01: delete Mail Hero's `GET /api/csrf` (`csrfResponse`) with its `/api/v1` 410 routes. On or
  after 2026-11-02: delete Home's `GET /api/csrf`, `CsrfResponse`, `PATHS.csrf` and the legacy-410 block, and
  Todofy's `GET /api/csrf` (`issueCsrf`), together with the other dated routes.

## Latest verified release

`129d5fe9`, Router cost visibility and recommendation array schemas:
[main release](https://github.com/ziyixi/todofy/actions/runs/40544317131). Its matching Personal cloud reconcile
passed with resolved drift, resource registration and VPS gates. Per-app identities are in GitHub production
Deployments.

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
- Brief is stopped since 2026-10-18 (`BRIEF_MODE=off`, code kept) and Newsletter is the active daily briefing.
  Resuming Brief means setting the mode and dispatching `app=brief`; its sender `onboarding@resend.dev` reaches only
  the Resend account's own address and must change before any send. Retiring either app is a separate owner decision.

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
  into its private bucket ([backup](model-router/docs/backup.md)).
- Provider keys are Router secrets and never pass through GitHub; spending is capped at the provider. Brief's stored
  budget and the other application budgets stay as they are; Workers Free remains in force.
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
