# Tasks verification

What each Tasks release established, as behaviour. Release runs, Deployments and Worker versions live in GitHub
Actions and Deployments, and the dated detail in git history; this page keeps the conclusions. Local checks use
synthetic tasks, mail and goals only. Production acceptance read owner pages without printing task or mail text and
changed no real task unless noted.

## Migration and native source (October 17–18)

- The Todoist import matched a final private source snapshot, with an empty post-export delta, by identity and
  digest for every project, section, label, filter, task and completion occurrence. Parent and project orphans were
  zero; historical labels kept recovered native identities. The original Todoist account was not modified.
- Native planning conversion matched every frozen planning choice field by field, retired only the exact replaced
  technical labels and filters, and left the task count unchanged. Pending legacy Mail stayed visible for the owner;
  no real mail was converted or deleted for acceptance. Day queues and time references matched their baseline.
- Real D1 refuses a seven-way compound identity SELECT, so the [import runbook](import.md) reads each table on its
  own, and source activity in bounded seven-day windows. Local SQLite and endpoint reads alone do not prove a complete
  migration; the private identity and digest comparison did.
- One synthetic production task was created, edited, reloaded and soft-deleted; imported tasks were not edited.
  The PWA manifest is served behind Access; installability, the honest offline page, an empty private CacheStorage
  and reconnect were checked in a disposable profile. Installing into the owner's desktop is the owner's action.

## Editing, planning facts and reads (October 17–18)

The owner's 28 refinement items were accepted one by one. What they established:

- Counts beside every view, projects managed from the sidebar, native Deep/Shallow effort, structured Repeat,
  separate Subtasks and Steps (only receipt-proven children became Steps), dependencies that name prerequisites and
  derive Blocked, Start ahead beside Deadline, and clock time only for Steps and Standalone or Quick work.
- The production cleanup preserved every task ID, parent and project identity, business date, estimate and
  completion occurrence; obsolete labels, key suffixes and the redundant Mail favorite are gone.
- Detail reads reuse a page-memory cache of at most 20 full replies for 30 seconds, cleared by writes, focus and
  visibility changes; a late reply cannot replace a newer task. An unchanged Save writes nothing.
- With 40 active and 2,000 completed tasks, a full Catalog read fell from 4,254 to 179 rows and a metadata-only
  read takes 10; doubling completed history leaves label counts at 298 rows. These are synthetic measurements, not
  a guarantee that the account stays inside its shared Free D1 allowance.
- Dialog and popover checks compare internal geometry and scroll position on first open, cached reopen and late
  data, not only the outer frame; they caught a shifting dependency heading and a date popup shrinking as it closed.
- An owner-reported 20-second refresh stall recovered on its own; its cause was not established.

## Lists, drag and selection (October 18–19)

- Parents start collapsed and read children only on expand, 100 rows a page; ordinary views omit Steps; Today and
  search do not duplicate a child already listed. Refreshes keep rendered rows until their replacement arrives.
- A row has one completion circle; Select task or a modifier click enters selection in the same slot. Dragging the
  row's edges inserts beside a task and its middle moves under it; pointer movement makes no request and a drop
  writes only parent, location and order under a fresh etag, keeping IDs, dates, kind and descendants.
- Plan writes: the week rollover expires memberships in bounded pages, so the first write of a new week no longer
  fails; a confirmed reorder keeps the returned etags; the drop animation can no longer intercept the next drag.
- An obsolete project was archived with the owner's approval; every task ID, open and completed, was kept.

## Focus mini timer and dialog (October 22)

The 64px mini timer keeps the Step title, clock and visible Pause/Resume, Stop and Complete; its controls are at
least 24px with names and focus outlines at 320×64, 320×120, 260×100, 420×180 and 420×240. Description Done saves
the whole draft through the one task write and keeps the editor open on failure. Delete step in Plan removes the
Step and its queue rows while its time records stay.

## Goals (October 24)

Goals adds three tables to the existing Worker, D1 and backup; no new service, Notion token, model call or
schedule. The private annual import inserted definitions only, with stable source identities: every Objective and
KR was compared with its source with no mismatch, no progress, milestone, focus or task link was invented, and the
before/after Plan, task counts and catalog matched. The plaintext input and SQL were deleted after readback. Task
or Step completion never changes a Goal's milestones or completion. Catalog CPU stays under the unchanged Free
budget in the cold-isolate check.

## GTD execution review (October 25)

Report tests separate Task, Step and Routine, Standalone and Quick, inherited task area and saved record area;
cross DST; keep weekly and removed-Step membership; omit Task rates before the first fully recorded week; and keep
full totals while limiting details to 100 rows. With 3,000 unrelated history rows a small period reads under 600
rows. The 31-day CPU fixture stays within the original budgets. In production, GTD showed its three tabs and the
calendar opened editable Focus days, read-only. Task rates count each week that starts in the period, through its
Saturday ([GTD](gtd.md)).

## Planning readiness and task details (October 26)

Synthetic journeys verified that completed prerequisites and Deadline windows surface work in Parked and that
planning acknowledges it after reload; that Waiting work and its descendants stay out of Plan while Focus keeps its
queue; Save return navigation; dependency geometry on first and cached open; read-only reverse links; Quick's clock
and time zone after a real queue drag; and Enter/Escape deletion without an unintended Save or delete. See
[planning readiness](planning-readiness.md).

## Limits

- Backup and restore of each new table passed locally; the first natural weekly backup that holds a new table is
  checked in production separately ([backup](backup.md)).
- Older periods have no trustworthy commitment denominator, so GTD shows their completion counts without a rate.
- Screenshots are synthetic and do not establish screen-reader or contrast compliance.
