# Plan write reliability verification

Verified 2026-10-19 UTC. Implementation: `cb4ef15b481c34c82542833a39a60d8796ed6e9f`.

## Defects and changes

- New-week planning writes first ran the legacy five-item rollover batch. With 32 expired memberships,
  the first Step request returned UNAVAILABLE with 27 remaining. Native rollover now expires a bounded
  page of 100 Core-owned memberships in D1, without Tasks RPCs. Current/new-week choices and all
  non-stage fields remain intact. Task content, dates and completion history are unchanged.
- A confirmed native reorder updated positions but discarded returned etags. A subsequent drag sent
  an old version. The UI now keeps confirmed etags and holds affected native siblings pending until
  their order is confirmed. Legacy Todoist's write behavior is unchanged.
- The old drop animation could leave a transparent overlay intercepting pointerdown, or later hide
  the next drag's preview. The wrapper now ignores pointer events. A supported immediate completion
  callback avoids delayed animation cleanup while retaining dnd-kit's keyboard focus restoration.
  The moving preview remains. This applies to main lists, Plan Review and Week.

The rollover uses four Core D1 statements for an ordinary page. Existing matching reset receipts retain
their old memberships through durable completion before cleanup. It adds no schema, service, dependency,
API or retry mechanism. [Rollover controls](../todofy/docs/planning-api.md#weekly-rollover-and-controls)
remain in force.

## Verification

- 22 real Python/DO/TasksApi/D1 cases pass, including title-only Steps in Inbox/project/section,
  the 32-member first-request regression, stable replay and real D1 transaction failure/retry.
- 235 focused native/legacy rollover, receipt and schema checks pass. They cover bounded progress,
  newer choices, preserved fields and interruption before receipt completion or membership cleanup.
- Tasks passes 59 units and 66 Chromium/D1 journeys; the retired shared-component consumer passes
  308 units and 65 packaged-browser journeys. Shared planning passes 24 units and type checks.
- The original consecutive-detach journey passes five repeats with its gesture helper and saved-state
  assertions unchanged. The native Plan regression confirms a reorder followed by a successful
  first stage write using its new etag, with persistence after reload.
- The browser server now waits for its existing post-migration ready message. Its former CSRF probe
  could answer before local D1 migrations finished. Temporary drag diagnostics and ineffective waits
  were removed.

Complete [branch CI 39218617558](https://github.com/ziyixi/todofy/actions/runs/39218617558) passed on
attempt 2. The only final-source rerun was the unchanged gateway cold-CPU check: its initial sample
was 8.61ms against an 8ms test bound. The retry passed without source or threshold changes. Earlier
candidates exposed the overlay race and the keyboard-focus regression; neither was promoted.

## Production

The same SHA passed [main release 39219943729](https://github.com/ziyixi/todofy/actions/runs/39219943729).
Native Deployments 7168699827 (Tasks) and 7168721418 (Todofy) reached verified success at
08:04:21Z and 08:05:37Z respectively. Independent Cloudflare reads found zero source, resource-binding,
route or declared-public-configuration differences:

| Worker | Version |
| --- | --- |
| tasks | `76ffd9c6-be09-4c32-81ff-6222be9b798c` |
| todofy-core | `f8ff0e02-d575-4c9a-bf0e-101348dcc687` |
| todofy | `963d5289-f7a0-4420-b40b-ae38acacd4c3` |

Limited production metadata before and after release showed planning enabled, week `2026-10-19`,
and zero expired memberships. The old periodic batches had already drained before release; that
observation alone does not prove the new first-request behavior. The real local integration regression
provides that evidence.

Acceptance used synthetic tasks. The owner's real tasks and open Plan draft were not operated on;
the original and Claude checkouts were left untouched. Copy any unsaved Step text before refreshing
Plan to load the new frontend. The owner's particular Step creation was not submitted for acceptance.
