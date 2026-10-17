# Todoist Plus verification

## Local checks, October 13

The isolated worktree implements the approved Plan, task-step and Focus flows. All business test
inputs are synthetic. The installed daily Chrome and production tasks were not used for these checks.

| Component | Evidence |
| --- | --- |
| Extension | 20 unit/component/API cases, three actual built-MV3 Chromium cases, types, lint and production build |
| Todofy | 549 real-workerd runtime cases, 1,653 Python units, 127 gateway cases, 93 owner-UI cases and builds |
| FlowDay | 125 workerd/D1 cases, 21 worker units, 119 UI cases, all 51 desktop browser scenarios, migration preservation and static export |
| Shared contracts | Buf lint, API lint, breaking/profile checks, type/schema checks; 495 TypeScript codec cases and 113 Python cases |
| CI/configuration | 452 guard cases with one existing local skip; 34 catalog cases and portable-domain generation |

The prototype was visually compared with the native Todoist layout. The content width and repeated
row hints were corrected; light and dark rendering and batch steps to a stopped timer were checked.
The packaged browser tests additionally caught the WXT host-reset conflict and wrong field-mask
spelling. They verify native navigation restoration, connection/mapping failure restoration, stable
completion identity, timer conflicts, native detail IDs and the canonical task-ID link.

The gateway dry-run is 81.9 KiB gzip against its existing 86 KiB budget. The Python core dry-run is
187.36 KiB gzip and contains the generated Plus messages; owner UI JavaScript is 175.7/208 KiB.
Calibrated new-path CPU samples were 1.13/0.56 ms for a 200-task Plus page and 6.85/4.70 ms for a
200-task FlowDay proxy page (cold/warm). The latter fixture has 2,000-character title and description
per task. The new proxy's regression bounds are 9.5/6 ms; Workers Free's 10 ms limit and old-path
bounds remain intact. This does not establish production CPU timings for arbitrary remote descriptions.

The existing runtime/full-unit checks preceded removal of an unused, unpublished URL field. The
cleanup passed eight focused unit and eight real-runtime Plus cases and regenerated proto checks;
the final full branch gate verifies the source SHA.

The first branch CI at `30c25b7` passed the packaged extension and runtime shards but rejected
an 8.16 ms cold proxy sample against its initial 8 ms startup ratchet. The new-path startup bound
is 9.5 ms; warm and existing-path limits remain unchanged. The same run also exposed the old
container-import verifier's assumptions about new defaulted D1 columns and timer command receipts;
the corrected import/verify/reset tools passed all 38 cases under Python 3.12 with mandatory local Wrangler/D1, including rejection of unexpected derived state. The corrected branch gate passed, as recorded below.

