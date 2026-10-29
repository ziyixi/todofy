# Mailsort design

The owner's Gmail has four reading queues. The selected model judges the latest reasonable reading time from message content;
Gmail remains the mailbox. The app never sends mail, marks it read, deletes it or creates tasks.

## 1. Runtime

One TypeScript Worker serves private, framework-free UI assets, verifies Access/Origin/CSRF and forwards the generated owner
API to SQLite DO `MailsortState`, stable object `mailsort-v1`. Its Alarm handles Gmail history, pending messages,
model requests, the existing write ledger, daily retention and the daily backup of every table into the private
bucket `mailsort-backups`, which a restore loads into an empty object ([backup and restore](backup.md)). Model Router selects and executes the configured
native model; its VPS Codex executor has no Gmail credentials, saved jobs or autonomous scheduler.

`state.ts` owns API dispatch and Alarm lifecycle. `pipeline.ts` owns a bounded pass. `gmail.ts` owns Google access;
`classification-model.ts` calls Model Router through the shared `modelrouter.inference.v1` client. Provider
protocols and credentials stay in Router and its executor. Defaults are bundled from `prompts/priority-classification.txt` and
`prompts/personal-rules.txt`. A saved override lives in existing DO metadata, not another database. The UI imports
only generated wire types, never Worker implementation.

For `gpt-6.1-sol`, Router uses the existing [gateway](../../codex-gateway/README.md), pinned to the official
`openai-codex==0.163.0` SDK and matching CLI. Mailsort supplies its classification effort and uses a standalone
request with no web context. The executor uses the subscription login, temporary workspace and ephemeral thread.
It stores no inference job or mail-content log. Model catalog availability and successful inference remain separate checks.

## 2. Gmail boundary and privacy

All Google calls pass the closed operation table in `gmail.ts`, mirrored independently by the fake. Message writes
only add/remove this app's owned P1-P4 labels and INBOX through a recorded intent. Read state, stars and unrelated
labels are preserved. Send, message-delete, trash, spam mutation, filters, forwarding and settings are refused.
The historical one-time initializer may delete only old user-label IDs already frozen as app-owned.

The model receives one array of message IDs, masked sender/subject/body, receipt time, evaluation time and timezone.
Subject is capped at 200 characters and body at 12,000; body truncation is explicit. Addresses and long numbers are
masked and links reduced to domains. Attachments are not sent. Model input is untrusted data with no tool access.
Router forwards the masked input to the selected provider, using its VPS executor for Codex. The application logs
no request or response content. The Router and gateway receive no Gmail authorization and cannot read or modify the mailbox.

| Stored data | Retention |
| --- | --- |
| Decision content: masked subject, sender, summary and sender domain | 14 days |
| Legacy review content | 14 days after arrival |
| Non-content decisions and write ledger; sender as salted hash | 180 days |
| Historical replay metadata | 7 days |
| Daily aggregate counters, returned Claude usage and historical Codex usage rows | 400 days |
| Historical masked examples and embeddings | Owner deletion, maximum 2,000; a withdrawn verdict or a "none" choice deletes its mail's example |
| Fixed labels and Gmail identities | Until explicit app-data removal |
| Saved base prompt and personal rules | Until replaced or app-data removal |
| Owner request receipts | 1 day |
| Latest unread batch IDs, state and scan progress, without content | Until next batch or app-data removal |
| Daily backups of every table above (private R2 `mailsort-backups`) | The newest 30 complete; a row deleted or cleared in the store stays in older backups until they rotate out |

Off mode still prunes. Logs and Ops contain counts, timestamps and safe codes, never subjects, addresses, labels,
body or credentials. The website `/privacy/mailsort` must match these operations and bounds.

## 3. Reading queues and mode

| ID/name | Policy | Inbox |
| --- | --- | --- |
| p1 / P1 | Prompt attention, including the owner's Daily Briefing | Keep |
| p2 / P2 | Important information or follow-up within two or three days | Archive |
| p3 / P3 | Personal periodic summaries or worthwhile weekend reading | Archive |
| p4 / P4 | Notifications and promotions kept for reference | Archive |

Personal rules take precedence over the base guidance. Initial preferences: ordinary USPS Informed Delivery P2,
same-day action P1; Daily Briefing P1; actual shopping receipts/order confirmations (any shopping platform) P2.
Brand promotions do not become purchase receipts. These rules are editable text, with no sender-specific code
branches, scam score, probability threshold or forced category balance. A provider error cannot become a priority.

The base has three input/JSON-response pairs covering seven synthetic messages and all four queues. They show
timely reading, transactional versus promotional mail, and periodic reports versus ordinary technical notices.
These demonstrate the default personal rules; changed or removed preferences follow the current rules/general
guide, so an old example does not silently restore a deleted preference. Examples stay in the stable prefix.

