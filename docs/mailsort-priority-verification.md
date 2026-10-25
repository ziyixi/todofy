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

## Priority evidence and calibration

The follow-up was developed on `codex/mailsort-priority-confidence`; its verified releases are recorded below.
A counts-only audit found 81 assigned P1 decisions, all from the uncertainty fallback. Their original raw model
top choices were P4: 52, P3: 15, P2: 11 and P1: 3. These are model-output aggregates, without owner answers;
they do not measure mailbox accuracy or establish that all 81 messages were urgent.
All 81 were unanswered and there were zero current-era weak-acceptance examples at this audit.

The candidate preserves the original model decision separately from assigned P1, repairs current-era fallback
metadata from saved probability evidence, and excludes unconfirmed fallback assignments from automatic learning.
It clarifies P2-P4 descriptions, splits direct/fallback P1 in the overview, and adds a narrow explicit unread
fallback recheck. Mode, neuron budget and write caps remain unchanged.

Local candidate checks passed: 151 unit tests, 83 workerd tests, 79 UI tests, the local Wrangler smoke (62 closed-table
fake Google calls), 26 deploy tests, proto lint/API lint, breaking checks, schema/type checks and 459 TypeScript /
110 Python proto contract tests. Workerd tests include
actual prior P1 ledgers, successful replacement after a transient failure, rejection of stale undo and restoration
of the latest preimage. The CPU fixture exercises both views through its fake binding; it does not measure classifier
quality. The measured Worker was about 141 KiB gzip. Its code-size check allows 148 KiB; model and spending budgets
are unchanged.

