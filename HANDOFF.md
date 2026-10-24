# Handoff

Updated 2026-10-24 UTC. Active work, open acceptance and dated compatibility only; move completed rollout detail to
a dated record and link it here. Rules are in [AGENTS](AGENTS.md); entry points in [README](README.md). Never put
private content, credentials or raw production output here.

Archives (their waiting lists are not instructions): [October 22](docs/history/handoff-2026-10-22.md)
(Tasks UI refinement and approved interface), [October 21](docs/history/handoff-2026-10-21.md) (the Private
MCP, Boundary B, done steps in Plan, the Tasks PWA features, the FlowDay retirement),
[October 20](docs/history/handoff-2026-10-20.md), [October 19](docs/history/handoff-2026-10-19.md),
[October 18](docs/history/handoff-2026-10-18.md), [October 11](docs/history/handoff-2026-10-11.md).

## Current work

`codex/mailsort-codex-batch` implements the owner-approved hourly Codex replacement: GPT-6.1 Sol medium,
an independent VPS CronJob, Mailsort machine claim/report endpoints, and current batch status in Mailsort/Home.
The owner explicitly approved one initial reclassification of **all currently unread** mail, including existing
P1-P4; routine hourly runs select only unread mail without a priority. No messages are deleted or marked read.
The local same-prompt 100-message comparison completed on SDK 0.163.0 (medium/high/max); private input and
per-message trial results stay outside Git. Production cutover and the first natural hourly run remain unverified.
The isolated checkout preserves Claude's shared source. Local checks include 154 Worker unit, 65 workerd
(including CPU), 76 UI, 26 deploy tests and the full 67-request synthetic Wrangler smoke; CI/image and
production verification remain pending. The new independent Codex login awaits the owner's Passkey verification
in Chrome; do not switch credentials or copy Newsletter auth to bypass it. VPS SSH works but sudo -n is unavailable,
so the fixed foundation bundle will need one owner sudo command.
Mailsort Ops no longer advertises retired Workers AI quotas or load shedding. Gmail daily-cap waiting is an
informational signal; saved decisions remain in the write ledger. Production currently reports the existing
150-write cap exhausted and the old daily-limit breaker; the owner has been asked whether to raise the cap
temporarily or wait for the next UTC day. Do not change the limit without that answer. CI for `69c70a29`
passed the new Mailsort/runner/Platform/Website checks; its only failure was a Home runtime registry assertion
missing the new hidden runner, now corrected. A full final branch gate remains required before main.
The older five unstarted original-100 rechecks below were cancelled in the preceding authorized read-only audit;
the production batch then reported applied 45, skipped 55, pending 0. Do not resume those cancelled requests.

