# Handoff

Updated 2026-10-19 UTC. Keep this file focused on active work, open acceptance and dated compatibility constraints.
Move completed rollout detail to a dated record and link it here. Repository rules are in [AGENTS](AGENTS.md);
service entry points are in [README](README.md). Never put private content, credentials or raw production output here.

Completed work is archived: the October 19 releases (Plan write reliability, whole-row drag, inline subtasks and Plan
completion) in [docs/history/handoff-2026-10-19.md](docs/history/handoff-2026-10-19.md), through October 18 (Tasks
refinement and cutover, VPS recovery, Recall, Mailsort) in
[docs/history/handoff-2026-10-18.md](docs/history/handoff-2026-10-18.md), earlier in
[docs/history/handoff-2026-10-11.md](docs/history/handoff-2026-10-11.md). Their waiting lists are not instructions.

## Current work

### Tasks cleanup and Todoist Plus removal (`claude/tasks-cleanup`)

A local branch from `f6c08aaf`, not pushed yet, merged with `origin/main` at `69ddb339` so that Codex's October 18-19
Tasks and Plan work (inline subtasks, whole-row drag, Plan completion, native rollover) runs on the native path: the
verified Tasks review fixes, Tasks' D1 in Todofy's weekly
backup, the Tasks duration as the only estimate, the Planning channel allowlist, and the removal of the Todoist Plus
extension and of every Todoist path in Todofy and FlowDay. By the owner's decision the end state ships at once: no
compatibility window, staged rollout, flag or rollback machinery.

- **Release.** Push, wait for the complete gate, then fast-forward `main` to the same green SHA. CI releases Tasks →
  FlowDay → Todofy → Home, and each works while the later apps still run the previous release. Migrations: Tasks
  `0004`, FlowDay `0005` (deletes the Todoist settings rows), Todofy `0012` (drops `plus_connections`, `plus_actions`).
- **Expected effects.** Home reports the retired Worker secrets as drift until step 2. A ConvertMailItem or
  DeleteMailSummaries retry across the release with the same request ID is refused; a new request works. FlowDay
  drops `FocusEntrypoint` while the old gateway still binds it (nothing calls it); if Cloudflare refuses that
  upload, the gateway, which drops the binding, has to go first.
- **Before pushing (read-only).** This must print nothing. If a map is listed, set it again without `TODOIST_API_KEY`
  and `CREDENTIAL_KEY` (`tools/cloud-bootstrap/bootstrap.py secrets`); the deploy wrappers now refuse those names.
  `gh secret list --env production --repo ziyixi/todofy | grep -E '^(TODOFY_CORE_WORKER_SECRETS|FLOWDAY_WORKER_SECRETS)\s'`

Right after the release, in this order:

1. The one-time FlowDay estimate backfill: [commands and checks](tasks/docs/backup.md#one-time-flowday-estimate-backfill).
   Do not wait: FlowDay's sync replaces an old FlowDay estimate as soon as its task changes in Tasks.
2. Delete what nothing reads any more, then refresh Home's drift check and expect no differences. The owner may also
   revoke the Todoist API token; nothing uses it.
   ```sh
   (cd todofy/gateway && npx wrangler secret delete TODOIST_API_KEY --name todofy-core)
   (cd flowday/worker && npx wrangler secret delete CREDENTIAL_KEY --name flowday)
   gh secret delete FLOWDAY_CREDENTIAL_KEY --env production --repo ziyixi/todofy
   gh variable delete TODOFY_PLUS_METADATA --env production --repo ziyixi/todofy
   ```
3. Confirm the first Tasks backup, taken at Todofy's first alarm after the release: its time on Todofy's health page
   or Home is newer than the release. Restore it locally as [Rehearse locally](tasks/docs/backup.md#rehearse-locally) says.
4. Remove the Plus releases and the merged branches. `git branch -r --merged origin/main | grep codex/` lists exactly
   these fourteen; the three unmerged Recall experiment branches stay by the owner's earlier decision.
   ```sh
   for t in $(git tag -l 'todoist-plus-v*'); do gh release delete "$t" --cleanup-tag --yes --repo ziyixi/todofy; done
   git push origin --delete codex/cloud-recovery-tasks codex/plan-write-reliability codex/plan-write-verification \
     codex/plus-ui-refinement codex/plus-ui-refinement-verification \
     codex/tasks-dependency-layout codex/tasks-details-polish codex/tasks-layout-verification codex/tasks-native \
     codex/tasks-read-efficiency codex/tasks-read-verification codex/tasks-refinement-verification \
     codex/tasks-workflow-refinement codex/vps-release-recovery
   git push origin --delete claude/tasks-cleanup; git branch -d claude/tasks-cleanup; git worktree prune
   ```
5. Owner, on the Mac: remove Todoist Plus at `chrome://extensions` with its unpacked folder, and delete the cutover's
   temporary operator files (a generated secrets file, private snapshots), whose locations are in private notes.

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
- The 48 merged `codex/*` branches were pruned from origin after a local bundle backup, so branch names cited
  in the archives as closing documentation may no longer exist. The three unmerged Recall experiment branches remain:
  `codex/recall-permission-setup`, `codex/recall-startup-diagnostic` and `codex/recall-orion-permission-verification`.

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
- [History](docs/history.md) and the handoff archives of [October 18](docs/history/handoff-2026-10-18.md) and
  [October 11](docs/history/handoff-2026-10-11.md): earlier releases and evidence. Move completed details there.
