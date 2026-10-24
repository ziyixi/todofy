# Mailsort design

The owner uses Gmail as four reading queues. This service assigns reading cadence and never decides whether a
financial sender is a scam. It does not create Tasks or send mail.

## 1. Runtime

One TypeScript Worker serves private static UI assets, checks Access/Origin/CSRF and forwards the generated owner
API to one SQLite Durable Object, `MailsortState` / `mailsort-v1`. Its existing Alarm owns history sync, pending
mail, model calls, Gmail writes, examples, replay and daily retention. No added service or scheduler.

`worker/src/{state,pipeline}.ts` own scheduling; `ai.ts`, `judge.ts`, `decide.ts` own model input and the priority
choice; `gmail.ts` owns all Google calls. `priority.ts` defines the fixed policy; `priority-setup.ts` performs the
explicit one-time replacement. The UI never imports Worker code.

## 2. Gmail boundary and privacy

Every Google request passes `gmail.ts`'s closed table, independently mirrored by the test fake. Reads cover the
profile history cursor, bounded history/messages and label metadata. Writes create planned English labels and
apply/undo one message's priority through its recorded intent. Only P1-P4 and INBOX may change on a classified
message. Other labels, read/unread and stars remain unchanged. No send, message-delete, trash, spam mutation,
forwarding, filters or Gmail settings operations are permitted.

The explicit `InitializePriorities` operation may delete only old user-label IDs frozen from existing Mailsort
ownership. It cannot delete arbitrary or system labels. Gmail removes those label associations while retaining
all mail. A repeated DELETE returning 404 is already complete. The operation needs the existing gmail.modify grant,
not a new OAuth scope. Google credentials stay in Worker secrets, written only from the owner's local grant tool.

The model sees masked sender display/domain, recipient code, subject (200 characters), snippet (300), body (2,000), mailing-list
and Gmail category hints, current-priority context and the original receipt/current-local clock. Links become
domains; addresses and long numbers are masked. Page/email text is data, never executable instructions. No AI Gateway.
DMARC/scam/trust-domain scores do not drive this model or route mail into review. Gmail's existing spam processing
remains independent.

| Stored data | Retention |
| --- | --- |
| Decision content (masked subject, sender, summary, sender domain) | 14 days |
| Legacy review content | 14 days after arrival |
| Non-content decisions and write ledger; sender as salted hash | 180 days |
| Replay result metadata | 7 days |
| Daily aggregate counters | 400 days |
| Priority examples, masked summary of up to 200 characters plus embedding |Owner deletion, max 2,000 |
| Fixed labels and their Gmail identities |Until explicit replacement/removal |
| Idempotent owner request receipts | 1 day |
| Latest unread batch: message IDs, state, ledger links and scan progress; no content | Until replaced by the next batch or deletion of app data |

Daily pruning runs even in off mode. Logs and Ops expose only identifiers, counts and error codes, not mail,
addresses, label names or credentials. The website's `/privacy/mailsort` page must match these operations and bounds.

## 3. Labels and operating modes

| ID/name | Policy | keep_in_inbox |
| --- | --- | --- |
| p1 / P1 |Prompt attention or uncertain priority |true |
| p2 / P2 |Important information or required follow-up that can wait two or three days |false |
| p3 / P3 |Substantive optional reading for a weekend session |false |
| p4 / P4 |Routine FYI, receipts or promotions without meaningful follow-up or substantial reading |false |

All four are real, flat Gmail user labels. Important automated notices are graded by their actual timing and
required action. P3 remains optional reading on Fridays and weekends; an optional offer's expiry does not make
P4 urgent. No brand whitelist or subject-keyword rules. These are reading cadences, without later timers,
automatic Inbox resurfacing or priority escalation.

Modes remain off, shadow and live. The deployment ceiling and existing breaker can lower the owner's mode.
Default shadow records only; live applies the fixed policy. The initializer does not change mode or budgets.
Only descriptions of the fixed priorities are model options. Normal label CRUD/trust/consolidation mutations are
rejected after initialization, including requests from an older open UI.

## 4. Classification

Gmail history registers new incoming messages and priority corrections. Message ID is the deduplication key.
Each new reply is judged independently; a thread's old low-priority decision cannot skip a new urgent reply.
The owner initializes priorities before new classification starts; arrivals may still register as pending.
Normal processing retains its Inbox and receipt-time cutoffs; it does not backfill old mail.

