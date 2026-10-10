# mailsort design

Gmail sorting for the owner's own mailbox on `sort.ziyixi.science`: every new INBOX mail is decided by the Workers AI
decision model Clef, asked twice (two views), with the mail's masked text, whether its sender is authenticated, the
nearest corrected examples and what the sender's earlier mail got as its evidence; a confident label is written to
Gmail (a label named by the label's path, at Gmail's top level) and the mail archived in live mode, never marked read.
Confident that no label fits, or uncertain, the mail gets no label and stays in the inbox; a few uncertain mails a day
are asked in the review queue. The owner teaches it by correcting labels in Gmail or answering the review queue;
nothing is fine-tuned.

The owner's decisions of 2026-10-06 shape v1: one label per mail (always a leaf of the label tree); labels nested up to
three levels (`金融/投资`), at Gmail's top level since 2026-10-07 (under `分拣/` before: only mailsort sorts this
mailbox, so the prefix only added a level); confident mail labelled AND archived, unless its label keeps it in the
inbox (账号安全, 政府法律), `UNREAD` never touched; no backfill of history (the sync starts at the install-time history
ID); Clef (27B) by default, Clef-flash for the rest of a UTC day past 70 % of the daily neuron budget, and a deferral
(never a failure) when Workers AI's quota is used up.

The owner's decisions of 2026-10-10 make it model-first (mailsort.ui.v2): sender-address rules sorted badly (one bank
sends statements and promotions alike), so there are no rules and the neighbours never decide on their own; the model
decides every mail, asked twice for precision; the owner no longer reviews every mail, only a daily quota of uncertain
ones (about 1 in 20); a label writes in live mode whenever it is enabled (no per-label 正式打, no precision gate); a mail
that asks the owner to act soon (a code, a payment, a reply) keeps its label in the inbox; a trust label also needs an
authenticated sender of a trusted domain, learned from the owner's answers. Measured in shadow before (2026-10-07 to
10-10, about 30 mails a day), the single view with a threshold of 0.8 was confident for about one mail in nine it saw,
and the owner's review of every item confirmed nearly all of the model's top choices; the replay evaluation (§5.1)
checks the new decision against those answers before Gmail labelling goes live.

## 1. Shape

One Worker, `mailsort`, and one SQLite Durable Object, `MailsortState` ("mailsort-v1"), the shape of the watch app:

| Part | Responsibility |
| --- | --- |
| `worker/src/http.ts` | Access JWT (packages/edge-auth), Origin + CSRF on mutations, then one call to the object; static UI |
| `worker/src/state.ts` | The object: SQLite, the alarm (`setAlarm`, no cron), the owner API through the shared transcoder, ops-v1 |
| `worker/src/gmail.ts` | **The only code that talks to Google**: the closed table of operations (§2) |
| `worker/src/pipeline.ts` | One alarm pass: sync, feedback, decide, write, embed, the replay, daily work (§4) |
| `worker/src/judge.ts`, `decide.ts` | One mail's evidence and the model's two views (shared with the replay); the decision table, the review quota, the sender history's text (§4.4, §5) |
| `worker/src/ai.ts`, `dmarc.ts`, `mask.ts` | Clef's request and strict answer, bge-m3; DMARC from Gmail's own header; masking and the sender's keyed hash (§4.2, §4.3) |
| `worker/src/replay.ts` | The replay evaluation (§5.1) |
| `worker/src/paths.ts` | Label paths: the tree, IDs and option keys from a path (§3.1) |
| `worker/src/flow.ts` | The daily flow counters behind 概览's diagram (§10) |
| `worker/src/feedback.ts`, `examples.ts` | Verdicts and examples (§6) |
| `worker/src/writes.ts` | The ledger of Gmail writes (§7) |
| `web/` | The Chinese, mobile-first UI (no framework) over `mailsort.ui.v2` |
| `../proto/mailsort/ui/v2/` | The owner API (AIP resources and custom methods) |

No D1, R2, KV, queue or cron. The object's SQLite holds labels and their trusted domains, the pending queue, decisions,
the review queue, examples with their bge-m3 embeddings (1024 floats as a BLOB), the ledger, daily usage, the replay
evaluation and the AIP-155 request log.

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
   | labels_create | `POST users/me/labels`, a name the store plans: one of its labels' paths, or a parent such a path nests under (a path of one to three non-empty segments without surrounding spaces) |
   | labels_patch | `PATCH users/me/labels/{owned id}`, the name only, exactly the path the store plans for that label |
   | message_modify | classify: `addLabelIds = [one owned label]`, `removeLabelIds = [] or [INBOX]`, for a ledger row in `intended`/`applied` whose archive flag matches; undo: `removeLabelIds = [that owned label]`, `addLabelIds = [] or [INBOX]` (INBOX exactly when the row archived), for a row in `undo_intended` |

   JSON bodies must be the canonical text of the value the guard checked (`JSON.stringify` of it): a duplicate key
   (`JSON.parse` keeps the last, a server might keep the first) or any other spelling is refused (`body_not_canonical`).

   So trash, untrash, delete, batchDelete, batchModify, send, drafts, filters, settings and forwarding have no path,
   and neither have `UNREAD`, `STARRED`, `IMPORTANT`, `SPAM`, `TRASH`, `CATEGORY_*` or any label mailsort does not own.
   Ownership is by Gmail label ID, never by name: an owned label is a linked label of the store (`ownedLabelIds`), one
   mailsort created or one it adopted (below). The owner's other labels are never owned, so no modify or rename can
   reach them, and neither can a parent that only groups. Feedback never writes.

   `test/gmail-guard.test.ts` records every call GmailClient makes through a fake fetch and checks it against an
   independent copy of the table (`test/fakes/table.ts`), tries every forbidden operation, and throws 20,000 seeded
   random operations at the guard; the workerd tests and the smoke run check every request the fake Gmail receives
   against the same independent table, with the leaf labels mailsort created or a test made for it to adopt, and for
   a label create or rename the store's paths as they were when it was sent (the fake reads them while the Worker
   waits: `FakeUpstream.plannedPaths`).

