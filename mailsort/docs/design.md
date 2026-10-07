# mailsort design

Gmail sorting for the owner's own mailbox on `sort.ziyixi.science`: new INBOX mail is decided by rules, the nearest
corrected examples and the Workers AI decision model Clef, then labelled (a Gmail label named by the label's path, at
Gmail's top level) and archived in live mode, never marked read. Unsure mail gets no label and stays in the inbox. The
owner teaches it by correcting labels in Gmail or in the review queue; nothing is fine-tuned.

The owner's decisions of 2026-10-06 shape v1: one label per mail (always a leaf of the label tree); labels nested up to
three levels (`金融/投资`), at Gmail's top level since 2026-10-07 (under `分拣/` before: only mailsort sorts this
mailbox, so the prefix only added a level); confident mail labelled AND archived, unless its label or rule keeps it
in the inbox (round 2: 账号安全, 政府法律, package pickup codes), `UNREAD` never touched; unsure mail left alone and listed in the review queue; no backfill of history (the
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
| `worker/src/decide.ts`, `ai.ts`, `dmarc.ts` | Rules (order, carve-outs, DMARC and DKIM), neighbours, Clef's request and strict answer, the decision |
| `worker/src/paths.ts`, `template.ts`, `import.ts` | Label paths (the tree, IDs and option keys from a path), the label template, import and export (§3.1, §6.4) |
| `worker/src/flow.ts` | The daily flow counters behind 概览's diagram (§10) |
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
nothing (`paths.ts` ownerPath): the owner's rule file and older exports say `分拣/金融/投资` and keep importing; nothing
writes it. No stored row needed a migration: a label's row has always held its path without the prefix (every entry
point stripped it, and no path may start with `分拣`), and rules name their label by ID. The live store had no Gmail label
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
| A decision's content: masked subject, sender and summary, and the exact sender address, domain, List-Id and delivered-to address | 14 days |
| The review queue (masked subject and sender) | 14 days after the mail came (an audit sample or a late write failure can queue older mail) |
| Decisions and the ledger without content (IDs, labels, probabilities, model, states) | 180 days |
| Examples: a masked summary (subject, sender name and domain, snippet; at most 200 characters) and its embedding | until deleted (one by one in 标签, with their label, or by turning the label 敏感), at most 2,000 |
| Rules: the exact sender address, domain, List-Id or delivered-to address, their subject words, the owner's evidence and notes, proposed or active | until deleted (in 标签, or with their label), at most 500 |
| The flow counters: counts per UTC day, stage, outcome and label (no content) | 400 days |
| Labels: their paths (also their Gmail names; SyncLabels reads back a rename made in Gmail), the Gmail label each is linked to and whether it was adopted, and the owner's descriptions | until deleted, at most 24 |
| The answers to the owner's own changes, kept by request ID so a retry is not applied twice (they can hold a masked subject and sender or a rule's values) | 1 day |

Examples and rules are what the app learned, so they outlive the 14 days on purpose; both are shown in full in the
dashboard and can be deleted there one by one.

