# Mailsort design

The owner's Gmail has four reading queues. Claude judges the latest reasonable reading time from message content;
Gmail remains the mailbox. The app never sends mail, marks it read, deletes it or creates tasks.

## 1. Runtime

One TypeScript Worker serves private, framework-free UI assets, verifies Access/Origin/CSRF and forwards the generated owner
API to SQLite DO `MailsortState`, stable object `mailsort-v1`. Its Alarm handles Gmail history, pending messages,
Claude requests, the existing write ledger and daily retention. No VPS, cron or added storage/scheduler.

`state.ts` owns API dispatch and Alarm lifecycle. `pipeline.ts` owns a bounded pass. `gmail.ts` owns Google access;
`claude.ts` owns the Anthropic Messages API. Defaults are bundled from `prompts/priority-classification.txt` and
`prompts/personal-rules.txt`. A saved override lives in existing DO metadata, not another database. The UI imports
only generated wire types, never Worker implementation.

## 2. Gmail boundary and privacy

All Google calls pass the closed operation table in `gmail.ts`, mirrored independently by the fake. Message writes
only add/remove this app's owned P1-P4 labels and INBOX through a recorded intent. Read state, stars and unrelated
labels are preserved. Send, message-delete, trash, spam mutation, filters, forwarding and settings are refused.
The historical one-time initializer may delete only old user-label IDs already frozen as app-owned.

The model receives one array of message IDs, masked sender/subject/body, receipt time, evaluation time and timezone.
Subject is capped at 200 characters and body at 12,000; body truncation is explicit. Addresses and long numbers are
masked and links reduced to domains. Attachments are not sent. Model input is untrusted data with no tool access.
Production calls go directly to Anthropic, without AI Gateway or request-body logging.

| Stored data | Retention |
| --- | --- |
| Decision content: masked subject, sender, summary and sender domain | 14 days |
| Legacy review content | 14 days after arrival |
| Non-content decisions and write ledger; sender as salted hash | 180 days |
| Historical replay metadata | 7 days |
| Daily aggregate counters and returned Claude usage | 400 days |
| Historical masked examples and embeddings | Owner deletion, maximum 2,000 |
| Fixed labels and Gmail identities | Until explicit app-data removal |
| Saved base prompt and personal rules | Until replaced or app-data removal |
| Owner request receipts | 1 day |
| Latest unread batch IDs, state and scan progress, without content | Until next batch or app-data removal |

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
same-day action P1; Daily Briefing P1; actual shopping receipts/order confirmations (including Weee/Yami) P2.
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
deployment ceiling and breaker can lower the owner mode. Setup or deployment does not raise it or replay old mail.

## 4. Hourly batches

The existing Alarm normally maintains Gmail every five minutes. A persisted `next_model_at` starts new model work
roughly hourly. It drains pending work in batches of up to ten, one request per pass, then schedules the next hour.
The pass stays within 40 external requests and existing run/day Gmail write caps. Message eligibility and existing
P1-P4 labels are checked before a reached write cap can defer it, so skip-only work can finish without a model or
Gmail write. Eligible mail waits through the normal queue; a routine cap is not a breaker fault.

History registers messages independently by Gmail message ID. Normal processing retains its Inbox and receipt
cutoffs and now skips read or already-classified mail. Each unread new reply can be judged independently of other
messages in its thread. The explicit unread action includes older/archived mail, retaining its existing scan and
progress table. Older recheck options remain explicit owner operations and never start on deployment.

`claude.ts` sends a standard Messages API request to `claude-opus-5-5` with adaptive thinking, medium effort and
structured JSON output. The response must cover all input IDs exactly once, with P1-P4 and a short reason. It has
a bounded response and timeout. There is no provider/model fallback, second vote, embeddings or automatic learning.

Provider/network failures use the existing pending backoff. Invalid results are not partially applied. Exhausted
retries become visible failures without new Gmail labels. Historical probabilities, examples and ledger entries
keep their original meanings; none are rewritten as Claude judgments.

## 5. Cost and credentials

A dedicated Anthropic Mailsort workspace has a provider-native $20/calendar-month spend limit; Brief and the
organization limit are separate. Credits count toward that spend limit and the cap resets on the first UTC day
of each month. API keys are scoped to this workspace.

