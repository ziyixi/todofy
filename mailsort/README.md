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
Choose a configured text model and its supported effort in **设置 → 分类引擎**. Choices come from Model Router and
show their provider: VPS Codex, OpenAI API, Claude API or Gemini API. `gpt-6.1-sol` uses the existing Codex subscription;
`openai/gpt-6.1-sol` uses the OpenAI API. Credentials remain in Router. Configuration does not prove successful inference.

The model and effort are saved in the existing settings row and survive reload and deployment. Older provider-only
settings keep `claude-opus-5-5` medium or `gpt-6.1-sol` medium; settings without a choice use Codex. Every model uses the same saved prompt; switching preserves mode, write limits and Claude
usage history. It affects the next batch without starting an unread batch or reclassifying labelled mail.
There is no automatic provider or model fallback.

The interval is persisted for both providers. Saving adjusts a future ordinary wait; retries, quota waits and
accepted backlog keep their own schedules. Older settings adopt 15 minutes once without reclassifying old mail.
Backlog continues over subsequent Alarm calls within existing request and write caps. History sync includes
mail opened before a batch; each normal due batch also lists at most 100 recent, unclassified Inbox IDs (never the
owner's own sent mail) to recover missed items. Classification checks the receipt window against the first enqueue
time, so already accepted work survives quota/retry holds. Unknown receipt dates are skipped. Old installation cutoffs
no longer exclude otherwise eligible mail inside the 48-hour window. The explicit unread action still has its own scope
and can cover older and archived unread mail; it is never automatically started by a deployment.

Classification uses a [base prompt](prompts/priority-classification.txt) and [personal rules](prompts/personal-rules.txt).
Edit either in **设置 → 分类提示词** and save; the existing database keeps the saved text through deployments.
It applies to the next model batch and does not rerun classified mail. The initial personal rules put ordinary
USPS Informed Delivery in P2 (P1 when timely action is needed), Daily Briefing in P1, and actual shopping receipts
and order confirmations from any shopping platform in P2. Promotions from the same brands keep the general policy.
The base includes three input/JSON-response demonstrations with seven synthetic messages covering all four queues;
they illustrate the default preferences, while current personal rules take precedence.
Inputs include masked sender,
subject, up to 12,000 body characters, receipt time and evaluation time. Each result is one P1-P4 choice and a short
reason. Brand preferences live in editable prompt text; there are no sender-specific code branches,
probability thresholds, second model vote or learned examples. A failed model call never fabricates P1. Failures
follow the shared Model Router error contract: an outage, rate limit or quota defers the whole batch without counting
against any mail (5 minutes doubling to an hour, or the Router's Retry-After), so a long outage only delays mail; a
configuration or auth failure retries hourly, or at once after a settings save; an invalid request or answer gives
a mail three tries and a timeout seven. A mail that already failed is retried alone.

Claude API retains the app's **$20/calendar-month recorded-usage stop**. Router owns the shared provider connection
and its separate workspace limits. Gift-credit usage counts toward provider limits. The app records returned input/output/thinking and cache tokens and
list-price cost, and stops new calls once its recorded monthly cost reaches $20. The console remains the billing
authority; out-of-app calls and calls with a lost response may not appear in the app tally. A provider spend refusal
leaves Claude work pending for the next UTC month. These limits apply only while Claude is selected; its usage and
cache records remain visible as history while another provider is selected. OpenAI and Gemini API usage and cost
are recorded in Model Router and follow their provider limits; they do not spend the Claude local budget.

Mailsort never asks for a prompt cache: a cache write costs more than the occasional reuse between batches saves.
The stable base/rules prefix still comes first. Cache reads/writes the API reports still appear on the usage card and
cost uses their separate prices.

Every model uses the private `MODEL_ROUTER` service binding and the shared `modelrouter.inference.v1` contract.
Mailsort sends trusted instruction blocks, masked input and a standard JSON Schema through
`@ziyixi/model-router-client`. The Router owns model connections, provider formats, usage normalization and the
VPS executor connection. Its authenticated caller identity attributes usage; all Claude callers share the Router's single key in the existing $80/month workspace. No model receives Gmail credentials or business tools. Model availability and successful real inference
remain separate checks from a configured route.

Model Router records Codex usage; its console is the only Codex usage view. Mailsort keeps no Codex ledger, and its
older daily Codex rows only age out with their 400-day retention.

## UI and existing data

- 概览: mode, Gmail status, selected classifier/configuration, next model batch, flow and Claude usage history.
- 分级: four fixed queues, counts and explicit unread-batch progress. A manual start queues immediately; existing
  P1-P4 mail is skipped. While an active batch is visible, progress updates every 30 seconds. It stops on completion
  or leaving the page, and a reached daily write cap shows its UTC-reset time in the browser timezone.
- 设置: persistent model, effort and interval choices, next classification time, personal rules, a collapsed base-prompt editor, mode, write limits and undo. Old examples, replay results and decision evidence remain readable as history.

Off, shadow and live modes retain their existing meanings. Shadow records decisions without changing Gmail;
live applies them. The deployment ceiling can lower the owner's mode. Existing labelled mail is not automatically
reclassified after a deployment. The one-time recheck actions and the label consolidation are retired: an older page
that still calls them is asked to reload.

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
Batch results separate confirmed Gmail changes and messages excluded before judgment; a recheck batch an older
release completed still shows its same-grade judgments apart. Priority badges refresh with batch progress.

UI checks in `web/`: `npm run lint && npm run typecheck && npm test && npm run build`.
See [design](docs/design.md) and [collaboration rules](AGENTS.md).

## Backup and restore

The object backs itself up daily at 11:41 UTC into the private bucket `mailsort-backups`: every table, the newest 30
complete copies, deleted by the app itself (no lifecycle rule). A backup is restored into an empty object by the owner's
`StartBackupRestore` call, in bounded alarm steps that check every part's SHA-256; nothing is replayed to Gmail and
intake resumes from the mailbox's current state. `tools/backup-restore.ts` downloads, verifies, loads into a local
SQLite file and uploads backups. See [backup and restore](docs/backup.md).

## Release and credentials

Pass the complete branch CI gate, then release the exact same SHA through main Actions. The deploy wrapper
injects the Access owner identity, `BUILD_SHA` and the `MAILSORT_MODE` ceiling. Gmail credentials remain owner-written Worker secrets, excluded from GitHub release secrets and preserved by
the wrapper. Provider keys and Codex executor credentials belong to Model Router. The Worker receives a private
`MODEL_ROUTER` binding with the Mailsort caller identity; it has no arbitrary endpoint setting or provider credential.
Use Router's single Claude key in the shared $80/month workspace. Mailsort's existing local business budget and history stay intact; no separate provider key is configured here.

The migration does not change the saved classifier choice, mode, prompt, pending work, write limits or usage
history. Credential transfer, deployment and a real synthetic inference require separate release evidence.
Do not paste keys into chat, issues or GitHub.

Gmail credentials still use `deploy/mint-token.mjs`. Full rebuild steps are in the root
[rebuild guide](../docs/rebuild.md). Home reads private Ops status and API budget warnings; account Workers AI
shedding no longer changes Mailsort's model.
