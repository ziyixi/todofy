# Approved Tasks interfaces: visual QA

## Goals

Final result: passed for the approved annual Goal/KR view and its links to Plan, Tasks and Steps.

Source: [approved Goals image](docs/images/goals-approved.png). Rendered implementation:
[desktop](docs/images/goals-qa/desktop.png), at the same 1487×1058 CSS viewport, density 1. The screenshot is a real
local Chromium/workerd/D1 scene with four synthetic Objectives, 12 KRs, one current focus, a weekly Bet and two
related Tasks. Both source and implementation were inspected together in the same paired-image review; body
regions, milestone controls and nested Steps were also checked in the uncropped captures.

The first comparison found a P2 readability mismatch: Goal titles, section labels, Task/Step copy and the period
strip were smaller than the approved design. Goals-only typography now uses a 30 px page title, 27 px KR title,
20 px section titles, 16 px primary body/Tasks and 15 px Steps; supporting text is 12–14 px. Columns changed to
1.3:1 and the focus strip to 72 px. Existing app/sidebar styles were not changed. The final capture was compared
again after these corrections; no actionable P0/P1/P2 visual finding remains.

Fidelity surfaces:

- Fonts: existing app system font retained; Goal-specific size/weight hierarchy corrected and readable.
- Layout: period strip, left result evidence and right weekly execution match the approved grouping. The KR
  selector and explicit result-complete control are intentional production additions for navigating all results
  and confirming outcomes. Existing 245 px sidebar preference is retained.
- Colours: existing warm-white, green actions, pale-green selection and neutral dividers are used.
- Assets: existing Lucide icons and native controls; no rasterized interface or substitute decorative artwork.
- Copy: English controls follow the existing app language; synthetic content remains clearly synthetic. Native
  account-local completion dates read Today rather than the illustration's example date. Long Objective titles
  wrap within the navigation and preserve full accessible text.

The synthetic fixture supplies source/evidence links; the latest capture includes the Source link. Routine
goals omit absent bounds; open exploration omits metric prompts and scores.

Interaction evidence: three native Goals page cases cover saved definitions/focus/evidence and reload, progress
deletion, Task/Step completion without Goal completion, narrow 390 px layout and draft/caret/geometry preservation
during refresh. Three linking cases cover lazy/cached GoalPicker geometry, inheritance, explicit set/clear, Bet
readback and Goal navigation. The complete 141-case browser suite passed, including existing drag, dates, Focus,
request-count and cached popup tests. Root also manually recorded synthetic progress and completed a Step in the
dedicated Chrome preview on port 18808; the Goal's milestone count and completion stayed unchanged. Console checks
and live production proof are recorded in [rollout verification](../docs/tasks-goals-verification.md).

No unresolved P3 change is required for the current scope. All captures use synthetic data; real Notion content
and production task titles are excluded.

final result: passed

## Earlier approved task editor and sidebar

Final result: passed for the approved task editor and sidebar. The final comparison has no open P0, P1 or P2 visual findings.

## Source and evidence

The owner's selected revision is [task-interface-approved.png](docs/images/task-interface-approved.png).
The source and local Chrome implementation at `http://127.0.0.1:8798` use the same 1487×1058 viewport at density 1,
with matching synthetic task content. The dialog and sidebar sheets crop corresponding regions for closer comparison.
The native dialog is 920×840; its illustrated reference is approximately 907×826.

- [Full desktop comparison](docs/images/task-interface-qa/desktop-final-comparison.png)
- [Rendered desktop](docs/images/task-interface-qa/desktop.png)
- [Dialog comparison](docs/images/task-interface-qa/dialog-final-comparison.png)
- [Sidebar comparison](docs/images/task-interface-qa/sidebar-final-comparison.png)
- [360 px execution layout](docs/images/task-interface-qa/narrow-360-fixed.png)

The review also inspected the uncropped final dialog and sidebar captures, `03-desktop-final.png` and
`09-sidebar-final.png`, in the local capture directory `/private/tmp/tasks-interface-qa/`.

## Findings resolved

- Initial P2: planning, child and dependency sections retained the description gutter. Their section edges now use
  the completion-circle gutter, restoring the approved content width.
- Initial P2: excess vertical spacing put the default subtask row partly behind the pinned footer. The final
  desktop capture shows that row above the footer.
- Initial P2: child Add actions inherited muted text. Add step and Add subtask now use the app's green action colour.
- Narrow-view finding: Execution labels overflowed at 360 px. Routine now stacks below Execution at widths up to
  480 px; the final 360 px capture shows all three labels within the segmented control.

## Fidelity review

| Surface | Final comparison |
| --- | --- |
| Fonts | Title, body, field labels and supporting text retain the approved hierarchy. |
| Layout | Sidebar grouping, dialog columns, section rules, Execution/Routine and child rows reproduce the approved structure. |
| Colours | Warm-white properties, pale-green selection, green actions, purple dates and orange priority retain the reference relationships. |
| Icons | Existing line icons use consistent styling and the intended meanings. Minor silhouette differences are optional P3. |
| Copy | Execution, Routine, helper text and actions match the approved wording. Canonical project paths and completion counts retain product semantics. |

## Product boundaries and verification

The native dialog remains centred and dims the sidebar. The sidebar remains resizable: the capture uses 245 px,
while the illustration is approximately 226 px. Favourite order follows the saved `sortOrder`; existing project
data, completion counts and dependency controls below the fold remain intact. Manual statuses were removed.
The existing Focus page, background and timer are outside this implementation scope. Duplicate property icons
from the illustration were not recreated.

Completed Chrome checks cover Quick/Routine save and reopen, restoring Steps, sidebar expansion and its menu,
and no app console errors; an unrelated Zotero extension message was excluded. The later Add-button refocus
issue has been repaired and verified in Chrome, including Escape returning focus to the Add button.
Final code review also caught focus loss after Enter created a child. A browser assertion reproduced the
failure; restoring focus after a successful add fixes continuous keyboard entry for both child kinds.

The 44 affected browser regressions pass, including saved execution flags, stage/deadline semantics,
category dragging, no-op saves, cached reopening and asynchronous/popup geometry. Web lint, typecheck and
72 unit tests pass; shared planning typecheck and 324 unit tests pass. The seven refinement cases were rerun
after the focus fix. The production build adds no dependency
or API request; the main JavaScript is 339.09 kB gzip (339.89 kB before this change).
Full branch CI and production release are recorded separately in HANDOFF.

final result: passed
