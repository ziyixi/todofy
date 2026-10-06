# mailsort design

Gmail sorting for the owner's own mailbox on `sort.ziyixi.science`: new INBOX mail is decided by rules, the nearest
corrected examples and the Workers AI decision model Clef, then labelled under the nested prefix `分拣/` and archived
in live mode, never marked read. Unsure mail gets no label and stays in the inbox. The owner teaches it by correcting
labels in Gmail or in the review queue; nothing is fine-tuned.

The owner's decisions of 2026-10-06 shape v1: one label per mail; labels under `分拣/`; confident mail labelled AND
archived, `UNREAD` never touched; unsure mail left alone and listed in the review queue; no backfill of history (the
sync starts at the install-time history ID); Clef (27B) by default, Clef-flash for the rest of a UTC day past 70 % of
the daily neuron budget, and a deferral (never a failure) when Workers AI's quota is used up.

## 1. Shape

One Worker, `mailsort`, and one SQLite Durable Object, `MailsortState` ("mailsort-v1"), the shape of the watch app:

| Part | Responsibility |
| --- | --- |
| `worker/src/http.ts` | Access JWT (packages/edge-auth), Origin + CSRF on mutations, then one call to the object; static UI |
| `worker/src/state.ts` | The object: SQLite, the alarm (`setAlarm`, no cron), the owner API through the shared transcoder, ops-v1 |
| `worker/src/gmail.ts` | **The only code that talks to Google**: the closed table of operations (§2) |
| `worker/src/pipeline.ts` | One alarm pass: sync, feedback, decide, write, embed, daily work (§4) |
| `worker/src/decide.ts`, `ai.ts` | Rules, neighbours, Clef's request and strict answer, the decision |
| `worker/src/feedback.ts`, `examples.ts`, `accuracy.ts` | Verdicts, examples, rule proposals, the precision bound (§6) |
| `worker/src/writes.ts` | The ledger of Gmail writes (§7) |
| `web/` | The Chinese, mobile-first UI (no framework) over `mailsort.ui.v1` |
| `../proto/mailsort/ui/v1/` | The owner API (AIP resources and custom methods) |

No D1, R2, KV, queue or cron. The object's SQLite holds labels, rules, the pending queue, decisions, the review queue,
examples with their bge-m3 embeddings (1024 floats as a BLOB), the ledger, daily usage and the AIP-155 request log.

## 2. Safety model

Two walls, neither of them a prompt:

1. **The grant.** The owner's Desktop OAuth client asks for `gmail.readonly` in shadow and `gmail.modify` in live,
   never `https://mail.google.com/`, the only scope that deletes mail for good. `deploy/mint-token.mjs` refuses a
   grant that includes it (or any scope besides the two).
2. **The closed table** (`gmail.ts` `checkRequest`, run before every fetch). A request that is not one of these shapes
   throws `GmailRefused` and never leaves the isolate:

   | Operation | Shape |
   | --- | --- |
   | token | `POST oauth2.googleapis.com/token`, refresh_token grant only |
   | profile | `GET users/me/profile?fields=historyId` (the install-time cursor; the address is never read) |
   | history | `GET users/me/history`, `historyTypes` ⊆ messageAdded/labelAdded/labelRemoved, `labelId` absent or INBOX |
   | messages_list | `GET users/me/messages?labelIds=INBOX&q=newer_than:2d` (the resync after a lost cursor) |
   | message_get | `GET users/me/messages/{id}`, `format=full` or `metadata` with the fixed header list and `fields` |
   | labels_list | `GET users/me/labels` |
   | labels_create | `POST users/me/labels`, a name under `分拣/` only |
   | labels_patch | `PATCH users/me/labels/{owned id}`, the name only, still under `分拣/` |
   | message_modify | classify: `addLabelIds = [one owned label]`, `removeLabelIds = [] or [INBOX]`, for a ledger row in `intended`/`applied` whose archive flag matches; undo: `removeLabelIds = [that owned label]`, `addLabelIds = [] or [INBOX]` (INBOX exactly when the row archived), for a row in `undo_intended` |

   So trash, untrash, delete, batchDelete, batchModify, send, drafts, filters, settings and forwarding have no path,
   and neither have `UNREAD`, `STARRED`, `IMPORTANT`, `SPAM`, `TRASH`, `CATEGORY_*` or any label mailsort does not own
   (an owned label is a linked label whose Gmail name starts with `分拣/`). Feedback never writes.

   `test/gmail-guard.test.ts` records every call GmailClient makes through a fake fetch and checks it against an
   independent copy of the table (`test/fakes/table.ts`), tries every forbidden operation, and throws 20,000 seeded
   random operations at the guard; the workerd tests and the smoke run check every request the fake Gmail receives
   against the same independent table.

