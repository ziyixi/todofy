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

   JSON bodies must be the canonical text of the value the guard checked (`JSON.stringify` of it): a duplicate key
   (`JSON.parse` keeps the last, a server might keep the first) or any other spelling is refused (`body_not_canonical`).

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
wrong label, which a review or an undo reverts.

Retention, as the code does it (`store.ts` `prune`, once per UTC day from `pipeline.ts` `retain`, in every mode: off
reads no Gmail and decides nothing, but the alarm still runs and still clears what is past its time):

| What | Kept |
| --- | --- |
| A decision's content: masked subject, sender and summary, and the exact sender address, domain, List-Id and delivered-to address | 14 days |
| The review queue (masked subject and sender) | 14 days |
| Decisions and the ledger without content (IDs, labels, probabilities, model, states) | 180 days |
| Examples: a masked summary (subject, sender name and domain, snippet; at most 200 characters) and its embedding | until deleted (例子, or with their label), at most 2,000 |
| Rules: the exact sender address, domain, List-Id or delivered-to address, proposed or active | until deleted (规则, or with their label), at most 500 |

Examples and rules are what the app learned, so they outlive the 14 days on purpose; both are shown in full in the
dashboard and can be deleted there one by one.

`firstMailbox` (`mask.ts`) reads the sender as Gmail's DMARC does: quoted display names and comments are blanked out
before the address is taken, so `"<boss@work.example>" <x@evil.example>` is x@evil.example, never the address in the
display name (which no sender rule may match).

## 3. Modes and limits

| Mode | Reads Gmail | Decides | Writes Gmail |
| --- | --- | --- | --- |
| off | no | no | no |
| shadow (default) | yes | yes, every decision a suggestion in the review queue | no |
| live | yes | yes | confident decisions of labels marked 正式打 (label + archive), and the owner's review choices |

The mode in force is the owner's (设置), lowered by the deployment's ceiling `MODE` (the GitHub variable
`MAILSORT_MODE`: `live`, `shadow` or `off`; the deploy wrapper refuses any other value, and a missing or unknown
`MODE` reads as off) and by the breaker (live becomes shadow).
Writes are capped per alarm run (`run_write_limit`, at most 10, retries of earlier passes included; a pass decides at
most 6 mails, so a value of 1 to 5 can trip on an ordinary busy pass) and per UTC day (`daily_write_limit`, default
150); passing either, or one label's share of today's writes jumping above 60 % and twice its last week's share (once
there are 15 writes today and 30 in the week), trips the breaker: the effective mode is shadow until the owner
chooses a mode again (an UpdateSettings whose mask names `mode`: 设置's 解除熔断, or another mode; a save of any other
field keeps the breaker), and ops-v1 raises `breaker_tripped`. A read-only grant never writes, whatever the mode.

