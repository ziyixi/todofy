# mailsort

Personal Gmail reading queues at `sort.ziyixi.science`. The Chinese UI manages four flat English Gmail labels.

| Label | When to read | Gmail action |
| --- | --- | --- |
| P1 | Prompt attention, with a concrete near-term consequence | Keep in Inbox |
| P2 | Important information or follow-up within two or three days | Archive |
| P3 | Personal periodic summaries or worthwhile weekend reading | Archive |
| P4 | Notifications, receipts and promotions kept for reference | Archive |

Mail is never marked read, sent, trashed or deleted. Stars and unrelated labels remain unchanged.
There are no reminders, automatic resurfacing or task creation.

## Classification

The existing Durable Object Alarm checks Gmail and maintenance every five minutes. Roughly hourly, it classifies
pending unread, unclassified mail in bounded batches of up to ten, with one **Claude Opus 5.5 medium** request per
batch. Backlog continues over subsequent Alarm calls within existing request and write caps. Normal history sync
retains its new-mail Inbox/receipt cutoff; the explicit unread action also covers older and archived mail.

The only classification policy is [the prompt](prompts/priority-classification.txt). Inputs include masked sender,
subject, up to 12,000 body characters, receipt time and evaluation time. Each result is one P1-P4 choice and a short
reason. No probability thresholds, sender-brand rules, second model vote or learned examples are used. An invalid
result or unavailable provider leaves mail pending through existing backoff; it never fabricates P1.

Mailsort has its own Claude workspace with a **$20/calendar-month provider spend limit**, separate from Brief.
Gift-credit usage counts toward provider limits. The app records returned input/output/thinking tokens and
list-price cost, and stops new calls once its recorded monthly cost reaches $20. The console remains the billing
authority; out-of-app calls and calls with a lost response may not appear in the app tally. A provider spend refusal
leaves pending mail for the next UTC month. There is no cheaper-model fallback.

## UI and existing data

- 概览: mode, Gmail status, last check, next model batch, flow and recorded Claude usage.
- 分级: four fixed queues, counts and explicit unread-batch progress. A manual start queues immediately; existing
  P1-P4 mail is skipped. While an active batch is visible, progress updates every 30 seconds. It stops on completion
  or leaving the page, and a reached daily write cap shows its UTC-reset time in the browser timezone.
- 设置: mode, write limits and undo. Old examples, replay results and decision evidence remain readable as history.

Off, shadow and live modes retain their existing meanings. Shadow records decisions without changing Gmail;
live applies them. The deployment ceiling can lower the owner's mode. Existing labelled mail is not automatically
reclassified after a deployment. Older recheck actions remain explicit owner operations.

The initial P1-P4 setup and historical label replacement are in [priority rollout](docs/priority-rollout.md).
This Claude rollout does not repeat that setup or delete labels.

## Development

One Worker serves static UI assets and a generated owner API backed by the existing SQLite DO `mailsort-v1`.
`gmail.ts` owns Google calls; `claude.ts` owns Anthropic calls. There is no VPS process or extra database/scheduler.

From `worker/`, with Node 26:

```sh
npm ci
(cd ../web && npm ci && npm run build)
npm run lint && npm run typecheck && npm test
npm run test:runtime
npm run test:smoke
node --test ../deploy/test/*.test.mjs
```

Runtime and smoke tests use workerd/SQLite and fake Gmail/Claude endpoints with synthetic data.
UI checks in `web/`: `npm run lint && npm run typecheck && npm test && npm run build`.
See [design](docs/design.md) and [collaboration rules](AGENTS.md).

## Release and credentials

Pass the complete branch CI gate, then release the exact same SHA through main Actions. The deploy wrapper
injects Access/CSRF material, `BUILD_SHA` and the `MAILSORT_MODE` ceiling. Gmail and `ANTHROPIC_API_KEY` credentials
are owner-written Worker secrets, excluded from GitHub and preserved by the wrapper. Do not run a plain release.

For a new account, create a dedicated Claude workspace, set its monthly spend limit to $20, and issue a key scoped
to that workspace. Put it directly into the Worker from the owner machine:

```sh
cd mailsort/worker
npx --no-install wrangler secret put ANTHROPIC_API_KEY --config ../wrangler.toml
```

Gmail credentials still use `deploy/mint-token.mjs`. Full rebuild steps are in the root
[rebuild guide](../docs/rebuild.md). Home reads private Ops status and API budget warnings; account Workers AI
shedding no longer changes Mailsort's model.