The public privacy policy (https://www.ziyixi.science/privacy/mailsort, `website/src/app/privacy/mailsort/page.tsx`)
states the closed table and this retention: change it in the same commit as either.

`firstMailbox` (`mask.ts`) reads the sender as Gmail's DMARC does: quoted display names and comments are blanked out
before the address is taken, so `"<boss@work.example>" <x@evil.example>` is x@evil.example, never the address in the
display name (which no sender rule may match).

## 3. Labels, modes and limits

### 3.1 Labels: a tree of paths, archive or keep

A label's display name is its path, and its Gmail name is that path (`出行`, `金融/投资`, at Gmail's top level): one to
three segments, each 1-40 characters, 100 in all, and never `分拣` as the first segment (`paths.ts`): the legacy prefix
is read as nothing, `分拣/金融/投资` is `金融/投资` in CreateLabel and a rename (`ownerPath`) as in the import, so an export
always imports back. Only leaves are labels: a label may not be the parent or child of another (CreateLabel, a rename,
an import and SyncLabels' rename all hold to it), so a mail's one label is always a leaf. Gmail gets the parents as
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
labels of a personal mailbox use, from the template's to `家人`, `报税` and `测试`; a word outside it becomes `x` and a
short hash of itself, while the path's other words keep their English, `金融/猫咪` is `finance-x…`), stable and readable
in URLs. A deleted label's ID
is retired (`retired_labels`, until its decisions and flow counters are pruned): its decisions, review items, ledger
rows and counters still name it, so a new label of the same path gets `finance-invest-2` instead of inheriting that
history, and CreateLabel refuses it as an explicit ID.

A label archives what it gets (removes INBOX) unless its 归档 is off (`keep_in_inbox`): then the label is added and the
mail stays in the inbox. A rule may keep its mail in the inbox too (Rule.keep_in_inbox) whatever the label says; a rule
can never make a keeping label archive, since keeping is the safe direction. The owner's review choices follow the
label, and the deciding rule when the owner confirms the label it suggested (the decision records the rule's keep:
a pickup-code carve-out onto 购物/订单物流 not yet live stays in the inbox when confirmed). The ledger records the choice per write (`archived`), the guard checks the modify against it, and an undo of a
kept mail only removes the label. A sensitive label (敏感) keeps no example: its mail's masked summary would otherwise
outlive the 14 days of content. Turning a label sensitive (UpdateLabel, an import, the template) deletes the examples
it has, embeddings and all, in the same transaction; the import's preview warns `examples_deleted`.

### 3.2 The template

`template.ts` holds fifteen recommended labels, none of them anyone's own: 开发/CI通知, 开发/平台工具, 金融/投资, 金融/银行支付,
账号安全, 政府法律, 购物/订单物流, 购物/促销, 订阅收据, 出行, 生活/账单住房, 生活/汽车, 生活/医疗, 求职, 学校与社群. Each description is
written for the decision model: one language, one sentence, 60-120 characters, saying what belongs and, between close
labels, what does not. Trust labels (金融/投资, 金融/银行支付, 账号安全, 政府法律, 生活/医疗) are transactional only: a bank's own
marketing is 购物/促销, so a look-alike promotion never borrows a trust label. 账号安全 and 政府法律 keep their mail in the
inbox; 生活/医疗 is sensitive. ImportRules applies it (`use_template`, previewed first with `validate_only`; 标签 offers it,
previewed, only when there is no label at all, and the live store has it); a label that exists already (same path) only gets
the template's description and switches, never a second copy, and keeps a threshold the owner tuned (the template
names none).