**Whether a write may go out is read at the moment of the write**, not once per pass (`pipeline.ts` `alarmGate`, the
`WriteGate` of `writes.ts`). Right before each `intended` ledger row goes to Gmail, whether it was recorded in this
pass or is a retry of an earlier one (a 429 or 5xx), the gate rereads the mode in force (owner, `MODE` ceiling,
breaker) and the write grant; for an automatic row also the label's 启用 and 正式打 and both caps. So shadow, `off`,
`MAILSORT_MODE=shadow`, a tripped breaker (also one tripped by this pass's own previous write) or a label taken out of
正式打 stop every write not yet made. A refused row fails (`mode_changed`, `label_not_live`, `daily_limit`,
`run_limit`), and its mail becomes a suggestion in 待审, like any write that failed for good. Undo rows are never
gated: they only give mail back to the inbox. The owner's review choices pass the same check in the API.

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
   is a bounded resync: a fresh cursor first, then the inbox's mail of the last two days (at most 100, deduplicated).
   Cursor first, because a mail that arrives between the two reads is then in the list, after the cursor, or both;
   read the other way round it would be in neither. A history record whose message ID the guard would refuse is never
   queued. The install time is stored with the first cursor, and mail received more than 5 minutes before it is
   skipped (`before_install`) even when a resync lists it: no backfill.
3. **Feedback** becomes verdicts, examples and rule proposals (§6).
4. **Retries** of writes an earlier pass left `intended` come first, through the same gate (§3).
5. **Drain**: up to 6 pending mails while 5 subrequests per mail are left. Per mail:
   - `messages.get` (full, at most 512 KiB, else metadata only); skip what is not incoming INBOX mail, and mail whose
     conversation carries an owned label now (one label per conversation: the mail's own labels, or a decided mail of
     the thread whose known labels, which follow mailsort's writes and undos and the owner's changes in Gmail, are not
     empty; an undone or removed label, or a shadow verdict that wrote nothing, does not hide the rest of the thread);
   - a read that fails is that mail's problem, never the queue's (it is read oldest first): rate limits and refused
     grants stop the pass and the mail keeps its place; an answer that will not change (the guard refused it, a 4xx,
     too large even as metadata) skips it as `unreadable` at once; a 403 or an unavailable Gmail puts it back with a
     per-mail backoff (5 minutes doubling, at most 6 hours) and skips it after 7 tries (about five hours);
   - features: the exact sender address, domain, List-Id and delivered-to address (for rules only), and the masked text
     (§4.2); DMARC alignment from Gmail's own topmost `Authentication-Results` (authserv-id `mx.google.com`);
   - stage 1, **rules**: an active rule of an enabled label decides (the most specific kind wins: address, list,
     delivered-to, domain; a disagreement within a kind decides nothing). A label that implies trust needs DMARC aligned;
   - stage 2, **neighbours**: when examples exist, the mail's summary is embedded (bge-m3) and compared by cosine with
     every embedded example of an enabled label; the three nearest go into Clef's state (each cut to 120 tokens). Only
     when the sender passed DMARC aligned and all three agree with similarity ≥ 0.92 on a non-trust label does that
     label decide without the model;
   - stage 3, **Clef**: one call with a `choice` question over the enabled labels (their stable IDs as keys, and as
     criterion each label's display name, then `: ` and the owner's description when there is one; never the ID alone,
     which is random for labels imported from Gmail) plus `none`, and two `noul` questions, `suspicious` and `bulk`. The
     state carries Gmail's snippet only when the body does not start with it. A model outage (anything but the quota)
     backs the mail off like a failed read and stops calling the model for the pass; an answer this code refuses
     (`clef_bad_*`) gets 3 tries. Only then is the mail unsure (`model_unavailable`). The answer must have
     exactly those keys and options, probabilities in [0, 1] summing to 1. Label L when the top option is not `none`,
     p(L) ≥ L's threshold (default 0.8), p(suspicious) < 0.3, L is enabled and does not imply trust; otherwise unsure,
     with the reason;
   - the outcome: a Gmail write (live in force now, the label live, a write grant; the caps are the gate's), else a
     suggestion, else unsure; every decision is recorded with its probabilities, model, and the description versions
     of the labels.
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
email address becomes `[email]`; six or more digits `[number]`, also grouped by single spaces, dashes or dots (card,
account and IBAN numbers, `123 456` codes) and in full-width digits (`１２３４５６`); every URL `[link <domain>]`, also
without a scheme when a host is followed by a path or query (`bank.example.com/reset?token=…`). Short numbers, times
and amounts stay. The patterns are linear (hostile text cannot make them slow); the unit tests include the probes of
the review (`worker/test/read.test.ts`). No AI Gateway: it would log request bodies.

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
  owner to import by hand, so stable rules keep working without this app. Rule values come from mail headers, and
  the export puts them into Gmail search criteria, where `(`, `)`, `-`, `*`, `{`, `OR` or a space could widen one
  sender's filter to most incoming mail, with none of mailsort's caps, breaker or undo. So every value, the owner's,
  a proposal's and an exported one's, must be plain (`rule-value.ts`: lower-case letters, digits and `._%+-`, no
  leading `-`, a real domain), a header value that is not never becomes a proposal, an older row that is not is left
  out of the export (counted in `skipped_count`), and the export quotes each value (`list:("…")`).
- **Accuracy and live gating.** Per label, confirmations count 1, weak accepts 0.5 and corrections 1 against, and
  准确率 shows the Wilson 95 % lower bound of the precision (35 confirmations without an error pass 0.90). The owner turns
  正式打 on per label; the daily pass turns it back off when the bound drops below the target (default 0.90) after a
  correction since it went live (ops-v1 `label_live_revoked`).
- TODO (not in v1): a weekly suggestion of description changes from the recurring corrections, approved by the owner.

## 7. The ledger

Every Gmail write is a ledger row first (`intended`, or `undo_intended` for an undo), committed before the request;
then the modify, which the guard accepts only for such a row; then the outcome (`applied`, `undone`, or `failed` for
a mail that is gone, a read-only grant, a row the gate refused). A pass interrupted between the two retries the same
row (adding a label that is there, or removing one that is gone, changes nothing), but only through the gate (§3).
An automatic row an earlier pass left (or one that failed once) is first checked against the mail as it is now, one
metadata read (`message_get` with the Message-ID header only): if the mail left the inbox or carries a user label it
did not have when the row was recorded (the owner filed it, or another `分拣/` label), the row fails (`mail_changed`)
instead of adding a second label to mail the owner has already dealt with.
An automatic row that fails for good, in its first pass or a later retry, makes its mail a suggestion in 待审. A
request the guard refuses (its label no longer owned) is permanent for that row only: the run goes on with the next.

Undo removes exactly the row's label and restores INBOX when it archived. It is refused (`NOT_UNDOABLE`, before any
intent is written) for a mail the owner has since moved to another label, and for a label that is no longer the
app's: deleted in 标签 (the Gmail label and its mails stay as they are) or missing in Gmail. Each entry says whether
it is `undoable`, with the mail's masked subject and sender while they are kept. 操作记录 undoes one entry, or a time
range: the server undoes at most 20 per call and answers how many are left; the page repeats the call until none is
left (or a call undoes nothing) and shows the totals. Labels are created in Gmail (`分拣/<name>`) just before the
first write that needs them, after the gate; SyncLabels links existing `分拣/` labels and imports the ones mailsort
does not know (disabled, without a description, which the page says).

## 8. Limits and measured costs

Workers Free: 10 ms of CPU per Worker request, 30 s per Durable Object invocation, 50 subrequests. The CPU test
(`worker/test/runtime/cpu.test.ts`, reference ms of the shared meter, 2026-10-06 on the reference machine, after the
review fixes): the fetch handler's very first request 3.2 ms (bound 6), every other request at most 1.3 ms first run
(bound 6) and 0.6 ms warm (bound 2.5); MailsortState's heaviest API calls 1.9-3.8 ms first run (24 labels, a page of
50 review items, a page of 50 ledger entries joined with their decisions, the accuracy report over 2,000 decisions;
bound 300); an alarm pass at its bounds (three history pages, 6 mails decided, 2,000 embedded examples searched)
35 ms (bound 1,500). Bundles: the Worker 111.6 KiB gzip (budget 135), the UI 46.4 KiB gzip (budget 54).

