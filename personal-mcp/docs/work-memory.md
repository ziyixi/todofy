# Work memory, Watch and Recall

Work memory keeps an assistant's ongoing responsibility resumable across chats and callbacks. Tasks owns formal tasks
and planning facts, Watch owns fetches and change evidence, and Recall owns browsing records; a Work record keeps only
the continuation facts and the refs needed to resume.

The Dot-facing rules (when to create a Work, resuming, checkpoints and reports, schedules, Watch relevance reviews,
Recall images, finishing and cleanup) have one source: the [skill](../plugin/skills/personal-cloud/SKILL.md), with each
call's details in the tool descriptions (`worker/src/work-tools.ts`, `worker/src/watch.ts`, `worker/src/recall.ts`).
Change them there.

What the server guarantees:

- Work records, entries, links and reports live in the existing `SubscriptionStore` SQLite DO. There is no scheduler:
  `review_at` is a hint, never a timer.
- `work_create`, `work_checkpoint` and `work_report` are idempotent on their request or report ID; the same ID with
  other input is refused. Checkpoints need the current Work etag; reports do not change it.
- A checkpoint is silent. Only a report on an active or waiting Work requests `work.attention`, whose payload carries
  identities only.
- `done` refuses unhandled reports, and both terminal states need a `result` and every owned Watch, schedule and Codex
  link confirmed stopped (or, for Codex, completed).
- Captured Watch evidence changes and Watch health reach linked open Works as reports from Watch's private feed, read at
  most once a minute while needed. An expired feed cursor (or, after a restore, one Watch refuses) becomes a new
  baseline plus one `blocked` gap report per open Work with a Watch; see [backup and restore](backup.md).

## Verification boundary

The tool catalog and behavior are defined by the Worker implementation and its synthetic tests. A local check,
published Worker, callback acknowledgment, visible image and actual Dots continuation are separate observations.
Production Work resumption, native schedule execution, local Codex delegation, Watch relevance judgment and
Recall image viewing require their own live acceptance. Do not describe them as verified from a build alone.
