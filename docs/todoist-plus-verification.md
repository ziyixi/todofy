# Todoist Plus verification

## Local checks, October 13

The isolated worktree implements the approved Plan, task-step and Focus flows. All business test
inputs are synthetic. The installed daily Chrome and production tasks were not used for these checks.

| Component | Evidence |
| --- | --- |
| Extension | 19 unit/component/API cases, three actual built-MV3 Chromium cases, types, lint and production build |
| Todofy | 549 real-workerd runtime cases, 1,653 Python units, 127 gateway cases, 93 owner-UI cases and builds |
| FlowDay | 123 workerd/D1 cases, 21 worker units, 119 UI cases, all 51 desktop browser scenarios, migration preservation and static export |
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
per task. The new proxy's regression bounds are 8/6 ms; Workers Free's 10 ms limit and old-path
bounds remain intact. This does not establish production CPU timings for arbitrary remote descriptions.

The existing runtime/full-unit checks preceded removal of an unused, unpublished URL field. The
cleanup passed eight focused unit and eight real-runtime Plus cases and regenerated proto checks;
the full branch gate is the final source-SHA check.

## Production acceptance

Pending branch CI, same-SHA deployment, Chrome install, real Todoist layout/keyboard/navigation,
explicit synthetic task writes, FlowDay cross-view state and Chrome PWA verification. Record each
result and actual release identity here after checking it. The first natural weekly rollover is a
separate future observation; synthetic rollover checks do not establish that production event.

The owner authorized Chrome installation and real-page acceptance on October 13. Existing labels
and filters stay in Todoist; confirmation of the mapping enables weekly rollover. Tests must not
change real task priorities or use private task content in public evidence.