`ClassificationPrompt` is one owner API singleton. Get returns the bundled defaults without creating a row;
Update saves both texts in `meta.classification_prompt` using the existing field-mask, etag and request-ID receipts.
The base must be nonblank; rules can be empty, and both together are bounded to 12 KiB UTF-8. A model call reads
one snapshot. Saving affects the next call, preserves in-flight/historical decisions and survives code deployment.
There is no prompt history, reset service or automatic reclassification.

Off stops Gmail/model work; shadow records model decisions without Gmail changes; live applies them. The existing
deployment ceiling can lower the owner mode. Setup or deployment does not raise it or replay old mail. The former
breaker is removed: a stored breaker is ignored, and `Settings.breaker_tripped` and Ops `modes.breaker` stay false.

`Settings.classification_model` and `classification_effort` persist the chosen Model Router route and its supported
effort in the existing meta row. GetSettings returns the Router's current text catalog in output-only `available_models`;
the catalog is never stored in settings or operation receipts. A model save requires a configured text route and a
supported effort, and derives `classification_provider` from the catalog. Codex, OpenAI API, Claude and Gemini have
separate provider identities in status and decision/flow history. Older provider-only settings retain Claude
(`claude-opus-5-5`, medium) or Codex (`gpt-6.1-sol`, medium); no saved choice defaults to Codex. Every route uses the same
saved prompt snapshot. The existing mask, etag and request-ID handling protects a switch; it preserves mode,
write limits, prompt and Claude accounting history. The existing Alarm can resume pending work with the
chosen provider. A switch does not start an unread batch, rewrite classified history or enable automatic fallback.

## 4. Automatic batch interval

The existing Alarm normally maintains Gmail every five minutes. `Settings.classification_interval_minutes` persists
one of 5, 15, 30 or 60 minutes, with 15 as the default for both providers. A persisted `next_model_at` gates new model
work. It drains pending work in batches of up to ten, one request per pass; an empty queue then begins the selected
interval. The next interval uses the latest saved choice, including a save while a model request is in flight.

A future ordinary wait adjusts by the difference between the old and new intervals. Due backlog, pending retries,
write-cap waits and selected-provider quota holds keep their schedules and `not_before` values. The first Alarm or
settings save adopts a missing legacy interval once, converting an ordinary 60-minute wait to 15 minutes and
persisting the field. Later reads and Alarms do not repeatedly move it. No new scheduler or table is introduced.
The pass stays within 40 external requests and existing run/day Gmail write caps. Message eligibility and existing
P1-P4 labels are checked before a reached write cap can defer it, so skip-only work can finish without a model or
Gmail write. Eligible mail waits through the normal queue; a reached cap only waits.

History registers messages independently by Gmail message ID. Normal processing retains its Inbox and receipt
scope: Inbox mail received within 48 hours of first enqueue, with a known receipt date and no P1-P4 label.
Read and unread mail are both eligible. Valid prior decisions remain frozen. Each recent new reply can be judged independently of other
messages in its thread. The explicit unread action retains its separate unread requirement and includes older/archived mail, retaining its existing scan and
progress table. The one-time recheck options (fallback P1, the first 100) finished and are retired: the deprecated
request fields answer RELOAD_REQUIRED, and a stored recheck batch keeps reporting its unchanged results.

Model calls use the shared `MODEL_ROUTER` binding (`Inference`, `props.app=mailsort`). Mailsort sends the prompt,
masked mail snapshot, selected model/effort and output schema through the common typed API. Router owns the native
provider payloads and the Access-authenticated VPS executor connection. Results must cover every input ID exactly
once, with P1-P4 and a short reason. Existing caller deadlines remain bounded. There is no automatic provider/model
fallback, second vote, embeddings or automatic learning.

Failures follow the shared Model Router error contract (`classification-model.ts`, `limits.ts`), by reason and,
for a reason this build does not know, by google.rpc.Code:

