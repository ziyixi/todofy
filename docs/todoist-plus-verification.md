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
the full branch gate is the final source-SHA check.

The first branch CI at `30c25b7` passed the packaged extension and runtime shards but rejected
an 8.16 ms cold proxy sample against its initial 8 ms startup ratchet. The new-path startup bound
is 9.5 ms; warm and existing-path limits remain unchanged. The same run also exposed the old
container-import verifier's assumptions about new defaulted D1 columns and timer command receipts;
the corrected import/verify/reset tools passed all 38 cases under Python 3.12 with mandatory local Wrangler/D1, including rejection of unexpected derived state. The next branch gate must verify this corrected SHA before publication.

The corrected `fb245900` passed the complete branch gate in
[run 38459315470](https://github.com/ziyixi/todofy/actions/runs/38459315470). Before publication,
the upgrade was extended to refresh unchanged cached hierarchy/deadline fields once, using the
existing bounded full-sync flow and preserving manual estimates, queue and timer state. Its
marker survives late old-Worker sync state and clears only after the new pass completes.
The two added real-D1 cases passed with the existing sync cases (26); the other 124 runtime cases
and CPU checks also passed. The extension now requests the existing manual sync for an explicitly
new task, and a throttled response blocks the following write with a visible retry instruction.
Its 20 unit/API/component and three built-browser checks pass. The final branch gate must verify
these last changes at their own source SHA before release.

The final native-startup browser check begins at ordinary `/app/today`: the exact replaced
favorites hide after a successful connection lookup while native content remains visible.
It then opens Plan and verifies native restoration. Mapping or authentication failures restore
legacy controls. No additional endpoint or local cache was introduced for this startup behavior.

## Production acceptance

Pending branch CI, same-SHA deployment, Chrome install, real Todoist layout/keyboard/navigation,
explicit synthetic task writes, FlowDay cross-view state and Chrome PWA verification. Record each
result and actual release identity here after checking it. The first natural weekly rollover is a
separate future observation; synthetic rollover checks do not establish that production event.

The owner authorized Chrome installation and real-page acceptance on October 13. Existing labels
and filters stay in Todoist; confirmation of the mapping enables weekly rollover. Tests must not
change real task priorities or use private task content in public evidence.
