# mailsort

Gmail sorting for the owner's own mailbox on `sort.ziyixi.science`: each new INBOX mail is decided by the Workers AI
decision model Clef, asked twice (two views), with the masked mail, whether its sender is authenticated, the nearest
corrected examples and what the sender's earlier mail got. In live mode a confident mail gets one label (a leaf of up
to three levels, `金融/投资`, at Gmail's top level) and leaves the inbox (archived) unless its label keeps it there or it
asks you to act soon (a code, a payment, a reply), and is never marked read; a mail no label fits, or an uncertain one,
gets no label and stays in the inbox, and a few uncertain ones a day (about 1 in 20) wait in the review queue. Shadow
mode (the default) only records. Chinese, mobile first. Design: [`docs/design.md`](docs/design.md). Rules:
[`AGENTS.md`](AGENTS.md).

| Path | What it is |
| --- | --- |
| `worker/` | The Worker `mailsort`: the fetch handler (Access, CSRF) and `MailsortState` (storage, alarm, pipeline, owner API, ops-v1) |
| `worker/src/gmail.ts` | The only code that calls Google, through a closed table of allowed requests (`docs/design.md` §2) |
| `web/` | The UI, built into `web/dist` and served by the Worker |
| `wrangler.toml` | The production config (top level = production); `wrangler.test.toml` is for local development and the smoke run |
| `deploy/` | The deploy wrapper `deploy-vars.mjs`, the bundle budget, and the owner's Gmail grant script `mint-token.mjs` |
| `../proto/mailsort/ui/v2/` | The owner API `mailsort.ui.v2` (`/api/v2/`; the paths of v1 answer 410 until 2026-11-10) |

## Use

Four tabs under a header whose one status line shows the mode in force, the Gmail grant and the next run
(`docs/design.md` §9):

- **待审**: only the few uncertain mails of a day (at most 1 to 5, 5 % of the last week's daily mail); with none it says
  没有需要你确认的邮件. Each row shows the masked subject and sender, why the model was unsure in plain words, and the
  answers as one-tap buttons: the model's likely labels with their probabilities, 都不是, 其他… (a searchable picker
  over every label) and 跳过; j / k, the digits, Enter, c and s do the same by keyboard. An answer with a trust label
  for a sender that passed DMARC teaches that label the sender's domain (the question before it says so).
  Corrections made in Gmail itself (moving a sorted mail to another of mailsort's labels, or removing the label)
  count too.
- **概览**: one status line (what the mode does, the last sync, mail waiting), today's numbers with their last 7 days
  (处理, 有把握, 都不是, 拿不准), the flow of today's mail as a Sankey diagram (the model's stages to the labels, 都不是
  and 拿不准, split by whether it went to 待审; drawn at zero on a day without mail; on a phone it scrolls in its own
  box, starting at where the mail went), a table of the last 7 days per label (自动, 改正, 拿不准) and the model budget.
- **标签**: everything about a label in one place. A search box finds a label by its path. The labels form a tree
  grouped by their top level (开发 › CI通知, 平台工具), one line each: the name (未启用 beside it when off), how many mails
  the model was sure of for it in the last 7 days, and 启用 (an enabled label is offered to the model and written to
  Gmail in live mode). A row opens its detail under it: the description (the model reads `path: description` and
  never picks a label without one; one language and 60–120 characters keep every call cheap, `docs/design.md` §8.1),
  归档 (off: the label is only added and the mail stays in the inbox), a trust label's trusted domains (learned from
  待审, each with 删除), the examples (listed on demand, deleted one by one) and 高级 (可信, 敏感 to keep no example,
  rename, delete). A trust label is written only for a sender that passed DMARC and whose domain it trusts
  (`docs/design.md` §4.4). A label's Gmail name is its path; when Gmail already has a label of exactly that name (made
  by hand), mailsort never takes it over: the label's detail says so in its first line (Gmail 里已有同名标签) and it
  writes nothing until it is renamed or 从 Gmail 同步 adopts (沿用) that label. An adopted label is never added to a mail
  that already has it, so an undo never removes the owner's own, and the owner's other labels are never touched.
  Deleting a label leaves its Gmail label and mails alone, and its writes can no longer be undone.
- **设置**: the mode (关闭 · 影子 · 正式, with the deployment's ceiling, a tripped breaker and 解除熔断, or a read-only
  Gmail grant under 正式 in one line); 撤销, the undo of a time range (1 hour, 24 hours, 7 days or your own), of one
  label when chosen, previewed first; and 从 Gmail 同步 (follows renames and deletions made in Gmail and adopts such
  labels, never one with labels nested under it; it never imports another one). Emergency stop: 设置 → 关闭
  (`docs/design.md` §10).
