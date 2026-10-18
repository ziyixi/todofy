# Retired Todoist Plus handoff, October 17

Historical release and acceptance notes from before the native Tasks replacement. Old Reload, label mapping
and extension connection steps below are not current operator instructions. Current status is in
[Tasks verification](../../tasks/docs/verification.md) and root [HANDOFF](../../HANDOFF.md); what replaced the
extension is in [Todoist Plus (retired)](todoist-plus.md). Links to its removed files point at commit `f6c08aaf`.

Todoist Plus UI refinement is released at `b79180283db375757f2cc8d29e481e55a6935c40`.
[Full branch CI 39013842528](https://github.com/ziyixi/todofy/actions/runs/39013842528) and
[same-SHA main 39014147662](https://github.com/ziyixi/todofy/actions/runs/39014147662) pass. Only the Plus
extension published; backend, other apps, images and VPS releases skipped. Version `2026.1017.449.46993`
was downloaded from its public release; all seven files match the green CI artifact and the owner's existing
`~/Documents/chrome_extensions/todoist-plus` folder. Two obsolete generated files were removed. Permissions
and Chrome-stored connection state were unchanged. Owner step: Reload Todoist Plus, then refresh Todoist.

The repair covers refreshed TaskEditor drafts, IME-safe dependency selection, desktop seven-day Week,
flat priority-flag cards and category backdrop dismissal. Local types/lint/build, 307 units and 62 actual
extension browser cases pass. Chrome synthetic checks confirm eight commitments and seven date targets
at 1440×900, pointer scheduling into Friday, and no horizontal overflow at 1024×800. No real tasks or account
settings changed. `codex/plus-ui-refinement-verification` only closes root docs, without another ZIP release.
[Evidence](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#ui-refinement-october-17).

Todoist Plus work of October 15-17 is all released. Each row passed full branch CI and the same-SHA main
release (Todofy deploy first, then the extension ZIP); the latest ZIP is installed in the owner's unpacked
folder with its digest checked and its manifest permissions unchanged. The backend is described in
[todoist-plus.md](https://github.com/ziyixi/todofy/blob/f6c08aaf/todofy/docs/todoist-plus.md), the interface in
[planning-interface.md](https://github.com/ziyixi/todofy/blob/f6c08aaf/todoist-plus/docs/planning-interface.md).

| Extension release | Main | Contents | Local evidence |
| --- | --- | --- | --- |
| `todoist-plus-v2026.1015.1250.22672` | `58908f64` | Board performance (research items 1-5), the Waiting row, the weekly review checklist, Sunday commitments kept for next week | [perf](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#board-performance-branch-local-checks-october-15), [GTD](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#waiting-list-weekly-review-and-sunday-commitments-local-checks-october-15) |
| `todoist-plus-v2026.1016.234.24624` | `60309fac` | Colours from Todoist's theme tokens, native Todoist never left hidden, Options page check | [theme](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#ui-theme-safety-and-polish-local-checks-october-15) |
| `todoist-plus-v2026.1016.808.36337` | `8df1a99d` | Review board lanes Start now, Waiting, Quarter, Month, Week, Committed (first two hidden while empty), the `active` label, the FlowDay task page capped at 100 | [lanes](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#start-now-and-waiting-lanes-local-checks-october-16) |
| `todoist-plus-v2026.1016.834.7822` | `1e8e6863` | Planning store M1-M3: migration `0007`, Todoist metadata cached in the core, write receipts in the object | [store](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#planning-store-caches-and-receipts-local-checks-october-16) |
| `todoist-plus-v2026.1016.1027.27206` | `6a465bee` | Task dependencies as `plan_edges`, never in Todoist text or labels | [dependencies](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#dependencies-local-checks-october-16) |
| `todoist-plus-v2026.1016.1224.9770` | `262ad007` | Text Work and Personal Bets in `plan_notes`, the Mailbox, migration `0008` and the one-time brief backfill | [Bets](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#text-weekly-bets-local-checks-october-16), [Mailbox](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#mailbox-review-fixes-local-checks-october-16) |
| `todoist-plus-v2026.1017.254.57066` | `deea01c9` | The owner's eight fixes D1-D8: the mail favourite hidden on every page, one-click filing into the Todoist Inbox, Add steps, Plan's view remembered, Week's Quick line and the Parked lane, reordering inside Review lanes and Next steps, Committed folds; planning protocol 6, no migration | [owner fixes](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#owner-fixes-d1-d8-local-checks-october-17), [final](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#final-local-verification-october-17) |
| `todoist-plus-v2026.1017.449.46993` | `b7918028` | TaskEditor refresh and IME correctness, desktop seven-day Week, flat cards with priority flags, category backdrop dismissal | [UI refinement](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#ui-refinement-october-17) |

Constraints that stay in force:

- GitHub variable `TODOFY_PLUS_METADATA` must stay set in `production` (now `cache`); `full` is the
  rollback of both caches ([caches](https://github.com/ziyixi/todofy/blob/f6c08aaf/todofy/docs/todoist-plus.md#caches)). An unset value fails the deploy.
- Receipts are never deleted (the owner's no-automatic-deletion rule; a 30-day expiry is a small change if
  the owner wants one). D1 `plus_actions` is read only, for request IDs of the last 30 days.
- The daily retention no longer deletes summaries; Delete all in the Mailbox deletes the summaries of the mail
  it deletes and keeps a mail a dependency names.
- The Bets label is a legacy role: old `@bets` tasks are not converted, the Monday reset still removes the
  label while the binding remains, and the Bets filter stays hidden. The three replaced deadline and waiting
  filters are hidden by exact query, behind a consistency test.

Owner steps: Reload Todoist Plus in Chrome's extension manager and refresh Todoist (planning protocol 6; a
page left open asks for the reload); type this week's two Bets in Plan; mail categories are optional and
filing always moves to the Todoist Inbox; confirm the account has `active` and `parked` labels; the Quick/Ops
and Parked favourite filters disappear after Todofy's first full Sync; then the ten checks in
[the extension's verification](https://github.com/ziyixi/todofy/blob/f6c08aaf/todoist-plus/docs/verification.md#owner-反馈修正2026-10-17本地).
Owner decisions: confirm that Delete all should delete summaries (built that way); M8/M9 of the data-layer
design drop the legacy `plus_*` tables and are irreversible, so they wait for the owner; a deleted bound
Quarter label still disables Plus with no in-product recovery.

Real-account checks still open (metadata only, no task content): `VerifyPlanStore` answers `{}`, the next
Sunday manifest lists the six `plan_*` tables and `plus_actions` stops growing; a Plus choice made on Sunday
survives the natural Monday rollover after 2026-10-19 07:00 UTC; a recurring task's `completed_count` reaches
the extension and the activity log answers for a completed and a deleted task; the brief backfill writes
briefs; drag feel. The unverified Todoist answers are listed in the
[Mailbox evidence](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#mailbox-briefs-and-summary-retention-local-checks-october-16).

Not done: data-layer steps M4-M6 and M10, the extension sending `ReadPlanRequest.view: BASIC` (until then
every native page's `ReadPlan` costs the FULL answer), the native popup's collapsed Steps & timing suffix
(plus-next §4 v2), and research items 6 (backend metadata reads) and 7 (native observer).

### Notes on the owner fixes D1-D8 (released 2026-10-17)

Branch CI [39001803330](https://github.com/ziyixi/todofy/actions/runs/39001803330) and same-SHA main
[39002425165](https://github.com/ziyixi/todofy/actions/runs/39002425165) passed; Todofy deployed (no
migration), then `todoist-plus-v2026.1017.254.57066` was published and installed in the owner's folder. The
lane order lives in `plan_settings` `board`; `ReorderTasks` (`tasks:reorder`) permutes only the moved task's
Todoist siblings, and Waiting and Parked keep their order in Todofy only. The first branch run failed one
browser case that measured cards while a language switch remounted the board; the measure now polls.
Interface: [planning-interface.md](https://github.com/ziyixi/todofy/blob/f6c08aaf/todoist-plus/docs/planning-interface.md); backend:
[reordering](https://github.com/ziyixi/todofy/blob/f6c08aaf/todofy/docs/todoist-plus.md#reordering).

Follow-ups:

- `item_reorder` is deprecated by Todoist. If the owner's check shows it does not move tasks that have an
  `order_key`, switch `core/plus.reorder_command` to `item_update` with `order_key`.
- If the owner's check shows `item_reorder` does not bump `updated_at`, Waiting and Parked may mirror their order
  to Todoist too (`core/plus.UNTOUCHED_LANES`).
- Next Plus release: `ReadMailSettings` stops answering the compatibility Inbox, kept only for extensions before
  planning protocol 6.
- Optional: retake `todoist-plus/docs/images/mailbox-file-menu.jpg`, which still shows the removed File menu.

Todoist Plus's approved planning board is released at `bcd1d1426f7dcf16198d2e71aefddc62cd7a8a87`.
[Full branch CI 38546241155](https://github.com/ziyixi/todofy/actions/runs/38546241155) and
[same-SHA main 38547547283](https://github.com/ziyixi/todofy/actions/runs/38547547283) pass. Todofy and the
Plus ZIP published; other applications, images, VPS and Recall publication skipped. Deployment `7062548541`
verified core `8e11f818-526f-4613-ac05-2c8eff61b223` and gateway `6113d2c3-e6d6-4c22-96d8-c72bbc07d139`;
public hooks health independently serves the same SHA.

Bets are actual weekly-goal task marks above Review/Week. Stage drag changes only the selected planning
label; day drag writes only FlowDay queues; Focus runs today's confirmed queue/timer. UpdatePlanLabels binds
existing label IDs, keeps other roles and does not relabel tasks. Quarter is explicitly bound in the owner UI.
Date-only child candidates stay with their parent; explicitly different-stage children remain independent.
The obsolete WeekPlanner/TaskFamily and unused CSS are removed. [Internal design and six synthetic screenshots](https://github.com/ziyixi/todofy/blob/f6c08aaf/todoist-plus/docs/planning-interface.md)
cover current behavior and API boundaries; [full verification](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-verification.md#approved-board-promoted-to-production-october-14)
separates tests, Chrome synthetic checks, actual deployment and remaining owner acceptance.

Version `2026.1014.598.48337` was downloaded from the actual public release. All seven files match the green
artifact, ZIP and existing `~/Documents/chrome_extensions/todoist-plus` directory. Two obsolete generated
assets were removed; directory identity, permissions and Chrome-stored connection remain. The only new
real task is one owner-authorized task; no existing task or real timer was manually changed. No other
credential, service or budget was altered.

**Pending:** owner Reload in Chrome's extension manager and Refresh Todoist. Tooling blocks that internal
page and alternate methods are forbidden. Do not ask for reinstall, folder changes or token rotation.
PWA and natural Monday rollover remain separate observations. Legacy FlowDay timer replace/clear stays
`RELOAD_REQUIRED` until at least 2026-11-13. `codex/plus-production-verification` only closes root docs and
HANDOFF; application files must remain unchanged so this closure does not publish another ZIP.

The earlier approved synthetic prototype is preserved in
[prototype verification](https://github.com/ziyixi/todofy/blob/f6c08aaf/docs/todoist-plus-planning-prototype.md); its local goal text and stopwatch are
historical design evidence, while production uses Todoist/FlowDay APIs.