The corrected `fb245900` passed the complete branch gate in
[run 38459315470](https://github.com/ziyixi/todofy/actions/runs/38459315470). Before publication,
the upgrade was extended to refresh unchanged cached hierarchy/deadline fields once, using the
existing bounded full-sync flow and preserving manual estimates, queue and timer state. Its
marker survives late old-Worker sync state and clears only after the new pass completes.
The two added real-D1 cases passed with the existing sync cases (26); the other 124 runtime cases
and CPU checks also passed. The extension now requests the existing manual sync for an explicitly
new task, and a throttled response blocks the following write with a visible retry instruction.
Its 20 unit/API/component and three built-browser checks pass. The final branch gate subsequently passed at its own source SHA.

The final native-startup browser check begins at ordinary `/app/today`: the exact replaced
favorites hide after a successful connection lookup while native content remains visible.
It then opens Plan and verifies native restoration. Mapping or authentication failures restore
legacy controls. No additional endpoint or local cache was introduced for this startup behavior.

## Release evidence, October 13

The initial implementation SHA `2f3b9b92a86bdeccc39a8304fe7b968c7eb3e4a0` passed
[full branch CI 38464767419](https://github.com/ziyixi/todofy/actions/runs/38464767419) and was pushed
unchanged to main. [Main run 38466487763](https://github.com/ziyixi/todofy/actions/runs/38466487763)
deployed FlowDay but failed before Todofy upload because an old release composite directly referenced
unsupported `vars` expressions. Home and the ZIP publication were skipped.

The correction removes those duplicate expressions and inherits the caller's existing resolved job
environment. All 453 repository guards pass with one existing local skip. The corrected SHA
`51342322e473c4073bfb395a61c867995a9ac902` passed
[full branch CI 38468696858](https://github.com/ziyixi/todofy/actions/runs/38468696858) and the
[same-SHA main release 38469896460](https://github.com/ziyixi/todofy/actions/runs/38469896460).

| Application | Verified Deployment | Worker identity | Verified at (UTC) |
| --- | --- | --- | --- |
| FlowDay | `7050422665` | `675b3116-ac82-4320-8621-ef33fa57ad8c` | 2026-10-13 21:23:06 |
| Todofy | `7050459573` | core `01680253-f596-44cf-b587-916b77ef856d`; gateway `a57f62e4-7159-4361-9428-370a94458d81` | 2026-10-13 21:24:54 |
| Home | `7050487447` | `957e44a3-a32d-49a3-9087-2adbd4484df7` | 2026-10-13 21:26:09 |

The [published extension ZIP](https://github.com/ziyixi/todofy/releases/download/todoist-plus-v2026.1013.1271.20788/todoist-plus-v2026.1013.1271.20788.zip)
is version `2026.1013.1271.20788`, source identity `5134232`, 182,611 bytes. Its SHA-256 is
`836cc8cd5484bb590708421246f82367b55a30b96f4c856f2c51d7c16ca91bc5`. Every one of its seven files matches
the passed CI artifact and the dedicated local installation folder. Newsletter, VPS, Recall and other
services were skipped in the final Changes outputs and actual publication jobs.

## Production acceptance

The owner authorized Chrome installation and real-page acceptance on October 13. The live `/plus`
page loaded under the existing owner login, recognized the existing labels and confirmed the approved
mapping/weekly rule in `US/Pacific`; the result visibly shows enabled. No extension token was issued
by the agent and no real task content or priorities were edited.

Browser tooling blocks `chrome://extensions/` and explicitly disallows alternate control methods.
The owner must load the dedicated folder and save the connection once. That manual step is pending;
ordinary Todoist HTTPS pages remain available for subsequent agent-led checks. Existing labels and
filters stay in Todoist. Tests use synthetic Inbox tasks and preserve any real active FlowDay timer.

Pending: real Todoist layout/keyboard/navigation with the installed extension, explicit synthetic task
writes, FlowDay cross-view state and Chrome PWA verification. Record each after checking it. The first
natural weekly rollover is a separate future observation; synthetic rollover checks do not establish
that production event.

## Owner-page presentation follow-up

Real Chrome review found that the owner connection page's buttons and device input omitted the
application's existing control classes. The presentation-only correction at
`d657985df185821a9154829db7c9bd214058ef1c` passed all 93 UI cases, types and production build
(175.7/208 KiB JavaScript gzip),
[branch CI 38471249025](https://github.com/ziyixi/todofy/actions/runs/38471249025) and the
[same-SHA main release 38472126635](https://github.com/ziyixi/todofy/actions/runs/38472126635).

Only Todofy was published. Deployment `7050788716` verified core
`21c820d0-08ed-4892-9585-bedc71da115c` and gateway `1067eacb-92ca-4f71-b08f-35dcc5d49cd2`
at `2026-10-13T21:40:50Z`. Home, FlowDay, the extension ZIP and all unrelated services were skipped.
A separate real Chrome tab confirmed the enabled mapping and existing green 40-pixel primary button,
with the styled device input. The original token page was preserved, and no token was generated.
The published extension and API contract are unchanged. This check covers the owner connection page;
it does not replace the pending installed-extension Todoist/PWA checks above.


## Installed-version audit and weekly planner revision

On October 13 the owner confirmed Chrome connection. Actual Chrome inspection reproduced the sparse flat
Plan, missing inline steps, simultaneous native Today/Plus selection, technical favorite clutter and the
list-only Focus experience. FlowDay's settings showed an absent Todoist key and a July sync. The old migration
intentionally excluded that credential; its existing owner setting was restored using the current credential,
then key-saved, Sync-complete and a fresh sync time were confirmed. No credential was generated or stored in
the extension; no private task content, key or real-data screenshot is committed.

On 2026-10-15 the owner confirmed in chat that they had authorized this FlowDay Todoist key restoration.

The owner chose day placement only in FlowDay. The revised Plan expands parent tasks and places leaf steps
in seven day columns; Focus shows the same parent context, ordered duration blocks and timer controls.
It reuses the existing daily flow resources and RolloverFlow, with a same-day guard. No new database,
service, scheduled job or billing setting was introduced. Favorites are collapsed only in the page;
original objects and project shortcuts remain. Existing task dates and Deadlines are preserved.

Local evidence: 26 extension cases and six actual built-MV3 browser scenarios; 127 FlowDay runtime cases
and 128 gateway units plus its CPU checks; source types/lint and proto lint/API-lint/schema/types. Browser
scenarios prove drag outcomes and reloaded order rather than counting event-handler calls. The original
prototype's duplicate width rules were removed after the real Chrome preview exposed unreadable columns.

The weekly planner commit `ba149ec541136666ef1e25b5cbad4fa5ada574fe` passed
[branch CI 38503430909](https://github.com/ziyixi/todofy/actions/runs/38503430909) and the
[same-SHA main release 38504086473](https://github.com/ziyixi/todofy/actions/runs/38504086473).
FlowDay Deployment `7055729792` verified version `bf436b36-04c7-4f56-9e95-9646f0b7a2fb`;
Todofy Deployment `7055754395` verified core `1ff43ae3-0006-49aa-8026-a2481ff04dcf` and gateway
`c7a22151-400d-4162-b228-20731d56fcb8`. Extension `2026.1014.173.47636` targets the same source.
All other application publications, Newsletter image and VPS deployment were skipped.

## Real synthetic task check and stale-view correction

Using the owner's currently installed extension, one synthetic Inbox parent and two 30-minute steps were
created. Batch creation, adding the first step to today's FlowDay queue, its completion from Plus Focus,
and the corresponding native Todoist completion were verified. The parent and remaining step were then
completed: its native checkbox showed checked, both children showed 2/2 completed, and the parent disappeared
from active Inbox. No timer was started, and no real task was edited. Screenshots containing private data
remain local; this record contains only synthetic results.

The real check exposed a stale queue when returning from native Todoist to the same Focus view. Refresh
showed the saved step; the component had remained mounted while hidden. The correction unmounts it only
when leaving the custom views, reloads on return, and refreshes between Plan and Focus. Switching directly
between those two retains the selected date. Already-queued steps now have a disabled “In today” check mark.
The actual built-MV3 regression failed against the old artifact and passes after the fix without Refresh.
All seven packaged-browser scenarios and 26 unit/component/API checks pass locally, with types and lint.

The new drag UI has been exercised in isolated Chromium and the synthetic Chrome preview. The owner's
new-directory load and actual installed-version drag/PWA acceptance remain pending, as does the separate
natural Monday rollover observation.

## Final extension release and fixed local folder

Correction `e4fd23a855c7ea4fa12e42a89fd322cd67f64b9e` passed
[branch CI 38507168961](https://github.com/ziyixi/todofy/actions/runs/38507168961) and the
[same-SHA main release 38507404630](https://github.com/ziyixi/todofy/actions/runs/38507404630).
Only the Plus extension was published; all Worker, image, VPS and unrelated extension publications skipped.
The [published ZIP](https://github.com/ziyixi/todofy/releases/download/todoist-plus-v2026.1014.216.58621/todoist-plus-v2026.1014.216.58621.zip)
is version `2026.1014.216.58621`, source `e4fd23a`, 221,747 bytes, SHA-256
`f372b66edc6c8d8f680cb83afc1963a3797510d0c1ca0f5d1c2d2d2487033d72`.

All seven files match the branch's tested CI artifact and the newly created
`~/Documents/chrome_extensions/todoist-plus` folder byte for byte. No credentials or profile data were
copied. The existing installation was preserved. The owner must disable the old instance, load this
new directory and reconnect once because the unpacked path can change extension identity. Future updates
use the same directory and Chrome Reload. The tool's blocked internal extensions page was not bypassed.

## Installed interaction feedback correction, October 13

The owner loaded the fixed directory and reported sluggish task selection/dragging, duplicate planning in
Focus, faint text, oversized navigation symbols, horizontal overflow and missing week navigation. A real
Chrome observation initially showed an invalidated old content script; reloading mounted the weekly version.
A synthetic Inbox parent with two 30-minute steps then exercised real scheduling and day-to-day dragging.
The moved step was confirmed on the next day's Plan after rereading; the immediate post-drop observation
had preceded the UI update. Test scheduling was removed and the parent/children completed. A fresh Inbox
reload confirmed no active test task. No real task or running timer was changed.

The source correction stays within the extension:

- Plan owns arrangement and estimates; Focus executes today's already arranged steps. Its picker, dragging,
  day planner and duplicate reorder controls are removed. Existing task estimates are edited in TaskEditor.
- View switching uses current data. Confirmed timer and queue responses update the interface directly;
  queue follow-up reads only the displayed seven days, and initial independent queries run concurrently.
  A bounded reading identity prevents an older week response from overwriting a newer view.
- Non-draggable parent rows no longer receive the draggable ref. The old package's semantic click regression
  reported the entire row disabled; the fix proves parent expansion and task details remain operable.
- The board browses previous/next weeks and returns to the current week without changing commitment tags,
  Todoist dates or timer ownership. Available width determines seven, three or one visible day. Normal desktop
  widths retain the pool beside the board; smaller widths stack them without horizontal overflow.
- Root-family color marks, 14px body text and 12px metadata improve hierarchy. Navigation glyphs are 18px
  inside the existing 24px slot, preserving native label alignment.

Local checks pass: 35 units/component/API cases and nine actual built-MV3 browser scenarios, types, lint and
production build. The browser scenarios verify persisted day order, no full task rescan after dragging,
confirmed timer display, native semantic actions, future-week saving, readable narrow layout and restored
navigation. Two stale-response regressions first failed and then passed; task estimates persist and clear.
Screenshots from the new Chrome prototype contain only synthetic content. A temporary Shadow DOM comparison
also supported normal pointer dragging; its files and an unsupported pointer-isolation experiment were removed.
No permanent diagnostic, new dependency, service, database, API schema or billing change was introduced.

Correction `b51413a02bdfec608dee5762e412a86c0adf35bf` passed
[branch CI 38516152038](https://github.com/ziyixi/todofy/actions/runs/38516152038) and the
[same-SHA main release 38516495384](https://github.com/ziyixi/todofy/actions/runs/38516495384).
Only the extension was published; all Worker, image, VPS and unrelated extension publications skipped.
The [ZIP](https://github.com/ziyixi/todofy/releases/download/todoist-plus-v2026.1014.320.46356/todoist-plus-v2026.1014.320.46356.zip)
is `2026.1014.320.46356`, source `b51413a`, 221,051 bytes, SHA-256
`eee97cea132b8ad5f1210786b868f8ec54cbd657152e895abdacf5f227bc9f0a`.

All seven files match the green branch artifact, the published ZIP and the updated existing
`~/Documents/chrome_extensions/todoist-plus` directory. Two obsolete generated assets were removed;
permissions and folder identity are unchanged. Chrome-stored connection data was not accessed or replaced.
The owner has been asked to click the extension's Reload and refresh Todoist once. Actual corrected-version
response and drag acceptance awaits that step; the old installed-version real check and new synthetic
checks remain distinct. PWA and natural Monday rollover remain separate open observations.

## Approved board promoted to production (October 14)

`codex/plus-production-planning` connects the approved prototype to real Todoist label identities and
FlowDay's existing queues/timer. Internal [design and screenshots](../todoist-plus/docs/planning-interface.md)
show the actual production components with synthetic data. Review moves only a selected outcome's planning
label; Week arranges leaf steps in daily queues; Focus executes today's confirmed queue. Weekly Bets are
shown as overall goals above the board and no longer decorate each commitment.

The label panel selects three required column IDs and an optional Quarter ID from current Todoist metadata.
UpdatePlanLabels changes only configuration, preserves the other roles and settles the old account week
with old bindings before remapping. Confirmed single-task results merge into the current UI without a full
metadata reload. Dates, unrelated labels and completed FlowDay queue identities remain unchanged. A
same-folder extension update preserves its connection and permissions; an old content script receives a
specific refresh message before changed planning actions can run.

Local checks: types, lint, production build, 56 unit/component/API checks and 11 actual built-MV3 Chromium
cases pass. Todofy’s host suite passes 1808 checks with one existing legacy-migration check skipped
because the separate historical protos checkout is absent. Those Chromium cases use temporary profiles, a synthetic Todoist DOM and independent protocol
responses in the extension background. They prove current label/etag writes, queue-only day arrangement,
pointer insertion/reorder with confirmed refresh, no full task read after day writes, seven/three/one-day
layout, native navigation and confirmed timer behavior. Start advances across Plan/Focus, Pause freezes,
Resume continues and Stop makes zero completion requests. Earlier-day timers keep their original day.

Chrome's production-component preview separately confirmed eight commitments, an independent weekly-goal
row, native pointer day movement, the precise label conflict message, click-outside
modal dismissal and no horizontal overflow at 1900, 1440, 1000 and 700 px. Screenshots contain no private
tasks or credentials. A first drag from the step tray adds another day's arrangement; dragging an existing
day card moves its source-day entry. No real task or production timer was used for this check.

The review removed the obsolete WeekPlanner and recursive TaskFamily implementation and kept the live
TaskBreadcrumb. Its old planner CSS fell from 506 to 28 lines. Outcome color lookup uses only the task's
ancestor chain. A date-derived weekly child stays in its parent's tray/context; a child explicitly assigned
to another mapped stage remains independent. The original Quick filter remains available because the new
board does not replace that view. No dependency, service, database or budget setting was added.

Implementation `bcd1d1426f7dcf16198d2e71aefddc62cd7a8a87` passed
[branch CI 38546241155](https://github.com/ziyixi/todofy/actions/runs/38546241155) and
[same-SHA main 38547547283](https://github.com/ziyixi/todofy/actions/runs/38547547283).
Todofy and the Plus ZIP were published; other applications, images, VPS and Recall publication skipped.
The actual provider receipt, GitHub Deployment `7062548541`, reports success at
`2026-10-14T10:11:31Z`: core version `8e11f818-526f-4613-ac05-2c8eff61b223`, gateway version
`6113d2c3-e6d6-4c22-96d8-c72bbc07d139`. The public hooks health independently returned the full implementation
SHA and healthy at `2026-10-14T10:17:35Z`; the authenticated owner page returned the new column controls.

[Release 2026.1014.598.48337](https://github.com/ziyixi/todofy/releases/tag/todoist-plus-v2026.1014.598.48337)
contains the [ZIP](https://github.com/ziyixi/todofy/releases/download/todoist-plus-v2026.1014.598.48337/todoist-plus-v2026.1014.598.48337.zip),
226,870 bytes, source `bcd1d14`, SHA-256
`682864500ab8cbe56b92cf50082756c7a92368e481dd34511ba35bce83df19ec`.
All seven files match the tested branch artifact and the published ZIP. The existing
`~/Documents/chrome_extensions/todoist-plus` folder was updated with those exact bytes; the ZIP is also
beside it. Two obsolete generated assets were removed. Permission sets, installation directory and
Chrome-stored connection were preserved; no Chrome profile or credential store was edited.

The owner page explicitly bound the previously created Quarter label. Its refreshed response showed the
four column selections, retained the eleven existing roles, kept planning enabled and disabled Save after
confirmation. The new operation writes configuration; no existing task or production timer was manually
changed. Only one owner-authorized real task was added, and a fetch confirmed its intended fields.
Private task identity/content are not committed here.

**Still pending:** the owner clicks Reload in Chrome's extension manager and refreshes Todoist. The browser
tool cannot operate that internal page; no alternate method was used. The installed bytes and owner API
are verified, while activation of this version in the real account is not yet claimed. PWA and natural
Monday rollover remain separate observations. Synthetic timer checks do not prove a real account session.

## Board performance branch, local checks (October 15)

`claude/plus-perf-gtd` implements the owner-approved performance plan (items 1-5 of the October 15
research; backend item 6 and observer item 7 are not part of it). It is local only: not pushed, no
branch CI, no release, and the installed extension is unchanged. All data below is synthetic.

- Reads no longer lock the board. Mount, Refresh, failed writes and void results re-read in the
  background; returning to the tab re-reads only after 60 s. Confirmed SetTaskLead, UpdatePlanLabels and
  weekly-goal tasks merge without a full load, and confirmed day queues no longer trigger a seven-day
  re-read. Completion still re-reads (recurring tasks advance) and stays disabled until it lands.
- One ID and one children index per task list replace the per-call maps; the running clock is a leaf.
- FlowDay task IDs, never titles, are remembered after a SYNCED answer and mirrored to session storage.
- Native pages call ReadPlan only and arrange the sidebar from an ID-only `storage.local` cache. The last
  confirmed data stays in content-script memory, so re-entering Plus paints at once.
- Owner-approved rule change: Review and Week drags show at once; only that card waits (dimmed, spinner,
  not draggable). All writes share one FIFO queue; a failure drops the queued writes, rolls every
  prediction back, shows the error and re-reads. Other writes stay confirm-first. Planning protocol is 3.

Local checks: types, lint, production build, 79 unit/component/API cases (was 56) and 13 built-MV3
Chromium cases (was 11). Eleven of the new cases also ran against the previous code and fail there.
They cover discarded overlapping reads, one-minute refocus, pending completion, confirmed
lead/label/goal merges, count-based derivation cost (16,011 element reads at 2,000 tasks against
3,158,011 before; bound 40,000), a ticking timer without board renders, remembered FlowDay IDs after a
fresh client, the ID-only cache hiding the sidebar while ReadPlan is held, instant re-entry, pending
drops, queued order and rollback after a failed save.

The research harness ran in a scratch copy against a baseline build of `de8b93ac` and this branch, same
synthetic data and Chromium. At 600 tasks and 100 ms per synthetic request:

| Action | Before | After |
| --- | --- | --- |
| Native page load | 13 requests, 4 stages | 1 request (ReadPlan) |
| Re-enter Plan from a native page | board after 855 ms | board after 55 ms; read finishes in background |
| Review stage drop | card and board after 122 ms | card after 18 ms; that card confirmed after 110 ms |
| Week tray-to-day drop | 9 requests; card 216 ms, board 321 ms | 2 requests; card 21 ms; that card confirmed 213 ms |
| Week day-to-day drop | 9 requests; card 214 ms, board 321 ms | 2 requests; card 23 ms; that card confirmed 213 ms |
| Tab refocus within a minute | 13 requests, board locked | none |

At 2,000 tasks with 0 ms requests, a running timer on Review caused five long tasks (409 ms) per 5 s
before and none after; the Review drop's 65 ms long task is gone. Opening Plan took 163-190 ms before and
139-154 ms after over four runs each. The content script grows from 357,235 to 361,110 bytes (113,330 to
114,724 gzip) and the background from 134,003 to 135,324 bytes; no dependency or budget changed. Production
latency, the real Todoist DOM and the installed extension were not measured.

### Review fixes on the same branch (October 15)

A branch review found write races that the old global lock had prevented. Each finding was reproduced
with synthetic cases first; all were fixed, and the branch is still local only.

- Removing a step and Add to today now read the day's current FlowDay queue (GetFlow) and send UpdateFlow
  with only that one ID added or removed, one extra GET each. Two quick removals from one day, Add to today
  while a removal waits, and a step added in another tab within the 60-second refocus window all survive.
- A remembered board still paints at once but stays read-only until this visit's first read lands; if that
  read fails, only the error is shown and the snapshot is dropped. This prevents a second CompleteTask for
  a task completed just before leaving, and timer or queue writes against yesterday after midnight.
- After a label-mapping save, writes wait for the re-read (every task etag changes). An older overlapping
  read no longer replaces a newer one. A card whose stage drag waits has read-only details and weekly-goal
  actions until it settles, then shows the stage the server kept.
- Task details re-read fully after a refused save and when the remembered data lacks the task. The
  gateway's 401 Status for a revoked token now reads "Connection expired or revoked" and clears the ID
  cache; a call that ends after a disconnect no longer writes the cache or FlowDay IDs back.
- Pending cards say "Updating…" in their accessible names. Pending handles use `aria-disabled`, so a
  keyboard drop keeps focus on the moved card. Disabled remove buttons stay hidden, reduced motion stops the
  pending spinner, and a rollback says "Change not saved; restored" with the count of later changes not sent.

Local checks: types, lint, production build, 91 unit/component/API cases and 14 built-MV3 Chromium cases.
All 12 new and 8 changed unit cases fail against the pre-fix source with the updated fixture. The three
queue-race cases fail there only because the queue actions changed; equivalent scratch cases had shown
those races on the pre-fix code. The two new browser checks fail against the pre-fix build.
The research harness, re-run at 600 tasks and 100 ms, shows the board 42 ms after re-entry (read done at
842 ms), the Review drop card at 23 ms, Week drops at 7-21 ms and unchanged request counts. The content
script is 362,109 bytes (115,318 gzip) and the background 135,702 bytes. Real-account behavior was not
checked.

## Waiting list, weekly review and Sunday commitments, local checks (October 15)

The owner chose three items from the October 15 GTD research: the Waiting list, the weekly review checklist
and the fix for Sunday commitments. They are on the same local branch, after the performance commits; not
pushed, no branch CI, no release. All data below is synthetic; no Todoist, FlowDay or Cloudflare account
was touched.

- Waiting: a folded "Waiting (N)" row under the Review lanes lists `@waiting`/`@blocked` tasks, untouched
  longest first ("N days untouched", from Todoist's `updated_at`), with Add follow-up step (the empty step
  editor), Add to today and Open. It never removes a label or contacts anyone.
- Weekly review: a toolbar entry and the Sunday review task's link (`?todoist-plus=review`, added to the
  task body only once Plus is set up) open five lines with counts and jump targets. Ticks and kept
  someday items are per ISO week in this browser's localStorage, IDs and line numbers only. Finish review
  completes the review task only when clicked, without a FlowDay day.
- Sunday rule: a SetTaskPlan that sets committed or Bet on the account week's last day is recorded for the
  next week, and `REMEMBER_WEEK` never moves a row back, so Monday's reset and that day's scans keep it.
  Task details now send only the changed stage or area.
- Contract: additive `PlanningTask.update_time` (OUTPUT_ONLY Timestamp, the AIP name for Todoist's
  `updated_at`) and `Plan.inbox_project_id`, `review_task_id`, `next_week_task_ids`, read once per Plan
  answer; no new table or dependency.

Local checks: proto format/lint, api-linter (69 files), breaking against the merge base `de8b93ac` and
`origin/main` `1e88aa3c`, the rules self-test, deterministic generation (151 files), the schema check,
495 TypeScript and 113 Python codec cases. Todofy: ruff check and format, 1,810 host cases (2 skipped as
before) and 558 real-workerd runtime cases (556 in four processes, then the serial file). The new SQLite
and runtime rollover cases fail against the old `REMEMBER_WEEK`: the page scan moved a Sunday choice back
to the ending week. The runtime write case asserts whichever branch the real clock takes; the unit cases
cover both. Gateway lint, types, 130 unit cases and the calibrated CPU suite pass with `update_time` in the
200-task page; the gateway dry-run is 82.2 KiB gzip (budget 86 KiB) and the core dry-run 190.02 KiB gzip.
The owner UI's types and 93 tests pass, and the 453 `.github/scripts` cases pass (1 skipped as before).

The extension passes types, lint, 101 unit/component/API cases (was 91) and 15 built-MV3 Chromium cases
(was 14). The new browser case opens Plan from the review link, keeps a tick across a reload, lists
Waiting oldest first without any write, and sends exactly one CompleteTask (review ID, no `flow_date`).
That build check first caught a real defect: Prettier had written the sort sentinel `￿` as a literal
noncharacter, so Chrome refused the content script as not UTF-8. The comparator now uses times.

A scratch benchmark (jsdom, synthetic tasks) measured per-render cost at 600 and 2,000 tasks: the Waiting
row 0.03 and 0.08 ms, Week's unplanned line 0.02 and 0.03 ms, all five review lines 0.08 and 0.23 ms. The
render-cost guard now includes these derivations. The content script is 372,556 bytes (118,124 with
`gzip -9`), against 362,109 bytes before; the background is 136,055 bytes. The synthetic production
preview at 1440 and 700 px, light and dark, English and Chinese, had no horizontal overflow and no console
errors; two of its captures are in the [interface document](../todoist-plus/docs/planning-interface.md).

Not verified: the real Todoist DOM and data, whether Todoist changes `updated_at` for comments or child
edits, a real review task's link, the first natural Sunday-to-Monday rollover with a Plus choice, branch
CI and release.

### GTD review fixes, local checks (October 15)

Two reviews of the GTD commits found one high, four medium and several low issues. They are fixed on the
same local branch, still not pushed. All data is synthetic; no Todoist, FlowDay or Cloudflare account was
touched.

- Keep for next week removed labels: `plan_labels` replaced every planning label even when the requested
  stage was the one the task already showed, so keeping a commitment that also carried `quarter` dropped
  it. A stage the labels already give now changes no label; a real stage change still replaces them.
- Sunday choices: the membership is recorded from the labels just written, right after the Sync write and
  before the confirming read, so a failed read (or a same-ID replay after midnight) no longer leaves the
  choice to the ending week's page scan. A Plus write that leaves neither mark deletes the task's row
  (`FORGET_TASK`); otherwise the row keeps the later week while its marks follow scans and writes. So
  `next_week_task_ids` lists only kept choices, and a mark added again in native Todoist that Sunday resets
  as usual. Before retrying a stored reset update, the Monday reset reads the task again: a task deleted
  meanwhile is forgotten instead of failing every tick. A row with no mark left gets no Todoist write.
- Both marks stay: a task has one row, so a Sunday Bet on an unfinished commitment keeps it committed. The
  checklist, the board note and both documents now say so; splitting the marks needs a migration, so it is
  left to the owner.
- Extension: a confirmed SetTaskPlan on Sunday updates next week's choices at once, following the server
  rule until the next read, so a board drag or goal pick shows as kept and is not offered again. Someday
  counts only items still to look at (neither kept nor already in this month). After Keep, Move, Keep for
  next week and Finish review, focus moves to the next action, the line or the heading, and a
  `role="status"` region reads the result. Closing returns focus to the toolbar, and the review jumps focus
  the Waiting summary or the runway line. Item actions carry the task title and are 24 px tall. The runway
  line says it selects the next one. The follow-up step entry gets focus once a running write no longer
  disables it.
- Copy: "Mail to clarify", "Waiting · N", 添加跟进步骤, 承诺未安排, 选要留到下周的（N）, "Changed within a
  day", and one untickable note instead of line 5 before Sunday. Review rows wrap at 650 px and below; at
  375 px they had overflowed.

Not changed: excluding an older open review task from the mail line needs another Plan field, so the line
is renamed and documented instead. A deleted bound Quarter label still disables Plus (pre-existing, needs
a design choice). The deploy-order edge (the installed extension always sends the stage from task
details) is a release step in the handoff.

Local checks: Todofy ruff check and format, 1,820 host cases (1 skipped: no protos checkout), including a new
host-level suite that drives `plus_api.handle` and `plus_week.tick` with a controlled clock, D1 on SQLite
and a fake Todoist, and 558 real-workerd runtime cases (four processes). Eight of the new or changed host
cases fail against the branch's previous code. The 453 `.github/scripts` cases pass (1 skipped as before).
Proto, gateway and owner UI are unchanged. The extension passes types, lint, 104 unit/component/API
cases (was 101) and 16 built-MV3 Chromium cases (was 15). The new Chromium case uses the keyboard in the
real Shadow DOM: focus moves through Someday's Keep actions to the line, a Sunday keep sends exactly one
SetTaskPlan, and focus returns to the toolbar on close. The content script is 374,657 bytes (118,802 with
`gzip -9`), against 372,556 before. The synthetic preview at 1440, 700 and 375 px, English and the
Chinese Sunday view, had no horizontal overflow and no console errors. The two interface captures were
taken again.

Not verified: real Todoist data, whether Todoist reports a deleted task's `item_update` as not found (the
reset now reads first, so it does not depend on it), the first natural Sunday-to-Monday rollover with a
Plus choice, branch CI and release.

## UI theme, safety and polish, local checks (October 15)

The owner approved the October 15 UI research on 2026-10-15: safety C1-C6, theming A1-A6 and polish
B1-B6. Local branch `claude/plus-ui-theme`, based on `origin/main` `58908f64`; not pushed,
no branch CI, no release, and the installed extension is unchanged. All data is synthetic; the live
Todoist page, FlowDay and Cloudflare were not touched. The token facts come from the owner's
content-free probe of the live page that day (Kale): `actionable-primary-idle-tint` and
`actionable-primary-selected-fill`, which Plus read, are missing there; the tokens the bridge now reads
are present, and `color-scheme` on `<html>` is `light`.

- Safety: the task tools take the row that holds the task's own content, else the selection list's
  first row, and attach nothing when a task link names another task; Plan/Focus and the nav re-mount
  after Todoist re-creates `#content` or the sidebar (ten mounts a minute); nothing native stays hidden
  while Plus is detached; a rejected mount no longer blocks later ones; Todoist dialogs and toasts in
  `#content` stay visible; disabling or reloading the extension restores native Todoist on the next
  pass, tab return or window focus; a render error leaves one "Back to Todoist / Reload" line, and the
  other view tries again; the observer runs at most once a frame and tears Plus down after 1,500 passes
  in 30 s in which Plus itself changed the page, so Todoist's own scrolling never counts. Selectors
  live in one ordered table (`anchors.ts`); the dead `#left_menu` is gone.
- Theme: one `--plus-*` bridge reads Todoist's tokens by role with the old values as `light-dark()`
  fallbacks; `applyTheme`'s per-mutation colour copy is removed. Until the live Dark theme confirms
  its `color-scheme`, a class change on `<html>` that turns the native text light marks each Plus host
  dark. All text on the selected fill uses Todoist's selected text colour; drag indicators use the
  accent. The options page follows the system. Vite's CSS target is Chrome 123: the default had
  turned every `light-dark()` fallback transparent.
- Polish: Paused state, step counts, one "Planning labels" name, 需要关注, priority checkboxes,
  calendar-clock, chevrons, no inert '+', a centred timer bar, week-number dates, 600 weights, 12 px
  minimum, one 1.5 px icon stroke, 32 px controls.
- Status line: the options page shows "Todoist 页面检测：全部正常" or which enhancement is off and why,
  from closed key sets that the background validates; it stays in `storage.local`.

Local checks: types, lint, Prettier on changed files, production build, 138 unit/component cases (was
104) and 19 built-MV3 Chromium cases (was 16). The new jsdom mount suite fails against the previous
`mount.tsx` in all eight safety cases; the new browser cases for the wrong-task binding, re-created
containers, the theme matrix and the timer bar fail against the previous build. The theme matrix loads
the public CSS of `@doist/product-libraries-tokens` 1.4.2 (MIT, an exact-pinned devDependency; nothing
from it is in the build output) for all nine themes, switches the `<html>` class and, in the same task,
checks every `--plus-*` colour against its token, the elements that use them, 4.5:1 for each text pair
Plus composes and 3:1 for indicator lines; in Week it measures today's number and the selected
outcome's metadata where they are drawn; it checks that Dark without its own `color-scheme` still makes
the hosts dark, then the no-token fallbacks in light and dark. A unit case fails on any
`--product-library-*` name the package does not define (only `shadow-raised-1`..`3`, seen live, are
allowed), on a `--td-ui-*` name outside the two seen live and on any name built at runtime; against the
previous CSS it reports exactly the two dead names.

A review of the branch the same day found, and this branch fixes: the loop breaker counting Todoist's
own passes; the task lookup that would bind to the first sub-task if the selection list holds sub-tasks;
favourites left hidden when the plan read fails while the Other views toggle loads; a startup report
from background tabs; a crash line and page check that outlived a view change; a capped view that a
click could not bring back; the token check missing built names; today's number, muted text on selected
fills, the error links and Tangerine drag lines below contrast targets; and the removed dark
`color-scheme` fallback. Each behaviour fix has a unit case that fails without it; the theme matrix
fails on the previous CSS at today's number and on the previous `mount.tsx` at the dark hosts, while
the error links and drag lines are covered by its token pairs.

The content script is 378,250 bytes (119,946 with `gzip -9`), against 374,657 (118,802) before; its CSS
32,306 bytes against 29,856; the background 136,746 against 136,055. No runtime dependency, budget or
service changed. Before/after captures in Kale (English and Chinese), Default, Blueberry, Dark and
Tangerine were reviewed locally and are not committed.

Not verified: the live Todoist DOM and theme values (public token values can differ a little), the
live task modal's shape and URL form that the task lookup relies on, the Dark theme's `color-scheme` and
`shadow-raised-*` values, the nav label offset, the installed extension, branch CI and release. Before
the same-SHA release the owner runs the two content-free console lines in
`todoist-plus/docs/verification.md` (theme in Kale and Dark; a task with sub-tasks and one of its
sub-tasks) and records the results here.

### Pre-release page check, October 16

The agent ran console line 1 from `todoist-plus/docs/verification.md` in the owner's Chrome on Today: once in the owner's
theme, once with `theme_dark` set on `<html>` in that tab only (no account setting changed). Only CSS values and booleans
were read.

- `colorScheme` was `light`, then `dark`; `plusDark` was `true` in Dark. All three `shadow-raised-*` values are box-shadows.
- Todoist's selected sidebar row has `selectable-secondary-selected-fill` as its background. Its text is
  `selectable-secondary-on-selected-fill`, not `-on-selected-tint`; that holds in both themes. The Plus nav row now uses that
  token (`--plus-nav-selected-text`). Board text on the selected fill keeps `-on-selected-tint`, because the native pair is
  4.47:1.
- `navLabelShift` was 5 px, measured on the installed older build. This branch's nav icon slot is 24 px, like Todoist's.
- Line 2 (task modal) was not run: it needs a real task with sub-tasks open. The C1 lookup hides Steps & timing on a
  mismatch, so it can never write elsewhere. After the reload, the owner checks step 4 of the six-step list, and the Options
  page check shows any mismatch.

## Deadlines, version 1, local checks (October 16)

The owner's final layout of the same day replaced the two stacked lists below: see [the next section](#start-now-and-waiting-lanes-local-checks-october-16). `SetTaskPlan.active`, the three replaced filters, the task-details sentence and button, Other views' remembered state and `--plus-danger` stay.

The owner approved version 1 of the deadlines and dependencies design (its §7): the start window (§1), the
favourite filters (§3) and `SetTaskPlan.active` (§5). Binding owner choices of 2026-10-16: the row actions of
Deadlines and Waiting show only on hover or keyboard focus; no `@blocked` mirroring; restrained visuals, with
`--plus-danger` only for "N days past". Dependencies (§2) and native row marks (§4) are not built. Local branch
`claude/plus-deadlines`, based on `origin/main` `60309fac`; not pushed, no branch CI, no release. All data is
synthetic; Todoist, FlowDay and Cloudflare accounts were not touched.

- Extension: `src/deadlines.ts` gives each task with a deadline one state from Todofy's unchanged `must_start` /
  `missing_lead` and the literal `active`, `blocked`, `parked` labels. "Deadlines · N" replaces "Needs a look":
  in Review below the lanes and above Waiting, in Week below the calendar; earliest deadline first, then
  priority; open by itself when something is past or in its start window, otherwise the owner's toggle for the
  visit. Each row is a title, one muted status and at most one text action ("Mark in progress", only when the
  account has the `active` label; "Choose when to start", which focuses the editor's start-ahead select). The
  actions are hidden by opacity only, so they stay in the tab order and the accessibility tree and keep their
  column. Waiting rows add the deadline ("Deadline Oct 22", or "2 days past deadline"). Focus shows one quiet
  line when a past or start-window task has nothing open planned this week, and it opens Review with Deadlines
  focused. Task details state where the deadline stands from the fields shown, with "Mark in progress" / "Not
  in progress"; the English select says "1 day". Cards name the start window in their accessible name and the
  calendar-clock tooltip. Legacy `<k:… dep:…>` suffixes with spaces are hidden in Plus's own views. Other views
  remembers open or closed in one `storage.local` boolean, cleared on disconnect.
- `--plus-danger` now reads Todoist's `schedule-overdue-tint`, its own overdue-date colour. The attention tint it
  read before is about 4.1:1 as 12 px text on the page background in all nine public themes, below 4.5:1, which
  the design's fallback rule would have turned into plain text everywhere; the overdue tint is 4.54:1 (light) and
  about 6.1:1 (dark). The error edge, the only other use, follows it.
- Backend: additive `SetTaskPlanRequest.active` (field 7). `plan_labels` adds or removes only `active`; Todofy
  refuses `active: true` with `ACTION_NOT_ALLOWED` before any Sync write while the account has no label of that
  exact name. `REPLACED_FILTER_QUERIES` adds the waiting-with-deadline query (two spellings), `@blocked` and the
  in-progress deadline query; the quick-task and parked filters stay native. No table, migration, dependency or
  budget change.

Local checks: proto format/lint, api-linter (69 files), breaking against `origin/main` `60309fac`, the rules
self-test, deterministic generation (151 files), the schema check, 495 TypeScript and 113 Python codec cases.
Todofy: ruff check and format, 1,823 host cases (1 skipped: no protos checkout) and 559 real-workerd runtime
cases (557 in four processes, then the serial file). The replaced-filter consistency case evaluates each
deadline or waiting query over 1,568 synthetic tasks with the real `task_view` and requires every selected task
in Deadlines or Waiting; with Waiting's `blocked` or Deadlines' in-progress rule removed it fails on the matching
query. The extension's matching case checks the same rule in API fields against `deadlines.ts` and the Waiting
list. The runtime case refuses `active` without the label (no Sync command), then writes and removes it with the
label, leaving the other labels, the deadline and a Sunday choice's week in place. Gateway lint, types, 130 unit
cases and the calibrated CPU suite pass; gateway source is unchanged. The owner UI's types, 93 tests and build
pass (176.8 KiB gzip, budget 208 KiB), and the 453 `.github/scripts` cases pass (1 skipped as before).

The extension passes types, lint, Prettier, 161 unit/component/API cases (was 138) and 24 built-MV3 Chromium
cases (was 19). The new Chromium cases: each status at rest with its action at opacity 0, shown on hover and
reached by Tab from the title; one SetTaskPlan `{active: true}` and no further task read; focus moving to the
next row's action; marking the last due row by keyboard; Focus's line opening Review with the Deadlines
summary focused; rows wrapping under the title at 640 px without overflow; Other views kept across reloads;
and `--plus-danger` on the background at 4.5:1 or more in all nine themes. The content script is 385,225 bytes
(121,861 with `gzip -9`), against 378,250 (119,946) before; its CSS 33,073 against 32,424; the background
137,035 against 136,746. Screenshots of the built extension on the synthetic page in Kale, Default and Dark
(Review and Week at rest and with a row hovered, Focus with its line, task details, and narrow Review and
details) were reviewed locally; one is in the [interface document](../todoist-plus/docs/planning-interface.md).

Review fixes, the same day. Marking the last due row, in the list or in the editor opened from its title,
closed the list when the owner had not toggled it, so focus fell to the page and the announcement was inside
a closed `<details>`. Acting on a row now keeps the list open for the visit, and its `role="status"` sits just
outside the list. A card whose stage drag is pending keeps its row's "Mark in progress" disabled, as its
details already were, so the write cannot carry the pre-drag etag. Statuses come last on screen through CSS
`order` (markup and reading order unchanged), so both lists end at one right edge, at rest and on hover; the
actions show on `:has(:focus-visible)` instead of `:focus-within`, so a mouse click leaves no action shown.
Screen readers hear only the part of the date a status lacks ("Deadline Nov 30, Mon"; "，" in Chinese); a
`@blocked` task past its deadline without a lead reads "2 days past" in the danger colour; in a narrow editor
"Mark in progress" keeps one line and wraps under the fields. The four `design/production.html` captures in
the interface document still showed "Needs a look" and were retaken. Each new case was checked to fail on the
previous code: the list staying open (unit and Chromium), the pending card, the right edge and the mouse
reveal. Kept as they were, with reasons in the interface document: the empty third line of a Waiting row at
about 350 px of content (the owner's hover rule), the app-wide ASCII colon in accessible names, and the
details sentence, which describes dates and the in-progress label only.

Not verified: the live Todoist page and data (including that the owner's filters normalize to exactly these
queries and that the account has an `active` label), real Todoist's overdue colour in the owner's theme, the
installed extension, the core and gateway production dry-runs, branch CI and release.

## Start now and Waiting lanes, local checks (October 16)

The owner's final layout of 2026-10-16 (restrained, no dark mode): no new tab. The Review board reads Start now |
Waiting | Quarter | Month | Week | Committed; Start now and Waiting use the same lane and card components and are
hidden while empty. Each task is in exactly one lane: its own stage label first (its card then says it waits or
should start), then `@waiting`/`@blocked`, then an open start window or a passed deadline without `@active`
(also for a Week candidate by the 7-day date rule), then the date rule. Dragging a Start now card into a stage lane
writes that stage and `active` in one confirmed SetTaskPlan, through the existing pending card and FIFO queue
with rollback; a card's hover "Start" adds only `active`; a Waiting card dragged into a stage lane gets only the
stage. Start now and Waiting take no drops. Nothing is stacked under the board or the Week calendar any more;
Focus's quiet line and the weekly review's Waiting jump focus the lane on Plan's Review. A deadline without a
lead is only a weekly review line, with the editor's start-ahead select per task. The dark-mode code is removed:
`syncScheme` and the `data-theme="dark"` host rule, the `light-dark()` fallbacks (light values kept), the options
page's dark color-scheme, the prototype's theme toggle and the Dark test cases. Same local branch
`claude/plus-deadlines`; not pushed, no branch CI, no release. All data is synthetic; Todoist, FlowDay and
Cloudflare accounts were not touched.

The extension passes types, lint, Prettier, 163 unit/component/API cases and 26 built-MV3 Chromium cases. New or
changed cases cover the lane rule and order, a client-side consistency grid (every combination of the API's
fields is in at most one lane, and a waiting or must-start task in exactly one, saying so), the drag from Start
now (one write with the stage and `active`, the predicted labels, rollback, stage only without an `active`
label), the Waiting drag (stage only, label kept), drops on Start now or Waiting writing nothing, Start's single
write with its focus and announcement, the weekly review's start-ahead line, the jumps from Focus and the weekly
review, and in Chromium the six lanes in one row with identical cards, Start hidden at rest and shown on hover
without moving the title or status, the drag into Committed shown at once and confirmed, and the narrow
stacking. The content script is 383,915 bytes (121,691 with `gzip -9`), its CSS 32,763; version 1 was 385,225
(121,861) and 33,073. Todofy's consistency case now requires every task a replaced deadline or waiting query
selects to be on the Review board (must start or waiting) or in progress, and every task of the missing-lead
query to be in the weekly review's line; the query set and backend behaviour are unchanged (one comment).
Screenshots of the built extension on the synthetic page, in Kale light only, were reviewed locally: the board
with both lanes, a Start now card dragged into Committed and pending after the drop, a hovered card showing
Start, and the weekly review's start-ahead line; the interface document's images were retaken.

Review fixes, same day. Focus's quiet line no longer counts a waiting task past its deadline, which the board
shows in Waiting, so the line's numbers, its wording and its jump agree. A two-part status ("12 天未变动 ·
10月22日截止") has its own row under the area and wraps only between its parts, so no line starts or ends with
the separator; English reads "No change in 12 days" and "2 days late". A waiting card past its deadline says
"已过 N 天" in the danger colour, the board's one red wording. Between about 800 and 1,260 px of content the four
stages keep one row under Start now and Waiting, two columns each. Start no longer reserves room in the title
row: it is drawn over the end of the title's first line on hover or keyboard focus. The drag preview takes the
dragged card's size. Week's commitment overview keeps its step counts. A step dropped into its own outcome's
lane, where it would come straight back to Start now or Waiting, writes nothing. The extension passes types,
lint, Prettier, 167 unit/component/API cases and 28 built-MV3 Chromium cases; new cases cover the 1,440 px
layout, the two-part status's wrap and its one-line Chinese, the preview's size, Start's free title width, the
step drops and steps of a committed outcome in the client consistency grid. Todofy's unit cases add one
`{stage, active}` request, with the Sunday next-week rule, and the `lead_3d` boundary. The content script is
384,037 bytes (121,765 with `gzip -9`), its CSS 33,605. The Kale screenshots and the interface document's images
were retaken.

Final branch check, same day, on the code at `5bc0f91a`. Every job that CI's change detection selects against
`60309fac` was run locally from the workflow's own steps and passes: the Changes job's tests, Todoist Plus (167
unit cases, 28 built-MV3 Chromium cases), Todofy static and all three runtime shards (559 cases, each exactly
once), Proto, Contracts, and the apps the proto change re-checks (Mail Hero, Home, FlowDay, links, watch,
mailsort, recall, brief, Fleet, the website and Platform). Two extension cases now wait for focus that moves in
an effect after the announcing render; one had failed once in a full run under load. Local gaps: no GPG here, so
Mail Hero's crypto round-trip skipped, and Platform's Linux-only steps (manifest compiler, AppArmor, image build,
k3s) did not run. The manifest's permissions are unchanged. On main the change would deploy Todofy and publish
the Todoist Plus extension; nothing else releases.

Not verified: the live Todoist page and data, the installed extension, branch CI and release.

## Planning store, caches and receipts, local checks (October 16)

Steps M1-M3 of the owner-approved October 16 data-layer design, on local branch `claude/plan-store-m1-m3`,
based on `origin/main` `60309fac`; not pushed, no branch CI, no release. All data is synthetic; production D1,
the Durable Object, Todoist and FlowDay were not touched. The owner's overrides hold: no shadow mode or
observation period, the `summaries_task` index is the partial one on `task_id <> '' AND imported = 0`, no
legacy table is dropped or rewritten, and `TODOFY_PLUS_METADATA=full` is the only switch.

- M1: migration `0007_plan_store.sql`, the six tables' backup (`plan_tasks` last), `RETIRED_TABLES` in the
  restore tool and the owner-only `VerifyPlanStore` (counts only); no behaviour change.
- M2: Todoist metadata from the object's SQLite with an incremental Sync token (five minutes for reads, an
  incremental Sync before every label write, at most 20 full Syncs per 15 minutes), the extension token checked
  inside `plus_ui` (fail-closed for a non-owner call without a digest), `ReadPlanRequest.view`.
- M3: replay receipts in the object's SQLite (`storage.sync()` before the Sync call, IDs only once done,
  read for 30 days and never deleted, the FlowDay settlement by compare-and-set), D1 `plus_actions`
  read-only for the last 30 days, `UpdatePlanLabels` replayed by value.
- Review fixes: a token check that Issue or Revoke overlaps keeps no copy (an in-memory change count, and
  the copy dropped before and after the D1 write); a started `SetTaskPlan` or `SetTaskLead` keeps its plan
  etag and answers `ETAG_MISMATCH` once the binding changed; a Monday label write syncs once (also under
  `full`); a backup job keeps the columns it was planned with, and one the release before saved starts over;
  the automatic 30-day receipt deletion was removed (the owner's override), the 30-day lookup window stays.

Local checks, all passing: Todofy ruff and 1,893 host tests (one existing skip), among them the new
`test_plan_store.py`, `test_plus_cache.py`, `test_plus_receipts.py` and the restore round trips; all 567
real-workerd runtime cases (565 in four processes, then the serial `test_alarm.py`), 25 of them Plus, among them
the new `test_plus_cache.py` and `test_plus_receipts.py`; the gateway's lint, types, 133 unit cases and its
CPU suite; both production dry-runs, the gateway at 82.5 KiB gzip (budget 86 KiB); proto format, lint,
api-linter, breaking against `60309fac`, deterministic generation, schemas and both codecs (495 TypeScript,
113 Python); `.github/scripts` (453, one existing skip), the cloud tools, generate, catalog, inventory and
drift checks; the dashboard Worker's 267 unit and 97 runtime cases; the extension's lint, types, 138 unit
cases, build and 19 built-MV3 Chromium cases (its behaviour is unchanged; the IDL change republishes it).

After the review fixes, re-run and passing: Todofy ruff and 1,906 host tests (one existing skip), among them
the new `test_backup_job.py` and the race, rebinding and Monday-Sync cases; all 568 real-workerd runtime cases
in three shards of four processes plus the serial `test_alarm.py`, among them the rebinding case in
`test_plus_labels.py`; both production dry-runs (the gateway still 82.5 KiB gzip); `.github/scripts` (453, one
existing skip). The fixes touch no gateway, proto, dashboard or extension file, so those checks were not
repeated.

The runtime cases read the object's SQLite file and check that each receipt is done with IDs only and that
D1 `plus_actions` gains no row; a done D1 receipt answers as stored, a started one is sent once and finishes
in the object, and a completion's D1 settlement is copied into the object with it (in workerd's SQLite, whose
JSON operators the settlement uses). The test servers have no FlowDay, so the settlement's compare-and-set
itself is covered on host SQLite and by the gateway's settlement cases.

Not verified: branch CI, the release, production D1 and Todoist (an incremental Sync's real answers, the
first full Sync after the release), the deploy window between the core and gateway uploads, and the
owner's review. No production row count was taken: building `summaries_task` writes one entry per delivered
mail with a task (`imported = 0`, the rows of the last 90 days), none for the imported archive. After the
release: `VerifyPlanStore` answers `{}`, the next Sunday manifest lists the six tables and `plus_actions`
stops growing.

## Dependencies, local checks (October 16)

Task dependencies, from the owner-approved October 16 designs (plus-next §2 and §5, as adjusted by the
data-layer design §5.1) and the owner's decisions of the same day, on local branch `claude/plus-dependencies`,
based on `origin/main` `1e8e6863`; not pushed, no branch CI, no release. All data is synthetic; production D1,
the Durable Object, Todoist, FlowDay and the owner's Todoist were not touched.

- The recurring rule was chosen from Todoist's official API reference, read on 2026-10-16: the v1 Task object
  (ItemSyncView, which `GET /api/v1/tasks` and the Sync API return) has a required `completed_count`, which goes
  up with every completion, recurring occurrences included, and down when a recurring completion is undone. So
  a recurring task can be a prerequisite, satisfied by its next completion after the dependency was added; one
  without the counter is refused by Todofy and greyed in the picker. The same reference says the activity log's
  availability and retention depend on the plan, so its 403 is answered without the six-hour Todoist block.
  Neither was checked against a real account.
- Todofy: additive `SetTaskDependency`, `ResolveDependencies`, `Plan.dependencies` (FULL answers),
  `PlanningTask.recurring` and `completed_count`; `plan_edges` between `plan_tasks` IDs, no migration (0007 has
  the tables), no receipt, no Todoist write; `CompleteTask` records the task completed.
- Extension: the 「依赖 / Depends on」 section and inline picker in both task details, 等「B」 on board cards,
  the Waiting lane, the ready state, the settle check after complete reads and the one-time deletion notice.

Local checks, all passing: Todofy ruff and 1,953 host tests (one existing skip), among them the new
`test_plus_dependencies.py` (the cycle and limit rules, both RPCs, the activity log through the real `call`,
statement counts: 5 for an add, at most 8 for a check) and the dependency statements in `test_plan_store.py`;
all 575 real-workerd runtime cases (573 in four processes, then the serial `test_alarm.py`), among them the six
new `test_plus_dependencies.py` cases through the gateway with the extension token; the gateway's lint, types,
134 unit cases and its CPU suite, which now includes a FULL ReadPlan with 500 labels and 300 dependencies
(first runs 0.77-0.86 ms, warm medians 0.40-0.71 ms in three isolates; bounds 6 and 4 ms of Free's 10); both
production dry-runs, the gateway at 82.9 KiB gzip (budget 86 KiB) and the core bundle with `plus_service_pb`;
proto format, lint, api-linter (69 files), breaking against `1e8e6863`, deterministic generation, schemas and
both codecs (495 TypeScript, 113 Python); `.github/scripts` (453, one existing skip); the owner UI's types and
93 tests; the extension's lint, types, 182 unit cases, build and 31 built-MV3 Chromium cases on the synthetic
Kale page, three of them new. Screenshots of the built extension on the synthetic page (Kale, light, Chinese
synthetic titles) were taken for the owner's review and are not in the repository: the section with the
picker open and a cycle candidate greyed, a card saying 等「订场地」 in Committed, the Waiting lane, and the
ready state after the prerequisite completes.

Not done: the native popup's collapsed Steps & timing suffix (`planMarks`, plus-next §4 v2). Not verified:
branch CI, the release, a real account's `completed_count` and activity-log answers, the installed extension
on real Todoist, and the owner's review.

### Review fixes (October 16)

The review of the branch found that done dependencies could not be removed and still filled the 5-per-task limit
and closed cycles (a recurring waiter kept its 「所等的任务都已完成」 line for good, and a satisfied recurring
prerequisite could not be picked again); that the one-time deletion notice could be used up in Focus or Week
where nothing shows it; that settling could starve past the first 20 IDs and left a prerequisite unknown forever
when the activity log failed for good; that a completion recorded in Plus outlived a reopening; that a missing log
event was told as a deletion; that a failed D1 record made a done CompleteTask answer an error; that the refusal
message guessed its cause; that a long prerequisite title overflowed or wrapped a card; and four small layout
points (the notice above the board moved it, the remove button was 28px and a confirmed row grew, the picker
highlighted a greyed option, a title gave no hover cue). Fixed on the branch:

- Todofy: only dependencies that still hold count. `SetTaskDependency` reads Todoist once (both tasks, what the
  task waits for and every task the prerequisite waits for) and tells holding ones by `core/plus.py holds`;
  `core/plan.py check_dependency` refuses a cycle or a sixth one by them, and at the store's limits the task's
  oldest done dependency gives way in the same batch; adding a done one starts it over from the current count.
  `ResolveDependencies` opens again a task recorded closed that Todoist lists, records `deleted` only for an
  explicit deletion event, and releases (removes with a neutral notice, `released_task_ids`, nothing recorded) a
  prerequisite the log does not explain or a plan without the log answers 403 for. CompleteTask's record is best
  effort.
- Extension: the details' done line has a hover-only remove action; the picker offers a satisfied recurring task
  again, greys a cycle only by holding dependencies and starts its highlight on the first option that can be
  chosen; only the Review board settles, once per complete read, gone waiters first and none it asked in the visit,
  and tells it under the lanes; the card's quoted title ends in an ellipsis inside its marks, its part on one line;
  rows are 32px saved or pending, the remove buttons 24px, and a title underlines on hover or focus; the refusal
  reads `Not added: this dependency cannot be added now. Refresh and try again.` Localising API errors, which are
  English throughout, is left as it is.

Local checks after the fixes, all passing: Todofy ruff and 1,961 host tests (one existing skip), among them the
review cases (a done dependency giving way and closing no cycle, a recurring re-pick, a reopened then deleted
prerequisite, a released one, a 403 log, a failed completion record); all 576 real-workerd runtime cases (574 in
four processes, then the serial `test_alarm.py`), seven of them dependency cases; the gateway's lint, types, 134
unit cases and CPU suite; both production dry-runs (gateway 82.9 KiB gzip of 86 KiB); proto format, lint,
api-linter (69 files), breaking against `1e8e6863` and the branch head, deterministic generation, schemas and both
codecs (495 TypeScript, 113 Python); `.github/scripts` (453, one existing skip); the owner UI's types and 93 tests;
the extension's lint, types, 186 unit cases, build and 32 built-MV3 Chromium cases on the synthetic Kale page (the
dependency ones now also check the notice leaving the board in place, a recurring re-pick, row heights, hover cues
and long Chinese and English titles at 1600 and 1440 px). The screenshots for the owner's review were retaken
(Kale, light, synthetic Chinese titles, not in the repository), with the done line's hover action, the notice
under the lanes and long titles added.

## Text weekly Bets, local checks (October 16)

The first part of the owner-approved October 16 Bets and Mailbox design, on local branch
`claude/plus-bets-mailbox`, based on `claude/plan-store-m1-m3` (`1a6d23d2`); not pushed, no branch CI, no
release. All data is synthetic; production D1, the Durable Object, Todoist, FlowDay and the owner's Chrome
were not touched. The owner's decisions hold: one Work and one Personal line of text per account week (at
most 160 UTF-16 units), in the planning store and never in Todoist; Enter or an in-page blur saves, Esc
cancels; an empty line offers last week's with Keep; Sunday's review writes next week's; old `@bets` tasks
are not converted, and the label and the Bets filter are left alone; no dark mode, no shadow mode.

- Todofy: `SetWeeklyBet` (additive RPC) writes one `plan_notes` row by compare-and-set on its rev, with no
  Todoist call and no receipt; the saved text answers as a replay; only this and next account week take a
  write; clearing keeps the row at the next rev. Every FULL Plan answer carries `weekly_bets` for last, this
  and next week (one more primary-key statement in the review batch). The Bets label is a legacy role: a
  saved binding is kept as saved and never checked, a new setup binds none, `SetTaskPlan` refuses `bet`, and
  the Monday reset still removes `@bets` while the binding remains. `PlanningTask.bet` and
  `SetTaskPlanRequest.bet` are deprecated. The owner page shows no retired role.
- Extension: the in-place editor (`BetText`), Keep, Sunday's line 5 ("Next week's commitments and goals",
  commitments only to keep), planning protocol 4 (a refused Bet crosses the message boundary as a value);
  the goal picker, `topLevelBets` and the task `bet` field are gone. While another write waits, the lines
  and Keep are only marked `aria-disabled`, so the focus Tab just moved to the other line stays.

Local checks, all passing: Todofy ruff and 1,939 host tests (one existing skip), among them the new
`test_plus_bets.py` and the reworked retired-label cases in `test_plus.py` and `test_plus_rollover.py`; all
570 real-workerd runtime cases (three shards of four processes plus the serial `test_alarm.py`), the Plus
files binding the retired label in their saved setup as production does, with a new SetWeeklyBet case through
the gateway and the extension token; the gateway's lint, types, unit cases and its runtime CPU suite; both
production dry-runs, the gateway at 82.7 KiB gzip (budget 86 KiB); the owner UI's types, tests and build
(177.4 KiB gzip, budget 208 KiB); proto format, lint, api-linter, breaking against `1a6d23d2`, deterministic
generation, schemas and both codecs (495 TypeScript, 113 Python); `.github/scripts` (453, one existing skip)
and the cloud tools; the extension's lint, types, 184 unit cases, build and 33 built-MV3 Chromium cases (5
new: the in-place save, Esc and key isolation from Todoist's document; blur saves and an emptied line
restores; Keep on hover, focus and Enter, hidden while another write waits; a change from another tab; Sunday's
next-week line). Headless Chromium keeps every page focused, so "switching windows keeps the draft" is
covered by the unit cases only.

Screenshots of the real built extension on the synthetic page (Kale light, Chinese) for the owner's review:
the two lines at rest, editing, an empty line with last week's and Keep, and Sunday's next-week lines. The
interface document's Review, Week, narrow, wide and weekly review images were retaken from
`design/production.html`.

Not verified: branch CI, the release, production D1 (the first `plan_notes` rows), the installed extension
in the owner's Chrome and a real Monday reset after the release. After release: reload the extension, refresh
Todoist, type this week's two Bets; the first check after Monday 00:00 removes `@bets` from the remaining
tasks as before.

## Mailbox, briefs and summary retention, local checks (October 16)

The second part of the owner-approved October 16 Bets and Mailbox design, on the same local branch
`claude/plus-bets-mailbox`; not pushed, no branch CI, no release. All data is synthetic; production D1, the
Durable Object, Todoist, Gemini, FlowDay, real mail and the owner's Chrome were not touched. The owner's
decisions hold: a quiet list (title, one muted brief, time), not cards; a sidebar entry 「邮件 / Mail」 under
Plan and Focus with no count; the mail project's favourite hidden while a Plus page is open; File shown only
on hover or focus; categories of one existing label and P1-P4 (at most four, names generated) filing in one
Todoist write to one destination chosen before the first use; a permanent Delete all of the frozen, untouched
listed mail behind a confirmation with the count, "永久删除，无法撤销" and the focus on Cancel; no dark
mode, no shadow mode.

- Todofy: six additive RPCs (`LookupMailItems`, `ReadMailSummary`, `ReadMailSettings`, `UpdateMailSettings`,
  `FileMailItem`, `DeleteMailItems`) in `runtime/plus_mail.py`; the categories in `plan_categories` (scheme
  `mail`) and the adapter document `plan_settings` `todoist.mail`; filing and deleting under receipts in the
  object's SQLite, deletions frozen before the first Sync, at most 100 commands a Sync, `ITEM_NOT_FOUND`
  counted as done for deletions only, a confirming read before the answer. `SUMMARY_EMAIL` gains one line
  (the summary's first line is a one-sentence brief), `core/mailbox.brief_of` reads it, and migration
  `0008_mail_briefs.sql` adds `summaries.brief`, stored at completion; `runtime/mail_briefs.py` gives the
  mail then in the Mailbox without one a model-written brief once, within half of the day's token budget.
  The daily retention no longer deletes summaries; everything else about retention is unchanged.
- Extension: the Mailbox page (`Mailbox.tsx`, `MailCategories.tsx`, `mail.ts`, `mailbox.css`), the sidebar
  entry, `PlanConfig.hiddenProjectIds`, the weekly review's mail line opening the Mailbox, planning protocol 5.

Local checks, all passing: Todofy ruff and 2,031 host tests (one existing skip), among them the new
`test_mailbox.py`, `test_plus_mailbox.py` and `test_mail_briefs.py`, the prompt's golden bytes and the
retention cases that keep every summary; all 574 real-workerd runtime cases (three shards of four processes
plus the serial `test_alarm.py`), with the new `test_plus_mailbox.py` through the gateway and the extension
token (D1 alone for the reads, one Sync for a filing, a repeated deletion that deletes nothing twice, the
backfill once from the alarm); the gateway's lint, types, 134 unit cases and its runtime CPU suite; both
production dry-runs, the gateway at 83.7 KiB gzip (budget 86 KiB) and the core at 215.0 KiB gzip; the owner
UI's types, 93 tests and build (178.4 KiB gzip, budget 208 KiB); proto format, lint, api-linter (no problems
in 69 files), breaking against `1a6d23d2` (none), deterministic generation and both codecs (495 TypeScript,
113 Python); `.github/scripts` (453, one existing skip) and the cloud tools; the extension's lint, types, 208
unit cases, build and 38 built-MV3 Chromium cases (5 new: the sidebar entry and the favourite, File on hover
and focus with keyboard filing and key isolation, the plain-text summary, Delete all's confirmation and frozen
batch, the categories dialog).

Screenshots of the real built extension on the synthetic page (Kale light, Chinese) for the owner's review:
the sidebar with 邮件, the list at rest, a hovered row, an expanded row, the File menu, the categories dialog
and the Delete all confirmation, besides the four Bets images retaken from the same build.

Not verified: branch CI, the release, production D1 (`0008`, the first `todoist.mail` document, the brief
backfill's run), Todoist's real answers for a missing task's `item_delete`, a replayed UUID and an
`item_update` with an `item_move` in one request, whether its task list carries `note_count` (without it
Delete all deletes nothing), the real summaries' first lines, and the installed extension in the owner's
Chrome. Replaced filters stay hidden on native pages too, as before; only the mail project's favourite is
limited to Plus pages, as the owner decided.

## Mailbox review fixes, local checks (October 16)

The same-day review of the Mailbox and Bets commit, on the same local branch; not pushed, no branch CI, no
release, synthetic data only. Every finding that held up is fixed with a test:

- Delete all's retry reads the frozen tasks again and resends only those still untouched, with their frozen
  UUIDs; a mail the owner labelled, commented on, re-prioritised, dated, moved or gave a step to after a
  failed first try stays, and no task is ever added. Todofy also keeps a mail an unfinished Plus write is
  changing (`plus_receipts.writing`, a `json_each` over the started receipts in the object's SQLite, by the
  new partial index `plus_receipts_started`), and counts a listed mail already gone as deleted. Before
  sending and before each Try again the extension checks what Todofy cannot see (a FlowDay estimate or day
  queue, the timer, a write on its way): the batch only shrinks, and a new count is shown before anything
  is sent, under a new request.
- Delete all deletes the `summaries` rows of the mail it deletes (subject, summary, brief); `mail_events`
  keeps its rows. This is the suggested default for the owner's 「邮件由 owner 自己删除」 and is listed for the
  owner's confirmation; nothing else deletes a summary, and their growth is recorded in
  `todofy/docs/cloudflare-setup.md`.
- A FileMailItem retry reads the task first: one that left the mail project is done; otherwise the frozen
  commands go again only if the task, the label and the destination still build them, else `ETAG_MISMATCH`
  (no label name Todoist no longer has, no label of the owner's dropped). A destination archived or deleted
  since it was chosen is `ACTION_NOT_ALLOWED`, and the Mailbox then opens the categories.
- The brief backfill counts each attempt before its call (a step that throws is given up after three) and
  paces its calls 30 s apart.
- The gateway answers the POST mail lookup in maintenance like the GET reads; its CPU suite measures the
  200-item lookup and the 64 KiB summary read (first runs 0.4-1.0 ms, medians 0.6-0.9 ms, passed through).
- Extension: the status line is always rendered in the space under the header and only its text changes
  (the list no longer moves between filings; a live region exists before the first write); repeated
  announcements are read again (`src/announce.ts`); the confirmation's `aria-describedby` names the warning
  and the kept mail; the Mail categories close on save with focus back on their opener; the Bet hint sits at
  the end of the column heading's line (the panel keeps its height) and the Bet focus ring is drawn inside;
  the Mailbox heading has no ring; a row's name drops the brief's closing punctuation and the time is not
  read twice.
- Not changed: the docs' "other rows stay usable while one is filed" holds; a built-MV3 case files a second
  mail while a write is held and finds the other rows' File enabled.

Local checks, all passing: Todofy ruff and 2,048 host tests (one existing skip; 17 new); all 577
real-workerd runtime cases in three shards plus the serial `test_alarm.py` (3 new: a delete retry after a
Todoist 429 that keeps the changed mail, the unfinished-write guard over the object's own SQLite, a filing
retry after a label rename and a filing into an archived project); the gateway's lint, types, 135 unit
cases and its runtime CPU suite (15 requests); both production dry-runs (gateway 83.7 KiB gzip, budget 86
KiB; core 216.5 KiB gzip); the owner UI's types, 93 tests and build; proto format, lint, api-linter (no
problems in 69 files), breaking against `1a6d23d2` (none), deterministic generation and both codecs (495
TypeScript, 113 Python); `.github/scripts` (453, one existing skip) and the cloud tools; the extension's
lint, types, 218 unit cases (10 new), build and 39 built-MV3 Chromium cases (1 new, 3 extended). The eleven
Kale-light screenshots of the built extension were retaken from the same build, and the interface
document's File-menu image with them (the status line no longer pushes the list down).

Not verified, besides the earlier list: what real Todoist answers for an `item_move` into an archived
project, and a screen reader's reading of the new live regions (checked only through the DOM).


Final branch check, same day, on the code at `2def9657`. Every job that CI's change detection selects against
`1a6d23d2` (the merge base with `origin/main`) was run locally from the workflow's own steps and passes: the
Changes job's tests, Todoist Plus (218 unit cases, 39 built-MV3 Chromium cases), Todofy static (2,048 host
tests, one existing skip; both dry-runs, the gateway at 83.7 KiB gzip) and all three runtime shards (577 cases,
each exactly once), Proto (breaking against `1a6d23d2`: none), Contracts, and the apps the proto change
re-checks (Mail Hero, Home, FlowDay, links, watch, mailsort, recall, brief, Fleet, the website and Platform).
One runtime case in a file this branch does not touch (`test_task_intents.py`) failed once when the harness's
`wrangler d1 execute` read of the local D1 got a Miniflare internal error; its shard passed when run again,
as did the file alone. Local gaps: no GPG here, so Mail Hero's crypto round-trip skipped, and Platform's
Linux-only steps (manifest compiler, AppArmor, image build, k3s) did not run. The manifest's permissions are
unchanged. On main the change would deploy Todofy (migration `0008_mail_briefs.sql` first) and then publish the
Todoist Plus extension; nothing else releases. Main has since taken `1a6d23d2` and the dependency feature
(`6a465bee`), so the branch is rebased onto it before it is pushed and these checks run again there.

## Bets and Mailbox rebased onto the dependencies, local checks (October 16)

The branch's four commits (`02b5b872`, `8559e3c0`, `2def9657`, `999899d9`) are squashed into one and rebased
onto `origin/main` `6a465bee`, which has the planning store (`1e8e6863`, with the task-modal mount fix) and the
dependencies; not pushed, no branch CI, no release; synthetic data only. Both features are kept as each was
built and tested:

- proto: `Plan.dependencies` stays field 14 and `PlanningTask.recurring` and `completed_count` 18-19;
  `Plan.weekly_bets` is 15, with its own `WeeklyBet` message, and the Bets and Mailbox RPCs follow the
  dependency RPCs. All of it is additive (breaking against `6a465bee`: none). The generated code was produced
  again by `proto/tools/ensure.mjs`, never merged by hand.
- Todofy: the review batch reads the two review weeks, next week, every dependency and the Bets, five
  statements (`test_plus_cache.py`); the dispatcher serves both method sets (the dependency writes still carry
  their request ID, SetWeeklyBet and UpdateMailSettings none); `plus_todoist` keeps the dependencies' `active`
  and `closed_as` reads beside the Mailbox's paged reads and the `gone_ok` Sync; the PlusFake answers an `ids`
  lookup in one page, as the dependencies expect, and filters a project read for the Mailbox. DeleteMailItems
  already kept any mail with a dependency either way (`plan_edges` by `plan_tasks` IDs, as the dependencies
  write them).
- Extension: task details have the 依赖 section, Plan the Bet lines and the sidebar the Mailbox; the Review
  board, the weekly review (Waiting counts the tasks that wait for another, the mail line opens the Mailbox,
  line 5 writes next week's Bets), the browser cases' synthetic page and the design fixture carry both. The
  mount fix of `1e8e6863` is unchanged. Planning protocol is 5.
- Changed after the merge, besides the text: a dependency test's task no longer sets the retired `bet` field,
  the Mailbox test's plan has `dependencies: []`, the gateway CPU suite's largest Plan carries six Bets beside
  the 300 dependencies (first runs 0.47-0.86 ms, warm medians 0.70-0.71 ms in three isolates), `core/plan.py`
  takes ruff's blank line, and the PlusFake's `ids` filter on paged reads, unreachable after the one-page
  lookup, is gone.
- Found by the independent check of the rebase: the Mailbox's Delete all counted a mail that a dependency
  names (either way) as deletable, because its `touched` rule predates the extension holding the
  dependencies; Todofy kept such mail, so the confirmed count could exceed what was deleted. `src/mail.ts`
  `touched` now keeps it too and the dialog lists it among the kept (a unit case in `test/mail.test.ts`);
  Todofy's own check is unchanged.

Local checks after the rebase, all passing, for every job `.github/scripts/ci_changes.py` selects against
`6a465bee` (it deploys Todofy and publishes the extension; the proto change re-checks every app that uses the
IDL): the Changes job's tests (453 `.github/scripts` tests, one existing skip; the cloud-config,
cloud-release, cloud-bootstrap and service-catalog tests; the generate, catalog and inventory checks; the
cf-guard, bundle-size and workerd-cpu tools); Proto (format, lint, api-linter with no problems in 69 files,
breaking against `6a465bee`: none, the rule self-test, deterministic generation of 151 files, the schemas, 495
TypeScript and 113 Python codec tests); Todofy static (ruff, 2,099 host tests with one existing skip, the
gateway's lint, types, 135 unit cases and its CPU suite of 16 requests, the owner UI's types, 93 tests and build
at 178.8 KiB gzip, both production dry-runs with the gateway at 84.2 KiB gzip of 86 KiB) and all 584 runtime
cases in three shards plus the serial `test_alarm.py`, each exactly once; Todoist Plus (lint, types, 237 unit
cases, build, 43 built-MV3 Chromium cases, the dependency, Bets and Mailbox ones among them); Contracts; and Mail
Hero, Home, FlowDay, links, watch, mailsort, recall, brief, Fleet, the website and Platform. Local gaps as
before: no GPG here, so Mail Hero's crypto round-trip is skipped, and Platform's Linux-only steps (manifest
compiler, AppArmor, image build, k3s) did not run. The interface images were not retaken: the synthetic page
has no dependency, so the board and the weekly review look as they did. Not verified: branch CI, the release
and the owner's review.

## Owner fixes D1-D8, local checks (October 17)

The owner reported eight problems with `todoist-plus-v2026.1016.1224.9770`; the decisions D1-D8 of
2026-10-17 are built on the local branch `claude/plus-owner-fixes` from `e2ff3da1`, in sixteen commits and
four slices that ship as one release: A (`8a8118d8`-`5c5d7d0c`) proto and Todofy, B (`a6e1da14`-`1344e2c8`),
C (`1f62fec1`-`2d5cca15`) and D (`984d8516`-`ca7ac86c`, then these records) the extension. Not pushed, no
branch CI, no release; synthetic data only. Production D1, the Durable Object, real Todoist, FlowDay,
Cloudflare and the owner's Chrome were not touched by this work.

- D1: the mail project's favourite is hidden on every Todoist page while Plus is attached and configured,
  and comes back on teardown without a refresh.
- D2: filing always moves the mail task to the account's Todoist Inbox (the `inbox_project` of one projects
  read); categories are optional; a row's hover shows one button per category and Inbox, one click each.
  `FileMailItemRequest.category_id` empty means the move alone; `UpdateMailSettings` still sends its REQUIRED
  destination, which Todofy ignores; `ReadMailSettings` still answers the Inbox for builds before protocol 6.
- D3: Next steps ends with Add steps, one confirm-first `AppendTaskSteps` per Enter; the weekly review's Plan
  steps opens it.
- D4: Plan's tab, Review's area, the weekly review (open, ticks, kept), Week's commitment and Committed's
  fold are kept in `storage.local` through the background, merged by field.
- D5: Quick/Ops (`@quick&(nodate|3days)`) and Parked (`@parked`, only while the account has a label named
  `parked`) join the replaced filters, behind the consistency gate and a cache fingerprint that forces one
  full Sync. Week shows a quiet Quick line; Review a Parked lane, always shown while the label exists, which
  `SetTaskPlan.parked` writes.
- D6: `ReorderTasks` (`POST /api/plus/v1/tasks:reorder`) keeps each Review lane's order in `plan_settings`
  `board` (no migration) and permutes the moved card's Todoist siblings' `child_order` by one `item_reorder`
  under a receipt (not for Waiting and Parked). Cards are dnd-kit sortables with only the keyboard plugin.
- D7: Next steps follow Todoist's sibling order (`order_key` when every sibling has one, else
  `child_order`) and reorder through the same RPC without a lane.
- D8: Committed folds behind Todoist's section chevron, remembered.
- Planning protocol 6 (slice C); slice D's `reorderTasks` and `parked` join it.

Local checks, all passing:

- Slice A, from the workflow's own steps: Proto by hand (format and lint, api-linter with no problems in 69
  files, breaking against `e2ff3da1`: none, the rule self-test, deterministic generation, the schemas, 495
  TypeScript and 113 Python codec tests); Todofy static (ruff, 2,121 host tests with one existing skip, the
  gateway's lint, types, 136 unit cases and its CPU suite, where `plan:read` with 700 lane order IDs ran 0.84
  ms first and 0.70 ms warm, the owner UI's types, 93 tests and build, both production dry-runs, the gateway at
  84.4 KiB gzip of 86.0 KiB); all 592 runtime cases (590 in four processes, then `test_alarm.py` alone), each
  exactly once; Contracts.
- The extension after each slice: B 252 unit and 45 built-MV3 Chromium cases, C 262 and 47.
- The final tree (`ca7ac86c` with these records): the extension's lint, types, 294 unit cases in 41 files,
  build and 56 built-MV3 Chromium cases (`plus.sh`, the steps of `check-todoist-plus`). Slice D's new cases:
  Parked placement, the label condition, the drops in and out of Parked and the landing check, the seven-lane
  layout at 1854, 1300, 1000 and 700 px with the empty Parked lane in place before a drag; the Quick window and
  its order, the Quick line and a card dragged into a day; reordering inside a lane by pointer (one request
  with the whole lane, the DOM unchanged during the drag, kept after a reload), a drop in the 7 px gap that
  writes nothing, the keyboard down-up-drop, Escape and a cross-lane arrow; Next steps in Todoist's order,
  reordered by pointer, and a step dropped into a day by keyboard; the spoken drag texts in both languages.
  Nothing outside `todoist-plus/` changed after slice A, and the backend jobs ran again on this tree, with
  slice A's results: Proto by hand (api-linter with no problems in 69 files, breaking against `e2ff3da1`:
  none, the rule self-test, deterministic generation of 151 files, the schemas, 495 TypeScript and 113 Python
  codec tests); Todofy static (2,121 host tests with one existing skip, 136 gateway unit cases and its CPU
  suite, the owner UI's 93 tests at 179.1 KiB gzip, both dry-runs, the gateway at 84.4 KiB gzip); all 592
  runtime cases, each exactly once; Contracts (882, 26, 69, 71, 6, 6 and 54 cases). `ci_changes.py` selects
  only the extension's check and publication for slice D's diff; for the branch against `e2ff3da1` it also
  selects Todofy, proto, contracts and every app that uses the IDL (Mail Hero, Home, FlowDay, links, watch,
  mailsort, recall, brief, Fleet, Platform and the website), whose own checks did not run here.

Mutation checks: the Quick twin fails when a fixed-zone due date counts on its UTC day; the gap test fails
when a card is a target by shape instead of under the pointer (the drag preview overlaps the cards around
the gap).

Not verified against real Todoist (owner checks after the release): whether `item_reorder` changes the order
Todoist shows for tasks that have an `order_key`; whether it bumps `updated_at`, and on which tasks (the
reordered ones, or every task of the project), which decides whether Waiting and Parked may mirror their order
too; that `/projects` marks the account's Inbox with `inbox_project`; the native Quick/Ops filter's `3 days`
boundaries and its reading of fixed-timezone due dates. Also not verified: branch CI, the release, the
installed extension, a screen reader's reading of the drag announcements (checked through the DOM only; the
instructions dnd-kit links with `aria-describedby` sit outside Plus's shadow root, as before this change), and
the feel of the drags.

### Review fixes (October 17)

A review of the branch confirmed sixteen findings, fixed in `11ae2b48`-`bb86efae` on the same local branch (not
pushed, no branch CI, no release; synthetic data only):

- Todofy: `UpdateMailSettings` stores the well-formed destination it is sent (still never checked against
  Todoist or used for filing; the replay check stays categories-only), so an extension before planning protocol
  6 that saves its categories dialog, which sends the Inbox `ReadMailSettings` answers, then offers the
  categories on its rows instead of "Set up categories" until it is reloaded.
- Mailbox: the transparent filing buttons no longer size the time's slot, whose solid background covered every
  title's end (about 256px of each row with four categories at 1280px); they are positioned out of it with their
  own background and fade. A category button ellipsizes only its label, so " · P2" always shows. An Inbox filing
  sends an empty categories etag (Todofy ignores it without a category), and a filing's request key carries the
  task's etag and, for a category, the categories' etag.
- Saving a stage in a parked task's details, or marking it in progress, also sends `parked: false`.
- Add steps is open only for the commitment it was opened for, so a selection that changes on its own (a read
  shows the commitment no longer committed) closes it without taking focus; the waiting step card has the step
  card's two lines, so the swap keeps the row's height. The unreachable `runway` jump is gone.
- Review: every outcome card's meta row wraps (at 1854px with seven lanes, 205px each, the counts ran past the
  card's border); Parked shows three cards before "more" (ten pushed the stages below the fold wherever the side
  lanes sit above them); an empty Parked lane alone above the stages is a strip of about 70px instead of 170px.
- Drags: each provider renders its own hidden instructions in the shadow root and every handle names them, with
  a localized role description; Chrome's accessibility tree had given the handles no description, because the
  ID dnd-kit sets points into `document.body`. Both providers are keyed by the language, so the announcements
  follow a language change.
- Tests for D4's remembered Review area and for the 100-ID caps of a lane's order and a Next steps reorder; the
  extension's README, `design.md`, `docs/architecture.md` and Todofy's README describe D1-D8.

Local checks on the final tree, all passing:

- The extension (`plus.sh`, the steps of `check-todoist-plus`): lint, types, 301 unit cases in 41 files, the
  build and 60 built-MV3 Chromium cases. New browser cases: the Mailbox's slot at rest is the time's width plus
  12px with four categories and a long title, and on hover each priority shows whole inside its button; the
  seven-lane board at 1854px keeps every part inside its card in English and in Chinese with two-digit counts;
  the lone empty Parked lane is under 90px at 1150 and 1000px; Chrome's accessibility tree (CDP
  `Accessibility.queryAXTree`) gives a Review handle and a Next steps handle the instructions as description in
  English, then in Chinese after `<html lang>` changes. The Add steps case also compares the waiting card's
  title block with the step card that replaces it.
- Todofy static (ruff, 2,121 host tests with one existing skip, the gateway's lint, types, 136 unit cases and
  CPU suite, the owner UI's 93 tests and build at 179.1 KiB gzip, both production dry-runs, the gateway at
  84.4 KiB gzip of 86.0 KiB); all 592 runtime cases (590 in four processes, then `test_alarm.py`), each exactly
  once; Contracts (882, 26, 69, 71, 6, 6 and 54 cases). Proto did not change. `ci_changes.py` selects Todofy,
  the contracts and the extension for this round's diff.

Mutation checks, each failing its new test: the Mailbox's old slot CSS (the slot measured 399px against the
expected 46px); the old review board CSS (about two dozen parts past their cards at 1854px, and a 170px empty Parked);
the Mailbox request key without the categories etag; Add steps open for any selected commitment; a one-line
waiting card (a 19.6px title block against the step card's 40.4px); `DragDropProvider` without the language
key; the Review handle without its own description (Chrome's tree then has none); and each 100-ID guard
removed.

Not verified: a real screen reader's reading of the new descriptions (Chrome's tree only); the touch layout of
the Mailbox (`hover: none` could not be emulated here; its rules are those of before, with the buttons static
again); and everything listed as unverified above.

### Final local verification (October 17)

The final tree (`0029a2d3` and this record; no code changed in this pass) went through every job that
`ci_changes.py` selects for a push of the branch, each run locally from the workflow's own steps with the local
composite actions expanded. External actions (checkout, setup, caches, artifact upload and download) did not
run. Synthetic data only; nothing pushed, deployed or published.

- Selection (`EVENT_NAME=push`, the branch ref, base the merge base `e2ff3da1`, 91 files): Todofy (static, the
  three runtime shards and Todofy checks), Proto, Contracts, the extension and every app that uses the IDL:
  Mail Hero, Home, FlowDay, links, watch, mailsort, recall, brief, Fleet, Platform and the website. Not
  Newsletter, Shared packages or Infra. On `main` the same diff deploys Todofy and publishes the extension
  only.
- Proto, as the job runs it for the first time on this branch: format and lint, api-linter (no problems in 69
  files), no breaking change against `e2ff3da1` (retired elements, buf FILE, the wire profile and HTTP rules),
  the rule self-test, deterministic generation (151 files from 71 `.proto`), the schemas, 495 TypeScript and 113
  Python codec tests.
- Todofy: static (ruff, 2,121 host tests with one existing skip, the gateway's lint, types, 136 unit cases and
  CPU suite, the owner UI's 93 tests and build at 179.1 KiB gzip, both production dry-runs, the gateway at 84.4
  KiB gzip of 86.0 KiB); all 592 runtime cases (590 in four processes, then `test_alarm.py` alone), each exactly
  once by `pytest_completeness.py` over one local shard; the shard planner splits the 48 files 14, 15 and 18
  (with `test_alarm.py`) over the three CI shards, each file once.
- Contracts: Mail Hero 38, Todofy 882, then 26, 69, 71, 6, 6 and 54 cases.
- The extension (`plus.sh`, the steps of `check-todoist-plus`): lint, types, 301 unit cases in 41 files, the
  build and 60 built-MV3 Chromium cases.
- The IDL's other users, each job passing with its bundle inside its budget: Mail Hero (21 deploy and 40 backup
  tests, 204 Worker cases with workerd bindings, 11 CPU bounds, 81 UI tests, 247.0 KiB gzip); Home (17, 267
  Worker, 97 runtime, 158 UI); FlowDay (11, 38 import tool, 21 Worker, 127 runtime with D1, 119 UI); links (14,
  34, 58 runtime, 29 UI); watch (14, 179, 101 runtime, 22 UI); mailsort (26, 122, 88 runtime, 97 UI, the smoke
  run); recall (18, 158, 107 runtime, 146 UI, the smoke run, 166 extension tests and 16 WebKit cases on the
  Orion build); brief (20, 107, 41 runtime, 47 UI); Fleet (12, 64, 9 runtime, 12 UI); Platform (ruff, format,
  240 tests); the website (298 unit tests, the static export with 22 and 30 Playwright cases for the empty and
  fixture content, 2 deployment cases, both Worker dry-runs).

Not run here, left to branch CI: Platform's pinned Linux `kubectl`, the AppArmor policy compile, the runtime
image build and the isolated k3s server-side apply (no Docker daemon and no AppArmor on macOS; its k3s
acceptance test skipped); Mail Hero's GPG round trip (no GPG; one backup test skipped). The website's export
tests ran on port 4183 instead of 4173, which another local process held; nothing else in the job changed.

Screenshots of each changed view, from the built extension over the browser suite's synthetic fixtures in
Todoist's light Kale theme, kept out of the repository: Review with the Parked lane (three cards and "2
more"), a Committed card dragged over another with the insertion line and, after the drop, the new order with
focus on the moved card; Week with Committed expanded and folded to its heading line (Next steps and the Quick
tasks line move up); Next steps with a saved new step, a waiting step and Add steps still open with the next
title typed, above the Quick tasks line; a Mailbox row on hover with two categories and Inbox at the right edge;
the weekly review still open with its tick after Open, Mail and Back; a native Today page whose favourites keep
only another project (the mail project's, Quick/Ops and Parked hidden; My projects keeps the mail project).

Not verified: branch CI, the release, the installed extension and everything listed as unverified above.
## UI refinement (October 17)

The owner approved the UI audit follow-up on `codex/plus-ui-refinement`, based on `aab36547`.
This change is limited to the extension and its documentation; it needs no backend or protocol change.

- TaskEditor keeps drafts only for fields the owner edits. Untouched fields follow refreshed tasks. A field
  changed elsewhere keeps its draft with an explicit choice, and Save stays disabled until that choice.
  Keeping a draft accepts the current baseline but does not itself save. Later edits to a different field
  start from its newly displayed value. Plan saves only changed fields; lead/deadline keep their existing API.
- Dependency search leaves composing Enter, arrows and Escape to the IME. Targeted regressions failed on
  the original implementation and pass after the correction. No real tasks were used.
- Week uses seven days above 960px of calendar content, three down to 420px and one below that. Reduced
  padding and the unplanned count inside the commitment heading keep all eight commitments visible while
  bringing the calendar into the first desktop screen. Static outcome cards have borders and priority flags;
  the existing drag overlay retains its shadow.
- Mail categories supports backdrop dismissal, returning focus to its entry. Clicking its contents does not
  close it. Deletion dialogs retain their separate restrictions.

Local typecheck, lint, build, **307 units** and **62 built-MV3 browser cases** pass. The browser checks include
the new eight-commitment desktop result, 1024px overflow check, light-theme priority colours and category
backdrop/focus behavior, alongside existing pointer/keyboard scheduling, ordering, timer, mailbox and restore
checks. The few old heading-text/child-order assertions were updated for the count's intentional move into
the header. Independent correctness and simplification reviews found no remaining blocker; the two local
drafts match two existing save operations and were not expanded into a generic draft mechanism.

In owner Chrome, the existing production-component preview used synthetic tasks and no production API:
at 1440×900 it displayed eight commitments, all seven days, the calendar around 593px and the first scheduled
card around 708px. A real pointer drop added an unscheduled synthetic step to Friday. At 1024×800 it kept
three days with no horizontal page overflow. A real outside click dismissed Mail categories. The screenshot
in [the interface guide](../todoist-plus/docs/planning-interface.md#验收与截图) is from this exact preview.
These checks do not claim real-account task writes or production latency. User task data, credentials,
account settings, budgets and installed browser connection state were not changed during verification.

[Full branch CI 39013842528](https://github.com/ziyixi/todofy/actions/runs/39013842528) and
[same-SHA main release 39014147662](https://github.com/ziyixi/todofy/actions/runs/39014147662) pass for
`b79180283db375757f2cc8d29e481e55a6935c40`. Main reused the green branch artifact and only published the Plus
extension; no Worker, other application, image or VPS release ran.

[Version 2026.1017.449.46993](https://github.com/ziyixi/todofy/releases/tag/todoist-plus-v2026.1017.449.46993)
targets that exact SHA. Its actual public ZIP was downloaded and all seven file names and contents matched
the original green CI artifact byte for byte. ZIP SHA-256
`d2166f498d2f4cce196116e51fdb51f9e901dbfbb09fe42e033cb05d55eea6eb` matches GitHub's asset digest.
Those same files were installed into the existing `~/Documents/chrome_extensions/todoist-plus` folder,
replacing `2026.1017.254.57066`; two obsolete generated assets were removed. Manifest permissions match
the previous version, the folder identity is retained and no Chrome-stored connection was read or changed.
Reload in Chrome's extension manager and refresh Todoist are still needed before this build runs in the
owner's existing page. This documentation closure does not rebuild or publish another extension.
