# Mailsort P1-P4 verification

Implementation: `a70ff257526e8baa3d47e783da1980fff9d9ce11`. The owner requested four actual Gmail labels;
P1 keeps Inbox, P2-P4 archive, and valid uncertainty becomes P1. The model's phishing/trust gates are removed.
Tasks Mail and its task priorities are separate and unchanged.

## Local checks

Worker lint/types and 124 unit tests passed; 69 real-SQLite/workerd cases passed, including actual maximum-path
CPU coverage with 2,000 priority examples and both views for six messages. UI lint/types, 62 tests and build passed.
The real local Wrangler smoke exercised all four labels, fallback, corrections, replay, undo, budget/quota,
CSRF and auth failure; all 62 synthetic Google requests matched the independent closed-operation table.
The 26 deployment/credential/config cases and 437 CI/config/proto guards passed (one existing skip). Proto lint,
API lint, schema and additive compatibility checks passed. Bundle budgets remain 140 KiB Worker and 67 KiB UI;
local measurements are 137.1 KiB and 56.8 KiB gzip respectively. No model, service, credential or budget was added.

A real Chrome tab exercised the isolated local UI's initializer and reload, confirming exactly four policy rows,
the three-page navigation and truthful setup completion. This used an empty synthetic mailbox and no production
credential. Local QA processes and the temporary tab were stopped after saving the screenshot.

## First implementation release

[Branch gate 40051440933](https://github.com/ziyixi/todofy/actions/runs/40051440933) passed on the exact implementation
SHA. The first attempt of this run failed only while installing WebKit's Ubuntu dependencies under Recall's
five-minute install limit. Rerunning failed jobs succeeded; no Recall code, deadline or test budget changed.
The earlier superseded branch run caught the website privacy test's old October 10 date; its assertion was updated
to October 23 without weakening the Limited Use/navigation checks.

[Same-SHA main release 40052652580](https://github.com/ziyixi/todofy/actions/runs/40052652580) passed, reusing the
complete green branch gate. Only Mailsort and the required website privacy page uploaded. The provider-verified
first Mailsort Worker version is `b01a5f98-0eee-43ca-bfe9-1c121506ca11`; GitHub Deployment `7292659715` reports
`success` at `2026-10-24T02:06:30Z`, after running identity/configuration/persistent-resource checks.
The production owner page independently shows the three tabs and fixed P1-P4 policy, with its preexisting
正式 mode and writable Gmail grant. The public privacy page independently shows the new four-label behavior and
October 23, 2026 date in Chrome; its Limited Use statement is intact.

## Production cutover

The owner explicitly confirmed the cutover and preservation of mail. `InitializePriorities` was executed in the
authenticated production UI on 2026-10-24 UTC. It returned completed; the page showed
“P1、P2、P3、P4 已启用。邮件及原有未读状态保持不变。” Reloading showed exactly four active priority rows, no setup
card, the existing 正式 mode and writable Gmail grant. The action removed only frozen managed labels/learning;
no message deletion operation exists in the Gmail guard. No real message body was read by the agent for acceptance.

The initializer itself deletes only frozen old managed label IDs, verifies the four new actual Gmail IDs/names,
and preserves every message, unread/star state and Inbox position. Old decisions/ledgers remain historical;
learning and future classification start from the recorded cutoff without advancing an existing Gmail cursor.
Synthetic tests do not establish the result of a later real incoming mail.

## Explicit unread batch

After confirming the cutover, the owner requested all currently unread mail be classified within the existing
allowance. The follow-up branch `codex/mailsort-unread-priorities` adds one explicit owner action and counts-only
progress. It includes old and archived unread mail, excludes Spam/Trash and normal incoming-mail exclusions, and
skips messages already graded or read before processing. Only this batch bypasses the ordinary new-mail cutoff.
P1 restores Inbox for originally archived mail; P2-P4 archive. Read/star/unrelated labels and existing budgets stay
unchanged. The existing queue/Alarm handles remaining work; quota exhaustion waits until the next UTC day.

Local Worker lint/types, 149 unit tests and 76 real-SQLite/workerd cases passed, including CPU. Seven new runtime
cases exercise 103 messages across multiple pages and a resumed list failure, old/archived mail, original-position
undo, skips without AI cost, daily write caps, shadow pause, the flash threshold, quota deferral and real write
success/failure counts. The independent Google guard/fake checks every request. Proto lint, API lint, generated
schema and additive compatibility against `88ab95ba` passed. UI lint/types, 73 cases and build passed; JavaScript
is 58.0 KiB gzip under the unchanged 67 KiB cap. The real Wrangler smoke passed with all 62 synthetic Google
requests inside the independent closed table, and all 26 deploy/credential-preservation cases passed. The pause
regression also covers a persisted Gmail 503 intent across Shadow and a reached daily cap before next-day success.
Worker gzip is 139.1 KiB against the unchanged 140 KiB budget. A real Chrome check of the built UI and local Wrangler
API completed a three-message synthetic batch: applied 3, pending/skipped/failed 0. Its temporary server, tab and
state were removed afterward.

[Full branch gate 40055318376](https://github.com/ziyixi/todofy/actions/runs/40055318376) and
[same-SHA main release 40056081312](https://github.com/ziyixi/todofy/actions/runs/40056081312) passed on
`d1295e7d9e52656b3d57560199698af9441a0f6e`. Only Mailsort and the required website privacy page deployed.
GitHub Deployment `7293139149` reports success at `2026-10-24T02:55:28Z` after verifying the running identity and
configuration. The Worker version is `7a0f9fe7-3e2b-45fd-ba81-99a2f9af0ce7`; its existing DO namespace is unchanged.

The authenticated production UI independently displayed the new action, 正式 mode and writable Gmail grant.
The owner's explicitly authorized batch was then started. At the 2026-10-24 03:07 UTC completion check, the UI
reported 99 unread messages and 99 actual Gmail applies, with zero pending, skipped, failed or deferred. Navigating
away and back retained the completed batch and counts. The original daily neuron budget stayed at 9,500; the UI
reported 143 estimated neurons before starting and 4,368 afterward (the latter also includes normal arrivals).
The day's usage remained below the 70% flash switch and below exhaustion. No synthetic or manual extra model calls
were made to consume unused allowance. Remaining allowance stays available to normal mail.
Only counts, operating state and quota metadata were read for acceptance; no real subject, sender or body was
extracted, printed or made into a fixture. No operating mode, write cap, model budget, credential or other app was
changed.
