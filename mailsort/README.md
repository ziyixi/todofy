# mailsort

Personal Gmail reading queues at `sort.ziyixi.science`. A VPS job checks once an hour and uses
GPT-6.1 Sol medium to classify unread mail that has no P1–P4 label. The UI is Chinese; Gmail labels are English.

| Label | When to read | Gmail action |
| --- | --- | --- |
| P1 | Timely attention; waiting two or three days would miss a concrete matter | Label and keep in Inbox |
| P2 | Important contact or follow-up within two or three days | Label and archive |
| P3 | Personal life/account review or selected reading for the weekend | Label and archive |
| P4 | Routine information and promotions, kept for later lookup | Label and archive |

Read state, stars and other labels stay unchanged. Mailsort never sends, deletes or trashes mail.
Gmail's Spam handling stays unchanged. No sender-brand rules or probability thresholds decide a priority.

## Daily use

- **概览** shows recent classifications, actual Gmail writes and the latest hourly batch: completion, model,
  prompt version, token usage and failures. A successful check with no work is separate from an unreachable job.
- **分级** shows P1–P4. **整理当前未读** selects only ungraded unread messages, including archived ones.
  **重新判断全部未读** explicitly includes unread messages already carrying a priority; read mail is excluded.
  Both join the next hourly job, rather than starting a second classifier.
- **设置** keeps off/shadow/live, the existing daily Gmail write cap and undo controls. Shadow records decisions without writes;
  off stops Gmail reads and classification. Existing write limits still apply.

Routine runs do not reclassify already graded messages, including after a prompt update. Every reply has its own
message identity. A model failure leaves mail unclassified for the next hour; no fallback classifier assigns P1.
Persisted decisions waiting for Gmail writes resume through the existing ledger without calling Codex again.
If an explicit recheck exceeds 100 messages, its remaining members continue next hour. Once all were judged,
new mail can be checked while previous Gmail writes wait for their daily allowance.

## Components

- `mailsort/`: Cloudflare Worker, existing SQLite `MailsortState` DO and owner UI. It owns the Gmail grant,
  message preparation, classification records, write ledger, retention and Home's private Ops binding.
- [`mailsort-runner/`](../mailsort-runner/README.md): independent image and hourly k3s CronJob. It claims masked
  inputs, makes one Codex turn for at most 100 messages, reports the results and exits. No VPS HTTP port is added.
- [`proto/mailsort/runner/v1`](../proto/mailsort/runner/v1/mailsort_runner_service.proto): the two typed machine
  endpoints, `classification:claim` and `classification:report`. They use a separate Bearer; owner APIs keep
  Access JWT, Origin and CSRF checks. The VPS has no Gmail credential.

The Alarm maintains Gmail history, owner corrections, retention and pending Gmail writes. It no longer calls
Clef, embeddings or replay evaluation. Historical decisions and ledgers remain readable. The Worker no longer
has a Workers AI binding.

The maintained instructions are [`prompt.txt`](../mailsort-runner/src/mailsort_runner/prompt.txt). Change that file,
pass branch CI and publish the same SHA through main. The prompt hash travels with every batch. No new database,
queue or model-provider framework is involved.

## Development

Node 26, from `worker/`:

```sh
npm ci
(cd ../web && npm ci && npm run build)
npm run lint && npm run typecheck && npm test
npm run test:runtime
npm run test:smoke
node --test ../deploy/test/*.test.mjs
```

UI checks run in `web/`. Runner checks and image build instructions are in its README. Workerd and the real local
Wrangler smoke use synthetic mail, fake Gmail and submitted synthetic model results; they make no live model call.
The runtime checks cover actual local SQLite/HTTP writes and Worker/DO CPU limits. They do not measure model quality.

## Deployment and credentials

Pass the complete branch CI gate, then publish that exact SHA through main. Mailsort's wrapper injects build,
mode and secrets; it preserves the owner's Gmail grant. Never deploy with plain Wrangler or place Gmail tokens
in GitHub. `CLASSIFICATION_TOKEN_SHA256` is the machine token's digest in `MAILSORT_WORKER_SECRETS`; the raw token
is only in the runner's private Kubernetes Secret. Only the two exact machine paths bypass interactive Access.

First installation uses the fixed CI bundle's [runner foundation](../tools/vps-bootstrap/README.md)
for its independent auth volume and Secret. Complete the runner's own official Codex login; do not share
Newsletter's auth volume. Subsequent updates use the existing deployment daemon and GitHub Actions.
A verified CronJob template does not prove that a natural batch ran or that Gmail accepted its labels.

See [design](docs/design.md), [collaboration rules](AGENTS.md) and the root [rebuild guide](../docs/rebuild.md).
