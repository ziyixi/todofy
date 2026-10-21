# Handoff

Updated 2026-10-20 UTC. Keep this file focused on active work, open acceptance and dated compatibility constraints.
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

Final local check on 2026-10-20 UTC, with `777d5f01` still the tip of `origin/main`: `ci_changes.py` selects every
check job and deploys Tasks, Todofy and Home (with commit 7 also Mail Hero, Links, Watch, Mailsort and Recall),
prints no `flowday_*` key and refuses `-f app=flowday`. Each job passed on macOS: Changes' tests (`.github/scripts`,
the cloud-config, cloud-release, cloud-bootstrap and service-catalog tests and the four generators' `--check`),
Shared packages, Proto (breaking against `777d5f01` with `flowday.ui.v1` retired), Contracts, Infra (guards,
`tofu fmt` and `tofu validate`; its plan needs the state), Todofy static (1887 host tests) and runtime (all 498 in
one shard, the completeness check included), Tasks (the Worker's 65 unit and 97 runtime tests, the web's 55 unit
tests, build and 107 Playwright tests, the tools' 29 tests), Home (268 unit and 97 runtime tests, the UI's 158),
Mail Hero, Links, Watch, Mailsort, Recall, Brief, Fleet, Website (its export and Worker dry runs on another free
port), Newsletter (its engine steps with an empty `HOME`) and Platform's contract steps. CI alone runs the
Newsletter image, Platform's Linux steps, Mail Hero's GPG backup test and Changes' decide step. Not verified here:
the plan against the real state of the three `moved` blocks and of the two policies that leave with their block
(step 1 below reads it; Lab's moves applied cleanly on 2026-10-07, but this is the first time a `from` names an
instance of a resource no block declares).


- **Before pushing**, in this order:
  1. Confirm that P2's Todofy release is live: its "Todofy deploy" job succeeded, or Home's 配置漂移 shows nothing
     `extra` on `todofy` or `todofy-core` (no `FLOWDAY_FOCUS`, `FLOWDAY_NATIVE_FOCUS`, `FLOWDAY_PUBLIC_URL`,
     `TASK_SOURCE`, `TODOIST_API_BASE` or `PLUS_METADATA`). The empty `RETIRED_SERVICE_BINDINGS` stops a release
     that still finds one (`REPAIR_MANUAL_REQUIRED`).
  2. This read-only check must print nothing:
     `gh secret list --env production --repo ziyixi/todofy | grep -E '^(TODOFY_CORE_WORKER_SECRETS|FLOWDAY_WORKER_SECRETS)\s'`
  3. Delete the retired Todoist key from todofy-core; a deploy keeps a secret it does not name, so an undeclared live
     one stops the release. From `todofy/gateway`: `npx wrangler secret list --name todofy-core` (names only), then
     `npx wrangler secret delete TODOIST_API_KEY --name todofy-core`. Home's 非 CI 改动 shows this once. If
     `gh secret list --env production --repo ziyixi/todofy` shows `TODOFY_TODOIST_API_KEY`, delete it too.
  4. Remove the FlowDay values from the infrastructure inputs: after this release `infra_state.py` refuses
     unexpected variables. `grep -c flowday_policy ~/.config/todofy-infra/local.tfvars` prints a count; if it is not
     0, delete the `flowday_policy_names` and `flowday_policy_options` entries (and in the private bootstrap input's
     `infra_values`, if kept), then, from this branch's checkout:
     `python3 infra/scripts/infra_state.py values-json --var-file ~/.config/todofy-infra/local.tfvars | gh secret set INFRA_TFVARS --env production -R ziyixi/todofy`
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
- **Red or noisy by design until step 5 below:** "Infra drift" exits 3; Home's 配置漂移 shows the `flowday` script
  and its custom domain as `extra`; "Personal cloud reconcile" fails "Verify complete account resource
  registration" (the Worker and the D1 database `flowday` unregistered) and applies nothing.

The lead's steps after the release, in this order:

1. Read the merge commit's "Infra drift" run (it runs because `infra/` changed); do not apply yet. It must show
   `delete: 5` in exactly the rows `cloudflare_d1_database.retired_flowday`,
   `cloudflare_zero_trust_access_application.retired_flowday`, `cloudflare_zero_trust_access_application.retired_flowday_bypass`,
   `cloudflare_zero_trust_access_policy.flowday["flowday"]` and `cloudflare_zero_trust_access_policy.flowday["flowday-bypass"]`;
   every other row `no-op` (the previous green run's count minus 5); `output changes: 2`, both `update`
   (`access_aud`, `d1_database_ids`); no outputs problem; and the expect line `delete=5,outputs=2@<fingerprint>`.
   If it failed with "unexpected" values, step 4 above was missed: do it, then `gh workflow run infra.yml --repo ziyixi/todofy --ref main`.
2. Confirm that Home deployed, so no live Home still probes FlowDay's manifest.
3. *(Owner's choice; by decision, none.)* A cold copy of FlowDay's D1 before it goes:
   `npx wrangler d1 export flowday --remote --output <private 0700 dir>/flowday.sql`.
4. Delete the Worker by hand (Wrangler owns it, not `infra/`): Cloudflare dashboard → Workers & Pages → `flowday` →
   Settings → Domains & Routes → remove `flowday.ziyixi.science` (this removes its DNS record), then delete the
   Worker (its secrets, versions and assets go with it). Check that DNS has no `flowday` record and the account no
   Worker `flowday` (it never had a Durable Object namespace). Home's 非 CI 改动 may show these deletions once.
5. Dispatch "Infra apply" with the line from step 1 (if `main` moved with an `infra/` change since, read the new
   drift run instead): `gh workflow run infra-apply.yml --repo ziyixi/todofy --ref main -f expect='delete=5,outputs=2@<fingerprint>' -f confirm_destructive=delete-replace-forget`.
   It backs up the encrypted state, deletes the two Access applications, then the two policies, and D1 `flowday`
   with its rows and Time Travel, and ends with a verify plan of "No changes".
6. Delete the GitHub leftovers. List them, then delete each name printed:
   `gh secret list --env production --repo ziyixi/todofy | grep -E '^FLOWDAY_'`,
   `gh secret list --repo ziyixi/todofy | grep -E '^FLOWDAY_'` and
   `gh variable list --env production --repo ziyixi/todofy | grep -E '^FLOWDAY_'`; for example
   `gh secret delete FLOWDAY_CSRF_SIGNING_KEY --env production --repo ziyixi/todofy` (and `FLOWDAY_WORKER_SECRETS`,
   `FLOWDAY_CREDENTIAL_KEY` if listed). Leave the `deploy:flowday` deployment records as history.
7. Verify: `gh workflow run infra.yml --repo ziyixi/todofy --ref main` is green with `no-op` rows only;
   `gh workflow run personal-cloud-reconcile.yml --repo ziyixi/todofy --ref main -f operation=check` passes "Verify
   complete account resource registration"; Home's 配置漂移 shows nothing `extra`.
8. The follow-up commit, as Lab's `6f5f93e4`: delete the three `moved` blocks and the `retired_flowday_policies`
   map (`infra/retired.tf` again says no app is being retired, with the apply's date) and the three `RETIRED` pairs,
   and update this file. Its drift run must be green with no change.
9. After the first Sunday backup after the release (2026-10-25 10:00 UTC), confirm on Todofy's health page that it
   completed. Optional read-only check from `todofy/` (names only):
   `npx wrangler d1 execute DB --remote --config wrangler.toml --command "SELECT key FROM plan_settings"` prints only
   `todoist.mail`.
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