The owner's explicit `StartUnreadClassification` request authorizes processing private unread mail across all
receipt dates and folders, including archived mail. It collects the IDs before classification starts, one
read-only page per Alarm, and persists progress for interruption recovery. Spam/Trash and the normal incoming-mail
exclusions remain excluded. A reread skips messages already carrying a current P1-P4 label, no longer unread or
gone. Only pending members of this batch bypass the normal Inbox/time boundary. The existing pending queue and
write ledger do the work; an active batch is reused when start is repeated. This authorizes the deployed app's
normal masked-model processing, not exporting private mail or model requests to chat, logs or test fixtures.

The optional `recheck_fallback=true` selects only current-era fallback P1 decisions without an owner confirmation
or correction. Before processing, the app rereads Gmail and requires UNREAD with exactly the current P1 priority
label; ordinary exclusions still apply. Already-read, relabeled or owner-answered mail is skipped. A new P1 result
updates decision evidence without another Gmail intent or write and counts as skipped. A P2-P4 result uses the
existing ledger and archive behavior. This option shares the ordinary batch's queue, mode gates, budgets and caps.

`recheck_initial100=true` is mutually exclusive with the fallback option. It freezes the earliest 100 unique messages
with a successful current-era automatic P1-P4 ledger, ordered by each message's earliest ledger `create_time` and ID.
Historical success remains eligible after undo; refreshed decision times and later arrivals cannot change cohort
membership. The existing batch table is seeded directly, without a Gmail list operation. Read and archived members
can be rejudged, while owner verdicts or a changed Gmail priority cause a skip. Same-priority results refresh evidence
without a new write. After an actual changed-priority write succeeds, prior applied automatic priority ledgers are
marked superseded in the same transaction; the newest undo restores its original label and Inbox preimage.

Clef receives only current-priority examples/history, receipt time and the judgment's local date/week. It answers
one priority question. The second view reorders the most likely options and runs when the first top probability
is at least 0.4. Agreement and a 0.55 combined probability accept a later priority. The threshold was selected from
real responses to 16 public synthetic cases; that small sample does not measure mailbox accuracy. A valid `none`,
low confidence or disagreement falls back to P1.
It is tagged and kept in Inbox in live mode, with no mandatory review item. Provider/network/malformed-answer
failures retain the existing pending/backoff path and become failures when retries are exhausted; quota exhaustion
defers to the next UTC day. Neither failure path fabricates a P1 result. The unread batch reports terminal failures
separately from applied labels.

`label_id` records the assigned priority; `top_label`, `unsure_reason` and the two probability maps preserve the
original model evidence. Schema 9 repairs overwritten current-era fallback metadata from those saved probabilities
and the original confidence policy. It leaves assigned Gmail labels, owner verdicts and write ledgers unchanged.

A new message can carry an older priority. Its persisted base label set authorizes replacing only those priority
labels on that message. Earlier messages in the conversation and unrelated labels are not modified.

## 5. Corrections and evaluation

The owner can move mail between P1-P4 in Gmail. Those changes teach the existing priority model, without a separate
approval workflow. The legacy `/review` route remains a quiet optional correction page, without phishing or
trusted-domain prompts. No new routine review quota or security queue is introduced.

Settings' effect check reuses the existing replay. Ground truth comes from current-priority owner corrections
or confirmations in Gmail or the old correction API, within the existing 14-day sample window. It rereads bounded
samples with the original decision clock and evidence available then; the answer to that same message cannot
leak into its own context. Replay uses remaining model budget and never modifies Gmail. Empty samples mean no
answered examples, not measured mailbox accuracy.

## 6. Learning boundary

`priority_started_at` separates the new classifier from retired topics. Replacement clears old examples, trusted
domains, pending reviews, feedback, replay and aliases, and invalidates the in-memory example cache. Historical
predictions, probabilities, ledger and aggregate counters remain historical. They are not translated into urgency.
An explicit unread batch may replace the latest per-message decision for a selected old message with a new priority
decision; its older Gmail write ledger is retained.

Sender history, weak acceptance, nearest/unembedded examples, Gmail feedback and replay admit only current P1-P4
records at or after that boundary. Automatic sender history and daily weak acceptance exclude fallback P1;
explicit owner confirmations and corrections can still teach. A later daily pass cannot revive retired topic
examples. A no-backfill receipt cutoff also prevents earlier mail being reclassified after cursor resync. The
owner-requested unread batch is the only exception to that receipt cutoff.

## 7. Writes and one-time setup

Gmail message writes keep the existing intended/applied/undo_intended/undone ledger and stable request identity.
The gate rechecks live mode, current fixed label and existing caps before sending. Original priority labels are
recorded in the existing base_labels, and base_inbox records whether the message was originally in Inbox.
P1 brings an archived batch member into Inbox; ordinary undo restores the replaced priorities and original Inbox
position, including an originally archived message. Manual changes can make an undo ineligible. The setup has no
reverse migration or special historical undo.