Round 2 widened `labels_create` for nested labels (2026-10-06, the owner's request): Gmail shows `开发/CI通知` nested
only when `开发` exists, so a parent may be created too. A parent only groups: it is never linked, so it is never owned
and no modify can add it to a mail (one label per mail, always a leaf). `message_modify` is unchanged: a classify
without `removeLabelIds` (a label that keeps its mail in the inbox) was already one of its two shapes.

**Labels without a prefix** (2026-10-07, the owner's request). Until then every label lived under `分拣/`, and the guard
took any name under it for mailsort's. Now a label's Gmail name is its path (`开发/CI通知`, `出行`), so a name says nothing
about who owns a label, and the guard asks the store instead (`Ownership` in `gmail.ts`): `labels_create` makes only a
name the store plans (`plannedPaths`: a label's path or a parent of one), `labels_patch` renames an owned label only to
the path the store plans for that very label (`plannedPath`; a rename writes the new path into the store first and puts
the old one back if Gmail refuses, `api.ts` renameInGmail), and there is no root label to create any more. Nor does a
name alone give mailsort a Gmail label: when Gmail already has a label of exactly a label's path (the owner's, made by
hand), no write creates or adopts anything; the label stays out of Gmail and says so (`Label.GmailState` NAME_TAKEN,
column `gmail_name_taken`), its mail becomes a suggestion, and nothing is written with it until the owner renames it or
**adopts** that Gmail label with 从 Gmail 同步 (SyncLabels, the only place a label is adopted, §3.1). Adopted, mailsort
owns it from then on (adds it to mail, renames it with the label) and says so (ADOPTED, column `gmail_adopted`; both
columns schema version 4). SyncLabels never adopts a Gmail label with labels nested under it (a parent there, and a
mail's label is always a leaf; not even a parent mailsort made), nor one another label here already holds (one renamed
to that path in Gmail): two labels never share one. A system label is never adopted, whatever its name (`writes.ts`
userLabelsByName keeps `Label_*` IDs only), and a parent the owner already has, or makes while mailsort creates one (a
409), is used to nest under, never linked or recorded. And a write fails when the mail already carries its label
(`already_labelled`), by the labels its intent recorded and, for an adopted label, by the mail as it is right before the
write, so an undo never takes off an owner's label that was there before. So no other label of the owner's is ever
written: only one the owner adopted, and never onto a mail that has it. The legacy prefix is still read on input, as
nothing (`paths.ts` ownerPath): a path typed as `分拣/金融/投资` (as the owner's rule file and older exports wrote it,
until rules went on 2026-10-10) means `金融/投资`; nothing writes it. No stored row needed a migration: a label's row
has always held its path without the prefix (every entry point stripped it, and no path may start with `分拣`). The live store had no Gmail label
yet (a read-only grant cannot create one), so nothing in Gmail needed renaming; a store with a label still named `分拣/x`
in Gmail keeps writing it by its ID, and SyncLabels leaves that name alone.

Three differences from the first plan, each for a reason: `history.list` is read without `labelId=INBOX` (an archived
mail has no INBOX, and the owner's label changes on it are the main feedback; the pipeline filters new mail by its
labels instead); `profile` (fields=historyId only) gives the install-time cursor without reading any message; and
`labels.patch` exists so a rename in the dashboard renames the Gmail label (name only, to the path the store holds).

Other guarantees: the Gmail grant lives only in Worker secrets the owner puts from their own machine (§12), never in
GitHub; logs hold counts and codes only (never a subject, sender, address or label name); the model sees masked text
only (§4.2); mail content is untrusted data, and the model has no tools: the worst a hostile mail can do is pick a
wrong label, which a review or an undo reverts.

Retention, as the code does it (`store.ts` `prune`, once per UTC day from `pipeline.ts` `retain`, in every mode: off
reads no Gmail and decides nothing, but the alarm still runs and still clears what is past its time):

| What | Kept |
| --- | --- |
| A decision's content: masked subject, sender and summary, and the sender's From domain | 14 days |
| The review queue (masked subject and sender) | 14 days after the mail came (a mail decided late, after a deferral or a backoff, still goes then) |
| Decisions and the ledger without content (IDs, labels, both views' probabilities, model, states, and the sender as a keyed hash: 16 hex characters of a salted SHA-256 of the From address, never the address) | 180 days |
| Examples: a masked summary (subject, sender name and domain, snippet; at most 200 characters) and its embedding | until deleted (one by one in 标签, with their label, or by turning the label 敏感), at most 2,000 |
| Trusted domains: a trust label's sender domains, learned from the owner's review choices (the first ones seeded from the former sender rules) | until deleted (one by one in 标签, or with their label), at most 50 per label |
| The replay evaluation: per mail its ID, the owner's answer and what the replay decided (labels and codes, no content) | 7 days |
| The flow counters: counts per UTC day, stage, outcome and label (no content) | 400 days |
| Labels: their paths (also their Gmail names; SyncLabels reads back a rename made in Gmail), the Gmail label each is linked to and whether it was adopted, and the owner's descriptions | until deleted, at most 24 |
| The answers to the owner's own changes, kept by request ID so a retry is not applied twice (they can hold a masked subject and sender or a trusted domain) | 1 day |

Examples and trusted domains are what the app learned, so they outlive the 14 days on purpose; both are shown in full in
the dashboard and can be deleted there one by one. The exact sender address is never stored: the sender history reads
the keyed hash (§4.2), and a trusted domain is a From domain the owner's own answer chose.

The public privacy policy (https://www.ziyixi.science/privacy/mailsort, `website/src/app/privacy/mailsort/page.tsx`)
states the closed table and this retention: change it in the same commit as either.

`firstMailbox` (`mask.ts`) reads the sender as Gmail's DMARC does: quoted display names and comments are blanked out
before the address is taken, so `"<boss@work.example>" <x@evil.example>` is x@evil.example, never the address in the
display name (whose domain is never the one DMARC checks or a trusted domain matches).

## 3. Labels, modes and limits

### 3.1 Labels: a tree of paths, archive or keep

A label's display name is its path, and its Gmail name is that path (`出行`, `金融/投资`, at Gmail's top level): one to
three segments, each 1-40 characters, 100 in all, and never `分拣` as the first segment (`paths.ts`): the legacy prefix
is read as nothing, `分拣/金融/投资` is `金融/投资` in CreateLabel and a rename (`ownerPath`). Only leaves are labels: a label
may not be the parent or child of another (CreateLabel, a rename and SyncLabels' rename all hold to it), so a mail's one
label is always a leaf. Gmail gets the parents as
plain grouping labels, created as needed before a label's first write (`writes.ts` ensureGmailLabel: one labels.list,
then whatever of `金融` and the leaf is missing; a label already there under the leaf's path leaves the label out of
Gmail, its name taken, §2) or before a rename. A parent this app created is recorded (table `gmail_parents`, schema
version 3): a label later made of it (新建标签 `新闻` once `新闻/周报` became `资讯/周报/精选`) links the Gmail label that is
there as the app's own, not adopted, and the record goes; while labels are still nested under it in Gmail it is a
parent, and the name is taken. A parent the owner already had is used as it is.

SyncLabels (从 Gmail 同步) only reads Gmail and never imports a Gmail label: with no prefix to tell them apart, every
label of the owner's would look like one. It refreshes the labels the store knows by their Gmail ID: one Gmail no
longer has is marked missing (nothing is written with it), one renamed in Gmail takes the new name when that is a path
no other label has and the tree allows (any other name, the legacy `分拣/x` among them, is left alone: writes go by the
ID). And a label not in Gmail (not created yet, or missing) is linked to the user label of exactly its path, adopted
(§2), when no other label holds it and no label is nested under it there; a label not created yet whose path is still
the name of a Gmail label keeps its name taken, and one whose path is free again loses it. A label made
without an ID gets one from its path (`金融/投资` is `finance-invest`, `paths.ts` pathSlug: a fixed glossary of the words
labels of a personal mailbox use, from `开发/CI通知` and `金融/投资` to `家人`, `报税` and `测试`; a word outside it becomes `x` and a
short hash of itself, while the path's other words keep their English, `金融/猫咪` is `finance-x…`), stable and readable
in URLs. A deleted label's ID
is retired (`retired_labels`, until its decisions and flow counters are pruned): its decisions, review items, ledger
rows and counters still name it, so a new label of the same path gets `finance-invest-2` instead of inheriting that
history, and CreateLabel refuses it as an explicit ID.

A label archives what it gets (removes INBOX) unless its 归档 is off (`keep_in_inbox`): then the label is added and the
mail stays in the inbox. A mail the model finds asks the owner to act soon (`needs_action` at least 0.6: a pickup or
verification code, a payment due, a deadline, a reply wanted) keeps its label in the inbox too, whatever the label
says; nothing can make a keeping label archive, since keeping is the safe direction. The owner's review choices follow
the label and the mail's `needs_action` the same way. The ledger records the choice per write (`archived`), the guard
checks the modify against it, and an undo of a kept mail only removes the label. A sensitive label (敏感) keeps no
example: its mail's masked summary would otherwise outlive the 14 days of content. Turning a label sensitive
(UpdateLabel) deletes the examples it has, embeddings and all, in the same transaction.

A label's description is what the model reads (`path: description`); a label without one is never offered, so it never
gets a mail. One language and 60-120 characters, saying what belongs and, between close labels, what does not, keep
every call cheap (§8.1). Trust labels (a bank, a brokerage, accounts, security, government) are transactional only:
a bank's own marketing belongs to a promotions label, so a look-alike promotion never borrows a trust label.

### 3.2 Trusted domains

A trust label (`trust_implying`) is decided only for a sender it trusts (§4.4): DMARC passed aligned with the From
domain, and that domain is one of the label's trusted domains or a subdomain of one (`bank.example.com` covers
`alerts.bank.example.com`, never `bank-alerts.example.net` or `example.com`). The domains are learned, never typed:
when the owner answers a review item with a trust label and the mail passed DMARC, its From domain joins that label's
list (origin `owner`, `api.ts` choose; at most 50 per label, the oldest going first). Schema version 5 seeded the first
ones from the store's active sender rules of trust labels and the rules with `require_dmarc` (an address rule's domain,
a domain rule's own; list and delivered-to rules name no sender), origin `seed`, in the same transaction that dropped the
rules (`store.ts` SCHEMA_V5). 标签 shows a trust label's list with 删除 on each (RemoveTrustedDomain); deleting the label
deletes its list. A Gmail-side correction never adds a domain: only the review queue's explicit answer does.

### 3.3 Modes and limits

| Mode | Reads Gmail | Decides | Writes Gmail |
| --- | --- | --- | --- |
| off | no | no | no |
| shadow (default) | yes | yes: confident decisions only recorded and counted; a few uncertain ones asked in the review queue (§5) | no |
| live | yes | yes | confident decisions of enabled labels (label, and archive unless the label or the mail keeps it), and the owner's review choices |

A label is live when it is enabled and the mode in force is live: there is no per-label 正式打 and no precision gate
since 2026-10-10 (they waited for verdicts the owner no longer gives on every mail); the replay evaluation (§5.1) is
the check before live.

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
breaker) and the write grant; for an automatic row also the label's 启用 and both caps. So shadow, `off`,
`MAILSORT_MODE=shadow`, a tripped breaker (also one tripped by this pass's own previous write) or a label disabled stop
every write not yet made. The same transaction lowers a row recorded to archive to keep when its label's
归档 has been turned off since (`writes.ts` keepIfLabelKeeps, its flow count moved along): keeping is the direction the
owner just chose. Never the other way: a row that keeps never starts archiving. A refused row fails (`mode_changed`, `label_disabled`, `daily_limit`,
`run_limit`), and its decision stays only recorded (`suggested`), like any write that failed for good: the mail is left
in the inbox as it is, and the review queue holds uncertain mail only. Undo rows are never
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
3. **Feedback** becomes verdicts and examples (§6).
4. **Retries** of writes an earlier pass left `intended` come first, through the same gate (§3.3).
5. **Drain**: up to 6 pending mails while 6 subrequests per mail are left (`messages.get` and its metadata fallback,
   the embedding, the two views, the modify: 6 × 6 = 36 after the token and up to three history pages, 40 in all; a
   label's creation in Gmail before its first write is checked by the write itself and waits for the next pass when
   the budget is short). Per mail:
   - `messages.get` (full, at most 512 KiB, else metadata only); skip what is not incoming INBOX mail, and mail whose
     conversation carries an owned label now (one label per conversation: the mail's own labels, or a decided mail of
     the thread whose known labels, which follow mailsort's writes and undos and the owner's changes in Gmail, are not
     empty; an undone or removed label, or a shadow verdict that wrote nothing, does not hide the rest of the thread);
   - a read that fails is that mail's problem, never the queue's (it is read oldest first): rate limits and refused
     grants stop the pass and the mail keeps its place; an answer that will not change (the guard refused it, a 4xx,
     too large even as metadata) skips it as `unreadable` at once; a 403 or an unavailable Gmail puts it back with a
     per-mail backoff (5 minutes doubling, at most 6 hours) and skips it after 7 tries (about five hours);
   - the evidence (`judge.ts` gather, §4.2): the masked text, DMARC alignment from Gmail's own topmost
     `Authentication-Results` (§4.3), the From address's keyed hash and its domain; then the nearest examples (when
     examples exist, the mail's summary is embedded with bge-m3 and compared by cosine with every embedded example of an
     enabled label; the three nearest go into the state, each cut to 120 tokens, context only: they never decide) and
     the sender history (§4.2);
   - the model's two views and the decision (§4.4). Clef is offered the enabled labels that have a description (a
     label without one is never offered: its bare name is too little), keyed by a slug of each label's path
     (`finance-invest`, `paths.ts` optionKeys: stable, meaningful, never a random ID; a word the glossary lacks falls back
     to a short hash, the rest of the path stays English, §3.1) with the criterion `path: description`, plus `none`. The
     answers are mapped back to label IDs. The state is lean: Gmail's snippet only when the body does not start with
     it, no empty field, and the neighbours and the sender history named by the same keys. A model outage (anything but
     the quota) backs the mail off like a failed read and stops calling the model for the pass; an answer this code
     refuses (`clef_bad_*`) gets 3 tries. Only then is the mail uncertain (`model_unavailable`). Each answer must have
     exactly the questions and options asked, probabilities in [0, 1] summing to 1;
   - the outcome, recorded in one transaction with its flow counter: a confident label is written to Gmail (live in
     force now and a write grant; the caps are the gate's) or only recorded (`suggested`); a confident none is left in
     the inbox (`none`); an uncertain mail joins the review queue while today's quota has room (§5) or is left in the
     inbox (`unsure`, shown or not). Every decision records both views' probabilities, the higher p(suspicious) and
     p(needs_action), the reason, whether it was shown, the model, and the description versions of the labels.
6. **Embeddings** of new examples, 8 per pass (one batched call).
7. **The replay evaluation**, when one runs (§5.1): last, with the subrequests the pass has left.
8. **Daily** (once per UTC day): weak accepts (§6) and the retention cleanup.

### 4.1 Workers AI budget

Neurons are estimated from each answer's reported input tokens at the published prices (Clef 21,818, Clef-flash 8,182,
bge-m3 1,075 neurons per million input tokens). Past 70 % of the owner's daily neuron budget (default 7,000 of the
account's 10,000) the rest of the UTC day uses Clef-flash; past the budget, or when Workers AI refuses for quota (its
daily free allocation), every waiting mail is deferred to the next UTC day: deferred, never failed, never unsure. A mail
asks up to two Clef calls (view 2 is cheaper: three labels' criteria instead of all of them), and the model is chosen
once per mail, so its two views always use the same one. The replay evaluation calls the model only while the day is
below half the budget (§5.1). Home's guard (its 80 % rule) sheds deferrable work: Clef-flash only, no replay
evaluation, no embedding rebuild.

### 4.2 What the model reads

The sender's display name and domain (masked), whether the sender is authenticated (`sender_authenticated`: `yes` when
DMARC passed aligned with the From domain, else `no`), the sender history, a short code for the delivered-to address
(`to-` and 6 hex of a hash, never the address), whether there is a mailing list, the subject (200 characters), Gmail's
snippet (300), the first text/plain part or the stripped first text/html part (2,000), Gmail's category, and the
neighbours' summaries.

