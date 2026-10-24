# P1–P4 reading priorities

Owner approved replacing the old topic labels and removing Mailsort's own phishing/trust review on 2026-10-23.
P1 is a real label and stays in Inbox; P2-P4 are real labels and archive. Valid uncertainty goes to P1.

## Cutover

1. Release the exact green branch SHA through main Actions, preserving Gmail secrets/mode/budgets.
2. Open 分级 and choose 启用 P1–P4 分级. The explanation identifies old managed Gmail labels and old learning as the
   removal scope; existing mail, read/unread, star and Inbox positions remain. Review that scope before acting.
3. If a bounded step is incomplete, use 继续设置. A failed call preserves progress; an uncertain response can retry
   the same request identity. Do not start a second migration or manually reclassify history.
4. Verify P1-P4 all linked by actual Gmail IDs with the fixed policies, then verify the preserved owner mode/budgets.
5. Natural new mail uses the new scheme. Old archived mail remains searchable in All Mail without topic labels;
   it is not automatically placed in new priorities or sent back to Inbox.

The API is `InitializePriorities` (`POST /api/v2/labels:initializePriorities`) on the existing owner API. It needs
only the existing Gmail write grant. It does not delete messages, read their bodies or call a model.

## Local verification (2026-10-24 UTC)

- Worker lint/types and 124 unit tests passed.
- The complete real-SQLite/workerd suite passed 69 cases, including the existing CPU budget. Its CPU fixture
  explicitly exercises 2,000 current-priority examples and both model views for six messages.
- UI lint/types, 62 tests and build passed. JavaScript is 56.8 KiB gzip under the unchanged 67 KiB budget.
- The local production-config Worker bundle is 137.1 KiB gzip under its unchanged 140 KiB budget.
- 26 deployment/config/credential-preservation tests passed. Proto lint/API lint, additive compatibility and
  generated-schema checks passed; 437 CI/config/proto guards passed with one existing skip.
- Real local Wrangler smoke passed all priority, fallback, correction/replay, undo, flash, quota, CSRF and auth
  scenarios. All 62 synthetic Google requests matched the independent operation table. It made no external request.
- Setup tests verify unchanged mail bodies/read/star/Inbox/other labels, historical decision preservation,
  interruption continuation, external-name refusal and a recheck before freezing IDs. A recorded arrival during
  setup proves the established Gmail history cursor is retained and the new message is later classified.
- Known daily model-quota refusal now suppresses further classification/embedding calls that UTC day; a
  reproduced workerd and smoke regression verifies idle/new-arrival suppression and next-day recovery.
- Reloading the UI after Gmail identities link but before setup verification retains the setup action through
  the real `ServiceStatus.priorities_initialized` field; linked Gmail IDs alone do not prove setup complete.

## Current evidence

Implementation is not yet released; production cutover is pending. Add actual CI/provider identities and the
metadata-only production read-back after release. Do not interpret the implementation description as acceptance.

Local verification uses only synthetic Gmail and local SQLite/Workers AI fakes. The focused setup tests verify
managed/hidden old-label removal, unchanged mail bodies and read/star/Inbox/other-label state, history preservation,
interruption continuation and external-name rejection. The local evidence above is separate from production acceptance.
