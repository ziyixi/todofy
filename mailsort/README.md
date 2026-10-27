# mailsort

Personal Gmail reading queues at `sort.ziyixi.science`. The Chinese UI manages four flat English Gmail labels.

| Label | When to read | Gmail action |
| --- | --- | --- |
| P1 | Prompt attention, including the owner's Daily Briefing | Keep in Inbox |
| P2 | Important information or follow-up within two or three days | Archive |
| P3 | Personal periodic summaries or worthwhile weekend reading | Archive |
| P4 | Notifications and promotions kept for reference | Archive |

Mail is never marked read, sent, trashed or deleted. Stars and unrelated labels remain unchanged.
There are no reminders, automatic resurfacing or task creation.

## Classification

The existing Durable Object Alarm checks Gmail and maintenance every five minutes. Normal automatic classification
defaults to a 15-minute interval, configurable in 设置 → 自动分类间隔 as 5, 15, 30 or 60 minutes. It classifies
recent Inbox mail without a P1-P4 classification, whether read or unread, in bounded batches of up to ten
with one model request per batch. Automatic intake is limited to the past 48 hours; archived mail stays outside
this automatic scope. Existing classifications and read/starred states are preserved.
Choose either provider in **设置 → 分类引擎**:

| Choice | Fixed model | Authentication |
| --- | --- | --- |
| Claude API | `models/claude-opus-5-5`, medium | Model Router, dedicated Mailsort connection |
| VPS Codex | `models/sol-6-1`, medium | Model Router, existing VPS subscription executor |

The Codex model and effort were checked against the production VPS catalog; inference requires separate verification.
The choice is saved in the existing settings row and survives reload and deployment. Legacy settings use Claude
until the owner switches. Both providers use the same saved prompt; switching preserves mode, breaker, write limits
and Claude usage history. It affects the next batch without starting an unread batch or reclassifying labelled mail.
There is no automatic provider or model fallback.

The interval is persisted for both providers. Saving adjusts a future ordinary wait; retries, quota waits and
accepted backlog keep their own schedules. Older settings adopt 15 minutes once without reclassifying old mail.
Backlog continues over subsequent Alarm calls within existing request and write caps. History sync includes
mail opened before a batch; each normal due batch also lists at most 100 recent, unclassified Inbox IDs to
recover missed items. Classification checks the receipt window against the first enqueue time, so already
accepted work survives quota/retry holds. Unknown receipt dates are skipped. Old installation cutoffs no longer
exclude otherwise eligible mail inside the 48-hour window. The explicit unread action still has its own scope
and can cover older and archived unread mail; it is never automatically started by a deployment.

Classification uses a [base prompt](prompts/priority-classification.txt) and [personal rules](prompts/personal-rules.txt).
Edit either in **设置 → 分类提示词** and save; the existing database keeps the saved text through deployments.
It applies to the next model batch and does not rerun classified mail. The initial personal rules put ordinary
USPS Informed Delivery in P2 (P1 when timely action is needed), Daily Briefing in P1, and actual shopping receipts
and order confirmations, including Weee and Yami, in P2. Promotions from the same brands keep the general policy.
The base includes three input/JSON-response demonstrations with seven synthetic messages covering all four queues;
they illustrate the default preferences, while current personal rules take precedence.
Inputs include masked sender,
subject, up to 12,000 body characters, receipt time and evaluation time. Each result is one P1-P4 choice and a short
reason. Brand preferences live in editable prompt text; there are no sender-specific code branches,
probability thresholds, second model vote or learned examples. An invalid
result or unavailable provider leaves mail pending through existing backoff; it never fabricates P1.

Claude API uses its own workspace with a **$20/calendar-month provider spend limit**, separate from Brief.
Gift-credit usage counts toward provider limits. The app records returned input/output/thinking and cache tokens and
list-price cost, and stops new calls once its recorded monthly cost reaches $20. The console remains the billing
authority; out-of-app calls and calls with a lost response may not appear in the app tally. A provider spend refusal
leaves Claude work pending for the next UTC month. These limits apply only while Claude is selected; its usage and
cache records remain visible as history while Codex is selected.

Consecutive batches can reuse five-minute Claude prompt caches. Only the stable base/rules prefix is marked;
emails and evaluation times follow it. Ordinary scheduled single batches do not request a cache write. The usage card
shows actual cache reads/writes, and cost uses their separate prices. There is no prewarming or extra API call.
This explicit cache policy applies only to Claude.