| Kind | Reasons (code) | Handling |
| --- | --- | --- |
| Configuration | `MODEL_AUTH` (16), `MODEL_NOT_CONFIGURED` (9), `MODEL_NOT_ALLOWED` (7), `MODEL_SPEND_LIMIT` | No attempts; the next model pass waits an hour, and after an auth or configuration failure any settings save retries at once. Claude's spend limit waits for the next UTC month. |
| Content | `MODEL_INVALID_REQUEST` (3), `MODEL_INVALID_ANSWER`, `MODEL_REFUSED`, `MODEL_OUTPUT_LIMIT`, `MODEL_UNSUPPORTED_TOOL` | Per-mail attempts, at most three, with the per-mail backoff. |
| Timeout | `MODEL_TIMEOUT` (4) | Per-mail attempts, at most seven (about five hours). |
| Infrastructure | `MODEL_QUOTA`, `MODEL_RATE_LIMIT`, `MODEL_UNAVAILABLE`, `MODEL_BUSY`, `MODEL_MAINTENANCE`, `MODEL_STORAGE_UNAVAILABLE`, `MODEL_INTERNAL`, any other code, a transport failure | No attempts; the whole pass is deferred 5 minutes, doubling per consecutive deferred pass up to an hour, or longer for the Router's Retry-After; a quota at least an hour. Success resets the backoff. |

A Router refusal over HTTP (its own auth or maintenance) is read by the same table; an unreadable answer or a network
failure is infrastructure. A mail with attempts is retried alone, so one mail the model cannot answer never fails
the mail beside it. Invalid results are not partially applied. Exhausted retries become visible failures without new
Gmail labels. Ops keeps the selected provider's configuration, Codex capacity and availability signals apart. Historical probabilities, examples and ledger entries
keep their original meanings; none are rewritten as judgments from the selected provider.

Usage and price are optional inference metadata, not classification validity. A successful, valid result can be
applied even when its usage or price is unavailable; it must not become `bad_answer` and trigger another paid call.
Unknown accounting stays absent, not a zero-cost row. Claude's existing known-spend gate runs before the call;
available known costs are still recorded even if the returned classification itself is invalid.

## 5. Cost and credentials

Mailsort keeps its existing $20/calendar-month local Claude budget. All Claude callers use Router's shared key in
the original Brief workspace, whose aggregate provider cap is $80/month. Provider billing and the application's
local ledger remain separate; the provider console is the authority for workspace spend.

The app stores Router-returned Claude usage and cost estimates in the existing SQLite store, by UTC day, and sums
at most one month's rows. Pricing and native token normalization belong to Router. Historical costs stay frozen;
unavailable usage or cost stays unknown. Even an invalid result counts when returned usage reports consumption.

Stable instruction blocks remain base first, then nonempty personal rules; message-specific email/time data follows
them. Mailsort never sends a cache hint: a five-minute cache write costs about a quarter more than the prefix, and
batches at the configured interval rarely reuse it. Cache reads/writes the provider reports anyway are still recorded
and priced. See [Router design](../../model-router/docs/design.md).

At recorded Claude cost >= $20, new Claude calls wait until the next UTC month. A provider spend refusal does the same even if
local accounting is lower. Network responses lost before usage is read and out-of-app calls may be absent locally;
Anthropic's console is the billing authority. Config/auth failures stay visible and do not assign fallback P1.
Claude's monthly cap applies only to Claude. Selecting another provider preserves those records as
history. OpenAI and Gemini API costs are recorded by Router and follow provider limits without adding them to the
Claude ledger. Codex uses the existing ChatGPT subscription, subject to its account/model availability and usage limits;
the app does not convert Codex tokens into Claude API fees. A saved login or a healthy process cannot establish
successful model access. Verify a real synthetic inference separately.

Model Router records Codex usage and its console is the only Codex usage view. Mailsort no longer writes its daily
`codex_usage` rows or reports `ServiceStatus.codex_usage`; existing rows stay until daily cleanup removes them after
400 days.

Mailsort's owner-machine secrets are its Gmail OAuth credentials: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN`,
put from the owner's machine and excluded from GitHub maps. Model Router alone holds shared provider keys and the
VPS executor's Access identity; Mailsort needs no endpoint variable, executor Bearer or Access client credentials.
The subscription login stays on the VPS auth PVC. Current connection setup is in the
[root rebuild guide](../../docs/rebuild.md) and [Model Router deployment](../../model-router/docs/deployment.md).

## 6. Existing writes and history

Gmail changes retain `intended/applied/undo_intended/undone`, original labels/Inbox state and stable request IDs.
Retries of existing intents precede new decisions. Undo uses the existing eligibility rules and ledger.
The model does not perform a new post-call manual-edit concurrency check; this personal app retains its ordinary
initial checks and established retry behavior.

Gmail corrections update verdicts, the label report and flow counts. They create no example; a historical example
stays until the owner deletes it (or withdraws the verdict it came from). The Workers AI embedding, weak-learning and replay code is removed. Old replay start calls return a
clear retired-feature error; GET history remains readable. The prior initializer keeps its original identity and
resume behavior. The label consolidation finished on 2026-10-11 and its code and Gmail operations are removed; its
three RPCs answer RELOAD_REQUIRED and its tables stay as history. A state restored from its run (an unfinished job)
refuses every owner mutation but settings with CONSOLIDATION_ACTIVE, so no priority setup or write starts over it.

