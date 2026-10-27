# Goals

Goals lives in Tasks. Annual Objectives contain Key Results; a result can be an outcome, a routine or an open
exploration. The current focus chooses a month range and one short intention for a KR. Weekly Bets and Tasks
can refer to it without copying a new monthly or weekly OKR tree.

## Use

Open Goals from Planning. Choose a year, an Objective and a KR. Its definition shows supplied Floor/Ceiling text
and notes; exploration omits metric prompts. Outcome milestones and the result's complete flag are confirmed
explicitly. Record progress creates a dated note with an optional evidence link. Notes can be edited or removed.
No overall life score or inferred completion percentage is computed.

Adjust focus changes that result's current `focus_start_month`, `focus_end_month` and `focus_text`. Clear removes
that current planning intention while keeping the KR, milestones and dated progress. This is not a separate
period hierarchy or automatic rollover process.

In Plan, the link beside a Work/Personal Bet selects its KR. Text editing and Keep preserve the association;
explicitly choosing No goal clears it. The Task editor has the same optional picker. Tasks and Subtasks choose
their own association; a Step inherits its direct parent's KR and shows a link to it. Creating a task from Goals
prefills the KR without selecting a date, planning stage or commitment for the owner.

The Goals detail lists directly associated Tasks/Subtasks and loads their Steps on expansion. Completion uses
Tasks' existing operation and Focus settlement. It never confirms a KR or adds a Goal progress note. Arrange in
Plan opens the existing planning view. Ordinary tasks may stay unlinked.

## Data and API

Migration `0009_goals.sql` adds `objectives`, `key_results`, `goal_progress`, plus the optional reference on Tasks
and weekly Bets. Definitions and progress are private application data, not deployment configuration.

The generated owner API exposes:

- `GetGoalCatalog`: current account year by default, or an explicit year; at most 20 Objectives and 100 concise KR
  summaries. It returns no progress history, long KR notes or milestone text.
- `GetKeyResult`, `Create/UpdateObjective`, `Create/UpdateKeyResult`: explicit field masks, existing etags and
  request receipts. Archive preserves definitions and links. Milestones are a bounded list, at most 20 per KR.
- `List/Create/Update/DeleteGoalProgress`: indexed, newest-first pages, at most 50 notes per response. Deletion is
  soft; no new retention scheduler is introduced.
- `ListTasks.key_result_id`: a bounded page of directly associated Task/Subtask owners. Their Steps remain children.
  Task reads include `effective_key_result_id` and `key_result_title` for stable inherited labels.

The owner host keeps its existing Access, Origin and CSRF checks. The existing TasksApi binding retains generic
read/read-write access; no additional credential or MCP tool catalog is required for the UI.

## Performance

Goals is a separate lazy UI chunk. Its small annual catalog is cached only in memory and invalidated on Goal edits
or explicit refresh. The picker loads it on opening; a normal task list or Plan/Focus visit does not fetch it.
Existing task/Step labels use short joined references. Selected Goal notes, related Tasks and expanded Steps are
read only when needed, and manual Refresh updates them together. A pending read cannot overwrite a confirmed Goal
write. Drafts and popup geometry stay in place while asynchronous or cached data arrives.

The existing unlinked list budgets remain 102 rows for the seeded first 50-row page, 103 for the later page and
four for the exact lookup. The seeded GetPlan remains three statements/nine rows. The synthetic worst-case catalog,
KR, progress page and linked-task CPU checks remain under Workers Free's request budget. Actual measurements and
release proof belong in [verification](../../docs/tasks-goals-verification.md).

The Goal CPU test uses the existing profiler with five independent cold workerd isolates. It compares the median
first authenticated catalog request with the unchanged 10 ms budget; each sample includes Access key import and
catalog encoding, with no warm-up request or retry. Warm endpoint bounds and worst-case fixtures are unchanged.
These calibrated local profiles detect regressions; they do not guarantee production latency or CPU use.

## One-time Notion import

The owner-authorized Notion page is read once and converted into private JSON outside the repository. The Worker
does not receive a Notion token or fetch Notion. Preserve the original descriptions, Floor/Ceiling text and rules,
with a source URL. An unscored exploration remains unscored. Do not invent progress, milestones, current focus,
task associations or completions from the source's plans.

The private input is an object with `source_url`, `year`, `imported_at` and `objectives`. Each Objective has a stable
source `key`, `title`, optional `description` and `key_results`; each KR has a stable source `key`, `title`, `kind`
(`outcome`, `routine`, `exploration`), `floor_text`, `target_text` and `notes`.

First inspect the destination year with GetGoalCatalog. Use an empty year for the initial import; a repeat must
contain the same source identities. For any additive import, check the projected distinct annual totals against
20 Objectives/100 KRs before applying. The generator bounds its input, not arbitrary pre-existing annual data.
Record a Time Travel bookmark or backup before the write. From the repository root:

```sh
node tasks/tools/prepare-goals-import.ts --input /private/path/okr.json
node tasks/tools/prepare-goals-import.ts --input /private/path/okr.json --output /private/path/goals.sql
cd tasks/worker
npx --no-install wrangler d1 execute DB --remote --config ../wrangler.toml --file /private/path/goals.sql
```

The first command is a count-only dry run. The second writes owner-only SQL outside Git, using existing private
operator conventions. Stable IDs come from source/year/source-key, and INSERT conflict handling leaves existing
owner-edited definitions intact. Only Objective/KR definitions are inserted; Tasks, Bets and progress are untouched.
After applying, read catalog and full KR details back through the API and compare counts/content privately, then
delete the plaintext input and SQL. Do not run ad-hoc production SQL or commit source content.

## Backup and testing

The existing weekly backup includes all three tables and reference columns. Restore orders Objective before KR
before progress. Pre-Goals backups restore them empty and use default empty Task/Bet references.

Tests use synthetic definitions/mail/tasks and local D1. They cover result CRUD, masks/replay, Step inheritance,
link preservation, Bet updates, completion separation, archived links, copied-task parent validation, import
idempotence, backup/restore, query/CPU budgets, real browser saves, refresh and dialog geometry. No real OKR is a
fixture. The approved source and rendered comparison are in [design QA](../design-qa.md#goals).
