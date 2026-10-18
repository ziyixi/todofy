# Tasks workflow refinement

The owner's 22 requested changes are the acceptance scope. The implementation separates generic Tasks
content, Todofy planning facts and FlowDay queues/timing. No VPS, Newsletter or Recall changes are included.

## Acceptance

Production evidence is pending until the same green branch SHA is released. Private cleanup inputs remain
outside this public repository. Counts below describe metadata, not private task content.

| Item | Result | Evidence before release |
| --- | --- | --- |
| 1 | Counts beside Inbox, Today, Upcoming, projects, labels and filters | Real D1 aggregation tests cover open/archived tasks and filter/date scope. |
| 2 | Redundant Mail favorite and separator removed | Exact private identities checked; production cleanup pending. |
| 3 | Empty Planning settings removed | Destination/component removed; old settings bookmark opens Plan. |
| 4 | Projects managed from sidebar | Catalog contains Labels & filters; archived projects remain accessible. |
| 5 | Dependencies are native; obsolete DAG status tags removed | Existing metadata contains no dependency declarations or native edges; no edges will be invented. Named dependencies and completion/unblocking pass browser checks. |
| 6 | Obsolete Reminding/hakuhaha labels removed | Membership checked; production cleanup pending. |
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

## Release and cleanup

Pending: branch CI gate, same-SHA main release, guarded cleanup and production metadata/UI acceptance.
The cleanup must retain task IDs, parent/project identities, completion occurrences, dates, estimates,
FlowDay queues and time history. Only the four children proven by existing AppendSteps receipts may
change kind. Already queued ordinary tasks may receive the native Standalone action fact without
moving their queues or converting their task kind. No original Todoist data is changed.