The full branch gate passed on `8bcac93d` ([run 40060474945](https://github.com/ziyixi/todofy/actions/runs/40060474945)).
Two unchanged jobs needed a rerun: a local Miniflare connection failure and a WebKit dependency download timeout.
This gate predates the calibrated threshold below; the final implementation needs its own green SHA.

### Real synthetic responses, 2026-10-24 UTC

The existing Clef request shape was used for 16 public English/Chinese fixtures, with identical message and clock
inputs for the baseline and candidate descriptions. There were 96 provider calls: baseline Clef, candidate Clef
and candidate Clef-flash, each with first and reordered second views. Estimated use was 949 neurons; no private
mail was used. The dedicated Workers AI Read token was revoked after testing; no existing token was changed.

| Descriptions / policy | Clef correct | Clef-flash correct |
| --- | --- | --- |
| Old descriptions, 0.7 | 9/16 | Not tested |
| Candidate descriptions, 0.7 | 13/16 | 11/16 |
| Candidate descriptions, 0.55 | 16/16 | 13/16 |

The 0.55 row replays the actual captured probabilities with the new policy; it is not another provider run.
Both views must agree and the first-view gate remains 0.4. All five expected-P1 cases stay P1 under both models.
Clef's unknown-deadline case remains a conservative P1 at 0.535837; 0.50 would wrongly archive it. Its three P2
cases pass at 0.563074, 0.651181 and 0.583853. Flash retains three P2-to-P1 errors, all conservative. Thresholds
0.54 through 0.56 give the same captured results; no margin rule or extra model question was added.

These are in-sample results with one pair per model/case, including one conservative fallback in Clef's 16/16.
They establish regressions for this sample, not production accuracy. Numeric captures are committed beside the
synthetic fixtures and replayed through the real `judge()` path. Unit checks now pass 153 cases and the targeted
pipeline/CPU workerd checks pass 16 cases. The subsequent release and mailbox batch are recorded below.

### Original 100-message repair entrypoint

The owner requested reanalysis of the previously classified 100 messages. The `recheck_initial100` option
uses the earliest successful automatic P1-P4 ledger identity per message, frozen at start; later arrivals and changed
decision timestamps do not replace members. Read or archived messages are eligible; later owner choices are skipped.
Same-priority results only refresh evidence, while a changed-priority write retains the existing ledger and quota gates.

A read-only production aggregate confirmed this original cohort is 100 messages: 99 from the prior unread batch and
one ordinary arrival, with 81 P1, 19 P4 and zero recorded owner confirmations/corrections. No message content or IDs
were exported. The root stated this original-cohort interpretation before preparing the operation; it is distinct from
selecting the newest 100 messages in the mailbox.

The integrated local checks passed 153 unit, 91 workerd and 82 UI cases, Worker/UI lint and typechecks, UI build,
the full local Wrangler smoke (62 closed-table fake Google requests), proto lint/API lint and breaking checks.
The final simplified version passed its complete branch gate and same-SHA release, recorded below.

### Calibrated core deployed

The calibrated core passed [branch gate 40063013920](https://github.com/ziyixi/todofy/actions/runs/40063013920), then
the same `725db27df907c0d31245990afc420d4b1a831ee1` passed [main release 40063783779](https://github.com/ziyixi/todofy/actions/runs/40063783779).
Only Mailsort and its privacy page deployed. The verified app record is Deployment `7294197010`, Worker version
`27a7ba8f-eee5-4c1c-bd88-78e4faf97dad`, with the original DO namespace unchanged. The refreshed production UI shows
direct P1 0, fallback P1 82 and 4,392/9,500 estimated daily model use. No repair batch had started at this check.

### Simplicity review and final release

The owner rejected handling concurrent manual label edits during model evaluation. The final diff removes the
new post-model Gmail metadata request, its exact-label comparison and three concurrency tests. It also removes
a redundant P1 condition in the write path. The ordinary initial label check and the existing retry/write ledger
remain. A separate review of this follow-up found no further necessary simplification; it introduced no new lock,
rollback system, retry state, service or configurable policy.

After removing that guard, the affected unread, failure and pipeline runtime checks passed all 51 cases. Worker
lint/types and the full UI checks remained green. The complete [branch gate 40064835511](https://github.com/ziyixi/todofy/actions/runs/40064835511)
passed on `eb3e21dc942f4fc78db5a3bf7794fa8c2537e937`, followed by the
[same-SHA main release 40065406437](https://github.com/ziyixi/todofy/actions/runs/40065406437).
Only Mailsort and its required privacy page deployed. Mailsort Deployment `7294420109` verified Worker version
`e3f237e1-ec0d-4394-8a1a-d161c2aeb67b`; the DO namespace remained unchanged.

### Original-100 production batch, 2026-10-24 UTC

The existing authenticated owner UI started the original-100 action once. At the 05:28 UTC acceptance check,
95 messages had been reanalyzed: 45 confirmed Gmail changes and 50 unchanged results, with zero failures.
The 50 unchanged results refreshed decision evidence without another Gmail write. The completed 95 decisions
were P1: 37 (all conservative fallback), P2: 0, P3: 7 and P4: 51. These counts describe model output, not owner-
confirmed classification accuracy. At that checkpoint, the original 100 totaled P1: 40, P2: 0, P3: 7 and P4: 53, including
five members whose old decisions have not yet been reanalyzed.

The remaining five reached the existing daily Gmail-write limit: total daily successful writes were 150/150.
App-estimated model use was about 7,622/9,500 and `quota_exhausted` remained false. The owner mode stayed live
and its breaker remained clear. The five persisted pending entries then had their next attempt scheduled for
`2026-10-25T00:00:00Z` (October 24, 17:00 Los Angeles time). No limit, mode, usage counter or credential was changed
at that checkpoint; the batch was not yet complete.

Only aggregate labels, batch states, allowance counters and retry times were read. No real mail body, subject,
sender or message ID was exported. The UI retained the same batch and counts after a full reload.

### Later cancellation, 2026-10-24 UTC

The owner subsequently asked to leave the original cohort unchanged. The five unstarted rechecks were cancelled
in the authorized audit, closing the batch with 45 actual Gmail changes, 55 skipped and zero pending members.
The scheduled continuation described above was cancelled and must not resume. The later authorization to classify
all currently unread mail has not been executed. The [Claude rollout](mailsort-claude-verification.md) does not
start either reclassification.


### Later interpretation correction

Historical recheck snapshots used “skipped” for both unchanged model judgments and actual exclusions. In the earlier
45-applied/55-skipped snapshot, 50 had been rejudged without a label change and five unstarted entries were later
cancelled. Do not infer that the model omitted all 55. The current Claude API separates unchanged from true skipped;
see [the recheck-counter fix](mailsort-claude-verification.md#recheck-result-counters-and-priority-badge-freshness).