Stores are bounded: 24 labels, 500 rules, 2,000 examples, request IDs for a day, content for 14 days, records for
180 days. Rows read: a pass reads a few rows per mail plus the embedded examples (cached in memory between passes).

### 8.1 The decision model: what was measured (P0)

The real-model evaluation has **not run**: the only Cloudflare token on hand refuses `ai/run` (HTTP 401, code 10000),
so there are no accuracy, calibration, latency or real token numbers for Clef or Clef-flash yet. What was measured,
offline with mailsort's own request-building code over the 200 synthetic P0 fixtures (10 labels with bilingual
descriptions of about 70 tokens each; mailsort's `estimateTokens`, Clef's own template not counted):

| | Before the review fixes | After |
| --- | --- | --- |
| Request JSON | 2,830 bytes, about 793 input tokens | 2,889 bytes, about 817 tokens |
| The three questions (criteria) | 675 tokens (description only; the random ID when empty) | 730 tokens (`name: description`); 231 with names only |
| The mail's state | 109 tokens (snippet duplicating the body's start in 200 of 200 mails) | 78 tokens (snippet dropped when the body starts with it) |
| Neurons per call (estimate) | Clef 17.3, Clef-flash 6.5 | Clef 17.8, Clef-flash 6.7 |

So each label's name costs about 5.5 tokens a call, and the snippet saved about 31; the criteria dominate the input
and cost the same on every call, which is why 标签 suggests one language and 60–120 characters per description. At
about 18 neurons per Clef call, the default budget of 7,000 covers roughly 270 Clef calls a day before the switch to
Clef-flash (at 70 %), far above the expected volume.

