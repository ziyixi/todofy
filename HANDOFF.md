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

### Review cleanup wave (in progress)

The owner approved fixing the October 25-27 review findings within these limits: backups stay as complete and
recoverable as before (Model Router request bodies stay in its backups), no backup scope, retention or restore tool
is reduced, no stored production data is deleted and the privacy pages are not changed. Dated 410 routes and old
core RPCs stay until their recorded dates; legacy contract schemas, fixtures and frozen bytes stay unchanged;
`platform/src/personal_cloud/deployment/` is frozen. Branches run local checks only and deploy nothing.

Nine branches start from `origin/main` `4ed50919`, each in its own worktree with disjoint paths:

| Branch | Owns |
| --- | --- |
| `claude/wave-router` | Model Router, Brief, `packages/model-router-client` |
| `claude/wave-telemetry` | Codex gateway and its monitor removal, ops/Codex/Platform protos, Platform, Fleet, VPS bootstrap, website relay, Home's Ops routing |
| `claude/wave-mailsort` | Mailsort |
| `claude/wave-tasks` | Tasks, `packages/planning-ui`, Tasks protos, `docs/tasks-*.md` |
| `claude/wave-home` | Home, except its Ops routing |
| `claude/wave-watchmcp` | Watch, Personal MCP, their protos, the work-memory and Watch evidence records |
| `claude/wave-ci` | `.github/`, `tools/`, toolchain declarations, [CI/CD](docs/ci-cd.md) |
| `claude/wave-docs` | HANDOFF, AGENTS, root docs and history, the moved verification records |
| `claude/wave-apps` | Newsletter, Todofy, Mail Hero |

Landing: merge all nine into one integration branch in any order. Each branch reports the few edits it made outside
its own paths; resolve those at the merge. Run the complete branch gate, promote the same green SHA to `main`, then
wait for the matching Personal cloud reconcile and a current Home check before delivery. When it lands, record
each branch's result and the release here, then move this section to a dated archive.

Next, in order: a backups wave, then the owner's secret cleanup (steps kept in private notes). The code side of that
cleanup is removing the retired optional secret declarations (regenerate with `tools/cloud-config/generate.py` and
`.github/scripts/drift_desired.py`) and emptying `RETIRED_VALUES` in `infra/scripts/infra_state.py`.

#### `claude/wave-docs`

- HANDOFF keeps in-flight work, one latest release, open checks, owner items and boundaries. The released sections
  moved to the [October 27 archive](docs/history/handoff-2026-10-27.md), without credential-handling,
  privileged-access or account-audit details.
- One-off verification ledgers moved into their applications, condensed to behavioural conclusions with one
  evidence link each: [Mailsort](mailsort/docs/verification.md) (four root records and the interval record),
  [Model Router](model-router/docs/verification.md), [Recall](recall/docs/verification.md) (four records),
  [Personal MCP](personal-mcp/docs/verification.md), [website](website/docs/verification.md) and a Gemini
  email-model section in [Todofy's verification](todofy/docs/verification.md). The Codex monitor record moved to
  [history](docs/history/codex-monitor.md). Older archives link to the removed files at `4ed50919`.
- AGENTS: public docs never record credential custody, key lifetimes, host leftovers, privileged steps or open
  security gaps; HANDOFF Current work holds only in-flight work; Brief is stopped and Newsletter is the active briefing.
- [Architecture](docs/architecture.md): every current Home binding, keyless CSRF, no Mailsort breaker, provider keys
  as Router secrets, Brief stopped, Recall's seven-day window. Mail Hero CI/CD, Todofy's development notes and
  Recall's mobile page install from the root pnpm lock instead of `npm ci`.
- Edits outside this branch's paths: inbound links in `mailsort/docs/priority-rollout.md`, `personal-mcp/README.md`
  and `personal-mcp/docs/connection.md`, and the appended section in `todofy/docs/verification.md`.
- For the merge: if `claude/wave-telemetry` drops Home's `CODEX_GATEWAY` binding, drop it from the architecture Home
  paragraph too; if another branch moves `docs/tasks-*`, `docs/work-memory-verification.md` or
  `docs/watch-evidence-verification.md`, repoint the links in HANDOFF and the October 27 archive. Markdown under an
  app directory selects that app's checks and release in `ci_changes.py`.
- Local checks: `.github/scripts` unit tests (461, one existing skip), service-catalog and cloud-config checks,
  website Prettier and a relative-link and heading-anchor check over every changed Markdown file.

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
  ([evidence](docs/work-memory-verification.md#native-dots-acceptance-2026-10-23-utc)); the first natural run of the
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
