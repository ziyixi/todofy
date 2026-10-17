# Importing Todoist data

The tools prepare private files and can be tested against local D1. They do not execute a production import or switch any consumer. A successful export is not proof that every archived task or recurring occurrence was available.

## Prepare the tools

Run from the repository root with Node 26:

```sh
npm ci --prefix packages/task-dates
npm ci --prefix tasks/worker
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

`PRIVATE_DIR` is an existing private directory outside this checkout. `HISTORY_START` is an RFC3339 date-time, for example the beginning of the account's history. The export reads full Sync, archived project/section listings, full contents of every active and archived project, completion-date queries in 28-day windows, and the paginated task-completion activity log. No mutation commands are sent.

The [official API reference](https://developer.todoist.com/api/v1/) documents form-encoded Sync and completion-date windows of at most three months. Its completion response uses `items`, while resource lists use `results`. The exporter checks those shapes and cursor progress.

The [official TypeScript SDK](https://github.com/Doist/todoist-api-typescript/blob/246d9898d79383a14fb857c8cac118fa9d1145cd/src/types/projects/requests.ts#L194-L212) defines `/projects/{id}/full` as a response with `project`, `tasks` and `sections`. The exporter validates the project identity and each contained resource's project ID before merging these records. A failed or malformed project read stops export; catalog listings alone cannot set `archived_contents_verified`.

Recurring completions come from `/activities`, separately from task snapshots. [Todoist explains](https://www.todoist.com/zh-TW/help/todoist/todoist-and-ai/connect-todoist-to-an-ai-assistant-xMSzFfHng) that these occurrences remain in the activity log when the task advances to its next date. Pro and Business provide full activity history; Beginner provides seven days. `history_access` records whether the source account confirms full access. `recurring_history_verified` requires completed pagination and either that full access or a requested window within seven days. It does not claim events before `history_since`, unavailable account history or deleted content were reconstructed.

Coverage fields describe the validated reads in this export. They do not replace the source/destination count and identity comparison before cutover. The live account has not been queried by the synthetic tests below.

The final read also needs a controlled window with the owner and project-owned writers paused. Separate API calls do not provide a cross-endpoint snapshot. Keep the original Todoist data until the imported state has been checked.

## Check before generating SQL

```sh
node tasks/tools/prepare-import.ts \
  --input "$PRIVATE_DIR/todoist-snapshot.json"
```

This dry run checks task values using the same validator as the Worker, resolves label identities, validates parent/project/section relationships and checks supported date and filter expressions. It prints resource counts, issue counts and coverage gaps.

Missing parents, unknown labels and invalid fields stop the import. They are not flattened, dropped or converted into new identities. Unsupported recurrence or filter input remains in the private source snapshot for review.

Generate a file for a disposable local preview:

```sh
node tasks/tools/prepare-import.ts \
  --input "$PRIVATE_DIR/todoist-snapshot.json" \
  --output "$PRIVATE_DIR/tasks-preview.sql" \
  --preview-incomplete
```

`--preview-incomplete` permits unresolved coverage for this preview. It does not permit invalid fields or unsupported rules. Without this flag, any coverage gap prevents SQL generation. Coverage fields should be changed only after independent evidence establishes what was retrieved.

The prepared SQL requires an empty target or the same frozen snapshot's unfinished import. It rejects a different snapshot and rejects a target where an owner or application has already written. Repeating the same file preserves IDs and does not duplicate completion occurrences. Do not use it as an ongoing sync mechanism.

## What is preserved

- Task, project, section, label and filter IDs, including the original Inbox project ID.
- Task creation/update timestamps, descriptions, hierarchy, priority, dates, deadlines, duration and label associations.
- Relative order, using provider `order_key` where available and the legacy numeric order otherwise.
- Archived project and section state for resources actually included in the snapshot.
- Each fetched completion's available title, project, creation time, completion time and due date. Activity events retain their source event identity. An activity event replaces an overlapping task snapshot at the same task/time; distinct activity IDs remain separate even when their timestamps match. Activity-only history for an unavailable task does not create a task object; fields unavailable from the source remain absent.
- Recurring lifetime counts, using the provider's `completed_count` as the imported baseline. Imported history is marked separately and does not increment this baseline again. This matters when a historical recurring completion was later undone: the source counter remains authoritative. New completions in Tasks increment it normally. A recurring task missing its source count creates an explicit import coverage gap.

Catalog creation timestamps that the provider does not supply use the snapshot time. The private source file retains the original provider records.

The supported recurrence grammar includes named weekdays, weekdays/workdays, interval days/weeks/months/years, completion-based intervals, common daily/weekly aliases and a restricted RRULE form. `every week` follows the completion date, as documented by [Todoist](https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV). More complex natural-language expressions, end dates and recurrence counts require explicit support before migration acceptance.

## Local evidence

```sh
node --test tasks/tools/test/*.test.mjs
npm run test:runtime --prefix tasks/worker
```

The synthetic D1 roundtrip checks preserved IDs, Unicode and quoting, archived visibility, completion history and lifetime counts, identical replay, and refusal after an owner write. A 120-occurrence shuffled-history case checks the latest 100 rows, the next 20, activity/snapshot deduplication, history for an unavailable task, and a new native completion increasing only the source baseline. Separate tests cover full-project identity mismatches, limited account history, pagination failures, form-encoded Sync, unresolved relationships and unsupported rules. No real account export or production data import has been performed by these tests.

## Keep planning identities during cutover

Todofy's dependencies and weekly marks refer to `plan_tasks.id`. Matching external task IDs alone is insufficient: the existing row must change provider in place so its internal ID stays the same.

Prepare a private metadata JSON file with three arrays:

- `plan_tasks`: `id`, `provider`, `external_id`, `created_at`, `closed_at`, `closed_as`.
- `plan_edges`: `task_id`, `prerequisite_id`, `kind`, `baseline_count`, `created_at`.
- `plan_marks`: `task_id`, `kind`, `period`, `created_at`.

These are the exact selected columns from the existing Todofy database. They contain identifiers and timestamps, with no task body, Bets or notes. The tool does not read production itself.

```sh
node tasks/tools/prepare-planning-cutover.ts \
  --snapshot "$PRIVATE_DIR/todoist-snapshot.json" \
  --metadata "$PRIVATE_DIR/planning-identities.json"
```

After import coverage and the identity check pass, add `--output "$PRIVATE_DIR/planning-cutover.sql"` to prepare one atomic SQL statement. It updates only `provider` from `todoist` to `tasks` on the matched existing rows. Internal IDs, dependency edges, baseline counts, marks, creation times and closed states stay unchanged. Unreferenced closed identities absent from the imported history remain under their original provider.

Duplicate Todoist/native identities, missing open or referenced tasks, changed metadata or changed edges stop the operation. The SQL checks the captured state again when it runs. Repeating the same accepted statement preserves the same identities. The operator must compare returned IDs/counts with the dry-run result before switching consumers. Frozen mail events, summary ledgers and FlowDay history are not rewritten by this tool.
