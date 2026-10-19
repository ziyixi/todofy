# Tasks row drag and selection, October 19

## Behavior

- Normal task rows have one completion circle, with a check on hover/focus. The extra left-hand batch
  checkbox is gone. Select task in the menu or Ctrl/Cmd/Shift-click enters selection; checkboxes replace
  circles in the same position. Clear returns to normal.
- Drag the title or row surface. The top/bottom insertion lines mean before/after at that row's level;
  the middle highlight means move under that task. Dropping beside a parent promotes its child to the
  same level. The target parent opens after a successful move; returning to a view still starts folded.
- A floating row preview follows the pointer and animates on drop. The existing handle stays available
  for keyboard dragging. Completion, expansion, menus and text inputs keep their ordinary behavior.
- Sidebar project/Inbox moves, additive labels and Today scheduling keep their existing meaning.
  Task IDs, dates, Deadline, kind and descendant identities remain intact. Steps remain absent from normal
  lists, and the parent editor reorders Subtasks and Steps separately using the same drag mechanism.
- Nested rows no longer repeat the already-visible parent title. Long project context stays on one
  clipped line with its full name on hover, keeping the completion control aligned with the title.

The change reuses installed dnd-kit 0.3.2 and the existing Tasks update API. Tasks declares the same pinned
dependencies directly, with Vite deduplication across the linked planning package. There is no new backend
method, database migration, scheduler or persistent cache. Moving the pointer makes no API request; a drop
updates only the relationship/location/order fields and refreshes the existing bounded view. An unexpanded
new parent needs one one-row query to insert the moved task first.

## Verification

Tasks web lint/type/build, all 59 unit checks and the complete 65-case Chromium/local-D1 run passed.
The focused 28-case run passed too. New cases verify whole-row reparenting and promotion,
retained dates/kinds/descendants after reload, selection without a second completion control or horizontal
title movement, ordinary detail/completion clicks, visible drag feedback, cycle rejection, and pointer/
keyboard Escape cancellation without a write. Existing category, child order, pagination, context-menu,
save-in-place and completion checks remain. The complete suite also retains cached-dialog geometry,
planning/Focus completion, Mail, recurrence and narrow-window checks.

The test gesture follows a row's updated bounds after native auto-scroll. A previous single-point gesture
left the pointer at its old screen position after the dialog scrolled; the screenshot and bounding boxes
identified that cause. No product retry or timing delay was added. Ctrl-click tests use ControlOrMeta so
macOS's context-menu gesture is not mistaken for the application's batch-selection action.

The first branch [39184856027](https://github.com/ziyixi/todofy/actions/runs/39184856027) remained blocked
on two gesture checks, so it did not deploy. The pointer helper now waits for the prior drag to release
the rendered row and starts from a stable surface; dialog gestures center that surface before pickup.
The saved hierarchy/order assertions are unchanged. Both affected cases passed five repetitions each.
The same inspection exposed multi-line project context enlarging rows; the one-line context now has a
browser height check. No product retry, fixed sleep or relaxed assertion was added.

Actual owner Chrome, against the disposable loopback/D1 instance, successfully dragged a title surface
under another task, promoted it beside its new parent, and moved it to a sidebar project. The moved child
appeared in its newly expanded parent and in the destination project. These fixtures contain no real
tasks or production credentials. Production task edits are excluded from acceptance.

![Normal task rows, with one completion control and compact nested children](../tasks/docs/images/task-row-whole-drag.png)

## Release

Implementation `30cc7327e6292ea07406b511907db2e05474153b` passed complete
[branch 39185583556](https://github.com/ziyixi/todofy/actions/runs/39185583556) and the
[same-SHA main release 39186010120](https://github.com/ziyixi/todofy/actions/runs/39186010120).
Only Tasks released. The final local lint/type/build, 59 units and all 65 Chromium/D1 journeys passed
again after the context/gesture correction.

Native GitHub Deployment `7163725810` (`deploy:tasks`, success at `2026-10-19T01:36:36Z`) records the
verified release. An independent Cloudflare read confirms Worker version
`71535d95-8f54-4aa2-96eb-ac8282f52aa0`, exact source SHA, unchanged D1 identity, expected planning binding
and declared public variables. Other applications and the original/Claude checkouts were not changed.

The existing owner Chrome tab first retained its old bundle when only the SPA hash changed. An explicit
reload then loaded `index-pgAflU2s.js`, matching the checked build. Its two visible rows had six new drop
zones, zero normal-mode batch checkboxes, zero old native HTML5 handles, one-line project context and
zero alerts. This was a bounded DOM/configuration read: no task titles, descriptions or credentials were
emitted, and no production task was edited, moved or completed. Gesture/persistence acceptance uses the
synthetic cases above. The disposable preview tab and loopback server have been closed.