Both choices use the private `MODEL_ROUTER` service binding and the shared `modelrouter.inference.v1` contract.
Mailsort sends trusted instruction blocks, masked input and a standard JSON Schema through
`@ziyixi/model-router-client`. The Router owns model connections, provider formats, usage normalization and the
VPS executor connection. Its authenticated Mailsort caller uses a dedicated Claude connection; Brief's key remains
separate. No model receives Gmail credentials or business tools. Model availability and successful real inference
remain separate checks from a configured route.

The app records Codex HTTP classification attempts, valid/failed responses and reported input/output tokens by UTC day,
retains those counters for 400 days and shows the current UTC month's totals. A response with an invalid classification
still contributes its reported tokens. Failed requests without returned usage count as attempts with unknown token use;
the UI shows how many requests supplied usage. Input totals include cached input. These records start with this release,
preserve both providers' history on a switch and do not estimate subscription cost or the ChatGPT account's remaining allowance.

## UI and existing data

- 概览: mode, Gmail status, selected classifier/configuration, next model batch, flow and separate Codex/Claude usage history.
- 分级: four fixed queues, counts and explicit unread-batch progress. A manual start queues immediately; existing
  P1-P4 mail is skipped. While an active batch is visible, progress updates every 30 seconds. It stops on completion
  or leaving the page, and a reached daily write cap shows its UTC-reset time in the browser timezone.
- 设置: the persistent provider and interval choices, next classification time, personal rules, a collapsed base-prompt editor, mode, write limits and undo. Old examples, replay results and decision evidence remain readable as history.

Off, shadow and live modes retain their existing meanings. Shadow records decisions without changing Gmail;
live applies them. The deployment ceiling can lower the owner's mode. Existing labelled mail is not automatically
reclassified after a deployment. Older recheck actions remain explicit owner operations.

The initial P1-P4 setup and historical label replacement are in [priority rollout](docs/priority-rollout.md).
Provider selection does not repeat that setup or delete labels.

## Development

One Worker serves static UI assets and a generated owner API backed by the existing SQLite DO `mailsort-v1`.
`gmail.ts` owns Google calls; `classification-model.ts` calls Model Router and validates Mailsort's classification IDs and buckets. The Worker and existing DO retain Gmail, settings, pending work and
write-ledger ownership. The gateway adds no database or scheduler.

From the repository root, with Node 26 and the shared workspace toolchain:

```sh
pnpm install --frozen-lockfile
cd mailsort/worker
(cd ../web && npm run build)
npm run lint && npm run typecheck && npm test
npm run test:runtime
npm run test:smoke
node --test ../deploy/test/*.test.mjs
```

Runtime and smoke tests use workerd/SQLite and fake Gmail/Claude/Codex endpoints with synthetic data.
Batch results separate confirmed Gmail changes, successful rechecks that kept the same grade, and messages
excluded before judgment. Priority badges refresh with batch progress. “重判最初100封” means the original earliest
successfully graded cohort, including read/archive mail, rather than the newest 100 unread messages.

UI checks in `web/`: `npm run lint && npm run typecheck && npm test && npm run build`.
See [design](docs/design.md) and [collaboration rules](AGENTS.md).

## Release and credentials

Pass the complete branch CI gate, then release the exact same SHA through main Actions. The deploy wrapper
injects Access/CSRF material, `BUILD_SHA` and the `MAILSORT_MODE` ceiling. Gmail credentials remain owner-written Worker secrets, excluded from GitHub release secrets and preserved by
the wrapper. Provider keys and Codex executor credentials belong to Model Router. The Worker receives a private
`MODEL_ROUTER` binding with the Mailsort caller identity; it has no arbitrary endpoint setting or provider credential.
Preserve the dedicated Mailsort Claude workspace and its $20 monthly provider cap when configuring the Router.

The migration does not change the saved classifier choice, mode, prompt, pending work, write limits, breaker or
usage history. Credential transfer, deployment and a real synthetic inference require separate release evidence.
Do not paste keys into chat, issues or GitHub.

Gmail credentials still use `deploy/mint-token.mjs`. Full rebuild steps are in the root
[rebuild guide](../docs/rebuild.md). Home reads private Ops status and API budget warnings; account Workers AI
shedding no longer changes Mailsort's model.