Defaults kept, pending the real run: the label threshold 0.8 and `suspicious` < 0.3. Before trusting them, the run
should check the calibration around p = 0.8 and how often legitimate bank, government and account-security notices
score `suspicious` ≥ 0.3. With 8 mails per label the run can only give a go/no-go and a model choice (8 of 8 correct
proves a Wilson lower bound of 0.68), so the per-label 正式打 decision stays with shadow-mode feedback on real volume.

## 9. The owner API and the UI

`mailsort.ui.v1` (`proto/mailsort/ui/v1`): labels (List/Get/Create/Update/Delete, `labels:sync`), review items
(List/Get, `:confirm`, `:correct`, `:skip`), rules (List/Get/Create/Delete, `:approve`, `:disable`,
`rules:exportGmailFilters`), examples (List/Get/Delete, `examples:rebuildEmbeddings`), ledger entries (List/Get,
`:undo`, `ledgerEntries:undo` for a range), and the singletons accuracyReport, serviceStatus and settings
(UpdateSettings needs an explicit mask). AIP-155 request IDs on every mutation, AIP-154 etags on labels and settings,
google.rpc.Status errors (`errors.proto`). The UI's eight views: 待审, 标签, 规则, 例子, 准确率, 记录, 状态, 设置.
设置 sends only the fields the owner changed (naming `mode` resets the breaker, so a budget change never does); 待审
puts a warning and a non-primary, confirmed 确认 on a suspected phishing mail (preselecting 都不是) and on a trust
label the model may not set; 例子 and 记录 page with 加载更多; sync and export toasts say what they did.

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
  the quota deferral, the breaker, a read-only grant, the owner API, ops-v1 over a service binding, CPU; and
  `failures.test.ts`, the review's findings each as a regression test: a leftover write stopped by shadow, the
  breaker, the `MODE` ceiling and a label leaving 正式打; retries against the run cap; a breaker tripped mid-pass; a
  poison mail (400, a lasting 500, a refused ID) never blocking the queue; a deleted or missing label's undo; the
  resync's read order and its install-time cutoff; a model outage backing off; one label per conversation after undo;
  a retry that finds the mail archived or filed by the owner (`mail_changed`); the content cleanup after 20 days off.
- `worker/test/smoke/smoke.mts`: the real `wrangler dev` (`../wrangler.test.toml`) against the fakes on loopback,
  the owner's whole loop through the HTTP API.
- `web/src/*.test.ts`: the views against a fake API on the shared transcoder.
- `deploy/test/*.test.mjs`: the production config, the deploy wrapper (MODE, the secrets file without the grant), that
  `wrangler deploy --secrets-file` keeps secrets it does not name (the pinned wrangler), that the public GitHub
  secrets spec leaves the grant out (`owner_machine_secrets` in `app.toml`), and mint-token: its checks, and `main()`
  end to end with its real loopback server, a fake browser, token endpoint and wrangler (the token request repeats
  the consent URL's `redirect_uri`).

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