Three differences from the first plan, each for a reason: `history.list` is read without `labelId=INBOX` (an archived
mail has no INBOX, and the owner's label changes on it are the main feedback; the pipeline filters new mail by its
labels instead); `profile` (fields=historyId only) gives the install-time cursor without reading any message; and
`labels.patch` exists so a rename in the dashboard renames the Gmail label (name only, still under the prefix).

Other guarantees: the Gmail grant lives only in Worker secrets the owner puts from their own machine (§12), never in
GitHub; logs hold counts and codes only (never a subject, sender, address or label name); the model sees masked text
only (§4.2); mail content is untrusted data, and the model has no tools: the worst a hostile mail can do is pick a
wrong label, which a review or an undo reverts. Content kept in SQLite (subjects, senders, summaries, the exact sender
keys) is cleared after 14 days; decisions and the ledger (IDs, labels, probabilities) are kept 180 days.

## 3. Modes and limits

| Mode | Reads Gmail | Decides | Writes Gmail |
| --- | --- | --- | --- |
| off | no | no | no |
| shadow (default) | yes | yes, every decision a suggestion in the review queue | no |
| live | yes | yes | confident decisions of labels marked 正式打 (label + archive), and the owner's review choices |

The mode in force is the owner's (设置), lowered by the deployment's ceiling `MODE` (the GitHub variable
`MAILSORT_MODE`: `live`, `shadow` or `off`; anything else reads as off) and by the breaker (live becomes shadow).
Writes are capped per alarm run (`run_write_limit`, at most 10) and per UTC day (`daily_write_limit`, default 150);
passing either, or one label's share of today's writes jumping above 60 % and twice its last week's share (once there
are 15 writes today and 30 in the week), trips the breaker: the effective mode is shadow until the owner chooses a
mode again, and ops-v1 raises `breaker_tripped`. A read-only grant never writes, whatever the mode.

## 4. The pipeline (one alarm pass)

The alarm runs every 5 minutes, every 30 s while a backlog waits. A pass may make 40 subrequests (Workers Free allows
50), shared by Google and Workers AI:

1. **Session.** Without the three Gmail secrets nothing is called (`gmail_not_configured`). A refused grant
   (`invalid_grant`, a 401) counts a strike; three in a row mark it failed and stop every Google call until the refresh
   token changes (its fingerprint), raising the critical ops-v1 signal `gmail_auth_failed`, which reaches Home's
   attention and the daily digest. The access token is cached in memory for 55 minutes, never stored.
2. **Sync.** The first pass stores the mailbox's current history ID: no backfill. Later passes read up to three history
   pages of 100 records; new mail with INBOX (and none of SENT, DRAFT, SPAM, TRASH, CHAT) goes to `pending`, and owned
   label changes on decided mail go to `feedback`, in the same transaction that advances the cursor. A lost cursor (404)
   is a bounded resync: the inbox's mail of the last two days (at most 100, deduplicated) and a fresh cursor.