### 3.3 Modes and limits

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
正式打 stop every write not yet made. The same transaction lowers a row recorded to archive to keep when its label's
归档 has been turned off since (`writes.ts` keepIfLabelKeeps, its flow count moved along): keeping is the direction the
owner just chose. Never the other way: a row that keeps never starts archiving. A refused row fails (`mode_changed`, `label_not_live`, `daily_limit`,
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
4. **Retries** of writes an earlier pass left `intended` come first, through the same gate (§3.3).
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
   - stage 1, **rules** (§4.3): the first usable active rule of an enabled label decides, in a total order: rules with
     `subject_includes` first (a carve-out), then the kind (address, list, delivered-to, domain; a longer domain
     first), more conditions first, then the oldest rule (create_time, then ID; an import keeps its file's order). A
     rule with only `subject_excludes` is no carve-out: an exclusion narrows a broad rule ("everything from the bank
     but 广告"), it does not make it specific, so it ranks with the plain rules of its kind and goes just before the
     plain rule of the same kind and value (and never before an exact address rule of a domain it covers). A
     rule is usable when its subject conditions hold and the mail is authenticated as §4.3 says. A carve-out whose
     words match but which cannot fire (its label disabled, the mail not authenticated) ends the search: its mail never
     falls through to the sender's plain rule; an exclusion-only rule that cannot fire does not;
   - stage 2, **neighbours**: when examples exist, the mail's summary is embedded (bge-m3) and compared by cosine with
     every embedded example of an enabled label; the three nearest go into Clef's state (each cut to 120 tokens). Only
     when the sender passed DMARC aligned and all three agree with similarity ≥ 0.92 on a non-trust label does that
     label decide without the model;
   - stage 3, **Clef**: one call with a `choice` question over the enabled labels that have a description (a label
     without one is never offered: its bare name is too little; rules and examples may still decide it), keyed by a
     slug of each label's path (`finance-invest`, `paths.ts` optionKeys: stable, meaningful, never the random ID a label
     imported from Gmail used to have; a word the glossary lacks falls back to a short hash, the rest of the path stays
     English, §3.1) with the criterion `path: description`, plus `none`, and two `noul` questions,
     `suspicious` and `bulk`. The answer is mapped back to label IDs. The state is lean: Gmail's snippet only when the
     body does not start with it, no empty field, and the neighbours named by the same keys. A model outage (anything but the quota)
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

### 4.3 What a rule needs: DMARC, DKIM, Delivered-To

Everything is read from Gmail's own topmost `Authentication-Results` (authserv-id `mx.google.com`; `dmarc.ts`), never
from a header the sender could add below it. Even that header quotes text the sender chose (the envelope sender in the
spf comment and in `smtp.mailfrom`, where a quoted local part may hold `;` and `dmarc=pass header.from=…`), so every
comment and quoted string is blanked before the header is split into results (a quoted string counts inside a comment
too, so a `)` in it cannot end the comment early), a header with an unclosed one authenticates nothing, and DMARC
counts only when there is exactly one dmarc result:

- a sender rule (From address or domain) fires only when DMARC passed aligned with the From domain (`header.from`
  equal to the address's domain, the address as Gmail's DMARC reads it, not a display name). A forged From (DMARC
  failed) or a look-alike (`"statements@bank.example.com" <alerts@bank-alerts.example.net>`) fires none: the mail goes on
  to the model, which may only suggest a trust label, or stays in the inbox;
- a label that implies trust, or a rule with `require_dmarc`, needs the same on any rule kind;
- a list rule (List-Id) needs the message's List-Id to equal the rule's, and, when the identifier's namespace is a
  domain (`digest.news.example.com` -> `news.example.com`), a DKIM signature that passed for that domain, a parent or a
  subdomain of it (`header.d`, or the domain of `header.i`). Anyone can write a List-Id; only the list's domain can sign
  for it. An opaque namespace has nothing to check a signature against, so there the List-Id alone counts (the choice
  recorded here: such lists are rare, and their rule can still ask for `require_dmarc`). A list that signs with an
  unrelated domain never fires its rule: the safe failure, the model decides;
- a delivered-to rule matches the `Delivered-To` Gmail wrote, never the sender's `To` (the model's address code may
  still fall back to `To`: it is only a hint).

Subject conditions read the exact subject (never stored or sent), NFKC-folded and lower case, as the words are stored.

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
  2,000 in all (the oldest weak accepts go first). 标签 shows each label's count and lists its examples on demand
  (ListExamples of the label), each with 删除 (DeleteExample); RebuildExampleEmbeddings stays in the API.
- **Rule proposals.** The same mailing list (else the same sender address) corrected to the same label twice proposes
  a rule; it decides nothing until the owner approves it in 标签 (批准 on its line; a dot by the label's rule count says one waits). Withdrawn corrections retract a proposal that falls
  below two. Active rules export as Gmail's filter XML (label, and archive unless the rule or label keeps the
  mail in the inbox) for the owner to import by hand; left out are rules of a trust label or with `require_dmarc` (a
  filter cannot check DMARC), rules with subject conditions, and every plain rule whose sender such a rule covers (the
  same kind and value, or a domain covering the carved address or subdomain, either way round; `filters.ts`
  exportableRules). Gmail applies every matching filter, so the plain rule's filter alone would give a pickup code the
  sender's label and archive it, or file a login notice under the sender's plain label: without it Gmail leaves that
  sender's mail in the inbox. Each is counted in `skipped_count`, and 设置's export says why (folded under 为什么). A sender rule of another label is exported without its DMARC check (such a
  filter can only put a forged mail under a non-trust label), so stable rules keep working without this app. Rule
  values come from mail headers, and
  the export puts them into Gmail search criteria, where `(`, `)`, `-`, `*`, `{`, `OR` or a space could widen one
  sender's filter to most incoming mail, with none of mailsort's caps, breaker or undo. So every value, the owner's,
  a proposal's and an exported one's, must be plain (`rule-value.ts`: lower-case letters, digits and `._%+-`, no
  leading `-`, a real domain), a header value that is not never becomes a proposal, an older row that is not is left
  out of the export (counted in `skipped_count`), and the export quotes each value (`list:("…")`).
- **Import and export** (`import.ts`; the rule file and the JSON export in the API only since the UI's redesign of
  2026-10-07, the template also from 标签 when there is no label). ImportRules takes the owner's rule file, a JSON list in the format of
  their validated rule set (`id`, `match` with exactly one of `from_address`, `from_domain`, `list_id`, `to_address`,
  `label` as the label's path (`金融/投资`; the legacy `分拣/金融/投资` of the owner's file means the same), `keep_in_inbox`, `trust`, `require_dmarc`, `evidence`, `notes`, and the optional
  `subject_includes` / `subject_excludes`), this app's export (`{"labels": [...], "rules": [...]}`) or the template.
  `to_address` is a delivered-to rule (§4.3): it matches the owner's own address Gmail delivered to, never `To` or
  `Cc`. A list address in `To` needs `list_id`; a notification's reason address in `Cc` (GitHub's) needs the sender
  and a subject condition.
  Evidence, notes and label descriptions may span lines (CRLF read as LF; any other control character is refused),
  and a List-Id may be written in its header form (`<digest.news.example.com>`, `rule-value.ts` normalizeRuleValue,
  as CreateRule reads it). It is previewed first (`validate_only`): every entry create, update (which fields), skip
  or invalid (why: a path, a value rule-value.ts refuses, a match with no or two keys, too many subject words, the
  tree, the bounds), with warnings (a `trust` rule whose label does not imply trust; two rules with the same match
  and conditions, of which the earlier is tried first). The confirmation plans again inside one transaction and
  applies all or nothing; an invalid entry makes it INVALID_IMPORT with the plan as a detail. A rule is matched by its
  `id` (a re-import updates the rule it made), else by what it is; a proposal it matches becomes active, a disabled
  rule stays disabled. A label a rule names that exists nowhere is created enabled, not live and without a
  description (rules fire at once, in shadow first; the model waits for a description; a `trust` rule makes it a
  trust label). Nothing reaches Gmail. ExportRules writes every label (with its `enabled` switch) and every rule but
  the proposals in the same format, so an export imports back as all skips, and into a fresh store with its disabled
  labels disabled; a label entry without `enabled` (the rule file, the template) creates an enabled label and leaves
  an existing one's switch alone.
