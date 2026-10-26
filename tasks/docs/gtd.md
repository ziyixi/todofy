# GTD: progress and time

GTD reviews execution. Mail remains a capture source in Mail. GTD has no inbox-age chart, cleanup target or
re-planning queue. Plan keeps planning, Goals keeps result progress, and Focus keeps daily execution and timing.

## Views

- **Overview** shows planned Task/Step completion, recorded time, related Tasks and completion counts by day
  (by week for a month). It links to the detailed tabs.
- **Completion** keeps parent Task context, expandable Steps, current child progress and completion dates.
  Routine has a separate section.
- **Time** contains the former Focus Week/Month statistics: time by saved area, daily bars or a monthly calendar,
  and recorded time/current estimates grouped by task. Only Steps roll into their direct parent; an executable
  Task/Subtask keeps its own title and estimate.

Tabs share dates and area; switching tabs reuses the period answer. Selecting a day opens
`#/focus/YYYY-MM-DD`, with the existing record editor. Focus retains day navigation, Today, timer, completed
queue, mini timer and away-pause. **View statistics** opens GTD Time.

Approved synthetic designs: [Overview](images/gtd/overview-approved.png),
[Completion](images/gtd/completion-approved.png), [Time](images/gtd/time-approved.png).
Actual browser evidence belongs in `tasks/design-qa.md`.

## What the numbers mean

- Task/Subtask is `kind=task`; Standalone and Quick remain Tasks. A literal Step is `kind=step`.
- Routine is independent. For reporting, a Step is also Routine when its direct parent is Routine; stored flags
  are not changed. Routine occurrences are separate; its time is already included in overall recorded time.
- Completions count occurrences inside account-local dates. Completing a parent also completes its open children,
  following existing Tasks behavior. Task and Step counts are never added into a score.
- Task rate counts unique non-Routine Tasks committed to any week overlapping the selected dates, and how many
  have a completion inside those dates. A Task committed in two weeks still counts once; a later release from
  commitment does not erase the earlier plan.
- Step rate counts unique non-Routine literal Steps ever placed in a day queue inside the selected dates, and
  how many have a completion inside those dates. Moving/removing a queued Step does not erase or duplicate it.
- Child progress shows current direct Steps. Dates describe the selected period. A parent returned only as
  context has no invented completion state.
- Recorded time includes saved timer/manual records, not an unfinished live session. It retains the record's
  original area. Classification and names/estimates beside history use current task properties; unassigned
  tasks inherit their nearest assigned ancestor's area, as in Plan.
- Current estimate is a reference beside this period's time, not a final efficiency score.

The migration seeds only weekly memberships still known and records when capture started. Task rates appear
from the first fully recorded week onward. Older/partial periods show completion counts without a fabricated
denominator. Existing imported history, task IDs and old GTD day rows remain intact.

## Implementation

Root proto defines one owner-authenticated, read-only `GetGtdReport`, for 1–31 account-local days and optional
Work/Personal filtering. Five indexed D1 statements return daily counts, totals, membership and at most 100
related task rows. Summary totals include the full matching period; the UI states when details are limited.
The report does not read Mail. The existing `GtdDay` and weekly-review APIs remain compatible.

`gtd_week_commitments` retains membership in the same transaction as task create/update. The small
`gtd_reporting` singleton holds capture start. Existing day-queue rows provide Step membership; there is no new
per-day ledger, event system, service or scheduler. Both tables participate in existing backup/restore.

`GtdPage` owns shared range/filter reads; `gtd/` contains metrics, parent/Step presentation and Time rendering.
The page remains a lazy chunk. Failed range changes never display the old totals as the new selected range.
Task editing and daily time editing reuse existing UI.

## Verification

Use the existing Worker, planning-ui, web and Chromium checks. Cover real Step completion/time persistence,
Routine/Standalone grouping, inherited area versus saved time area, DST boundaries, incomplete plan history,
bounded detail with full totals, tab/range reuse and calendar navigation to editable Focus records. Existing
CRUD, timer, mini timer, away-pause and backup checks remain required.

Weekly report ranges and calendar rows run Sunday through Saturday in the account time zone. Commitment membership uses the existing Monday IDs for those weeks; historical rows and calendar-day records are not rewritten.
