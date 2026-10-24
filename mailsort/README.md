# mailsort

Personal Gmail reading priorities at `sort.ziyixi.science`. New incoming messages get one of four real Gmail labels.
The UI uses Chinese; Gmail labels are `P1`, `P2`, `P3`, `P4`.

| Label | When to read | Gmail action |
| --- | --- | --- |
| P1 | Promptly, or the model cannot confidently choose a later time | Add P1; keep in Inbox |
| P2 | Safe to wait two or three days | Add P2; archive |
| P3 | Safe to wait until the next weekend | Add P3; archive |
| P4 | Optional, low-value or ordinary FYI | Add P4; archive |

Mail is never marked read, sent, trashed or deleted. Reading cadence is not a timer: the app does not move mail
back into Inbox later or create tasks. Tasks' Mail categories and task priorities are independent.

## Classification

Workers AI Clef judges when it is safe to read the masked message, using receipt time, local date/week and current
priority examples. A confident result needs the existing two-view agreement and threshold; valid uncertainty or
`none` becomes P1. Provider errors use the existing backoff and can fail after retries; quota exhaustion waits
for the next UTC day. Neither creates a priority judgment. Each new reply is judged independently; message IDs
still deduplicate delivery. A new reply carrying an earlier priority can replace it without changing other
labels, unread or starred state. Normal processing keeps its new-mail receipt cutoff.

The owner can explicitly choose **处理全部未读** (`StartUnreadClassification`). It first collects unread message
IDs across all ages and folders, including archived mail, then processes that batch through the existing Alarm
and pending queue. Spam, Trash and the normal incoming-mail exclusions are skipped, as are messages already
carrying P1-P4 or no longer unread. Only this batch bypasses the new-mail cutoff and may replace a message's
latest stored decision; old Gmail write ledgers remain. P1 puts an archived message in Inbox; ordinary undo restores
its original Inbox position. Read/unread, stars and unrelated labels are preserved.

The existing modes, write caps and model budget apply. At 70% of the daily neuron budget the model switches to
Clef-flash; exhaustion defers work to the next UTC day. A paused mode or a reached write cap leaves batch work
waiting. Progress distinguishes applied, skipped, failed and pending messages; completion does not mean every
message received a label. Only the latest batch's IDs, state, ledger links and scan progress are kept until the
next batch replaces them or the app's data is deleted; this progress stores no mail content.

There is no model phishing/scam question, suspicious-score gate or trusted-domain requirement. Gmail's own spam
handling is unchanged. Financial notices get a reading priority from their contents, without sender-brand rules.

## UI

- **概览**: mode, Gmail grant, freshness, today's flow, per-priority counts, the model budget and the explicit
  unread-batch action and progress.
- **分级**: four fixed rows, their Inbox/archive behavior and learned examples loaded only on expansion.
- **设置**: owner mode, existing undo and the read-only classification-effect check. Gmail corrections teach the
  priority model. Uncertain mail does not require a separate review; the old `/review` path remains readable.

The initial **启用 P1–P4 分级** action replaces this app's old topic labels and learning. It deletes the old managed
Gmail labels, including known retired identities, while retaining every message and its existing Inbox/unread
state. Other labels stay untouched. Old decisions and ledgers remain history, excluded from new learning;
an explicit unread batch may later replace the selected messages' latest decisions.
A bounded step can be continued with the same stored setup; there is no background migration service.
See [priority setup and verification](docs/priority-rollout.md).

## Architecture and development

One Worker, the existing SQLite `MailsortState` DO and its Alarm, plus static UI assets. No added database,
scheduler, model provider or secret. Production Gmail calls go only through `worker/src/gmail.ts` and its closed
operation table. Model, daily neuron budget, mode ceiling and request/write limits retain their existing values.

From `worker/`, with Node 26:

```sh
npm ci
(cd ../web && npm ci && npm run build)
npm run lint && npm run typecheck && npm test
npm run test:runtime
npm run test:smoke
node --test ../deploy/test/*.test.mjs
```

The runtime and smoke tests use local workerd/SQLite, fake Gmail and fake Workers AI. They never call Google or
read personal mail. UI checks run in `web/`: `npm run lint && npm run typecheck && npm test && npm run build`.
Design, storage bounds and retention are in [design](docs/design.md); collaboration rules in [AGENTS](AGENTS.md).

## Release and credentials

Pass the complete branch CI gate, then release the exact same SHA through main's `Mailsort deploy`. The existing
wrapper injects `BUILD_SHA`, the `MAILSORT_MODE` ceiling and Access/CSRF material. It preserves Gmail credentials.
Do not use a plain `wrangler deploy` or put Gmail credentials in GitHub. Only the owner initializes those through
`deploy/mint-token.mjs` on their own machine.

The dashboard mode is lowered by the deployment ceiling and existing breaker. Initialization does not change
mode or budgets. Off stops normal Gmail processing; retention still runs. Home reads only the standard private
Ops binding. See the root [rebuild guide](../docs/rebuild.md) for a new account.