- **Accuracy and live gating.** Per label, confirmations count 1, weak accepts 0.5 and corrections 1 against, and
  概览 shows the Wilson 95 % lower bound of the precision (35 confirmations without an error pass 0.90). The owner turns
  正式打 on per label; the daily pass turns it back off when the bound drops below the target (default 0.90) after a
  correction since it went live (ops-v1 `label_live_revoked`).
- TODO (not in v1): a weekly suggestion of description changes from the recurring corrections, approved by the owner.

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
An automatic row that fails for good, in its first pass or a later retry, makes its mail a suggestion in 待审. A
request the guard refuses (its label no longer owned) is permanent for that row only: the run goes on with the next.

A row archives (removes INBOX) unless its label or deciding rule keeps the mail in the inbox (§3.1); the owner's
review choices follow the label. Undo removes exactly the row's label and restores INBOX when it archived. It is refused (`NOT_UNDOABLE`, before any
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

`mailsort.ui.v1` (`proto/mailsort/ui/v1`): labels (List/Get/Create/Update/Delete, `labels:sync`), review items
(List/Get, `:confirm`, `:correct`, `:skip`), rules (List/Get/Create/Delete, `:approve`, `:disable`,
`rules:exportGmailFilters`, `rules:import` with `validate_only`, `rules:export`), examples (List/Get/Delete,
`examples:rebuildEmbeddings`), ledger entries (List with a label filter, Get, `:undo`, `ledgerEntries:undo` for a
range, of one label when `label` is set), mail flows (`mailFlows/today`, `last-7-days`, `last-30-days`), and the singletons accuracyReport,
serviceStatus and settings (UpdateSettings needs an explicit mask). AIP-155 request IDs on every mutation, AIP-154
etags on labels and settings, google.rpc.Status errors (`errors.proto`). The UI uses only part of it; every RPC
stays (the import of a rule file, the JSON export, the embedding rebuild, the write limits, the neuron budget and
the thresholds of the settings, the single undo and the 7- and 30-day flows are API only).

