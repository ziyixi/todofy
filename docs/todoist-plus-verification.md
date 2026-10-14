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

Branch CI, same-SHA main deployment, exact ZIP identity, Quarter binding and the authorized tomorrow
installation task are pending publication and will be recorded after verification. PWA and natural Monday
rollover remain separate open observations; synthetic timer checks do not prove a real account session.
