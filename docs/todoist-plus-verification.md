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
