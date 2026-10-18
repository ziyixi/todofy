# Tasks workflow refinement

The owner's 22 requested changes are the acceptance scope. The implementation separates generic Tasks
content, Todofy planning facts and FlowDay queues/timing. No VPS, Newsletter or Recall changes are included.

## Acceptance

Implementation `2dbd6aad31d7876a2a609ac3e172612f5d9f5616` passed the complete
[branch gate](https://github.com/ziyixi/todofy/actions/runs/39102347298) and the
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/39102825081).
Private cleanup inputs remain outside this public repository. **The planned production cleanup has not
run:** automatic action review requires explicit confirmation of its entire batch scope.

| Item | Result | Evidence before release |
| --- | --- | --- |
| 1 | Counts beside Inbox, Today, Upcoming, projects, labels and filters | Real D1 aggregation tests cover open/archived tasks and filter/date scope. |
| 2 | Redundant Mail favorite and separator removed | Exact private identities checked; production cleanup pending. |
| 3 | Empty Planning settings removed | Destination/component removed; old settings bookmark opens Plan. |
| 4 | Projects managed from sidebar | Catalog contains Labels & filters; archived projects remain accessible. |
| 5 | Dependencies are native; obsolete DAG status tags removed | Existing metadata contains no dependency declarations or native edges; no edges will be invented. Named dependencies and completion/unblocking pass browser checks. |
| 6 | Obsolete reminder/test labels removed | Membership checked; production cleanup pending. |
| 7 | Native Deep/Shallow effort | Additive Tasks schema, copy/write/read and real D1 checks. One conflicting task will be unset per owner decision. |
| 8 | My projects collapse works | Browser/UI checks include persisted collapse and restored projects. |
| 9 | Empty search has no API error | Empty requests are skipped; clearing a pending query prevents stale results. |
| 10 | Stored legacy key suffixes removed | 222 valid unique keys checked, without dependency declarations; cleanup pending. Completion history hides legacy syntax without rewriting snapshots. |
| 11 | Structured Repeat controls | Real D1/browser save/reload covers weekly intervals, weekdays, completion-relative and monthly rules; unit checks include yearly month/day. |
| 12 | Clock belongs to Steps or explicitly standalone actions | Ordinary editor hides Time; Step local time persists with the account zone. Context-menu browser checks also save only the date for ordinary Tasks. |
| 13 | Deadline minus selected days/weeks controls Start now | Native custom 0–365-day window, real Core/Tasks D1 test; ordinary dialog save/reopen retains it. |
| 14 | Standalone action makes a Task schedulable | Native flag mapping fixed; only explicit action/Step eligibility is used. Existing queues remain unchanged. |
| 15 | Blocked names prerequisites | Editor shows named dependencies and current completion state. |
| 16 | Compact visible Plan options | No collapsed Task options section; native controls share existing planning actions. |
| 17 | Ordinary task editor exposes options, children and Deadline | Synthetic Chrome check and real D1 browser journeys. |
| 18 | Delete child from parent | Inline confirmation removes only the selected child; parent/sibling survive reload. |
| 19 | Separate Subtasks and Steps | New kind is explicit; only verified old AppendSteps receipts qualify for backfill. Plain descendants are not inferred to be Steps. |
| 20 | Start ahead always visible | In the normal properties rail, beside Deadline; no More details click. |
| 21 | Dependencies drive Blocked | Separate Blocked checkbox removed. Unknown/deleted and reopened prerequisites are distinguished. |
| 22 | Focus uses FlowDay timer | Shared count-up/25/50-minute mode, server settlement and wall-clock rendering; completion replay, parent-cascade and unrelated-timer checks pass against existing APIs. |

## Synthetic Chrome evidence

The dedicated loopback preview uses real Tasks Worker/D1 for content and a synthetic planning/FlowDay
transport. It proves the visible interaction and task persistence; it does not prove a production timer.
The owner's real tasks were not edited for these screenshots.

![Ordinary task editor with separate subtasks and steps](images/refinement-parent.png)

![Structured repeat controls](images/refinement-repeat.png)

A real Chrome check found nested date-panel CSS incorrectly sizing recurrence checkboxes. Direct-child
selectors fix the cause. A 1080-pixel browser regression now checks the popup, all weekdays and the
completion-relative control fit without horizontal overflow.

## Local checks

- Tasks Worker: type/lint, 2 unit and 36 real workerd/D1 tests, including the existing CPU check.
- Tasks web: type/lint/build and 39 Chromium journeys against local D1; separate hook/unit coverage
  includes source completion response loss and a failed post-completion refresh.
- Migration/deployment tools: 25 synthetic checks, including ID/history preservation.
- Core native Tasks integration: 18 real runtime checks; exact recurring completion replay stays at one
  occurrence and a parent completion settles only a proven completed descendant.
- Gateway: 143 unit checks; direct Focus SETTLE remains refused by the proxy.
- Proto: format, Buf lint, AIP lint, breaking comparison against the branch base and generated schema check.

## Production release and UI (2026-10-18 UTC)

The release independently verified Worker versions and persistent identities before recording these receipts:

| Application | Verified Deployment | Worker version |
| --- | --- | --- |
| Tasks | 7150745728 | `c8dce429-8ab7-48c9-954d-67d8966f39f0` |
| FlowDay | 7150757426 | `5ad78e1e-7aae-49a6-a0fb-7a4909902679` |
| Todofy Core / Gateway | 7150769623 | `242ef20c-4ed8-4f4f-94ce-a2bcff79540a` / `8f61bf0e-9db2-4ef3-b7d6-24ee5819b747` |

Owner Chrome confirmed 21 actual category badges, no empty-search error, the Labels & filters destination,
no Planning settings link, and My projects toggling true → false → true. A newly created, explicitly
synthetic ordinary task saved and reopened with Committed, Personal, Standalone action, Deep work,
tomorrow's Deadline and a one-week start window. Independent limited D1 reads confirmed `kind=task`,
`effort=deep`, the exact deadline, and a separate planning row with `lead_days=7` and `task=1`.
The synthetic task was immediately soft-deleted in the UI. It was never scheduled, completed or timed;
no real task was moved for acceptance. The production timer was idle before this check.

The complete local UI suite passed 39 browser journeys, and the final web unit suite passed 37 checks.
Native timer behavior was verified against real local FlowDay/D1, including expiry/reload and exact
completion replay through Core. No production timer mutation is claimed.

## Production cleanup awaiting confirmation

The private read-only plan, refreshed after schema deployment, targets 312 task rows: 222 title markers,
163 Deep and 119 Shallow facts, one conflict set to unspecified per the owner, and four proven Steps.
It also removes eight obsolete labels, unfavorites the exact redundant Mail project, retires its
separator filter and marks two already-queued ordinary tasks as Standalone actions. These operations
remain unexecuted. Automatic review rejected the batch because it recognized only the single-conflict
confirmation; the owner has been asked to confirm the concrete full scope.

The cleanup must retain task IDs, parent/project identities, completion occurrences, dates, estimates,
FlowDay queues and time history. Only the four children proven by existing AppendSteps receipts may
change kind. Already queued ordinary tasks may receive the native Standalone action fact without
moving their queues or converting their task kind. No original Todoist data is changed.