3. **Feedback** becomes verdicts, examples and rule proposals (§6).
4. **Retries** of writes an earlier pass left `intended` come first.
5. **Drain**: up to 6 pending mails while 5 subrequests per mail are left. Per mail:
   - `messages.get` (full, at most 512 KiB, else metadata only); skip what is not incoming INBOX mail, and mail whose
     thread mailsort or the owner already sorted (one label per conversation);
   - features: the exact sender address, domain, List-Id and delivered-to address (for rules only), and the masked text
     (§4.2); DMARC alignment from Gmail's own topmost `Authentication-Results` (authserv-id `mx.google.com`);
   - stage 1, **rules**: an active rule of an enabled label decides (the most specific kind wins: address, list,
     delivered-to, domain; a disagreement within a kind decides nothing). A label that implies trust needs DMARC aligned;
   - stage 2, **neighbours**: when examples exist, the mail's summary is embedded (bge-m3) and compared by cosine with
     every embedded example of an enabled label; the three nearest go into Clef's state (each cut to 120 tokens). Only
     when the sender passed DMARC aligned and all three agree with similarity ≥ 0.92 on a non-trust label does that
     label decide without the model;
   - stage 3, **Clef**: one call with a `choice` question over the enabled labels (their stable IDs, the owner's
     descriptions as criteria) plus `none`, and two `noul` questions, `suspicious` and `bulk`. The answer must have
     exactly those keys and options, probabilities in [0, 1] summing to 1. Label L when the top option is not `none`,
     p(L) ≥ L's threshold (default 0.8), p(suspicious) < 0.3, L is enabled and does not imply trust; otherwise unsure,
     with the reason;
   - the outcome: a Gmail write (live, the label live, a write grant, within the limits), else a suggestion, else
     unsure; every decision is recorded with its probabilities, model, and the description versions of the labels.
6. **Embeddings** of new examples, 8 per pass (one batched call).
7. **Daily** (once per UTC day): weak accepts, the audit sample, live gating (§6) and the retention cleanup.

### 4.1 Workers AI budget

Neurons are estimated from each answer's reported input tokens at the published prices (Clef 21,818, Clef-flash 8,182,
bge-m3 1,075 neurons per million input tokens). Past 70 % of the owner's daily neuron budget (default 7,000 of the
account's 10,000) the rest of the UTC day uses Clef-flash; past the budget, or when Workers AI refuses for quota (its
daily free allocation), every waiting mail is deferred to the next UTC day: deferred, never failed, never unsure.
Home's guard (its 80 % rule) sheds deferrable work: Clef-flash only, no audit sample, no embedding rebuild.

### 4.2 What the model reads

The sender's display name and domain (masked), a short code for the delivered-to address (`to-` and 6 hex of a hash,
never the address), whether there is a mailing list, the subject (200 characters), Gmail's snippet (300), the first
text/plain part or the stripped first text/html part (2,000), Gmail's category, and the neighbours' summaries. Every
email address becomes `[email]`, every run of six or more digits `[number]`, every URL `[link <domain>]`, with linear
patterns only (hostile text cannot make them slow). No AI Gateway: it would log request bodies.

## 5. The review queue

