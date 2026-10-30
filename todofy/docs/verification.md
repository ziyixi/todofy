# Todofy verification

Evidence below is dated. Local checks, deployment identity, a real provider call and an actual business effect
are separate observations. Current behavior and commands are in [README](../README.md),
[development notes](dev-notes.md) and [CI/CD](ci-cd.md).

## Initial Cloudflare cutover (2026-09-29/30, historical)

The Python core and TypeScript gateway replaced the old Go service. A consistent legacy snapshot was exported,
rehearsed in local D1 and imported once into production; table verification passed. Synthetic webhook checks,
Mail Hero delivery and the first real-mail processing succeeded. Newsletter's existing client returned successful
summary/recommendation responses. A health-response compatibility fix ended the initial Newsletter crash loop.

The gateway split brought first-day plain-Worker CPU observations below its Free request budget; those samples
were not a week-long quota check. Weekly D1-to-R2 backup produced and verified its first package. Local suites
used synthetic data and exercised D1, DO, alarms, HTTP contracts and state transitions. They did not verify remote
Access, provider limits or the later natural schedules.

The original local runs, rollout identities, measured values and then-pending checks remain in
[the dated source](https://github.com/ziyixi/todofy/blob/288e5ef7c9e3df3761b45b0e436b86503bf38cba/todofy/docs/verification.md).
Its Todoist-era paths, generator commands and September pending list are historical. Tasks now owns task data,
Model Router owns provider calls, and this document does not authorize repeating the old data import.

## Gemini email model order (2026-10-04/05; superseded by Model Router on 2026-10-27)

Release `26c9662c` gave individual email and the email canary Flash-Lite first and the daily report, Top 5 and
Top 10 Flash first. Fake-service checks covered first-call success, ordered fallback, all models failing, network
errors and deadlines; completed and pre-summarized events stayed frozen, and the canary created no task or summary
row. In production, synthetic canary `canary-manual-20261005T004417Z` completed with Flash-Lite, and the October 5
daily summary and Top 10 were computed by Flash with nonempty input. The report ledger does not record what
triggered a computation, so Alarm provenance was not established; the owner stopped that observation on
2026-10-17. Model choice now lives in Todofy's settings through Model Router ([model selection](../README.md#use)).
Evidence: [main release](https://github.com/ziyixi/todofy/actions/runs/37248342156). The run-by-run record is in the
repository history at `4ed50919` (`docs/email-model-verification.md`).

## Business prompt checks (2026-10-28)

Revision `61e4206d` rewrites the email, digest and recommendation instructions with explicit input semantics,
decision rules and synthetic examples. Output contracts stay plain text for email/digests and the existing JSON
array for recommendations. Models, budgets and completed results are unchanged.

Local checks: 1,058 unit tests, 11 fake-service tests, and the affected prompt/parser/schema checks passed. The
[branch CI](https://github.com/ziyixi/todofy/actions/runs/40825960129) passed the full gate, including all three
workerd runtime shards and Contracts.

Seven held-out synthetic inputs were submitted through the owner's Model Router Playground using the revised
instructions and existing content framing. The three email calls used API Sol 6.1 medium; the digest and three
recommendation calls used API Astra medium. No real email was read or recomputed.

| Case | Observed result |
| --- | --- |
| Paid receipt containing instructions to invent a payment | Kept the paid state; no invented payment or heading |
| Partial payment | Preserved the paid amount, remaining amount and exact deadline |
| Subject only | Reported the missing delivery time without inventing one |
| Digest with duplicate reminders and a later resolution | Merged the reminders; kept the resolved payment as resolved |
| Receipts, normal autopay, statement and promotion | Returned `[]` |
| Unpaid balance, separate transaction check and reply request | Returned three distinct actions; payment reason retained unknown autopay |
| Current paid confirmation followed by older failure and an open invitation | Returned only the invitation with its age prefix; no invented overdue claim |

The three email first lines contained 29, 32 and 22 characters. All three recommendation results passed the current
JSON Schema and `parse_recommendations`; the digest passed `fit_summary` and retained the four plain-text categories.
These are bounded format and decision checks, not a measured accuracy improvement on real mail.

The same source SHA passed [main publication](https://github.com/ziyixi/todofy/actions/runs/40826685310) and
[personal-cloud reconciliation](https://github.com/ziyixi/todofy/actions/runs/40827033499), including the deployed
Todofy comparison, physical VPS readiness and resolved infrastructure drift.
