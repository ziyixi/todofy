# Work memory, Watch and Recall

Work memory keeps an assistant's ongoing responsibility resumable across chats and callbacks. Tasks continues to
own formal tasks and planning facts; Watch owns fetches and change evidence; Recall owns browsing records. A Work
record stores the continuation facts and links needed to resume that responsibility.

## When to create a Work

Create a Work for an authorized responsibility that crosses turns, waits for a person or event, continues in the
background or delegates follow-up work. Ordinary questions and actions completed in the current turn do not need
a Work record. An existing Work should be reused when the goal and authorization are the same.

Keep six facts understandable without the original conversation:

| Fact | Field | What to save |
| --- | --- | --- |
| Goal | `goal` | The result the user asked for |
| Authorized scope | `scope` | Allowed actions, relevant limits and decisions that remain with the user |
| Completion condition | `completion_criteria` | Observable evidence required before marking the Work done |
| Continuation summary | `checkpoint` | Confirmed results, decisions and unresolved facts needed to resume |
| Next action | `next_action` | The concrete next step within the current scope |
| Waiting and follow-up | `waiting_for`, `review_at`, schedule links | What is awaited, who or what will resume it, and the follow-up arrangement |

Use four states: `active` while an executor can act, `waiting` while progress depends on an external condition,
`done` after the completion condition is observed, and `cancelled` after the responsibility is stopped. Work state
does not complete or delete a Task, change a Watch, stop a schedule or prove that a Codex chat has finished.

References use `links` entries with `type`, `ref`, an optional `label` and `owned`. Supported types are `task`,
`codex`, `watch`, `recall`, `schedule` and `artifact`. Save real source identities after the corresponding resource
exists. Use `owned` only for a resource dedicated to this one Work; a reference to a shared Watch or schedule
remains shared. An active Work requires `next_action`; a waiting Work requires `waiting_for`. Do not store
credentials or copy entire mail, task or page bodies into the Work summary.

## Resume and act

1. Read `work_context` at the start of a resumed session to find the current Work and continuation facts. Use
   `work_list` to find other relevant records and `work_get` to read the selected Work and its log.
2. When an event arrives, use its IDs to read the Work and then the real source with the relevant get/read tool.
   An old summary or an event payload alone cannot establish current business state.
3. Before an external action, call `work_checkpoint` with the intended next action and the facts needed if the
   response is lost. Keep the write's native request ID, etag or receipt identity available for an exact retry.
4. Perform the authorized action through its source tool. Write the confirmed receipt or observed result back
   with another checkpoint. If the outcome is unknown, preserve that uncertainty and read back or retry the same
   native request. Do not invent a successful outcome or create a fresh request to repeat an uncertain effect.
5. Use `work_report` for a meaningful observation, question, blocker or result from an attached source. A
   checkpoint saves the Dot's own progress silently and does not wake the same Work again. A report can notify
   an active `work.attention` subscription; notification delivery still needs separate acceptance from the work
   itself. Do not report the same observation again while handling its callback.

`work_create` requires a request UUID; `work_checkpoint` requires a request UUID and current Work etag, with
only the intended fields in `changes`. Links are a complete replacement when supplied, so preserve other refs.
An exact retry keeps the same ID, etag and input. A new or changed action uses a new request ID after a current
read. `work_report` uses a stable `report_id` and a real `source` already present in the Work's links; an exact
retry keeps those and all input unchanged. Reports add observations and attention; update the Work's state or
continuation fields separately with a checkpoint. A report does not itself mark the Work done. Only reports
written while the Work is active or waiting request attention; late reports on terminal Works remain in the log.

`work_get` paginates entries and unhandled reports separately. After reading and processing reports, save
`handled_through_report_seq` with a checkpoint, advancing only through the reports actually handled. The returned
`handled_through_candidate` identifies the last report in that page; later reports remain pending. Do not repeat
a report merely to acknowledge it. Context and list results are also bounded; follow returned tokens only as
needed. `work_export` provides saved continuation material for handoff. Exported material is private owner data
and does not enlarge the recipient's authority. Keep one execution owner for each
Work. A callback, scheduled review and Codex chat must check the latest record before acting so they do not repeat
an action already underway or confirmed.

Subscribe through Dots' native event lifecycle. `work.attention` accepts an optional `work_id` UUID; omitting it
selects all open Works. Its payload identifies the Work, report sequence, kind, source and timestamp. Read
`work_get` for the report and the current Work before reading source evidence. Watch candidates enter through
this same report path; do not add a second `watch.changed` subscription. Subscribe only for the already
authorized responsibility and reuse an existing suitable subscription.

## Waiting and schedules

`review_at` records when a Work should next be reviewed. It does not register a timer, create a scheduled task or
wake Dots. If timed follow-up is required and authorized, create or reuse Dots' native schedule first, then save
the returned schedule ID as a reference. A failed creation leaves the Work waiting with no claimed schedule.

An hourly overall review can use one native schedule for outstanding Works. Its instruction should read the
latest context, review only due or actionable records, inspect their real sources, and stay quiet while conditions
are unchanged. Reuse that schedule rather than adding one per Work. This documentation does not create it.
The review must leave a Work with its current executor while that executor is still running.

For local Codex work, use Dots' native route to the existing Codex chat and record its real identity. The Personal
MCP stores the reference and observations; it does not directly wake a local Codex process. Do not report a
delegation as started until the native handoff or message has actually succeeded.

## Work Watches