Shadow suggestions, unsure mail (reason shown) and a few random applied mails a day (the audit) wait in 待审 with the
masked subject and sender (kept 14 days). 确认 takes the suggestion, 改为所选 another label or 都不是, 跳过 leaves it.
In live mode a choice is also written to Gmail: the chosen label added and INBOX removed (for an audited mail the
Worker's own label is undone first; 都不是 restores the inbox). A choice is a verdict (§6).

## 6. Learning from the owner

- **Verdicts.** From the review queue, and from Gmail itself: history records of owned labels on decided mail are
  compared with what mailsort left there. Moving an applied mail to another owned label is a correction to it,
  removing the label only a correction to none, putting it back withdraws the correction; adding an owned label to a
  mail mailsort only suggested is a confirmation (the suggested label) or a correction. mailsort's own writes update the
  known labels when they are made, so their history records are not feedback. An applied label untouched for 3 days is
  a weak accept.
- **Examples.** A verdict with a label stores the mail's masked summary (at most 200 characters) as an example of that
  label (origin correction, confirmation or weak accept; weak accepts only while the label has fewer than 50) and the
  next pass embeds it. A withdrawn verdict deletes it, deleting a label deletes its examples. At most 200 per label and
  2,000 in all (the oldest weak accepts go first). 例子与向量库 shows the counts and the embedding backlog, deletes one,
  or drops every embedding for a rebuild.
- **Rule proposals.** The same mailing list (else the same sender address) corrected to the same label twice proposes
  a rule; it decides nothing until the owner approves it in 规则. Withdrawn corrections retract a proposal that falls
  below two. Active rules export as Gmail's filter XML (label + archive; rules that need DMARC are left out) for the
  owner to import by hand, so stable rules keep working without this app.
- **Accuracy and live gating.** Per label, confirmations count 1, weak accepts 0.5 and corrections 1 against, and
  准确率 shows the Wilson 95 % lower bound of the precision (35 confirmations without an error pass 0.90). The owner turns
  正式打 on per label; the daily pass turns it back off when the bound drops below the target (default 0.90) after a
  correction since it went live (ops-v1 `label_live_revoked`).
- TODO (not in v1): a weekly suggestion of description changes from the recurring corrections, approved by the owner.

## 7. The ledger

Every Gmail write is a ledger row first (`intended`, or `undo_intended` for an undo), committed before the request;
then the modify, which the guard accepts only for such a row; then the outcome (`applied`, `undone`, or `failed` for
a mail that is gone or a read-only grant). A pass interrupted between the two retries the same row (adding a label that
is there, or removing one that is gone, changes nothing). Undo removes exactly the row's label and restores INBOX
when it archived; it is refused for a mail the owner has since moved to another label. 操作记录 undoes one entry, or a
time range (20 per call, repeat until none is left). Labels are created in Gmail (`分拣/<name>`) just before the first
write that needs them; SyncLabels links existing `分拣/` labels and imports the ones mailsort does not know.

## 8. Limits and measured costs

Workers Free: 10 ms of CPU per Worker request, 30 s per Durable Object invocation, 50 subrequests. The CPU test
(`worker/test/runtime/cpu.test.ts`, reference ms of the shared meter, 2026-10-06 on the reference machine): the fetch
handler's very first request 3.0 ms (bound 6), every other request at most 1.3 ms first run (bound 6) and 0.8 ms warm
(bound 2.5); MailsortState's heaviest API calls 1.4-4.2 ms first run (24 labels, a page of 50 review items, the accuracy
report over 2,000 decisions; bound 300); an alarm pass at its bounds (three history pages, 6 mails decided, 2,000
embedded examples searched) 30 ms (bound 1,500). Bundles: the Worker 110.0 KiB gzip (budget 135), the UI 45.2 KiB gzip
(budget 54).

Stores are bounded: 24 labels, 500 rules, 2,000 examples, request IDs for a day, content for 14 days, records for
180 days. Rows read: a pass reads a few rows per mail plus the embedded examples (cached in memory between passes).

## 9. The owner API and the UI

`mailsort.ui.v1` (`proto/mailsort/ui/v1`): labels (List/Get/Create/Update/Delete, `labels:sync`), review items
(List/Get, `:confirm`, `:correct`, `:skip`), rules (List/Get/Create/Delete, `:approve`, `:disable`,
`rules:exportGmailFilters`), examples (List/Get/Delete, `examples:rebuildEmbeddings`), ledger entries (List/Get,
`:undo`, `ledgerEntries:undo` for a range), and the singletons accuracyReport, serviceStatus and settings
(UpdateSettings needs an explicit mask). AIP-155 request IDs on every mutation, AIP-154 etags on labels and settings,
google.rpc.Status errors (`errors.proto`). The UI's eight views: 待审, 标签, 规则, 例子, 准确率, 记录, 状态, 设置.

## 10. Operations

