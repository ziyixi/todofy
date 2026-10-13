# Todoist Plus backend

The Chrome extension lives in `todoist-plus/`; it calls the separate `PlusService` in
`proto/todofy/ui/v1/plus_service.proto`. Todofy owns every Todoist write. FlowDay owns
its local queue, estimates, timer and time entries. Neither service imports the other's code.

## Setup

1. Publish FlowDay's `FocusEntrypoint` service entrypoint, then Todofy with its `FLOWDAY_FOCUS` binding.
   `FLOWDAY_PUBLIC_URL` is the configured owner link used for FlowDay-only tasks.
2. Open Todofy's `/plus` page under the existing Access login. Check the exact labels and account
   timezone. Missing or ambiguous labels prevent confirmation; labels are never created automatically.
3. Confirm the mapping once to enable planning writes and Monday rollover. This initially reads all
   active tasks, at most ten 200-task pages, before saving setup. A partial read does not enable it.
4. Issue a named connection token, copy it into the extension settings, and keep the existing Todoist
   credentials on `todofy-core`. Only the token's SHA-256 digest is stored. Repeating token creation
   returns metadata without disclosing the token again; revoke it on this page when no longer needed.

The owner API retains Access, same-origin and CSRF checks. The hooks host requires the separate
`todofy_plus_` token on `/api/plus/v1/*` and `/api/plus/flowday/*`. It does not grant the extension
owner setup, generic service proxying, FlowDay task creation, or arbitrary FlowDay task edits.
The extension background calls these routes using host permission; page CORS is not enabled.

## Planning and completion

`ReadPlan` returns mapping, account-local dates and IDs of exactly matching replaced filter queries.
`ListPlanningTasks` returns bounded active pages with the canonical Todoist task ID, labels, parent,
scheduled date, true deadline, optional estimate and derived planning state. Counts require every page.
Task content is read from Todoist when requested; it is not kept as a second task database.
The extension builds native links as `https://app.todoist.com/app/task/<v2_id>` from that ID;
API v1 no longer returns a task URL. See the official [Task URLs contract](https://developer.todoist.com/api/v1/).

Set-plan and lead changes check the displayed etag and retain unrelated labels and the scheduled date.
The date-driven candidate view uses scheduled date, or deadline when no scheduled date exists.
Lead windows retain the existing filter's exclusive upper boundary; `lead_1m` remains 30 days.
One Todoist duration day is 480 estimated work minutes, matching FlowDay. Unknown estimates are absent.

Append-steps creates at most 20 explicitly entered children. Each write freezes its command bytes
and stable Todoist Sync UUID before sending. A repeated request ID must carry the same input.
Successful receipts are replayed; a lost upstream response resends the same commands.
`item_close` completes a normal task or advances one recurrence. Parents are never auto-completed.

When completion names a Focus date, Todofy confirms the actual Todoist close first, then freezes a
FlowDay timer-settlement command. Repeating a failed settlement retains the close identity and cannot
advance the recurring task again. A stale timer etag is refreshed once with a new settlement UUID.
The extension cannot call settlement itself. Its other FlowDay writes are queue order, estimates
and normal timer actions. Local/pseudo tasks retain their FlowDay identity and owner link.

## Weekly rollover and controls

Rollover is disabled until mapping confirmation. The existing ten-minute cron observes planning marks;
after Monday 00:00 in the confirmed Todoist timezone, it processes up to five remembered old-week tasks
per invocation. Unfinished old commitments become weekly candidates; old Bets are removed without
changing their candidate stage. Unrelated labels, task content, dates and history remain intact.
New-week extension decisions wait for the old batch to finish and replace the remembered membership,
so an old reset cannot clear those decisions. Repeating setup also settles an ended week first.

Native Todoist remains editable. Marks made there are observed by the next page scan; a native decision
made at the week boundary before that scan has no separate week identity. The extension's planning
actions record that identity immediately. There is no title matching or guess about work/personal area.

`MAINTENANCE_MODE` and the existing backup lease hold Plus writes. Reads remain available during backup,
but do not update weekly membership. The backup includes all four Plus tables, including token digests
and command receipts. Backup start and Plus mutations share the coordinator lock.
Every Plus Todoist call shares `FORCE_PAUSE_TODOIST`, auth blocking and the existing request budget.
`PROCESSING_PAUSED` retains its mail-pipeline meaning; it does not disable the confirmed weekly planner.

## Local verification

`tests/unit/test_plus.py` covers classification and filter semantics. Gateway tests cover credential,
CSRF, bounded proxy and frozen settlement behavior. `tests/runtime/test_plus.py` exercises the real
gateway, Python Durable Object and D1 against synthetic Todoist Sync/REST responses, including lost
responses, recurring completion, week rollover and shared pause/auth controls. The gateway CPU suite
includes full 200-task Plus and FlowDay-proxy pages. Production and browser acceptance are recorded
separately in the extension's verification document; a local test result is not production evidence.

Local evidence on 2026-10-13: all 549 real-workerd runtime cases passed, including eight Plus cases.
Gateway type/lint/unit checks and the owner UI's 93 tests passed. The gateway dry-run was 81.9 KiB gzip
(existing budget 86 KiB); Python core was 187.36 KiB gzip and included the generated Plus messages;
owner UI JavaScript was 175.7 KiB gzip (budget 208 KiB).

The calibrated CPU suite measured a 200-task Plus page at 1.13 ms cold / 0.56 ms warm, and a 200-task
FlowDay proxy page with 2,000-character title and description per row at 6.85 ms / 4.70 ms.
The new proxy uses its own 9.5 ms cold / 6 ms warm regression bounds; existing route bounds and the
Workers Free 10 ms limit remain unchanged. These are local reference-machine measurements, not
Cloudflare production timings or a guarantee for arbitrarily large remote descriptions.