The sender history (`sender_history`, `judge.ts` senderHistory) says what the sender's earlier mail of the last 180 days
got: for each earlier decision of the same From address (by its keyed hash; at most the newest 200), the owner's
verdict when there is one (a label, or `none` for 都不是; a verdict counts only from the time it was given), else the
automatic label of a confident decision (written or only recorded; a confident none or an uncertain mail adds nothing).
The three labels with the most of the owner's verdicts, then the most mail, go into the state as `label-key ×n`
(`finance-bank-pay ×3, none ×1`), named as the options are; a deleted label is left out. Every
email address becomes `[email]`; six or more digits `[number]`, also grouped by single spaces, dashes or dots (card,
account and IBAN numbers, `123 456` codes) and in full-width digits (`１２３４５６`); every URL `[link <domain>]`, also
without a scheme when a host is followed by a path or query (`bank.example.com/reset?token=…`). Short numbers, times
and amounts stay. The patterns are linear (hostile text cannot make them slow); the unit tests include the probes of
the review (`worker/test/read.test.ts`). No AI Gateway: it would log request bodies.

### 4.3 Authentication: DMARC from Gmail's own header

Everything is read from Gmail's own topmost `Authentication-Results` (authserv-id `mx.google.com`; `dmarc.ts`), never
from a header the sender could add below it. Even that header quotes text the sender chose (the envelope sender in the
spf comment and in `smtp.mailfrom`, where a quoted local part may hold `;` and `dmarc=pass header.from=…`), so every
comment and quoted string is blanked before the header is split into results (a quoted string counts inside a comment
too, so a `)` in it cannot end the comment early), a header with an unclosed one authenticates nothing, and DMARC
counts only when there is exactly one dmarc result. A mail is authenticated when DMARC passed aligned with the From
domain (`header.from` equal to the address's domain, the address as Gmail's DMARC reads it, not a display name). A
forged From (DMARC failed) or a look-alike (`"statements@bank.example.com" <alerts@bank-alerts.example.net>`) is not
authenticated for the bank: the model reads `sender_authenticated: no`, a trust label waits (§4.4), and a review choice
teaches no trusted domain from it (§3.2).