- **ops-v1** (`Ops` entrypoint, Home's `MAILSORT` binding): counters `decided_today`, `applied_today`, `unsure_today`,
  `review_pending`, `pending`, `gmail_calls_today`, `neurons_today`, `neuron_budget`, `last_sync_minutes`; modes
  `maintenance` (always false), `mode_limited` (MODE below live), and from storage `live`, `sorting_off`, `breaker`;
  signals `gmail_auth_failed` (critical), `gmail_not_configured`, `breaker_tripped`, `sync_stale` (warnings),
  `ai_quota_exhausted`, `label_live_revoked`, `guard_shed` (information). Counts and codes only. The guard defers
  `full_model`, `audit` and `embedding_rebuild`.
- **Emergency stop**, from fastest: 设置 → 关闭; the GitHub variable `MAILSORT_MODE=off` (or `shadow`) and a redeploy;
  revoking the grant at https://myaccount.google.com/permissions (Google account → Security → Third-party access).
- **Logs**: one line per alarm (mode, counts, a code) and per refused request (request ID, status, reason).

## 11. Tests

All data is synthetic (Chinese and English mails from example.com-style domains, `worker/test/fakes/fixtures.ts`);
the fake Gmail (`fake-gmail.ts`) and fake Workers AI (`fake-ai.ts`, Clef and bge-m3) answer every request.

- `worker/test/*.test.ts` (Node): the guard and the fuzz, masking, MIME, DMARC, the decision, Clef's strict read,
  the Wilson bound, the filter export, ops-v1's golden bytes (two are contract fixtures).
- `worker/test/runtime/*.test.ts` (workerd, a real SQLite MailsortState): the pipeline in shadow and live, unsure,
  undo, corrections into examples and proposals, trust labels, skips, the resync, the auth stop, the Clef-flash switch,
  the quota deferral, the breaker, a read-only grant, the owner API, ops-v1 over a service binding, CPU.
- `worker/test/smoke/smoke.mts`: the real `wrangler dev` (`../wrangler.test.toml`) against the fakes on loopback,
  the owner's whole loop through the HTTP API.
- `web/src/*.test.ts`: the views against a fake API on the shared transcoder.
- `deploy/test/*.test.mjs`: the production config, the deploy wrapper (MODE, the secrets file without the grant), that
  `wrangler deploy --secrets-file` keeps secrets it does not name (the pinned wrangler), and mint-token's checks.

## 12. Owner setup and going live

Done by the owner, on their own machine and accounts (nothing here can do it):

1. **Google Cloud project**: a new dedicated project; enable the Gmail API.
2. **OAuth consent screen**: user type External; add only the scope `gmail.readonly` (later `gmail.modify`); add
   yourself as a user; set the publishing status to **In production** without submitting for verification (a personal
   app under 100 users may stay unverified; in Testing, refresh tokens expire after 7 days).
3. **Client**: create an OAuth client of type **Desktop app**.
4. **Advanced Protection**: check that the Google account is not enrolled in Advanced Protection (it blocks
   unverified apps).
5. **Grant**, after the first deploy (`wrangler secret put` needs the Worker to exist; until then the app runs and
   reports `gmail_not_configured`): from `mailsort/worker/` after `npm ci` and `npx wrangler login`:
   `GMAIL_CLIENT_ID=… node ../deploy/mint-token.mjs --scope readonly` (the secret is asked for, hidden). It runs the
   loopback OAuth flow with PKCE, accept the "unverified app" notice once, and puts `GMAIL_CLIENT_ID`,
   `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` into the Worker with `wrangler secret put`. Never paste them into a
   chat or GitHub. For live mode, run it again with `--scope modify`.
6. **Revoke** any time: https://myaccount.google.com/permissions.

Before the first deploy (the repository side, as the watch app's W2): "Infra apply" creates the Access application
`mailsort` (`infra/access.tf`); its AUD goes into `config/resources.toml` `[access_audiences]` (then
`tools/cloud-config/generate.py` writes `ACCESS_AUDIENCE` into `wrangler.toml`) and its id into `infra/ids.tf`; the
GitHub production secret `MAILSORT_CSRF_SIGNING_KEY` (64 hex) and variable `MAILSORT_MODE` (`shadow` to start) are
created; then `mailsort` leaves `CHECK_ONLY` in `.github/scripts/ci_changes.py` (which also lets Home deploy with its
`MAILSORT` binding). After the first deploy, the `MailsortState` namespace id goes into `config/resources.toml`
`[durable_objects]` as `mailsort-state`.

Then: run in shadow for 1-2 weeks, confirm or correct a few mails a day, and turn 正式打 on per label once its
precision bound reaches the target; set the mode to live (and `MAILSORT_MODE=live`) with a `gmail.modify` grant.
