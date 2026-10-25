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

The existing Durable Object Alarm checks Gmail and maintenance every five minutes. Roughly hourly, it classifies
pending unread, unclassified mail in bounded batches of up to ten, with one model request per batch.
Choose either provider in **设置 → 分类引擎**:

| Choice | Fixed model | Authentication |
| --- | --- | --- |
| Claude API | Opus 5.5, medium | Dedicated Anthropic workspace API key |
| VPS Codex | `gpt-6.1-sol`, medium | Existing ChatGPT subscription login on the owner's VPS |

The choice is saved in the existing settings row and survives reload and deployment. Legacy settings use Claude
until the owner switches. Both providers use the same saved prompt; switching preserves mode, breaker, write limits
and Claude usage history. It affects the next batch without starting an unread batch or reclassifying labelled mail.
There is no automatic provider or model fallback.

Backlog continues over subsequent Alarm calls within existing request and write caps. Normal history sync
retains its new-mail Inbox/receipt cutoff; the explicit unread action also covers older and archived mail.

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
emails and evaluation times follow it. Ordinary hourly single batches do not request a cache write. The usage card
shows actual cache reads/writes, and cost uses their separate prices. There is no prewarming or extra API call.
This explicit cache policy applies only to Claude.

Codex uses the independent [gateway](../codex-gateway/README.md), with the official
[Python SDK](https://learn.chatgpt.com/docs/codex-sdk) pinned to `openai-codex==0.156.1`.
It accepts one synchronous structured-inference request, has no Gmail access or saved jobs, and starts no autonomous
work. It shares only the existing login PVC with Newsletter; it does not import Newsletter code or invoke its workflows.
The model gets masked data without business tools or web access. The gateway requires ChatGPT subscription auth,
with no API-key fallback. Process health and a saved login do not establish model availability or successful inference.

## UI and existing data

- 概览: mode, Gmail status, selected classifier/configuration, next model batch, flow and Claude usage history.
- 分级: four fixed queues, counts and explicit unread-batch progress. A manual start queues immediately; existing
  P1-P4 mail is skipped. While an active batch is visible, progress updates every 30 seconds. It stops on completion
  or leaving the page, and a reached daily write cap shows its UTC-reset time in the browser timezone.
- 设置: the persistent two-provider selector, personal rules, a collapsed base-prompt editor, mode, write limits and undo. Old examples, replay results and decision evidence remain readable as history.

Off, shadow and live modes retain their existing meanings. Shadow records decisions without changing Gmail;
live applies them. The deployment ceiling can lower the owner's mode. Existing labelled mail is not automatically
reclassified after a deployment. Older recheck actions remain explicit owner operations.

The initial P1-P4 setup and historical label replacement are in [priority rollout](docs/priority-rollout.md).
Provider selection does not repeat that setup or delete labels.

## Development

One Worker serves static UI assets and a generated owner API backed by the existing SQLite DO `mailsort-v1`.
`gmail.ts` owns Google calls; `claude.ts` owns Anthropic calls; `codex.ts` calls the independent VPS gateway through
the root `codex.inference.v1` wire contract. The Worker and existing DO retain Gmail, settings, pending work and
write-ledger ownership. The gateway adds no database or scheduler.

From `worker/`, with Node 26:

```sh
npm ci
(cd ../web && npm ci && npm run build)
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
injects Access/CSRF material, `BUILD_SHA` and the `MAILSORT_MODE` ceiling. Gmail and `ANTHROPIC_API_KEY` credentials
and the three Codex credentials below are owner-written Worker secrets, excluded from GitHub release secrets and
preserved by the wrapper. Do not run a plain release.

For a new account, create a dedicated Claude workspace, set its monthly spend limit to $20, and issue a key scoped
to that workspace. Put it directly into the Worker from the owner machine:

```sh
cd mailsort/worker
npx --no-install wrangler secret put ANTHROPIC_API_KEY --config ../wrangler.toml
```

For Codex, the generated `CODEX_ENDPOINT_URL` deployment var points to
`https://platform-runtime.ziyixi.science/api/codex/v1/inference:run`. The route requires a dedicated Access machine
identity and an inference-only Bearer; it grants no deployment or Newsletter permissions. Put its credentials
directly into the Worker from the owner machine, through Wrangler's local prompts:

```sh
npx --no-install wrangler secret put CODEX_ENDPOINT_TOKEN --config ../wrangler.toml
npx --no-install wrangler secret put CODEX_ACCESS_CLIENT_ID --config ../wrangler.toml
npx --no-install wrangler secret put CODEX_ACCESS_CLIENT_SECRET --config ../wrangler.toml
```

IaC owns the Access identity and keeps sensitive outputs in encrypted state. The gateway's subscription login stays
in the existing VPS auth PVC. Verify a real synthetic inference separately from `/healthz`, release identity and
Access/Bearer configuration before treating Codex as ready. Deployment does not select a provider on the owner's behalf.

Gmail credentials still use `deploy/mint-token.mjs`. Full rebuild steps are in the root
[rebuild guide](../docs/rebuild.md). Home reads private Ops status and API budget warnings; account Workers AI
shedding no longer changes Mailsort's model.
