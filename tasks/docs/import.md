# Importing Todoist data

The tools prepare private files and can be tested against local D1. They do not execute a production import or switch any consumer. A successful export is not proof that every archived task or recurring occurrence was available.

## Prepare the tools

Run from the repository root with Node 26; the root lock installs the shared packages with the Worker:

```sh
pnpm install --frozen-lockfile
```

Keep the token, snapshot and generated SQL outside the repository. The writers create new files with mode `0600` and refuse to overwrite an existing file. Terminal output contains counts and error codes only.

## Read a snapshot

Supply the earliest date whose completion history must be preserved. The token file contains only the existing Todoist API token; do not put its value in the command or chat.

```sh
node tasks/tools/todoist-export.mjs \
  --token-file "$PRIVATE_DIR/todoist-token" \
  --since "$HISTORY_START" \
  --output "$PRIVATE_DIR/todoist-snapshot.json"
```

`PRIVATE_DIR` is an existing private directory outside this checkout. `HISTORY_START` is an RFC3339 date-time, for example the beginning of the account's history. The export reads full Sync, archived project/section listings, full contents of every active and archived project, completion-date queries in 28-day windows, and the paginated task-completion activity log in seven-day windows. No mutation commands are sent.

The [official API reference](https://developer.todoist.com/api/v1/) documents form-encoded Sync and completion-date windows of at most three months. Completion pages use `items`; project pages use `results`. The observed archived-section response instead uses `sections`, `has_more` and `total`. That reader requires a complete page matching its total; `has_more=true` stops with `TODOIST_ARCHIVED_SECTION_PAGINATION_UNVERIFIED` until its continuation contract has been verified. The other readers check cursor progress.

The [official TypeScript SDK](https://github.com/Doist/todoist-api-typescript/blob/246d9898d79383a14fb857c8cac118fa9d1145cd/src/types/projects/requests.ts#L194-L212) defines `/projects/{id}/full` as a response with `project`, `tasks` and `sections`. The exporter validates the project identity and each contained resource's project ID before merging these records. It also reads `/tasks?section_id=…` for every separately listed archived section, since a full-project response can omit that section. A failed or malformed project or section-task read stops export; catalog listings alone cannot set `archived_contents_verified`.

Recurring completions come from `/activities`, separately from task snapshots. [Todoist explains](https://www.todoist.com/zh-TW/help/todoist/todoist-and-ai/connect-todoist-to-an-ai-assistant-xMSzFfHng) that these occurrences remain in the activity log when the task advances to its next date. Pro and Business provide full activity history; Beginner provides seven days. `history_access` records whether the source account confirms full access. `recurring_history_verified` requires completed pagination and either that full access or a requested window within seven days. It does not claim events before `history_since`, unavailable account history or deleted content were reconstructed.

The live activity endpoint rejected a full account-age date range with HTTP 400 and accepted a seven-day query. Its requests use complete UTC days; the exporter then filters to the exact requested start and export time and deduplicates boundary events by source ID. This keeps the last partial day without claiming events after the snapshot time.

Activity IDs can exceed JavaScript's safe integer range. The Node 26 exporter preserves their original decimal text while parsing the HTTP response, before numeric rounding can merge distinct events.

Coverage fields describe the validated reads in this export. They do not replace the source/destination count and identity comparison before cutover. The live account has not been queried by the synthetic tests below.

The final read also needs a controlled window with the owner and project-owned writers paused. Separate API calls do not provide a cross-endpoint snapshot. Keep the original Todoist data until the imported state has been checked.

## Check before generating SQL

```sh
node tasks/tools/prepare-import.ts \
  --input "$PRIVATE_DIR/todoist-snapshot.json"
```

This dry run checks task values using the same validator as the Worker, resolves label identities, validates parent/project/section relationships and checks supported date and filter expressions. It prints resource counts, issue counts and coverage gaps.

Set `TIME_ZONE` in `tasks/wrangler.toml` to the dry run's `time_zone` before release so date-only tasks and weekly planning keep the source calendar. Native planning does not depend on a confirmed label mapping.

Missing parents, unknown labels on current tasks and invalid fields stop the import. Unsupported recurrence or filter input remains in the private source snapshot for review.

The account's `N days` filters cover today through day `N-1`; overdue tasks require an explicit `overdue` term. Unprefixed `today`, `overdue` and these ranges use the scheduled date, falling back to the deadline when the task has no scheduled date. `no date` checks only the scheduled date. Built-in Today and Upcoming also follow scheduled dates, as [Todoist documents](https://www.todoist.com/help/todoist/get-started/plan-your-day-with-the-today-view-UVUXaiSs); a deadline alone does not place a task in those views.

Historical task snapshots can still name labels that were deleted from Todoist's current catalog. The importer recreates those names as ordinary native labels, with deterministic `imported-label-<SHA256 of name>` IDs and no favorite flag. The original deleted label IDs are unavailable; these are new native identities. Current labels retain their original source IDs, and current tasks cannot use this recovery to bypass an unresolved label. The dry-run count `recovered_historical_labels` reports how many labels were recovered. Repeating the same snapshot produces the same IDs.

Generate a file for a disposable local preview:

```sh
node tasks/tools/prepare-import.ts \
  --input "$PRIVATE_DIR/todoist-snapshot.json" \
  --output "$PRIVATE_DIR/tasks-preview.sql" \
  --preview-incomplete
```

`--preview-incomplete` permits unresolved coverage for this preview. It does not permit invalid fields or unsupported rules. Without this flag, any coverage gap prevents SQL generation. Coverage fields should be changed only after independent evidence establishes what was retrieved.

The prepared SQL requires an empty target or the same frozen snapshot's unfinished import. It rejects a different snapshot and rejects a target where an owner or application has already written. Repeating the same file preserves IDs and does not duplicate completion occurrences. Do not use it as an ongoing sync mechanism.

## Import into a new empty destination

The original October 2026 cutover is complete. Its FlowDay/Plus/Todofy task-source switches are retired; do not repeat
those steps against the live Tasks database. Todoist import is neither ongoing sync nor recovery of subsequent native
writes. Use [backup/restore](backup.md) for the current task state.

For a separately authorized new migration:

1. Pause source editing/project-owned writers and keep the destination empty. Repeat the read-only export and its
   exact coverage window; separate API reads are not an atomic snapshot.
2. Generate final SQL without the preview override. Require zero issues/coverage gaps and check its statement sizes
   against current D1 limits without printing SQL or content.
3. Apply the existing destination migrations and frozen SQL only to that authorized empty database. Capture any
   diagnostics privately because provider errors may contain SQL.
4. Read destination IDs, counts, hierarchy, dates, completion occurrences and frozen import digest back privately and
   compare with the final source snapshot. Local SQLite or one count alone does not prove complete migration.
5. Activate consumers through the normal checked configuration/release flow only after those comparisons succeed.
   Keep the original account intact. After native writes begin, the import guard refuses a repeat.

Operator data stays outside Git. A failed partial import continues only the same frozen file; a different snapshot
must not be applied over it. The full historical execution record remains in Git and [verification](verification.md).

## What is preserved

- Task, project, section, label and filter IDs, including the original Inbox project ID.
- Task creation/update timestamps, descriptions, hierarchy, priority, dates, deadlines, duration and label associations.
- Relative order, using provider `order_key` where available and the legacy numeric order otherwise.
- Archived project and section state for resources actually included in the snapshot.
- Closed-task descriptions and final state, including their source completion timestamp, remain task resources. Completion history uses all activity occurrences for each task ID covered by the activity feed. Only task IDs absent from that feed get snapshot-backed history rows. This avoids counting final task state as an extra occurrence when its timestamp differs from the activity event. Distinct activity IDs remain separate even when their timestamps match. Activity-only history for an unavailable task does not create a task object; unavailable fields remain absent.
- Recurring lifetime counts, using the provider's `completed_count` as the imported baseline. Imported history is marked separately and does not increment this baseline again. This matters when a historical recurring completion was later undone: the source counter remains authoritative. New completions in Tasks increment it normally. A recurring task missing its source count creates an explicit import coverage gap.

Catalog creation timestamps that the provider does not supply use the snapshot time. The private source file retains the original provider records.

The supported recurrence grammar includes named weekdays, weekdays/workdays, interval days/weeks/months/years, completion-based intervals, common daily/weekly aliases and a restricted RRULE form. `every week` follows the completion date, as documented by [Todoist](https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV). More complex natural-language expressions, end dates and recurrence counts require explicit support before migration acceptance.

## Local evidence

```sh
bazel test //tasks/tools:check
```

Synthetic tests cover actual D1 roundtrip, IDs, Unicode/quoting, archived visibility, completion history/counts,
identical replay and refusal after an owner write, pagination, unavailable history, relationships and unsupported
rules. They never export the real account or run a production import.

Old planning-provider and label conversion tools were one-time migrations and have been removed. Their imported
identities remain stored; current planning is native task data. Historical copy boundaries are documented in
[backup](backup.md#one-time-planning-import).