**The UI** (redesigned 2026-10-07 on the owner's "less is more": too many settings, flat lists, a flow without a
diagram at zero, import and the ledger page not needed). Plain TypeScript DOM (`web/src/dom.ts`, `components.ts`), no
framework; Chinese, short plain words, at most one hint line where needed.

- **Design system** (`styles.css`): light and dark from `prefers-color-scheme` through CSS tokens (neutral `--bg`,
  `--surface`, `--sunken`, `--ink`, `--muted`, `--line`; one accent `--accent` with `--accent-soft`; `--warn` and
  `--danger` for state only; the flow's eight series and its zero gray), an 8 px spacing scale, a 10 px radius, 1 px
  hairlines, no heavy shadows, the system font with PingFang SC and Noto Sans SC, tabular figures for every number,
  a 2 px accent focus ring. One set of components: primary, ghost (the plain button) and quiet buttons, chips, a
  segmented control, a toggle switch, a disclosure (更多, 为什么, 高级), a small ⋯ menu, a textarea that grows with its
  text, a card, a compact list row, a KPI number, a meter and a small bar, an empty state, and the searchable label
  picker. A 48rem column with 16 px gutters; works at
  360 px (the flow diagram scrolls inside its own box below 600 px).
- **Shell** (`app.ts`): a sticky header with 邮件分拣 and, on the same row (wrapping under it on a phone), one quiet
  status line from ServiceStatus: the mode in force as a chip (影子 neutral, 正式 accent, 关闭 warn), `Gmail ✓ 只读`
  or `可写` (or the problem: 授权失效, 未授权, 未连接, in the warning color) and `下次运行 3 分钟后`; under it exactly
  four tabs, 待审 (with the queue's count as a chip) · 概览 · 标签 · 设置, the current one underlined in the accent.
  The status is read once per navigation and again after a review choice or a mode change. There is no other page:
  the rules and the examples live in 标签 (`/rules` answers 找不到这个页面).
- **待审** (`/`): one list, newest first, one row per mail: the masked subject (one line) and the time, the masked
  sender, then the suggested label as an accent chip (都不是 as a muted one) with the model's confidence as a small
  bar and a percentage, why it is here when not a plain suggestion (`拿不准 · 低于阈值`, `抽查`), and on the right
  确认 (primary), 改为… and 跳过 (quiet). 改为… opens the searchable picker under the row (都不是 first, then the
  labels; typing filters, ↑ ↓ move, Enter chooses, Escape closes). Keyboard: j / k move between rows (the active one
  has an accent edge), Enter confirms the focused row, c opens the picker, s skips; a hint line shows the keys where
  there is a fine pointer. A choice leaves the list at once and the next row takes the focus; an empty queue says
  都处理完了. A suspected phishing mail and a trust label the model may not set show one warning line, their 确认 is
  not primary and asks first, and the phishing mail's picker starts at 都不是 (another at the model's next choice).
- **概览** (`/overview`): four KPI numbers for the UTC day (处理, 已打标签, 待审, 拿不准; 2 × 2 on a phone); the card
  今天的流程 with the Sankey diagram (§10), always drawn: with no mail the skeleton at zero and the line 今天还没有邮件;
  then, side by side from 640 px, 准确率 (each label with verdicts: name, a small bar of its precision bound, warn
  below the target, `92% · 40`; the target in the card's corner; else one line, 还没有确认或纠正过的邮件) and 模型额度
  (today's estimated neurons over the budget as a thin meter, warn from 70 %, danger when used up, and a line only
  when Clef-flash is in use, the quota is gone or mail waits for tomorrow); the latest error code in a warning box
  only when there is one.
- **设置** (`/settings`): three cards and nothing else. 模式: a segmented 关闭 · 影子 · 正式 (正式 asks first; a choice
  sends only `mode` and the etag) and one line: what the mode does, or the deployment's ceiling (`部署上限是“影子”，现在按
  影子运行`), or the tripped breaker in words with 解除熔断. 撤销 (the safety net that replaced 操作记录, §7): a
  segmented 1 小时 · 24 小时 · 7 天 · 自定义 (two date-time fields), a label select (全部标签 first) and 预览, which
  shows `将撤销“出行”的 12 条` with 确认撤销 and 取消, or 这段时间没有可撤销的写入. Gmail: two rows, 从 Gmail 同步
  (a toast says what the sync did) and 导出过滤器 (downloads `mailsort-filters.xml`, keeps a 下载过滤器文件 link,
  folds why rules were left out under `N 条没有导出`, and one line on where to import it in Gmail). The write limits,
  the neuron budget and the thresholds are no longer in the UI; their stored values stand.
- **标签** (`/labels`, `views/labels.ts` and `label-detail.ts`): the one place for everything about a label. From the
  top: a search box (搜索标签、发件人或域名) that filters as one types, over the labels' paths and their rules' values,
  so a sender's rule is found at once (Escape clears it); a quiet line with `15 个标签` (`找到 2 个` while searching)
  on the left and 正式打 on the right, over the switch column; then one card holding the tree, in the labels' order,
  hairlines between rows. A top-level group (开发, 金融) is a muted 13 px heading row and its labels are indented
  under it by their rest of the path (CI通知, 平台工具; `汽车 › 保养` under 生活); a label of one segment (账号安全) is
  a row at the top level. Each row is one line and nothing else: the name (muted when the label is off), the rule
  count when it has rules (`3 规则`, with an accent dot when a proposal waits), a 32 px bar of the precision bound
  when the label has verdicts (warn below the target; an empty slot keeps the column), and the 正式打 switch, which
  saves `live` at once (`update_mask=live,etag`) and puts itself back when refused. While searching, a row found by
  its rules names the matching values under its name in small mono.
  The row is a button: it opens the label's detail under it (an accent edge on the open row, one detail open at a
  time; again closes it). The detail, on the page's background: the description, a textarea that grows with its text
  (the placeholder says the model never picks a label without one), saved on blur or with a small 保存 shown while
  it differs; the 留在收件箱 switch; 规则 with its count, one bordered line per rule (proposals first, then active,
  then stopped, which is muted with 已停用): the kind chip (发件人, 域名, 列表, 收件地址), the value in mono, the subject
  words as outline chips (`含 取件码`, `不含 广告`), `留在收件箱` when the rule keeps, `待批准` (accent) with a small
  批准, and ⋯ on the right, which shows 停用 or 启用 and 删除 inline (Escape closes it); a line the search matched is
  drawn in the accent's soft color. Under them 添加规则: one field (地址或域名) whose kind is inferred as one types and
  shown as a chip beside it (an address is a sender, also `Name <x@y>`; `@domain` or a bare domain a domain;
  `<list.id>` a list), Enter or 添加 creates it (the field is locked while it is sent, then empty and focused for the
  next); 更多 holds 类型 (自动 · 列表 · 收件地址), 主题包含 and 主题不含 (comma separated) and the rule's 留在收件箱.
  Then 例子 with its count and 查看 / 收起 (50 at a time, 再看 50 个), each a masked summary, its date and 删除; a
  sensitive label says 敏感标签不留例子. Last, 高级, folded: 阈值 (0.5–0.99, empty for the default, saved on change),
  可信, 敏感 (asks before it deletes the examples), 启用, the path with 改名 (the label moves in the tree, the detail
  stays open), `Gmail：已关联` (尚未创建, 已沿用原有标签, or 已不存在 in the warning color) and 删除标签 (asks first).
  Every save sends only its own fields and the label's current etag. At the bottom one quiet `+ 新标签`: one path
  field, and the new label opens with its description focused. With no label at all the page is one empty state,
  还没有标签, with 套用推荐模板 and + 新标签: the template's 15 labels are previewed by group (ImportRules with
  `validate_only`) and 添加这些标签 imports them. Light and dark from the same tokens; at 360 px the rows keep one
  line, a rule's text wraps beside its ⋯ and the detail loses its indent.

## 10. Operations

- **ops-v1** (`Ops` entrypoint, Home's `MAILSORT` binding): counters `decided_today`, `applied_today`, `unsure_today`,
  `review_pending`, `pending`, `gmail_calls_today`, `neurons_today`, `neuron_budget`, `last_sync_minutes`; modes
  `maintenance` (always false), `mode_limited` (MODE below live), and from storage `live`, `sorting_off`, `breaker`;
  signals `gmail_auth_failed` (critical), `gmail_not_configured`, `breaker_tripped`, `sync_stale` (warnings),
  `ai_quota_exhausted`, `label_live_revoked`, `guard_shed` (information). Counts and codes only. The guard defers
  `full_model`, `audit` and `embedding_rebuild`.
- **The flow** (`flow.ts`, 概览). The Durable Object keeps one counter per UTC day, stage, outcome and label (table
  `flow`), changed in the same transaction as what it counts: a decision (its decider as the stage: 规则, 向量近邻,
  Clef 27B, Clef-flash, or 未调用模型 without a model answer; its outcome: archived, kept in the inbox, only suggested,
  unsure), a skip (sent/draft/spam, a conversation already sorted, from before the install, unreadable), a mail
  still waiting after a deferral (延后, on the day of its first deferral; the transaction that decides or skips it
  takes it out again, so every mail is counted exactly once), a write that failed and left its mail a suggestion
  (moved from written to suggested on its day), and a correction (added on the day the mail was decided, taken back
  when withdrawn). Pruned after 400 days. GetMailFlow sums a fixed range of UTC days (at most 2,000 counters; the UI
  reads `today`). 概览 draws it as a Sankey diagram (d3-sankey for the layout only; SVG in the page's light and dark
  tokens, labels grouped and colored by their top-level segment: each group has a home hue in the labels' order,
  enabled labels' groups first, and the first eight keep theirs every day; a later group the day shows borrows a hue
  whose home group the day does not show (`flowchart.ts` groupSlots), so the template's ten groups never run out, and
  only a day showing more than eight groups has gray ones, which the legend says; every node named with its count;
  hover or focus for exact numbers and shares; no motion under prefers-reduced-motion; on a phone it scrolls inside
  its own box). A day without mail draws the skeleton (`skeletonGraph`): 新邮件, the seven stages, and 打标签, 拿不准
  and 影子建议 with every path a mail can take, laid out as one mail per path and drawn with hairline links, muted
  nodes and every count 0, so the diagram is never missing.
- **Emergency stop**, from fastest: 设置 → 关闭; the GitHub variable `MAILSORT_MODE=off` (or `shadow`) and a redeploy;
  revoking the grant at https://myaccount.google.com/permissions (Google account → Security → Third-party access).
- **Logs**: one line per alarm (mode, counts, a code) and per refused request (request ID, status, reason).

## 11. Tests

All data is synthetic (Chinese and English mails from example.com-style domains, `worker/test/fakes/fixtures.ts`);
the fake Gmail (`fake-gmail.ts`) and fake Workers AI (`fake-ai.ts`, Clef and bge-m3) answer every request.

- `worker/test/*.test.ts` (Node): the guard and the fuzz (nested names, only the store's planned names, a rename only
  to its label's planned path), masking, MIME,
  DMARC and DKIM (forged and look-alike From), the decision (rule order, carve-outs), Clef's request (path keys, lean
  state) and strict read, the Wilson bound, the filter export; `import.test.ts` over the store's SQL on Node's SQLite:
  paths, IDs and option keys, the template's rules, the import plan, its application and the export's round trip,
  the schema migrations (version 4 keeps the live store's labels and rules as they are), the flow counters; ops-v1's
  golden bytes (two are contract fixtures).
- `worker/test/runtime/*.test.ts` (workerd, a real SQLite MailsortState): the pipeline in shadow and live, unsure,
  undo, corrections into examples and proposals, trust labels, skips, the resync, the auth stop, the Clef-flash switch,
  the quota deferral, the breaker, a read-only grant, the owner API, ops-v1 over a service binding, CPU; and
  `failures.test.ts`, the review's findings each as a regression test: a leftover write stopped by shadow, the
  breaker, the `MODE` ceiling and a label leaving 正式打; retries against the run cap; a breaker tripped mid-pass; a
  poison mail (400, a lasting 500, a refused ID) never blocking the queue; a deleted or missing label's undo; the
  resync's read order and its install-time cutoff; a model outage backing off; one label per conversation after undo;
  a retry that finds the mail archived or filed by the owner (`mail_changed`); the content cleanup after 20 days off;
  the owner's own Gmail labels never taken over (a write never adopts, a label already on the mail is never written
  so its undo cannot take it off, no adoption of a label with sublabels, a 409 is the owner's);
  and `round2.test.ts`: the template and the rule file imported (preview, all-or-nothing confirmation), a nested
  label created in Gmail with its parents, keep-in-inbox by label and by rule (undo removing only the label), the
  carve-out order, forged and look-alike From headers, a nested Gmail label adopted by the sync (never at once, never its parent, nothing imported), a rename refused for a name Gmail has, the flow counters with corrections
  and the ledger's label filter, and the export.
  The QA fixes of round 2 have their regression tests: the filter export and its carve-out coverage (`decide.test.ts`),
  multi-line evidence, header-form List-Ids, `enabled` through an export, the legacy `分拣/x` and the glossary (`import.test.ts`), a
  retry lowered to keep (`failures.test.ts`), the parents' record, the legacy `分拣/x` in CreateLabel and the label-filtered range
  undo (`round2.test.ts`), and in the UI the switch rows, the template's ten groups' hues and the filtered range undo.
- `worker/test/smoke/smoke.mts`: the real `wrangler dev` (`../wrangler.test.toml`) against the fakes on loopback,
  the owner's whole loop through the HTTP API, round 2's import, nested label, keep in inbox, carve-out, forged From,
  flow API and export included, and the QA fixes (filter export, `enabled`, multi-line evidence and `<list-id>`,
  the legacy `分拣/x`, the parents' record, the label-filtered range undo), and labels at Gmail's top level with an owner's
  label of a label's path adopted by the sync.
- `web/src/*.test.ts`: the views against a fake API on the shared transcoder: `app.test.ts` the shell (four tabs, the
  status line, the queue's count), 待审 (confirm, the picker, skip, the keyboard, the caution), 设置 (the mode's mask,
  the ceiling, the breaker, the undo's preview and rounds, one label's undo, the custom range, the sync, the filter
  download); `labels.test.ts` 标签 (the tree's grouping, the one-line row with its count, proposal dot, precision bar
  and 正式打 with its mask, etag and refusal, one detail open at a time, the search over names and rule values, 添加规则's
  inferred kinds, its lock and 更多, the rule menu, the description on blur, the examples on demand, 高级 with 敏感's
  question, rename and delete, a new label, and the template's preview and import when there is no label; the fake
  refuses a stale etag and changes only masked fields); `overview.test.ts` the flow graph and diagram (hues, size,
  tooltip, tokens, the zero skeleton) and 概览 with and without mail; `check-layout.test.ts` the switch rows;
  `no-external.test.ts` the same-origin rules.
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

Then: run in shadow for 1-2 weeks, confirm or correct a few mails a day, and turn 正式打 on per label once its
precision bound reaches the target; set the mode to live (and `MAILSORT_MODE=live`) with a `gmail.modify` grant.