### 4.4 The decision: two views

`decide.ts` decideViews, over what `judge.ts` gathered:

1. **View 1**: one Clef call with a `choice` over the offered labels plus `none`, and three `noul` questions:
   `suspicious` (phishing, a scam, an impersonation), `bulk` (recorded, not decided on) and `needs_action` (the mail
   asks the owner to act soon: a pickup or verification code, a payment due, a deadline, a reply wanted).
2. **View 2**, only when view 1's top option is a label with p ≥ 0.4: a second call with the same state and the same
   three noul questions, over view 1's three most likely labels plus `none`, in reverse order (an answer that only
   follows the options' order cannot agree with itself). The same noul questions in both views, chosen over none in
   view 2: the trust gate reads the higher p(suspicious) of the two (a second opinion on phishing), and keeping in the
   inbox the higher p(needs_action); they cost little next to the labels' criteria, and the code reads both answers
   the same way.
3. **Accept label L** (confident) when both views' top is L, the mean of their p(L) is at least `AUTO_THRESHOLD` (0.7,
   a constant in `limits.ts`, not owner-facing), the higher p(suspicious) is below 0.3 and L is enabled. A **trust
   label** also needs an authenticated sender (§4.3) whose From domain is one of L's trusted domains or a subdomain of
   one (§3.2), and p(suspicious) below 0.1.
4. **Confident none** when view 1's top is `none` with p ≥ 0.6, or both views' top is `none` (view 2 runs only after a
   label top, so in practice the first): no label, the mail left in the inbox, not shown.
