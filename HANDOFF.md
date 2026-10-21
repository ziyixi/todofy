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

### Private MCP connection gate (`codex/personal-mcp`)

Implementation is isolated in `/private/tmp/todofy-personal-mcp`; the shared checkout and Claude's work are
untouched. Published main SHA `ef76b57d` passed full branch CI `39545449859`; production release `39546367619`
passed on attempt 2 after its initial anonymous network probe failed. The unchanged live probe also passed.
IaC creates/updates `39545088566` / `39546470218` touched only the MCP Access application and ended with no drift.

The real Access identity and SubscriptionStore namespace are recorded in config/resources.toml. This follow-up
removes the namespace's first-deploy marker and completes Home's resource mapping. It has passed all local
registration checks and the full Home recipe; its branch CI/main publication still need completion.
The MCP has only connection status, synthetic test delivery and persistent subscriptions, with no business bindings.

**Blocked on owner consent:** Chrome created the private Personal Cloud connector and is at Connect Personal Cloud.
Automatic approval review requires explicit confirmation of the page's newly disclosed potential chat/memory
sharing scope. The approval question is pending. Do not bypass it, create another connector, or extract browser
credentials. Continue the retained page after confirmation, then use the existing Dot for real subscription/receipt.
No real Dots receipt or business-content access is claimed. Evidence and next steps:
[Personal MCP verification](docs/personal-mcp-verification.md). Only after this gate passes, add business tools/events.

### Done steps stay in Plan's Week calendar (`claude/plan-done-steps`)

**Local only, not pushed**, rebased on `origin/main` `8d8ce547`. A calendar step ticked in Plan › Week stays in its day,
done, after the open steps and outside the day's total; its title opens Tasks' dialog to reopen it; Focus is
unchanged ([interface](packages/planning-ui/docs/interface.md#week)). Reviewed: a repeating step dropped back on its
done day now shows open at once; a browser journey reopens a done step from Tasks' dialog. Deploys Tasks only. After
the rebase, `ci_changes.py` selects shared packages, contracts and Tasks; all three passed on macOS (planning-ui's 272
tests; the Worker's 65 unit and 97 runtime tests, the web's 55 unit tests, build and 109 Playwright tests, the tools' 31).

### Retire FlowDay and drop Todofy's planning store (`claude/retire-flowday`)

**Ready to release; local only, not pushed.** A branch from `origin/main` `777d5f01`, which holds the Tasks
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
