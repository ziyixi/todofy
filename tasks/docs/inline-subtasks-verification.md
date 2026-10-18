# Inline subtasks and operations follow-up

## Behavior

Main task lists show a chevron for parents. Children start collapsed and are read only when expanded,
using the existing parent query with 100 rows per page and an explicit Load more control. Subtasks can
expand recursively; executable Steps keep their kind. Existing edit, completion, selection, context
menus and sibling ordering remain available. Children already listed independently in Today/search
stay in place and are not duplicated under their parent. Completed visibility follows the list setting.

The browser preserves rendered children during a refresh and ignores replies for a closed or replaced
branch. Opening a different view or reloading starts collapsed again. The Worker, schema and proto are
unchanged. There is no new persistent cache, polling or dependency.

Project Edit also waits for catalog metadata: an early click previously opened the Add project form
because the selected project was still undefined. A browser regression reproduces that exact race.

## Local checks

On 2026-10-18, Tasks web lint, typecheck, build and all 55 unit checks passed. All 55 Chromium journeys
against real local D1 passed, including folded first load, nested children and Steps, editing, sibling
dragging, completion/reopening, adding the first child, Today de-duplication, bounded pagination and
selected-child actions. Existing cached-dialog and popup layout regressions also passed.

Real owner Chrome also verified collapsed first load and nested expansion in the ephemeral preview.
Only synthetic tasks appear in this screenshot. Release checks are pending.

![Expanded subtasks and a Step in the synthetic Chrome preview](images/inline-subtasks.png)

The right-click and More menus use the installed Base UI tooltip for each schedule/priority icon,
with the same visible names as their existing accessible labels. The browser check hovers all nine
icons, verifies the displayed explanation and unchanged menu bounds, then performs real date/priority
writes against local D1. No scheduling semantics changed.

![Task shortcut explanation in the synthetic Chrome preview](images/task-menu-tooltip.png)

## Owner-approved archive

The requested obsolete email entry was a project, not a saved filter. The owner explicitly approved
archiving it after reviewing the counts. The standard owner UI saved Archived, then a separate metadata
query confirmed all 2,307 task IDs remain: 192 incomplete and 2,115 complete, all hidden from active
project views. No tasks were deleted and no source Todoist objects were changed. Private project
identity and screenshots remain outside this public repository.

## Cloud recovery

Personal cloud reconcile [39147228294](https://github.com/ziyixi/todofy/actions/runs/39147228294) failed
only its VPS comparison with `RUNTIME_COMPARISON_UNAVAILABLE`; Worker comparisons passed. The host API
was reachable while Pod host-address metadata no longer matched the current host. The owner ran the
existing runbook's k3s restart. All three running Pod UIDs, readiness and restart counts were preserved.
Attempt 2 reran only the failed job and succeeded. Fleet subsequently reported a ready runtime,
healthy Newsletter, active monitored daemons and a clean reconcile plan without a new application rollout.

Mail Hero's separate stale-backup alert came from `native_backup_lease_expired`. A retry through its
existing native R2 snapshot runner created snapshot `65cc4689-64b4-4d0e-9019-dd5ed88813c9`, fully verified
at 2026-10-18 22:33:49.013 UTC: 1,903 files and 66,221,731 bytes, `native_readback_verified`.
The copy and validation finished in about 28 minutes and the existing pause was released. No backup
contents were downloaded or printed. Home's next due status refresh remains to be verified.
This incident does not establish a permanent fix for host address changes or future snapshot timeouts.