5. Anything else is **uncertain**, with the first reason that holds: `suspicious` (p ≥ 0.3), `low_confidence` (view 2
   did not run, or the mean is below 0.7), `views_disagree`, `untrusted_sender` (a trust label without an authenticated
   sender of a trusted domain), `suspicious` again for a trust label at p ≥ 0.1; `model_unavailable` after the retries;
   `no_labels` when no enabled label has a description (nothing to ask, never shown). Its combined probability is the
   mean of both views' p of view 1's top label (view 1's alone when view 2 did not run).
6. **needs_action**: the higher p(needs_action) at least 0.6 keeps a labelled mail in the inbox (the label is still
   added; a label's 归档 switch still applies, and keeping wins). It replaced the rules' subject carve-outs.

## 5. The review queue

待审 holds only uncertain mail (§4.4), and at most a daily quota of it: `max(1, ceil(0.05 × the average daily mail of the
7 UTC days before today))`, at least 1 and at most 5 (`decide.ts` reviewQuota over the days' `usage.decided`). An
uncertain mail joins while today's quota has room (`decide.ts` joinsReview, in the transaction that records it); the
informative band is preferred: a mail whose top label's combined probability is in [0.35, 0.7), two views that
disagree, or a trust label for an untrusted sender joins while the quota has room, any other only while two places are
left, so the day's last place is kept for the informative band (a quota of 1 is the band's only). A mail with nothing
to ask (`no_labels`) never joins. The rest stays in the inbox untouched, recorded as uncertain and not shown
(`decisions.shown` says which). There are no shadow suggestions, no audit sample and no confident decisions in 待审: in
shadow mode confident decisions are only recorded and counted (概览). Each item shows the masked subject and sender
(kept 14 days), the reason, and the model's three most likely options.

The owner's choices (ResolveReviewItem, SkipReviewItem): a label (the top candidates first), 都不是, or 跳过. A label
or 都不是 is a verdict (§6): with a label it makes an example, and for a trust label and a mail that passed DMARC it
adds the sender's From domain to that label's trusted domains (§3.2). In live mode a label is also written to Gmail
(added, and INBOX removed unless the label or the mail's needs_action keeps it); 都不是 writes nothing. 跳过 leaves the
mail without a verdict.

### 5.1 The replay evaluation

Before Gmail labelling goes live, the owner checks the new decision against their own answers (`replay.ts`):

- **StartReplayEvaluation** (POST `/api/v2/replayEvaluation:start`, idempotent by `request_id`: a repeat answers the
  first start) takes every review item the owner resolved in the last 14 days with a label or 都不是, at most 200,
  newest first (one per mail, its newest answer), and writes one row per mail with the owner's answer and the original
  decision's time, next to the job's own row, in the one table `replay`. A new start replaces the previous job.
- Each alarm pass, after the drain and the embeddings and with the subrequests the pass has left (5 per mail: the
  read and its metadata fallback, the embedding, two views), decides up to 6 waiting mails again, oldest first: it
  re-reads the mail (metadata and body, as the drain does, with the read grant), gathers the same evidence and asks
  the same two views (`judge.ts`), as of the original decision (the sender history before it, verdicts given before
  it), always with the full Clef. It writes nothing to Gmail and makes no decision, verdict, example, review item,
  ledger row or flow count: only its own rows and the day's usage (Gmail calls, neurons). It also records whether the
  review quota of the mail's own day would have shown an uncertain decision, the replayed mails of that day competing
  as they arrived. A mail Gmail no longer gives (deleted, unreadable) is skipped; Gmail's rate, a refused grant or an
  outage stops the pass like any Google failure; a model outage stops the replay for the pass, a refused answer is
  tried 3 times, then counted as uncertain (`model_unavailable`).
- It never starves the live pipeline: it runs last, only while the day's neurons are below half the owner's budget
  and Workers AI's quota lasts (else it waits for the next UTC day), never while Home's guard sheds (§10), and not in
  off mode (no Gmail read). The trusted domains are today's, so a domain the owner taught after a mail came counts for
  it: the replay answers how live would decide from now on.
- **GetReplayEvaluation** (GET `/api/v2/replayEvaluation`) answers the summary, counts and label names only: how many
  mails it covers, evaluated and skipped; confident labels and how many matched the owner; confident nones and how many
  matched 都不是; uncertain and how many the quota would have shown; and the mismatching confident decisions as label
  pairs (decided, owner's), the most frequent first. NOT_FOUND before the first start and after its rows were pruned
  (7 days after the start). The UI does not show it: the owner (or the agent, from the signed-in page) calls it from
  the browser's console.

## 6. Learning from the owner

- **Verdicts.** From the review queue, and from Gmail itself: history records of owned labels on decided mail are
  compared with what mailsort left there. Moving an applied mail to another owned label is a correction to it,
  removing the label only a correction to none, putting it back withdraws the correction; adding an owned label to a
  mail mailsort left (a label only recorded, an uncertain mail, a confident none) is a confirmation (the decided label)
  or a correction. mailsort's own writes update the known labels when they are made, so their history records are not
  feedback; an owner's review choice written to Gmail comes back from the history as the same verdict, which keeps
  its source and time. An applied label untouched for 3 days is a weak accept. The verdicts feed the sender history the
  model reads (§4.2).
- **Examples.** A verdict with a label stores the mail's masked summary (at most 200 characters) as an example of that
  label (origin correction, confirmation or weak accept; weak accepts only while the label has fewer than 50) and the
  next pass embeds it. A withdrawn verdict deletes it, deleting a label deletes its examples. At most 200 per label and
  2,000 in all (the oldest weak accepts go first). 标签 shows each label's count and lists its examples on demand
  (ListExamples of the label), each with 删除 (DeleteExample); RebuildExampleEmbeddings stays in the API. The model
  reads the three nearest as context (§4); they never decide on their own.
- **The label report** (GetLabelReport, 概览): per label over the last 7 UTC days, the confident decisions (written or
  recorded), the decisions of the label (confident, or the most likely of an uncertain one) the owner corrected in Gmail
  and in the review queue, the uncertain ones, and how many were shown; and the totals (decided, confident, none,
  uncertain, shown). One grouped read of the week's decisions.
- Gone on 2026-10-10 (mailsort.ui.v1 had them): rules and their proposals, import, export and Gmail filter export; the
  label template; the daily audit sample; the per-label 正式打 with its Wilson precision bound and auto-revoke.
- TODO: a weekly suggestion of description changes from the recurring corrections, approved by the owner.

## 7. The ledger

Every Gmail write is a ledger row first (`intended`, or `undo_intended` for an undo), committed before the request;
then the modify, which the guard accepts only for such a row; then the outcome (`applied`, `undone`, or `failed` for
a mail that is gone, a read-only grant, a row the gate refused). A pass interrupted between the two retries the same
row (adding a label that is there, or removing one that is gone, changes nothing), but only through the gate (§3.3).
An automatic row an earlier pass left (or one that failed once) is first checked against the mail as it is now, one
metadata read (`message_get` with the Message-ID header only): if the mail left the inbox or carries a user label it
did not have when the row was recorded (the owner filed it, or another of mailsort's labels), the row fails (`mail_changed`)
instead of adding a second label to mail the owner has already dealt with. A row whose label the mail already carries
fails too (`already_labelled`, §2): for an adopted label the mail is read right before every write (an owner's choice
recorded no labels), and a retry whose earlier try reached Gmail with its answer lost then fails the same way, the
label left in place. The write that finds a label's name taken fails (`label_name_taken`); from then on that label's
mail is only suggested, until the owner renames the label or adopts the Gmail label.
An automatic row that fails for good, in its first pass or a later retry, leaves its decision only recorded
(`suggested`); the mail stays as it is. A
request the guard refuses (its label no longer owned) is permanent for that row only: the run goes on with the next.

A row archives (removes INBOX) unless its label or the mail's needs_action keeps the mail in the inbox (§3.1); the
owner's review choices follow the same two. Undo removes exactly the row's label and restores INBOX when it archived. It is refused (`NOT_UNDOABLE`, before any
intent is written) for a mail the owner has since moved to another label, and for a label that is no longer the
app's: deleted in 标签 (the Gmail label and its mails stay as they are) or missing in Gmail. Each entry says whether
it is `undoable`, with the mail's masked subject and sender while they are kept. 设置's 撤销 undoes a time range (1
小时, 24 小时, 7 天 or the owner's own, at most 31 days), of one label when one is chosen (UndoLedgerEntries' `label`):
预览 first counts the range's undoable entries from ListLedgerEntries (newest first, the label filter, at most 20
pages of 50; "至少" when it stopped there), and only 确认撤销 undoes them: the server undoes at most 20 per call and
answers how many are left; the page repeats the call until none is left (or a call undoes nothing) and shows the
totals. A preset range ends ten minutes after the browser's clock, so a write the Worker dated later is in it.
UndoLedgerEntry (one entry) stays in the API; the UI no longer lists the ledger. Labels are created in Gmail (named by their path, with the parents it nests under) just before the
first write that needs them, after the gate, never over a Gmail label of that path (its name is then taken, §2);
SyncLabels follows renames and deletions made in Gmail and adopts, never imports (§3.1).

## 8. Limits and measured costs

Workers Free: 10 ms of CPU per Worker request, 30 s per Durable Object invocation, 50 subrequests. The CPU test
(`worker/test/runtime/cpu.test.ts`, reference ms of the shared meter, 2026-10-06 on the reference machine, after the
review fixes): the fetch handler's very first request 3.2 ms (bound 6), every other request at most 1.3 ms first run
(bound 6) and 0.6 ms warm (bound 2.5); MailsortState's heaviest API calls 1.9-3.8 ms first run (24 labels, a page of
50 review items, a page of 50 ledger entries joined with their decisions, the accuracy report over 2,000 decisions;
bound 300); an alarm pass at its bounds (three history pages, 6 mails decided, 2,000 embedded examples searched)
35 ms (bound 1,500). Bundles: the Worker 111.6 KiB gzip (budget 135), the UI 46.4 KiB gzip (budget 54).

Round 2 (same meter and machine, 2026-10-06): GetMailFlow over 30 days of 11,520 counters (24 labels, every stage and
outcome every day, far more than a real month) 7.9 ms first run in MailsortState and 0.4 ms in the fetch handler; the
preview of an import of 500 rules (about 120 KiB of body, the request body limit is now 256 KiB) 12.4 ms first run in
MailsortState and 1.1 ms in the fetch handler; the alarm pass at its bounds 33 ms; every other call as before. Bundles:
the Worker 128.5 KiB gzip (budget 135: the template, the import, the flow counters and the larger descriptors), the UI
58.2 KiB gzip (budget raised to 67: d3-sankey's layout with the parts of d3-array, d3-shape and d3-path it uses,
2.8 KiB, and the 流程 and 导入导出 views).

After the QA fixes of round 2 (same meter and machine, 2026-10-06): GetMailFlow 7.8 ms first run, the 500-rule import
preview 12.9 ms, the alarm pass at its bounds 33 ms, every other call at most 4.0 ms first run in MailsortState and
1.9 ms for the fetch handler's very first request. Bundles: the Worker 130.2 KiB gzip (the label glossary's new words,
the export's carve-out check, the parents' record; budget 135 unchanged), the UI 58.5 KiB gzip (budget 67 unchanged).

Labels without a prefix (2026-10-07, the same meter in reference ms, one run on a development machine): the alarm pass
at its bounds 37 ms, the 500-rule import preview 14.6 ms and GetMailFlow 8.1 ms first run in MailsortState, every other
call at most 4.6 ms, the fetch handler's very first request 2.1 ms; every bound held. Bundles: the Worker 130.4 KiB
gzip, the UI 58.5 KiB gzip (budgets unchanged).

The UI's redesign (2026-10-07, §9; the Worker unchanged): the UI 56.4 KiB gzip (budget 67 unchanged: six views and
the flow's table removed, the components, the picker and the zero skeleton added). Then 标签 with the rules, the
examples and the template folded in, and 规则 removed: 59.0 KiB gzip (budget unchanged).

The model-first decision (2026-10-10, mailsort.ui.v2; the same meter in reference ms, one run on a development
machine, `worker/test/runtime/cpu.test.ts` with the new seed: 24 labels with 50 trusted domains each, a sender history
of 200 decisions, 2,000 decisions in the week, a replay of 200 mails): the alarm pass at its bounds (three history
pages, 6 mails, each with the sender history, two views and a write) 32.5 ms (bound 1,500); a pass of the replay
evaluation deciding 6 mails again 13.7 ms (same bound); MailsortState's heaviest API calls 1.3-8.0 ms first run
(GetMailFlow over 11,520 counters the most; ListLabels with every trusted domain 5.4; the label report 3.0; the replay's
summary 1.5; bound 300); the fetch handler's very first request 2.2 ms (bound 6), every other at most 1.4 ms first and
0.8 ms warm (bounds 6 and 2.5). Bundles: the Worker 130.4 → 121.9 KiB gzip (the rules, the import, the template, the
filter export and the precision bound gone; the replay, the two views and the trusted domains added; budget 135
unchanged), the UI 59.0 → 55.0 KiB gzip (budget 67 unchanged). Subrequests per mail: 6 (§4).

Stores are bounded: 24 labels, 50 trusted domains each, 2,000 examples, a replay of 200 mails for 7 days, request IDs
for a day, content for 14 days, records for 180 days. Rows read: a pass reads a few rows per mail (the sender history
through the `decisions_sender` index, at most 200) plus the embedded examples (cached in memory between passes).

### 8.1 The decision model: what was measured (P0)

(Written for v1's single view and its threshold of 0.8. Since 2026-10-10 the decision is §4.4's two views, and the
evidence of the owner's shadow review and the replay evaluation (§5.1) replace the go/no-go below; the token numbers
still hold for view 1, and view 2 costs the criteria of three labels instead of all.)

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

Round 2 (keys from the label's path, labels without a description not offered, empty state fields left out), the same
fixtures: about 814 tokens a request, 738 of them the questions and 67 the state (`/tmp/w4-eval` measure.mjs; the
eval harness builds every request with the Worker's own `clefState`, `clefInput` and `optionKeys` now, nothing
copied, and runs as soon as a token with Workers AI permission is on hand).

So each label's name costs about 5.5 tokens a call, and the snippet saved about 31; the criteria dominate the input
and cost the same on every call, which is why 标签 suggests one language and 60–120 characters per description. At
about 18 neurons per Clef call, the default budget of 7,000 covers roughly 270 Clef calls a day before the switch to
Clef-flash (at 70 %), far above the expected volume.

Defaults kept, pending the real run: the label threshold 0.8 and `suspicious` < 0.3. Before trusting them, the run
should check the calibration around p = 0.8 and how often legitimate bank, government and account-security notices
score `suspicious` ≥ 0.3. With 8 mails per label the run can only give a go/no-go and a model choice (8 of 8 correct
proves a Wilson lower bound of 0.68), so the per-label 正式打 decision stays with shadow-mode feedback on real volume.

## 9. The owner API and the UI

`mailsort.ui.v2` (`proto/mailsort/ui/v2`, under `/api/v2/`): labels (List/Get/Create/Update/Delete, `labels:sync`,
`:removeTrustedDomain`), review items (List/Get, `:resolve` with a label or none, `:skip`), examples (List/Get/Delete,
`examples:rebuildEmbeddings`), ledger entries (List with a label filter, Get, `:undo`, `ledgerEntries:undo` for a
range, of one label when `label` is set), mail flows (`mailFlows/today`, `last-7-days`, `last-30-days`), and the
singletons labelReport, replayEvaluation (Get, `:start`), serviceStatus and settings (UpdateSettings needs an explicit
mask). AIP-155 request IDs on every mutation, AIP-154 etags on labels and settings, google.rpc.Status errors
(`errors.proto`). The UI uses only part of it; every RPC stays (the replay evaluation, the embedding rebuild, the write
limits, the neuron budget, the single undo and the 7- and 30-day flows are API only).

Version 2 replaced `mailsort.ui.v1` on 2026-10-10 (rules, the import and exports, the audit, live gating and the
accuracy report removed: breaking, so a new major version, `proto/README.md` rules 4 and 6; the v1 package is retired in
`proto/retired.json`). The Worker and its UI deploy together; a tab of the page from before the update calls
`/api/v1/...`, which answers 410 RELOAD_REQUIRED in the same google.rpc.Status (its LocalizedMessage, 邮件分拣已更新，
请刷新页面, is what that page shows for a reason it does not know) until 2026-11-10 (`docs/history.md`).

**The UI** (redesigned 2026-10-07 on the owner's "less is more": too many settings, flat lists, a flow without a
diagram at zero, import and the ledger page not needed; moved onto mailsort.ui.v2 on 2026-10-10 with the smallest
changes, until its model-first redesign). Plain TypeScript DOM (`web/src/dom.ts`, `components.ts`), no framework;
Chinese, short plain words, at most one hint line where needed.

- **Design system** (`styles.css`): light and dark from `prefers-color-scheme` through CSS tokens (neutral `--bg`,
  `--surface`, `--sunken`, `--ink`, `--muted`, `--line`, and `--track` for an off switch, at least 3:1; one accent
  `--accent` with `--accent-soft`; `--warn` and `--danger` for state only; the flow's eight series and its zero gray),
  an 8 px spacing scale, a 10 px radius, 1 px hairlines, no heavy shadows, the system font with PingFang SC and Noto
  Sans SC, tabular figures for every number, a 2 px accent focus ring. One set of components: primary, ghost (the
  plain button) and quiet buttons, chips, a segmented control, a toggle switch, a disclosure (更多, 高级,
  `N 条没有导出`), a small ⋯ menu (one open at a time; a choice, Escape, a click elsewhere or Tab away closes it), a
  textarea that grows with its text, a card, a compact list row, a KPI number, a meter and a small bar, an empty
  state, and the searchable label picker. A 48rem column with 16 px gutters; works at 360 px: each page is one
  `minmax(0, 1fr)` grid column, so no child widens it (the flow diagram scrolls inside its own box below 600 px), and
  `check-layout.test.ts` pins the rules this depends on.
- **Shell** (`app.ts`): a sticky header with 邮件分拣 and, on the same row (wrapping under it on a phone), one quiet
  status line from ServiceStatus: the mode in force as a chip (影子 neutral, 正式 accent, 关闭 warn), `Gmail ✓ 只读`
  or `可写` (or the problem: 授权失效, 未授权, 未连接, in the warning color) and `下次运行 3 分钟后` (马上 within a
  minute); under it exactly four tabs, 待审 (with the queue's count as a chip, hidden at 0) · 概览 · 标签 · 设置, the
  current one underlined in the accent. The tabs are built once and only marked, so one chosen by keyboard keeps the
  focus. The status is read once per navigation and again after a review choice or a mode change. There is no other
  page: the examples live in 标签 (`/rules` answers 找不到这个页面).
- **待审** (`/`): one list, newest first, one row per uncertain mail: the masked subject (one line) and the time, the
  masked sender, then the model's most likely label as an accent chip (都不是 as a muted one) with its confidence as a
  small bar and a percentage, why the model was uncertain in plain words (把握不够, 两次判断不一致, 疑似钓鱼, 发件人还不
  可信, 模型暂不可用; nothing more when a warning line already says why), and on the right 确认 (that label: primary),
  改为… and 跳过 (quiet). Both are ResolveReviewItem with a label or 都不是. A long subject is cut with … and the time
  stays on one line, so the actions are always in sight. 改为… opens the searchable picker under the row (都不是
  first, then the labels, the highlighted one scrolled into sight; typing filters, ↑ ↓ move, Enter chooses, Escape
  closes). Keyboard: j / k move between rows (the active one has an accent edge), Enter confirms the focused row, c
  opens the picker, s skips; a hint line shows the keys where there is a fine pointer. A choice leaves the list at once
  and the next row takes the focus; an empty queue says 都处理完了. A suspected phishing mail and a trust label for a
  sender not trusted yet show one warning line, their 确认 is not primary and asks first, and the phishing mail's
  picker starts at 都不是 (another at the model's next choice).
- **概览** (`/overview`): four KPI numbers for the UTC day (处理, 已打标签, 待审, 拿不准; 2 × 2 on a phone); the card
  今天的流程 with the Sankey diagram (§10), always drawn: with no mail the skeleton at zero (its nodes named, but not
  Tab stops) and the line 今天还没有邮件; where it scrolls in its box (a phone) it starts at its right end, where the
  mail went; then, side by side from 640 px, 最近 7 天 (the label report: each label with mail this week, `自动 38 · 改
  2 · 拿不准 2`; else one line, 最近 7 天还没有邮件) and 模型额度 (today's estimated neurons over the budget as a thin
  meter, warn from 70 %, danger when used up, and a line only when Clef-flash is in use, the quota is gone or mail
  waits for tomorrow). No error box: the codes are never cleared and carry no time, so one transient `gmail_429` would
  stay for good (ServiceStatus still lists them).
- **设置** (`/settings`): three cards and nothing else. 模式: a segmented 关闭 · 影子 · 正式 (正式 asks first; a
  choice sends only `mode` and the etag) and one line: what the mode does, or the deployment's ceiling
  (`受部署上限限制，按影子运行`), or the tripped breaker in words with 解除熔断. 撤销 (the safety net that replaced
  操作记录, §7): a segmented 1 小时 · 24 小时 · 7 天 · 自定义 (two date-time fields), a label select (全部标签 first)
  and 预览, which shows `将撤销“出行”的 12 条` with 确认撤销 and 取消, or 这段时间没有可撤销的写入. Gmail: one row,
  从 Gmail 同步 (a toast says what the sync did). The write limits and the neuron budget are not in the UI; their stored
  values stand.
- **标签** (`/labels`, `views/labels.ts` and `label-detail.ts`): the one place for everything about a label. From the
  top: a search box (搜索标签) that filters the labels' paths as one types (Escape clears it); a quiet line with
  `15 个标签` (`找到 2 个` while searching) on the left and 启用 on the right, over the switch column; then one card
  holding the tree, in the labels' order, hairlines between rows. A top-level group (开发, 金融) is a muted 13 px heading
  row and its labels are indented under it by their rest of the path (CI通知, 平台工具; `汽车 › 保养` under 生活); a
  label of one segment (账号安全) is a row at the top level. Each row is one line and nothing else: the name (muted,
  with 未启用 beside it, when the label is off), its example count when it has examples, and the 启用 switch, which
  saves `enabled` at once (`update_mask=enabled,etag`) and puts itself back when refused. The row is a button: it opens
  the label's detail under it (an accent edge on the open row, one detail open at a time; again closes it). The detail,
  on the page's background: first, only when Gmail takes nothing from the label, one warning line with what to do (its
  path is a Gmail label of the owner's: `Gmail 里已有同名标签，改个名字或到 设置 → 从 Gmail 同步 沿用`; its Gmail
  label was deleted: `Gmail 里已没有这个标签，不再打它；在 Gmail 建回同名标签后到 设置 → 从 Gmail 同步`); the
  description, a textarea that grows with its text (the placeholder says the model never picks a label without one),
  saved on blur or with a small 保存 shown while it differs; the 留在收件箱 switch; for a trust label, 可信域名 with its
  count, one line per domain in mono with 删除 (RemoveTrustedDomain with the etag; no add: a hint says they come from
  the review queue); then 例子 with its count and 查看 / 收起 (50 at a time, 再看 50 个), each a masked summary, its
  date and 删除; a sensitive label says 敏感标签不留例子. Last, 高级, folded: 可信, 敏感 (asks before it deletes the
  examples), 启用, the path with 改名 (the label moves in the tree, the detail stays open), the Gmail state only when it
  says something (`Gmail：尚未创建` or `已沿用原有标签`; a linked label says nothing) and 删除标签 (asks first). Every
  save sends only its own fields and the label's current etag. At the bottom one quiet `+ 新标签`: one path field, and
  the new label opens with its description focused. With no label at all the page is one empty state, 还没有标签, with
  + 新标签. Light and dark from the same tokens; at 360 px the rows keep one line and the detail loses its indent.

## 10. Operations

- **ops-v1** (`Ops` entrypoint, Home's `MAILSORT` binding): counters `decided_today`, `applied_today`, `unsure_today`,
  `review_pending`, `pending`, `gmail_calls_today`, `neurons_today`, `neuron_budget`, `last_sync_minutes`; modes
  `maintenance` (always false), `mode_limited` (MODE below live), and from storage `live`, `sorting_off`, `breaker`;
  signals `gmail_auth_failed` (critical), `gmail_not_configured`, `breaker_tripped`, `sync_stale` (warnings),
  `ai_quota_exhausted`, `guard_shed` (information; `label_live_revoked` went with live gating on 2026-10-10). Counts and
  codes only. The guard defers `full_model`, `replay` (the replay evaluation; `audit`, the daily sample, until
  2026-10-10) and `embedding_rebuild`.
- **The flow** (`flow.ts`, 概览). The Durable Object keeps one counter per UTC day, stage, outcome and label (table
  `flow`), changed in the same transaction as what it counts: a decision (its decider as the stage: Clef 27B,
  Clef-flash, or 未调用模型 without a model answer; its outcome: archived, kept in the inbox, only recorded
  (`suggested`), confident none (`no_label`), uncertain shown in 待审 (`unsure_shown`) or not (`unsure`)), a skip
  (sent/draft/spam, a conversation already sorted, from before the install, unreadable), a mail still waiting after a
  deferral (延后, on the day of its first deferral; the transaction that decides or skips it takes it out again, so
  every mail is counted exactly once), a write that failed and left its decision only recorded (moved from written to
  suggested on its day), and a correction (added on the day the mail was decided, taken back when withdrawn). Rows of
  the stages before 2026-10-10 (规则, 向量近邻) stay until pruned (a correction of such a decision still counts there)
  and are left out of GetMailFlow's answers. Pruned after 400 days. GetMailFlow sums a fixed range of UTC days (at most 2,000 counters; the UI
  reads `today`). 概览 draws it as a Sankey diagram (d3-sankey for the layout only; SVG in the page's light and dark
  tokens, labels grouped and colored by their top-level segment: each group has a home hue in the labels' order,
  enabled labels' groups first, and the first eight keep theirs every day; a later group the day shows borrows a hue
  whose home group the day does not show (`flowchart.ts` groupSlots), so ten groups of labels never run out, and
  only a day showing more than eight groups has gray ones, which the legend says; every node named with its count;
  hover or focus for exact numbers and shares; no motion under prefers-reduced-motion; on a phone it scrolls inside
  its own box). A day without mail draws the skeleton (`skeletonGraph`): 新邮件, the five stages, and 打标签, 都不是,
  拿不准 and 影子建议 with every path a mail can take, laid out as one mail per path and drawn with hairline links, muted
  nodes and every count 0, so the diagram is never missing.
- **Emergency stop**, from fastest: 设置 → 关闭; the GitHub variable `MAILSORT_MODE=off` (or `shadow`) and a redeploy;
  revoking the grant at https://myaccount.google.com/permissions (Google account → Security → Third-party access).
- **Logs**: one line per alarm (mode, counts, a code) and per refused request (request ID, status, reason).

## 11. Tests

All data is synthetic (Chinese and English mails from example.com-style domains, `worker/test/fakes/fixtures.ts`);
the fake Gmail (`fake-gmail.ts`) and fake Workers AI (`fake-ai.ts`, Clef and bge-m3) answer every request.

- `worker/test/*.test.ts` (Node): the guard and the fuzz (nested names, only the store's planned names, a rename only
  to its label's planned path), masking, MIME, DMARC (forged and look-alike From, planted results); `decide.test.ts`
  the decision table (both views agreeing, the mean at the threshold, views that disagree, view 2 not run, suspicious in
  either view, confident none, the trust gate: authenticated, trusted domain, p(suspicious) below 0.1, a disabled
  label), view 2's labels, needs_action, the review quota and its informative band, the sender history's text, Clef's
  request (three noul questions, the options' order, path keys, lean state with the sender evidence) and strict read;
  `store.test.ts` over the store's SQL on Node's SQLite: paths, IDs and option keys, the schema migrations (version 4
  to 5 seeds the trusted domains from the right rules, drops the rules, keeps labels and decisions with the sender as
  its hash, keeps only uncertain pending review items, and runs again harmlessly; a migration cut short leaves version
  4 as it was; versions 1 to 3 go straight to 5), the trusted domains (subdomains, never a look-alike, the bound of 50),
  the flow counters and the retention cleanup (the hash outliving the content, the replay's 7 days); ops-v1's golden
  bytes (two are contract fixtures).
- `worker/test/runtime/*.test.ts` (workerd, a real SQLite MailsortState): `pipeline.test.ts` the pipeline in shadow and
  live (two views, view 2 over view 1's three labels reversed, only recorded in shadow, label and archive in live,
  confident none left in the inbox, needs_action keeping a label in the inbox), undo, a Gmail correction into an
  example, a trust label waiting until the owner's review choice teaches its domain (the next mail written, the sender
  history in the model's state, a forged copy uncertain), the daily review quota, skips, the resync, the auth stop, the
  Clef-flash switch with two views a mail, the quota deferral, the breaker (a refused write only recorded), a read-only
  grant; `replay.test.ts` the replay evaluation (no write even in live mode, no decision, verdict, example, review item,
  ledger row or flow count; a deleted mail skipped; the summary's counts and label pairs without content; a repeated
  request ID; waiting while shed and past half the budget); `labels.test.ts` nested labels with their parents, a trust
  label's domain learned and removed (RemoveTrustedDomain, etag and request ID), forged and look-alike From headers
  never borrowing it, Gmail labels adopted by the sync only (never at once, never a parent), renames, the legacy
  `分拣/x`, the flow counters and the label report, sensitive labels, retired IDs and a label-filtered range undo;
  `api.test.ts` the HTTP surface (the old `/api/v1` paths answering 410 RELOAD_REQUIRED), the owner API and ops-v1 over
  a service binding; `failures.test.ts`, the review's findings each as a regression test: a leftover write stopped by
  shadow, the breaker, the `MODE` ceiling and a disabled label (each left only recorded); retries against the run cap;
  a breaker tripped mid-pass; a poison mail (400, a lasting 500, a refused ID) never blocking the queue; a deleted or
  missing label's undo; the resync's read order and its install-time cutoff; a model outage backing off; one label per
  conversation after undo; a retry that finds the mail archived or filed by the owner (`mail_changed`); the content
  cleanup after 20 days off; the owner's own Gmail labels never taken over (a write never adopts, a label already on
  the mail is never written so its undo cannot take it off, no adoption of a label with sublabels, a 409 is the
  owner's); `cpu.test.ts` the CPU bounds (§8).
- `worker/test/smoke/smoke.mts`: the real `wrangler dev` (`../wrangler.test.toml`) against the fakes on loopback,
  the owner's whole loop through the HTTP API: two views in shadow, live labels, confident none, needs_action, undo, a
  trust label's domain learned from the review queue and a forged From, Gmail corrections into examples, an adoption, a
  nested label, the replay evaluation, the Clef-flash switch, the quota deferral, the flow API, the legacy `分拣/x`, the
  parents' record, a label-filtered range undo, the old `/api/v1` paths' 410 and the auth failure.
- `web/src/*.test.ts`: the views against a fake API on the shared transcoder: `app.test.ts` the shell (four tabs, the
  focus kept on a tab, the status line, 马上, the queue's count), 待审 (ResolveReviewItem by 确认 and the picker and its
  highlighted label scrolled into sight, skip, the keyboard, the caution for phishing and an untrusted sender, the
  reasons in words), 设置 (the mode's mask, the ceiling, the breaker, the undo's preview and rounds, one label's undo,
  the custom range, the sync; no filter export); `labels.test.ts` 标签 (the tree's grouping, the one-line row with its
  example count and 启用 with its mask, etag and refusal, one detail open at a time, the search over names, the
  description on blur, a trust label's trusted domains with 删除, the examples on demand, the Gmail state lines, 高级
  with 敏感's question, the visible 未启用, rename and delete, a new label, also when there is none; the fake refuses a
  stale etag and changes only masked fields); `overview.test.ts` the flow graph and diagram (hues, 都不是 apart from
  拿不准, size, tooltip, tokens, the zero skeleton out of the Tab order, the phone's start at the outcomes) and 概览 with
  and without mail (the label report), without an error box; `check-layout.test.ts` the switch rows and the
  phone-width rules (one column per page and per 待审 row, the time on one line, the settings rows, the tree's
  hairlines, the off switch's track); `test/no-external.test.ts` the same-origin rules.
- `deploy/test/*.test.mjs`: the production config, the deploy wrapper (MODE, the secrets file without the grant), that
  `wrangler deploy --secrets-file` keeps secrets it does not name (the pinned wrangler), that the public GitHub
  secrets spec leaves the grant out (`owner_machine_secrets` in `app.toml`), and mint-token: its checks, and `main()`
  end to end with its real loopback server, a fake browser, token endpoint and wrangler (the token request repeats
  the consent URL's `redirect_uri`).

## 12. Owner setup and going live

Done by the owner, on their own machine and accounts (nothing here can do it):

1. **Google Cloud project**: a new dedicated project; enable the Gmail API.
2. **OAuth consent screen**: user type External; add only the scope `gmail.readonly` (later `gmail.modify`); add
   yourself as a user; the privacy policy link is https://www.ziyixi.science/privacy/mailsort; set the publishing status
   to **In production** without submitting for verification (a personal app under 100 users may stay unverified; in
   Testing, refresh tokens expire after 7 days).
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

Then: run in shadow and answer the few uncertain mails 待审 shows; check the trust labels' trusted domains in 标签; run
the replay evaluation from the signed-in page's console (StartReplayEvaluation, then GetReplayEvaluation once it
succeeded, §5.1) and read its matches and mismatching label pairs; then grant `gmail.modify` (mint-token
`--scope modify`), set `MAILSORT_MODE=live` and choose 正式 in 设置. Every enabled label then writes; 设置 → 撤销 and
the breaker stay the safety net.