The app stores returned usage in the existing SQLite store, by UTC day, and sums at most one month's rows. The
recorded price is $4/million uncached input, $5/million five-minute cache writes, $0.20/million cache reads and
$20/million output tokens; thinking is part of output tokens, not an extra charge. Input totals include uncached,
cache-created and cache-read tokens. If the provider reports one-hour cache creation, it is priced at $8/million;
this application only requests five minutes. Optional missing thinking breakdown remains unknown. Even a billed invalid result counts when the API
returned its usage. No estimates, reservations or extra accounting service are introduced.

The API's stable system blocks are base first, then nonempty personal rules; message-specific email/time data
follows them. Each system block gets an explicit five-minute cache breakpoint only when the prepared batch has
more due pending work behind it or a returned cache read/write began within five minutes. The latter is one
timestamp in existing metadata, recorded from request start only when usage actually reports caching. No top-level
automatic cache or email breakpoint is sent. Prefix edits invalidate the affected cache naturally; a rules edit
can still reuse the base. No padding, prewarming or keepalive calls are used. Below the provider's minimum prefix
length, caching may be ignored. Actual returned token fields determine cost and whether a hit occurred.
See [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and
[Opus 5.5 pricing](https://platform.claude.com/docs/en/about-claude/pricing).

At recorded cost >= $20, new calls wait until the next UTC month. A provider spend refusal does the same even if
local accounting is lower. Network responses lost before usage is read and out-of-app calls may be absent locally;
Anthropic's console is the billing authority. Config/auth failures stay visible and do not assign fallback P1.

Gmail OAuth and `ANTHROPIC_API_KEY` are owner-written Worker secrets. `app.toml`, generated secret inventories and
the deploy wrapper keep them out of GitHub and preserve them during deploy. The initial account setup is in the
[root rebuild guide](../../docs/rebuild.md); the concrete key command is in [README](../README.md).

## 6. Existing writes and history

Gmail changes retain `intended/applied/undo_intended/undone`, original labels/Inbox state and stable request IDs.
Retries of existing intents precede new decisions. Undo uses the existing eligibility rules and ledger.
The model does not perform a new post-call manual-edit concurrency check; this personal app retains its ordinary
initial checks and established retry behavior.

Gmail corrections can still update historical answer records. No active embedding/weak-learning/replay process
uses them. Old replay start calls return a clear retired-feature error; GET history remains readable. The prior
initializer and consolidation state keep their original identity and resume behavior, with no new migration system.

## 7. UI and Ops

概览 shows Gmail freshness separately from the hourly model schedule, the current model/effort, recorded monthly
cost/tokens, actual cache reads/writes and any provider/config error. 分级 shows the four queues and explicit
unread-batch progress. 设置 shows editable personal rules with a collapsed base-prompt field, alongside mode/write
controls and undo. Saving updates that card in place; a prompt-load failure leaves other settings usable.
Old examples, model stages and replay results are labelled history.

Home's private Ops binding exposes fresh mode/auth/pending counts and Claude budget warnings. It no longer declares
the account Workers AI guard capability: shedding unrelated free-model usage cannot switch or stop Mailsort's Claude
model. The manual batch card consumes the fresh status after Start and reads status every 30 seconds only while
its batch is active and visible. It cancels on hide/leave/completion and refreshes once on visible return.
`ServiceStatus.gmail_write_resume_time` reports the next UTC midnight only when the effective daily write cap is
full. The UI uses that timestamp for a specific local-time explanation. No new endpoint or scheduler is added. Recheck progress derives `unchanged_count` from existing batch/decision
metadata and excludes it from `skipped_count`; a successful same-grade judgment is not an unprocessed exclusion.
Labels refreshes its existing report after status updates and patches count spans in place, preserving focus and
expanded details. Home owns its existing warning dismissal behavior.

## 8. Verification and release

Use synthetic Gmail/Claude endpoints, the independent Gmail operation table, real workerd/SQLite, the generated
owner API and the existing local Wrangler smoke. Cover batch ID validation, all four Gmail outcomes, preserved
read/star/other labels, already-classified skips, hourly cadence, actual usage, monthly reset/wait, auth/provider
failure and ordinary write-cap waits. CPU tests must reach the actual batched Claude path. Frozen contract fixtures
remain unchanged and readable.

Pass the full branch CI gate; deploy the same SHA through main Actions and record actual Worker/Deployment identity.
Code deployment, native provider configuration, a real synthetic model call and actual Gmail classification are
separate evidence. No existing mail is automatically reclassified by this rollout.
