# Email model verification

Recorded 2026-10-04, updated 2026-10-05 (America/Los_Angeles). Application release:
`26c9662c1ace2c578866f1691b3549a0cabb2f93`.
Configuration and rollback instructions are in
[Todofy README](../todofy/README.md#gemini-model-order).

## Deployed configuration

| Use | Model order |
| --- | --- |
| Individual email and email Canary | `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.7-flash` |
| Daily reports, Top 5 and Top 10 | `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.5-flash-lite` |

Read-only Cloudflare settings confirmed both orders and the release SHA on `todofy-core`.
The live Budget page shows both orders. `GeminiBudget.email_models` is additive field 7;
an older response displays `未提供`, and an absent email configuration inherits the existing chain.
The generated desired inventory includes the new static variable.

## Checks and release

[Branch CI 37247921893](https://github.com/ziyixi/todofy/actions/runs/37247921893) passed before
the same SHA reached main. [Main release 37248342156](https://github.com/ziyixi/todofy/actions/runs/37248342156)
successfully deployed Todofy and Home. The
[post-release reconciliation 37248539807](https://github.com/ziyixi/todofy/actions/runs/37248539807)
also succeeded.

Local checks passed: 1,780 host tests, 93 frontend tests, the 15 cloud-config tests,
416 repository guard tests (one skipped), TypeScript, proto lint/typecheck/schema and Ruff.
All 68 selected workerd cases passed across the initial run and the fixed fixture rerun;
the complete runtime suites subsequently passed in branch CI.
Vite compiled and the direct JS budget check passed at 176,584 gzip bytes.
The local build wrapper still mishandles URL-escaped spaces in the checkout path;
the complete unchanged build command passed in CI's path without spaces.

Fake-service checks cover Lite succeeding on the first call, ordered fallback, all models failing,
network errors, timeout/deadline exhaustion, cumulative tokens and existing non-retryable errors.
Daily reports and Top 5/Top 10 retain their default chain even after an email override.
Completed and pre-summarized events remain frozen; pending and explicit retries use the new chain.
Canary creates neither a Todoist task nor a completed-summary row. New and old status responses
are covered. Provider failures were exercised with fake services, without interrupting production.

## Production Canary

Home started synthetic run `canary-manual-20261005T004417Z` at 17:44:17 local on October 4
(`2026-10-05T00:44:17Z`). A bounded, read-only query of that exact synthetic run confirmed
Todofy's event reached `complete` with `summary_model=gemini-3.5-flash-lite`.
Its task ID remained empty and it contributed no row to the report summaries table.

This verifies a real Lite response through the existing synthetic delivery path. The Canary
bypasses source-email forwarding and MIME ingestion; this check does not revalidate Gmail/Exchange
forwarding. The persisted event retry counter is separate from the Gemini client's model-attempt
counter. First-call success and fallback attempt accounting are verified by the fake-service tests.
Home checks the synthetic run's downstream progress on its normal 30-minute cadence.

## Report model verified; automatic trigger provenance pending

After the next configured precomputation time, `2026-10-05T13:30:00Z` (06:30 local),
a bounded read of the October 5 report metadata confirmed:

| Report | Computed at (UTC) | Local time | Status | Actual model | Error code |
| --- | --- | --- | --- | --- | --- |
| Daily summary | `2026-10-05T13:40:19Z` | 06:40:19 | `ok` | `gemini-3.8-flash` | Empty |
| Top 10 recommendation | `2026-10-05T13:40:00Z` | 06:40:00 | `ok` | `gemini-3.8-flash` | Empty |

Both had nonempty input. The actual Worker still reports the application SHA above,
the two configured model orders and `REPORT_PRECOMPUTE_UTC=13:30`.
This proves successful live Flash report calls after the email-model release; these are neither
empty-window results nor fallback-model responses. Top 5's default order remains covered by
the fake-service checks; this read found no October 5 Top 5 row.

This acceptance issued only read-only settings and finite D1 metadata queries. It did not call
the summary/recommendation HTTP endpoints, which can compute missing reports, or trigger recompute.
The current report ledger does not store trigger origin, and normal on-demand requests can replace
the same daily row. These timestamps therefore do not independently prove that an automatic Alarm
initiated computation. Platform invocation evidence for the corresponding time window is still
pending; the acceptance follow-up remains active. Do not regenerate history to fill this evidence gap.