## 7. UI and Ops

概览 shows Gmail freshness separately from the configured classification interval and next-batch time, the current model/effort, recorded monthly
Claude cost/tokens, actual Claude cache reads/writes and the selected provider/config error. While Codex is selected,
Claude figures are labelled history and the card points to the Model Router console for usage. `ServiceStatus.classifier` reports the selected provider, saved model/effort,
local configuration, next batch time, safe error and last successful response; configuration presence does not check
network reachability or authentication. 分级 shows the four queues and explicit unread-batch progress. 设置 shows
the catalog model and effort selectors and 5/15/30/60-minute interval selector, the fresh next-batch time and editable personal rules with a collapsed base-prompt field, alongside mode/write
controls and undo. Saving updates that card in place; a prompt-load failure leaves other settings usable.
Old examples, model stages and replay results are labelled history.

Home's private Ops binding exposes fresh mode/auth/pending counts and selected-provider warnings; Claude budget
warnings apply only while Claude is selected. It also reports the last backup's age and time, `backup_stale` (critical,
3 days) and `backup_failed` (warning), app-only signals. It no longer declares the account Workers AI guard capability:
shedding unrelated free-model usage cannot switch or stop Mailsort's model. The manual batch card consumes the fresh status after Start and reads status every 30 seconds only while
its batch is active and visible. It cancels on hide/leave/completion and refreshes once on visible return.
`ServiceStatus.gmail_write_resume_time` reports the next UTC midnight only when the effective daily write cap is
full. The UI uses that timestamp for a specific local-time explanation. No new owner API endpoint or scheduler is added. A retired
recheck batch's progress derives `unchanged_count` from existing batch/decision metadata and excludes it from
`skipped_count`; a successful same-grade judgment is not an unprocessed exclusion.
Labels refreshes its existing report after status updates and patches count spans in place, preserving focus and
expanded details. Home owns its existing warning dismissal behavior.

## 8. Verification and release

Use synthetic Gmail/Claude/Codex endpoints, the independent Gmail operation table, real workerd/SQLite, the generated
owner API and the existing local Wrangler smoke. Cover batch ID validation, all four Gmail outcomes, preserved
read/star/other labels, already-classified skips, default and configured cadence, retry/quota schedule preservation, actual usage, monthly reset/wait, auth/provider
failure and ordinary write-cap waits. Cover provider persistence, legacy defaults, selected-provider errors, no fallback
and preserved mode/prompt/budget history. CPU tests must reach the active batched model path. Gateway checks
use the shared Python wire codec, a fake SDK and offline pinned-feature inspection. Frozen contract fixtures
remain unchanged and readable.

Pass the full branch CI gate; deploy the same SHA through main Actions and record actual Worker/Deployment identity.
The gateway has its own image/workload release. Process `/healthz` reports the image's baked source identity and
release request ID. Code deployment, native provider configuration, a real synthetic model call and actual Gmail classification are
separate evidence. No existing mail is automatically reclassified by this rollout.

## Recent read Inbox intake

Automatic classification adds only Inbox messages received within the 48 hours before their first enqueue.
Reading a message before history sync or before the model pass no longer excludes it. P1-P4 labels, prior
valid decisions, Sent/Draft/Spam/Trash and unknown receipt dates remain exclusion conditions. This replaces
the old installation-time receipt boundary for automatic intake. Pending rows keep their original added_at,
attempts and not_before, so accepted work remains eligible through quota/retry waits.

At a normal batch's due time, reuse the bounded Gmail messages.list operation with INBOX, newer_than:2d,
P1-P4 and sent-mail (`-in:sent`) exclusions and maxResults 100, so an Inbox copy of the owner's own message is skipped
once instead of re-listed on every pass. This returns IDs only and never follows an all-mailbox/backfill path.
The ordinary message preparation independently checks the same receipt boundary because history arrivals
do not come through that list query. An active manual unread batch keeps its fixed scope; automatic
reconciliation waits until their pending work finishes.

Only old non-model skip records for not_inbox or before_install can be recovered in this bounded scope.
Their old skipped flow count is withdrawn transactionally before enqueue; valid model decisions, write
ledger, history and unrelated labels are preserved. No new table, scheduler or retention policy is added.
The flow UI has a separate outside_recent_window outcome, rather than calling it an installation failure.

Gmail query semantics: [message search](https://developers.google.com/workspace/gmail/api/guides/filtering)
and [supported operators](https://support.google.com/mail/answer/7190?hl=en).
