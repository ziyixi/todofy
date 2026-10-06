# mailsort

Gmail sorting for the owner's own mailbox on `sort.ziyixi.science`: each new INBOX mail is decided by the owner's rules,
the nearest corrected examples and the Workers AI decision model Clef. In live mode a confident mail gets one label
under `分拣/` (a leaf of up to three levels, `分拣/金融/投资`) and leaves the inbox (archived) unless its label or rule keeps it
there, and is never marked read; an unsure mail gets no label, stays in the
inbox and waits in the review queue. Shadow mode (the default) only suggests. Chinese, mobile first. Design:
[`docs/design.md`](docs/design.md). Rules: [`AGENTS.md`](AGENTS.md).

| Path | What it is |
| --- | --- |
| `worker/` | The Worker `mailsort`: the fetch handler (Access, CSRF) and `MailsortState` (storage, alarm, pipeline, owner API, ops-v1) |
| `worker/src/gmail.ts` | The only code that calls Google, through a closed table of allowed requests (`docs/design.md` §2) |
| `web/` | The UI, built into `web/dist` and served by the Worker |
| `wrangler.toml` | The production config (top level = production); `wrangler.test.toml` is for local development and the smoke run |
| `deploy/` | The deploy wrapper `deploy-vars.mjs`, the bundle budget, and the owner's Gmail grant script `mint-token.mjs` |
| `../proto/mailsort/ui/v1/` | The owner API `mailsort.ui.v1` |

## Use

- **标签**: add the labels (a path such as `金融/投资`, shown as a tree; a description of what belongs there; the threshold;
  whether it implies a trusted sender; 归档, off to keep its mail in the inbox; 敏感, to keep no example of it). The
  model reads `path: description` for each label with a description and is never offered one without; one language
  and 60–120 characters keep every call cheap (`docs/design.md` §8.1). 套用推荐模板 previews 15 recommended labels. 同步
  Gmail links `分拣/` labels that already exist and imports the other leaves (disabled, without a description). 正式打 per label lets live mode write it; it turns itself off when the label's precision
  bound falls below the target. Deleting a label leaves its Gmail label and mails alone, and its writes can no longer
  be undone from 记录.
- **待审**: confirm a suggestion, choose another label or 都不是, or skip. Corrections made in Gmail itself (moving a
  sorted mail to another `分拣/` label, or removing the label) count too.
- **规则**: approve the rules proposed from repeated corrections, add exact-address, domain, mailing-list or
  delivered-to rules by hand (with subject words to include or exclude, a carve-out tried before the sender's plain
  rule, and keep in inbox), and export them as Gmail filters (label, and archive unless kept) to import in Gmail's
  settings; left out are trust and DMARC rules, rules with subject conditions and the plain rules of the senders they
  cover (Gmail would apply both). A sender rule fires only when DMARC passed aligned with the From domain, a list rule only with a DKIM
  signature of the list's domain (`docs/design.md` §4.3).
- **导入**: import the owner's rule file or an export (pasted or uploaded JSON), or the template: a preview of every
  create, update, skip or invalid entry first, then 确认导入 (all or nothing); export every label (with its 启用) and rule
  as JSON.
- **流程**: how mail moved through the pipeline today, over 7 or 30 days (a Sankey diagram and a table per label; a
  label opens its 操作记录); 状态 shows today's, compact.
- **例子**, **准确率**, **记录** (undo one write or a time range, of one label when opened from 流程), **状态** (Gmail grant, sync, today's model use),
  **设置** (mode, limits, neuron budget; 解除熔断 after the breaker tripped). Emergency stop: 设置 → 关闭
  (`docs/design.md` §10).
- **What is kept**: decided mail's subject, sender and exact sender keys, and the review queue, for 14 days (the
  daily cleanup runs in every mode, off included); decisions and the ledger without content for 180 days; the flow
  counters (counts only) for 400 days; examples (masked summaries) and rules (exact sender, domain, list or
  delivered-to values, subject words, your evidence and notes) until you delete them (`docs/design.md` §2).

## Develop

From `worker/` (Node 26; the pinned toolchains are in each package's lockfile):

```sh
npm ci && (cd ../web && npm ci)
npm run lint && npm run typecheck && npm test   # unit tests (Node), the Gmail guard and its fuzz included
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

After the first deploy, open `https://sort.ziyixi.science/status` signed in: it must show the next alarm, and, once
the grant is put, a sync within five minutes. Home's 邮件分拣 tile shows ops-v1 through the `MAILSORT` binding and the
daily drift check compares the Worker with `dashboard/worker/src/drift-desired.json`.

### Rollback

A code-only revert is the normal path. To stop the Gmail side effects at once: 设置 → 关闭 (or `MAILSORT_MODE=off`
and a deploy), and revoke the grant at https://myaccount.google.com/permissions. Writes already made can be undone
from 记录 while the app runs. Deleting the Worker deletes `MailsortState` (labels, rules, examples, ledger) for good.
