# Task dates

The Tasks Worker and its import tool use this package to parse scheduled dates and advance supported
recurrence rules. It wraps the pinned `chrono-node` and `rrule` packages with the app's calendar-date and
timezone semantics. It owns no storage, network calls or scheduler.

`previewDate` produces an explicit date, optional instant/timezone and recurrence; `nextOccurrence` advances
that schedule after completion. Unsupported rules reject instead of silently changing a task's meaning.
The imported rules include fixed annual dates such as `every 1st Jan` and named biweekly dates such as
`every 2 weeks Tue`. Per the owner's choice, `every 30th` uses February's last day (28 or 29), then returns
to the 30th in March; completing it late skips past occurrences and keeps the fixed monthly schedule.
Run `npm ci`, `npm run typecheck` and `npm test` in this directory.