Use `watch_list` and `watch_get` before creating another Watch. An existing shared Watch can be linked to the Work
without changing its notification policy. For a new dedicated Watch, inspect the current page with
`watch_preview`, create it with `watch_create` linked to the Work, and retain the default `NONE` notification
policy. This avoids adding a separate Watch-generated Tasks item. Successful creation automatically attaches an
owned Watch link; read back the Work to confirm it. To attach a shared Watch, checkpoint its source name in the
Work's links with `owned: false`, preserving other links.

| Operation | Inputs and limits |
| --- | --- |
| `watch_preview` | Required `display_name`, HTTPS `uri` and `intent` (up to 200 characters); optional `source`, `trigger`, `check_interval_minutes`, existing `name` and `refresh` |
| `watch_create` | `work_id`, request UUID and the same settings; creates a dedicated HTTP Watch and its owned Work link |
| `watch_update` | `name`, request UUID, current Watch `etag` and `changes` containing only authorized setting changes; existing notification policy is preserved |
| `watch_control` | `name`, `action` (`pause`, `resume`, `check`) and request UUID; pause/resume also require the current Watch etag |
| `watch_changes` | A specific change `name`, or a `parent` Watch with `page_size` and `page_token`; `watches/-` reads across Watches |

Use selectors or structured source paths only after previewing their extracted evidence. Read the preview's
`fetch.fetch_time`, `cached`, `next_fetch_time`, extracted/normalized lines and truncation indicators before
judging its freshness. These tools retain Watch's fetch spacing and robots rules. `check` requests a check when
allowed and does not prove a fetch succeeded. A confirmed pause updates the owned link's stop observation;
resume clears it. Pause/resume read the current source state after the mutation; a frozen old receipt alone
cannot confirm that the Watch is still stopped. Shared references remain shared. Reuse the same request ID and
input after an uncertain write.

Watch's rules select candidate changes. After a candidate Work report, read the current Work goal, the Watch
health and the bounded before/after evidence from `watch_changes`. Use a silent `work_checkpoint` entry with
`kind: "watch_review"`, its required `summary` and `review: {change_ref, verdict, reason}` to record the Dot's
decision:

- `relevant`: the evidence advances the Work or meets its completion condition. Perform only already authorized
  follow-up; report the result when it merits attention.
- `irrelevant`: the available evidence is sufficient to show this candidate does not affect the Work. Save the
  reason and continue waiting without notifying the user.
- `uncertain`: the evidence is incomplete, truncated, unavailable or does not resolve the goal. Save what is
  missing and keep the Work open; request user input only when that gap blocks the authorized next step.

Use the real change identity as `change_ref` and explain how the evidence relates to the Work goal in `reason`.
Read `before_context` and `after_context` as the evidence frozen with that candidate. `context_available: false`
means no comparison context is available, including for older changes; `context_truncated: true` means it is
incomplete. Each side is bounded to at most 40 lines and 8 KiB. A current preview cannot replace the historical
comparison when deciding what that candidate meant.

The decision belongs to this Work. Do not change Watch's comparison baseline or add a permanent ignored line to
encode an irrelevant candidate. A failed fetch means the current state is unknown. A truncated comparison cannot
prove irrelevance. Read enough bounded evidence to support the decision; do not repeatedly fetch a site to fill
the gap. Check the preview's current state as well: if the user's condition already holds, act or report within
scope immediately instead of waiting for a later edge-triggered change.

## Recall evidence

`recall_activity` reads a bounded activity timeline. Follow returned pagination only as far as the Work requires;
an incomplete page does not describe a complete day. Use `start_time`, `end_time` and optional `device_id` to limit
the read, preserving the same filters on subsequent pages. This is recorded foreground activity, not a live
screen. Use `recall_search` to locate pages and `recall_read` for the existing text and snapshot-metadata read,
including its archive and truncation indicators.

Use `recall_view(page, document?)` when the question needs the captured image; omitting `document` selects the
latest snapshot. Read the actual MCP image content, not a base64 string or text metadata describing a screenshot.
Check capture time and `image_available`; an absent image or a content error leaves the visual evidence
unverified. The tool does not capture a new screen. A screenshot covers the captured viewport, so it cannot
establish facts outside that image.

## Finish or cancel

Before setting `done`, observe the completion condition and confirm that no dedicated follow-up is still needed.
Before setting `cancelled`, pause the real owned Watch, stop its native schedule and read back the result. Apply the
same cleanup when completed work no longer needs those resources. Only stop a resource marked owned and used
solely by this Work. Keep a shared Watch and the overall review schedule running for their remaining users.
Watch deletion permanently removes its snapshots and change evidence. The MCP lifecycle tool exposes pause,
resume and check; ordinary completion uses pause.

If cleanup fails, keep the Work open with the exact blocker and the resource identity needed to finish. A state
write cannot stand in for stopping the resource. Each owned Watch/schedule link needs `stop_state: "stopped"`;
an owned Codex link can be `stopped` or `completed`. Record a real `observed_at` and nonempty `observation` with
that confirmed outcome. Keep the link as evidence rather than removing it to bypass this check. Terminal Work
states also require a `result` describing the confirmed outcome. If the outcome needs a notification, report it
while the Work is still open. Read and handle pending reports, then save the terminal checkpoint; `done` refuses
unhandled reports. Callback `accepted` only confirms receipt by ChatGPT; it cannot be used as evidence that these
actions completed.

## Verification boundary

The tool catalog and behavior are defined by the Worker implementation and its synthetic tests. A local check,
published Worker, callback acknowledgment, visible image and actual Dots continuation are separate observations.
Production Work resumption, native schedule execution, local Codex delegation, Watch relevance judgment and
Recall image viewing require their own live acceptance. Do not describe them as verified from a build alone.