Mailsort's calibrated priority correction and original-100 entrypoint are deployed at `eb3e21dc` after full
[branch gate 40064835511](https://github.com/ziyixi/todofy/actions/runs/40064835511) and
[same-SHA main release 40065406437](https://github.com/ziyixi/todofy/actions/runs/40065406437). Only Mailsort and
its required privacy page deployed. Verified Deployment `7294420109` reports Worker version
`e3f237e1-ec0d-4394-8a1a-d161c2aeb67b`, with the existing DO namespace unchanged.

The original 81 P1 assignments were all uncertainty fallbacks; 19 P4 passed the old policy. The deployed fix
preserves model evidence, excludes unconfirmed fallback assignments from automatic learning and separates P1
counts in the UI. Actual synthetic calibration used 96 calls, about 949 estimated neurons; its temporary Read
token was revoked. Acceptance is now 0.55 with the existing 0.4 first-view gate and two-view agreement. Captured
Clef results are 16/16 and Flash 13/16; these are sample regressions, not mailbox accuracy. Existing operating
modes, model budgets, write limits and Gmail credentials remain unchanged.

The earlier original-100 batch ended after the owner asked to leave its mail unchanged: 45 actual Gmail
changes, 55 skipped, pending 0 and failed 0. The five not-yet-started rechecks were cancelled; do not resume
or recreate them. The new owner-approved Codex task below separately authorizes reclassifying all **currently
unread** mail after the new release. Historical metrics are not mailbox accuracy.

The owner rejected a new post-model Gmail metadata check for concurrent manual edits. That request, its exact-label
guard and three tests were removed, along with one redundant P1 condition. Keep the ordinary initial label check
and pre-existing retry/ledger behavior; do not restore concurrency machinery or a test matrix. The affected runtime
checks passed all 51 cases after removal. Integrated checks also covered 153 unit, 91 workerd and 82 UI cases,
lint/types/build, the full local Wrangler smoke and proto lint/API lint/breaking checks. Full evidence is in
[priority verification](docs/mailsort-priority-verification.md).

The Watch evidence implementation and native Dots acceptance are complete; the verification record is in
[Watch evidence verification](docs/watch-evidence-verification.md). Its temporary subscription is stopped,
dedicated Watch paused and synthetic Work done. Existing hourly Work review remains unchanged.
Work used the isolated checkout `/private/tmp/todofy-tasks-design`; Claude's shared source checkout is untouched.

## Latest verified release

Mailsort's calibrated priority correction and simplified original-100 entrypoint are live at `eb3e21dc`, as recorded
above. Its earlier P1-P4 switch and 99-message unread batch completed at `d1295e7d`; the old recheck has no pending members. P1 keeps Inbox, P2-P4 archive, uncertainty becomes P1, and the
scam/trust gates are removed. Original mail and history remain. The isolated checkout left Claude's shared tree
untouched. Provider identity, tests and privacy-safe evidence are in
[priority verification](docs/mailsort-priority-verification.md); actions are in [priority rollout](mailsort/docs/priority-rollout.md).

Watch page evidence (`f7942fb6`) passed the complete
[branch gate](https://github.com/ziyixi/todofy/actions/runs/39950244799) and
[same-SHA production release](https://github.com/ziyixi/todofy/actions/runs/39952782780). Watch, Personal MCP and
Home deployed; their exact provider versions and successful Deployment IDs are in
[the verification record](docs/watch-evidence-verification.md). The private evidence bucket is managed by IaC;
[final drift](https://github.com/ziyixi/todofy/actions/runs/39952857265) has 39 no-ops and no changes. Home lists the
bucket under Watch. Private Personal Cloud skill 1.3.0 matches source, preserves its App/OAuth connection and
shows 36 tools plus the existing six events. The same Dot sees the new tools without a Reboot. No model API,
periodic scheduler, new secret or paid upgrade was introduced; ordinary Watch notifications remain independent.

Real Browser Run saved Markdown, native structure and a 1280 × 960 JPEG. The existing Dot actually read the images
and resumed on source event `watch:1`, handled sequence 9 and saved a structured relevance review against the frozen
after snapshot. The live fixture changed source-URL metadata; automated real-storage tests cover visual-only
changes. Scoped cleanup completed at 2026-10-23 13:04:27.673 UTC: subscription count, open Works and pending reports
all returned to zero. The verification record distinguishes the initial fact checkpoint from the structured
review added after clarifying the existing snapshot-reference contract.

Tasks' sidebar change (`56662a46`) passed the complete [branch gate](https://github.com/ziyixi/todofy/actions/runs/39931674226)
and [same-SHA production release](https://github.com/ziyixi/todofy/actions/runs/39933099264). The verified deployment
is `7274991045`, Worker version `01b39f19-8e70-48b2-b837-77af3a61e2a5`. Only Tasks deployed. Without a saved
branch choice, nested projects default expanded, including when the catalog arrives asynchronously; manual
collapse remains persistent. Six local Sidebar cases, TypeScript and lint passed. The owner's current project
branches were expanded through their existing controls and stayed open after reloading the deployed app.
Only browser navigation preferences changed; no real tasks or catalog records were modified.

Personal work memory (`84183945`) passed the complete [branch CI](https://github.com/ziyixi/todofy/actions/runs/39777372400)
and [same-SHA production release](https://github.com/ziyixi/todofy/actions/runs/39779693261). Watch and Recall deployed
before MCP, then Home. The authenticated existing MCP connection returns the exact SHA and `stage: work_memory`;
its old accepted delivery records remain intact. The private plugin skill is `1.2.0`, read back against source with
the App identity, OAuth connection, presentation and sharing unchanged. There is no new service, database resource,
model API or scheduler. Budgets, operating switches, browser extensions and real user content remain unchanged.

Local checks include 64 MCP unit tests, seven workerd cases and the source apps' checks; full CI also verified all
repository gates. Worker/version identities and the native-client results are in
[work-memory verification](docs/work-memory-verification.md). The earlier Tasks interface release and its 135
browser cases remain in [the dated record](docs/history/handoff-2026-10-22.md#approved-tasks-interface) and
[visual review](tasks/design-qa.md).

## Open from earlier releases

- Boundary B ([archive](docs/history/handoff-2026-10-21.md#boundary-b-released-claudeboundary-b)): after the
  2026-10-25 Sunday backup, Todofy's health page shows it complete with no `tasks` section. In the next push that
  deploys them anyway, empty `RETIRED_SERVICE_BINDINGS` (Todofy) and reword `proto/buf.yaml`'s header comment, which
  still names the retired `todofy/taskintent/v1` (a change to that file alone deploys every app and the VPS).
- Owner UI, read-only, for Boundary B: Tasks › Mail lists mail and its categories; Plan's weekly review shows the
  pending-mail count; Tasks › GTD shows the copied trend; Mail Hero's 提醒 card names Home's digest task.
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
- Owner: remove Todoist Plus from `chrome://extensions` (its variable, releases and merged branches are gone).

## Open acceptance

### Native hourly Work review

Catalog refresh and native Work event continuation passed in the owner's existing Dot; see
[the actual-client evidence](docs/work-memory-verification.md#native-dots-acceptance-2026-10-23-utc).
The scoped synthetic subscription is stopped, its dedicated Watch paused, and its Work done after source
read-back. The shared native hourly review is saved, but its first natural run is unverified (the host's next-run
field is null). Recall image viewing passed on the known older public diagnostic snapshot; today's new capture
did not arrive and was not used. Do not substitute a Codex heartbeat,
accepted delivery count or local fake callback for client execution. Existing user Watches and all old stopped
automations stay as they are.

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

- Mailsort's write limit tripped on 2026-10-21 at 04:00 UTC and it fell back to shadow mode (Home: 待审 6 封).
  The owner decides whether to switch it back to live and whether to raise the per-run limit.
- Install Recall Orion `2026.1015.451` on the phone; renewed phone acceptance follows it.
- Brief's sender `onboarding@resend.dev` delivers only to the Resend account's own address; change it before sending.
- Check the Claude Console workspace spend limit against Brief's stored $80 budget (unverified; $50 was suggested).
- Dedicated Cloudflare tokens for the infra workflows and a fresh deploy token; the infra workflows have not switched
  yet ([replacing the token](infra/README.md#replacing-the-token)).

### Remaining observations and separate follow-ups

- `5134232` removed the direct `vars` expressions from the release composites. Todofy and Home uploaded through them
  in [run 38469896460](https://github.com/ziyixi/todofy/actions/runs/38469896460); the Mail Hero, Brief, Links,
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