`InitializePriorities` uses one owner request with a request UUID and the existing budget. It:

1. Checks concurrency, completes previously requested undos and checks the Gmail write grant and name conflicts.
2. Freezes only existing owned old Gmail IDs (including hidden merge identities, and app-created parents without
   unrelated children), the cutover time and a current history cursor. Supersedes remaining old auto intents.
3. Deletes only those labels in bounded steps; each successful result advances the same saved remaining list.
4. Retires local old identities and learning, creates the four fixed label rows and links their Gmail identities.
5. Reads the actual Gmail label list to verify all four IDs/names before enabling new classification and rearming
   the existing Alarm. New arrivals after the cutover cursor remain eligible.

The small setup record stays in the existing meta table. Another click continues it after budget/dependency
interruption; request replay answers the prior receipt. No mail bodies are fetched or models called by setup.

## 8. Budgets

Keep existing `limits.ts`: 40 external requests per pass, six mails at most, history pages and bounded MIME/body
reads. Clef-flash begins at the existing 70% daily neuron threshold; the daily neuron limit or a provider quota
refusal defers remaining mail to the next UTC day. Write gates/caps and label-share protection remain, with
comparison limited to the current priority era. Before classifying an unread-batch member, a mode pause or reached
write cap leaves it pending without consuming a model judgment; a daily write cap waits until the next UTC day.
The final write gate still applies if conditions change during the request. Batch completion counts applied,
skipped and failed outcomes separately and never counts a shadow suggestion as a successful Gmail classification.
Workers Free and account-wide AI quotas remain shared. No budget or paid-plan change is part of this feature.

Run the CPU regression on the actual model path: fixed-priority examples, sender history and two-view decisions,
with assertions that those paths really ran. A setup-required early return is not a performance measurement.

## 9. UI

Overview is the default route. The three visible tabs are 概览, 分级, 设置. Four fixed rows state the reading cadence
and Inbox/archive behavior; examples load only when expanded. The setup card states exactly which old labels and
learning are removed and that existing mail remains. It makes a bounded owner RPC per click, without polling.
The 分级 page offers 批量分级 with 整理当前未读, 重判保底 P1, 重判原100封 and 刷新进度, showing scanning, pending/deferred,
applied, skipped and failed counts. A completed batch can include skips or failures. The last-seven-day overview
separates direct P1 decisions from fallback P1 assignments; assigned P1 alone is not evidence of urgent mail.
Settings keeps modes, ordinary undo, read-only replay and budget information.
Legacy outcomes are readable as history without presenting old topic names as active priorities.

## 10. Ops

The existing private Ops entrypoint returns service freshness, modes, auth, pending/processing/review counts,
AI usage and safe errors; Home owns display/dismissal. Accepted setup or deployment is not proof that a later real
mail received a priority. Invocation traces stay off; logs retain app counts/codes only.

## 11. Verification

Use only synthetic mail and local fake Google/Workers AI. The fake's independent operation table checks each
request against the recorded setup or ledger scope. Essential cases are P1 kept / P2-P4 archived, uncertainty to P1,
financial notices without scam questions, urgent new replies, original-label preservation/undo, old-learning
exclusion, and label cleanup retaining every message and read/star/Inbox state. Keep Origin/CSRF, scopes, quotas,
mode gates, retries, replay boundaries and CPU checks. Unread-batch cases cover pagination/resume, old and archived
mail, already graded/read exclusions, next-day deferral, write caps and original Inbox restoration on undo. The real
local Wrangler smoke exercises the same generated owner API; no test reaches Google.

Fallback regressions cover original evidence preservation and schema repair, exclusion from automatic learning,
owner-correction protection, changed Gmail state before recheck, a P1 no-op without a new write, and an archive
through the existing ledger when a later priority is accepted. Frozen real Clef probabilities check the calibrated
boundary through `judge()`; offline replay is distinct from fresh provider calls. Actual provider and live recheck
results belong in the dated verification record.

Production evidence records only labels/identities/counts, operating mode and provider versions. Do not read
private mail to demonstrate the model. Dated evidence and the current cutover state are in
[priority rollout](priority-rollout.md). The older [topic-consolidation record](label-consolidation.md) is history.

## 12. Deployment

Only branch CI gate followed by the exact green SHA on main Actions. `Mailsort deploy` uses the existing wrapper;
no plain Wrangler release. Preserve Gmail secrets, Access, mode variables, budgets and other apps. Initialize
through the owner UI only after the new code is deployed, then verify four linked Gmail labels and the unchanged
mode/budgets. Historical data clearing, code deployment and actual natural-mail classification are separate
acceptance facts. See [README](../README.md) for commands and the root rebuild guide for account bootstrap.