- **API only**: the replay evaluation (before going live: your answers of the last 14 days decided again by today's
  pipeline, nothing written, `docs/design.md` §5.1), the embedding rebuild, the single-entry undo, the write limits and
  the neuron budget. To run the replay from the signed-in page's console:

  ```js
  const t = (await (await fetch('/api/csrf')).json()).token
  await fetch('/api/v2/replayEvaluation:start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': t }, body: JSON.stringify({ request_id: crypto.randomUUID() }) }).then((r) => r.json())
  // a few alarm passes later (about 6 mails each):
  await fetch('/api/v2/replayEvaluation').then((r) => r.json())
  ```
- **What is kept**: decided mail's subject, sender and From domain, and the review queue, for 14 days (the daily
  cleanup runs in every mode, off included); decisions and the ledger without content (the sender only as a keyed hash)
  for 180 days; the replay evaluation for 7 days; the flow counters (counts only) for 400 days; examples (masked
  summaries) until you delete them (with their label, by turning it 敏感, or DeleteExample) and trusted domains until you
  delete them (`docs/design.md` §2).

## Develop

From `worker/` (Node 26; the pinned toolchains are in each package's lockfile):

```sh
npm ci && (cd ../web && npm ci)
npm run lint && npm run typecheck && npm test   # unit tests (Node): the decision table, the migration, the Gmail guard and its fuzz
npm run test:runtime                            # workerd: real MailsortState, fake Gmail and Workers AI, CPU
(cd ../web && npm run lint && npm run typecheck && npm test && npm run build)
node --test ../deploy/test/*.test.mjs
npm run test:smoke                              # wrangler dev against the loopback fakes (needs the UI build)
```

Trying the UI by hand (synthetic mail only, never Google): copy `../.dev.vars.example` to `../.dev.vars`, build the UI,
then in two terminals from `worker/`:

```sh
node test/smoke/fake-upstream.mts 8796     # the fake Gmail and Workers AI
npm run dev                                # wrangler dev on http://127.0.0.1:8795 (local bindings only)
```

`curl -X POST 'http://127.0.0.1:8796/__fake/deliver?mail=newsletterZh'` delivers a synthetic mail (the names are in
`test/fakes/fixtures.ts`), `curl -X POST 'http://127.0.0.1:8795/__dev/step?now=<epoch ms>'` runs an alarm pass and
`/__dev/clock?now=` sets the API's clock. Local state is in `mailsort/.wrangler/` (delete it after a schema change).

## Deploy

Only from GitHub Actions: `Mailsort deploy` (`.github/workflows/ci.yml`) on `main` after `CI gate`, in the
`production` environment, through `deploy/deploy-vars.mjs` (never a plain `wrangler deploy`). Until the Access
application `mailsort` exists, `mailsort` is in `CHECK_ONLY` (`.github/scripts/ci_changes.py`): its checks run, its
deploy and Home's (which binds `MAILSORT`) do not. The steps that lift it are in `docs/design.md` §12.

The wrapper writes the Worker secrets `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` (from the dashboard's secrets: one
owner) and `CSRF_SIGNING_KEY` (from `MAILSORT_CSRF_SIGNING_KEY`), and sets `MODE` from the GitHub variable
`MAILSORT_MODE` (`live`, `shadow` or `off`; an unset or other value stops the deploy before wrangler runs, and a
Worker without `MODE`, such as after a plain `wrangler deploy`, reads it as off) and `BUILD_SHA`. It never writes, needs or deletes the
Gmail secrets `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN`: `wrangler deploy --secrets-file` keeps
secrets the file does not name (pinned by `deploy/test/secrets-kept.test.mjs`), and the wrapper refuses a secrets file
that names them. Only the owner puts them, with `deploy/mint-token.mjs` from their own machine (`docs/design.md` §12).

```sh
openssl rand -hex 32 | gh secret set MAILSORT_CSRF_SIGNING_KEY -R ziyixi/todofy --env production
gh variable set MAILSORT_MODE -R ziyixi/todofy --env production --body shadow
```

After the first deploy, open `https://sort.ziyixi.science/` signed in: the header's status line must show the next
run, and, once the grant is put, `Gmail ✓`. Home's 邮件分拣 tile shows ops-v1 through the `MAILSORT` binding and the
daily drift check compares the Worker with `dashboard/worker/src/drift-desired.json`.

### Rollback

A code-only revert is the normal path. To stop the Gmail side effects at once: 设置 → 关闭 (or `MAILSORT_MODE=off`
and a deploy), and revoke the grant at https://myaccount.google.com/permissions. Writes already made can be undone
from 设置 → 撤销 while the app runs. Deleting the Worker deletes `MailsortState` (labels, trusted domains, examples,
ledger) for good.
