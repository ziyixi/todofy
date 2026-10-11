# mailsort design

Gmail sorting for the owner's own mailbox on `sort.ziyixi.science`: every new INBOX mail is decided by the Workers AI
decision model Clef, asked twice (two views), with the mail's masked text, whether its sender is authenticated, the
nearest corrected examples and what the sender's earlier mail got as its evidence; a confident label is written to
Gmail (a single-level English label) and the mail archived in live mode, never marked read.
Confident that no label fits, or uncertain, the mail gets no label and stays in the inbox; a few uncertain mails a day
are asked in the review queue. The owner teaches it by correcting labels in Gmail or answering the review queue;
nothing is fine-tuned.

The current label rule (2026-10-11) is one single-level English label per new classification, with Chinese
criteria and UI text. Existing Chinese and nested names remain readable until the owner consolidates them. Confident
mail is labelled and archived unless its label keeps it in the inbox; `UNREAD` is never touched. New mail starts at the
install-time history ID. Consolidation moves existing label memberships without classifying or reading old content.
Clef (27B) remains the default, Clef-flash is used past 70% of the daily neuron budget, and quota exhaustion defers work.

The owner's decisions of 2026-10-10 make it model-first (mailsort.ui.v2): sender-address rules sorted badly (one bank
sends statements and promotions alike), so there are no rules and the neighbours never decide on their own; the model
decides every mail, asked twice for precision; the owner no longer reviews every mail, only a daily quota of uncertain
ones (about 1 in 20); a label writes in live mode whenever it is enabled (no per-label 正式打, no precision gate); a
trust label also needs an authenticated sender of a trusted domain, learned from the owner's answers. Measured in shadow
before (2026-10-07 to 10-10, about 30 mails a day), the single view with a threshold of 0.8 was confident for about one
mail in nine it saw, and the owner's review of every item confirmed nearly all of the model's top choices; the replay
evaluation (§5.1) checks the new decision against those answers before Gmail labelling goes live.

The owner's decision of 2026-10-11: a labelled mail belongs under its label, not in the inbox, and is never marked read.
Every confident label archives its mail unless the label's 归档 switch is off (`keep_in_inbox`, the owner's explicit
control, §3.1); the exception of 2026-10-10 that kept a mail asking the owner to act soon (a code, a payment, a reply)
in the inbox is gone, and so is the model's `needs_action` question, which nothing else used (§4.4).

## 1. Shape

One Worker, `mailsort`, and one SQLite Durable Object, `MailsortState` ("mailsort-v1"), the shape of the watch app:

| Part | Responsibility |
| --- | --- |
| `worker/src/http.ts` | Access JWT (packages/edge-auth), Origin + CSRF on mutations, then one call to the object; static UI |
| `worker/src/state.ts` | The object: SQLite, the alarm (`setAlarm`, no cron), the owner API through the shared transcoder, ops-v1 |
| `worker/src/gmail.ts` | **The only code that talks to Google**: the closed table of operations (§2) |
| `worker/src/pipeline.ts` | One alarm pass: sync, feedback, decide, write, embed, the replay, daily work (§4) |
| `worker/src/judge.ts`, `decide.ts` | One mail's evidence and the model's two views (shared with the replay); the decision table, the review quota, the sender history's text (§4.4, §5) |
| `worker/src/ai.ts`, `dmarc.ts`, `mask.ts` | Clef's request and strict answer, bge-m3; DMARC from Gmail's own header; masking and the sender's salted hash (§4.2, §4.3) |
| `worker/src/replay.ts` | The replay evaluation (§5.1) |
| `worker/src/paths.ts` | Single-level English names, legacy path reading, stable IDs and option keys (§3.1) |
| `worker/src/label-merge.ts`, `label-identity.ts` | Bounded label consolidation and canonical views of preserved historical identities (§3.1) |
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
   | labels_create | `POST users/me/labels`, a single-level English name planned by the store, or the frozen consolidation target still without a Gmail ID in its rename phase |
   | labels_patch | `PATCH users/me/labels/{owned id}`, the name only, exactly the name the store or frozen consolidation plans for that label |
   | message_modify | classify: `addLabelIds = [one owned label]`, `removeLabelIds = [] or [INBOX]`, for a ledger row in `intended`/`applied` whose archive flag matches; undo: `removeLabelIds = [that owned label]`, `addLabelIds = [] or [INBOX]` (INBOX exactly when the row archived), for a row in `undo_intended` |
   | merge_list | `GET users/me/messages`, one frozen source label or recorded app-created grouping label; IDs only, bounded first page, including archived mail |
   | merge_metadata | `GET users/me/messages/{id}`, only `id,labelIds,historyId`, for a persisted consolidation item |
   | merge_modify | one frozen source label removed and its frozen target added, only with a persisted pending intent; no INBOX or other labels |
   | labels_hide | visibility fields only, after an owned source or app-created grouping label is verified empty |

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

A Gmail name alone does not grant ownership. A same-name external label stays `NAME_TAKEN` until the owner explicitly
adopts it through 从 Gmail 同步; a label with children or a system label is never adopted. All writes identify owned
labels by Gmail ID. If a message already carries the target label, ordinary classification refuses the write so an
undo cannot later remove an existing owner label. Consolidation leaves merged source operations read-only; they cannot be undone after the merge. New
classification writes retain ordinary undo. Old grouping labels are never added to mail; only empty app-created groups without unrelated
children may be hidden. Neither source labels nor grouping labels are deleted.

Three differences from the first plan, each for a reason: `history.list` is read without `labelId=INBOX` (an archived
mail has no INBOX, and the owner's label changes on it are the main feedback; the pipeline filters new mail by its
labels instead); `profile` (fields=historyId only) gives the install-time cursor without reading any message; and
`labels.patch` exists so a rename in the dashboard renames the Gmail label (name only, to the name the store holds).

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
| Decisions and the ledger without content (IDs, labels, both views' probabilities, model, states, and the sender as a salted hash: 16 hex characters of a SHA-256 of the From address with a fixed salt, never the address; the salt is in the public code and no secret key is used, so it keeps the address out of the row, not out of reach of someone testing candidate addresses) | 180 days |
| Examples: a masked summary (subject, sender name and domain, snippet; at most 200 characters) and its embedding | until deleted (one by one in 标签, with their label, or by turning the label 敏感), at most 2,000 |
| Trusted domains: a trust label's sender domains, learned from the owner's review choices (the first ones seeded from the former sender rules) | until deleted (one by one in 标签, or with their label), at most 50 per label |
| The replay evaluation: per mail its ID, the owner's answer, what the replay decided (labels and codes) and the decision's numbers (the model's probabilities, whether the sender passed DMARC), no content | 7 days |
| The flow counters: counts per UTC day, stage, outcome and label (no content) | 400 days |
| Labels: their paths (also their Gmail names; SyncLabels reads back a rename made in Gmail), the Gmail label each is linked to and whether it was adopted, and the owner's descriptions | until deleted, at most 24 |
| The answers to the owner's own changes, kept by request ID so a retry is not applied twice (they can hold a masked subject and sender or a trusted domain) | 1 day |

Examples and trusted domains are what the app learned, so they outlive the 14 days on purpose; both are shown in full in
the dashboard and can be deleted there one by one. The exact sender address is never stored: the sender history reads
the salted hash (§4.2), and a trusted domain is a From domain the owner's own answer chose.

The public privacy policy (https://www.ziyixi.science/privacy/mailsort, `website/src/app/privacy/mailsort/page.tsx`)
states the closed table and this retention: change it in the same commit as either.

`firstMailbox` (`mask.ts`) reads the sender as Gmail's DMARC does: quoted display names and comments are blanked out
before the address is taken, so `"<boss@work.example>" <x@evil.example>` is x@evil.example, never the address in the
display name (whose domain is never the one DMARC checks or a trusted domain matches).

## 3. Labels, modes and limits

### 3.1 Labels: single-level names, archive or keep

Gmail and Mailsort use the same English name, at most 40 characters, with at least one ASCII letter. Digits, spaces
and common punctuation (`& ' ( ) . , + _ -`) are allowed; `/`, control characters and non-ASCII names are rejected on
create and rename. The UI is a flat searchable list. Existing Chinese or nested names remain readable with their
full name; their internal IDs do not change. Normal creation never creates a grouping label.

SyncLabels reads only labels the store already knows. It identifies them by Gmail ID, adopts an exact-name external
label only on explicit sync, and never imports unrelated labels. A Chinese/nested external rename, or an owned label
that now has children, is exposed as a specific `Label.problem` and blocks new classification writes for that label.
The owner can rename it through its detail. A previously linked ID that Gmail no longer returns is marked missing;
a label not yet created in Gmail remains pending with a null ID. The old slug/path helpers remain for
reading historical records and assigning stable IDs; they do not authorize a new nested label.

The owner can consolidate labels in Settings with a private mapping. `label-merge.ts` journals bounded Alarm work;
`label-identity.ts` maps old IDs for reports and replay while stored predictions, probabilities and ledger
rows remain unchanged. Existing targets keep their Gmail ID; merged sources transfer their members to the
first source and are hidden when verified empty. A source with `gmail_state=pending`, a null Gmail ID and no name
conflict has no Gmail members to move; its examples and trusted domains still merge. An uncreated target is created
with its final English name during the rename phase, and its returned ID is stored and read back for verification.
Missing labels, name conflicts and inconsistent state/ID pairs remain errors. Preflight checks both old source
names and final target names against Gmail; consolidation never adopts an unowned label by name. If creation loses
its response before an ID is recorded, the job stays blocked with the creation result unverified.
Merged source ledger entries stay read-only; there is no reverse migration. Examples and trusted domains retain their learning times. The full
preflight, pause, resume and validation procedure is in [label consolidation](label-consolidation.md).

A label archives what it gets (removes INBOX, `UNREAD` untouched) unless its 归档 is off (`keep_in_inbox`): then the
label is added and the mail stays in the inbox. Nothing else keeps a labelled mail in the inbox (the owner's decision of
2026-10-11: until then a mail the model found asked the owner to act soon, `needs_action` at least 0.6, kept its label
in the inbox whatever the label said). New labels archive by default; 归档 is the owner's switch. The owner's review
choices follow the label the same way. The ledger records the choice per write (`archived`), the guard checks the modify
against it, and an undo of a kept mail only removes the label. A sensitive label (敏感) keeps no example: its mail's
masked summary would otherwise outlive the 14 days of content. Turning a label sensitive (UpdateLabel) deletes the
examples it has, embeddings and all, in the same transaction.

A label's description is what the model reads (`name: description`); a label without one is never offered, so it never
gets a mail. One language and 60-120 characters, saying what belongs and, between close labels, what does not, keep
every call cheap (§8.1). Trust labels (a bank, a brokerage, accounts, security, government) are transactional only:
a bank's own marketing belongs to a promotions label, so a look-alike promotion never borrows a trust label.

### 3.2 Trusted domains

A trust label (`trust_implying`) is decided only for a sender it trusts (§4.4): DMARC passed aligned with the From
domain, and that domain is trusted for the label (`store.ts` isTrusted). A trusted domain matches that exact From domain;
only one seeded from a former sender domain rule also covers its subdomains (`subdomains`: `bank.example.com` then covers
`alerts.bank.example.com`), and none ever matches `bank-alerts.example.net` or a parent such as `example.com`. Exact is
the rule for everything learned: a platform signs its sellers' or users' messages from other subdomains of its own
domain (`marketplace.shop.example`), whose text a third party wrote.

The domains are learned, never typed. When the owner answers a review item with a trust label, the item's teachable
domain joins that label's list (origin `owner`, an exact entry; `api.ts` choose, `decide.ts` teachableDomain; at most
50 per label, the oldest going first): the mail's From domain, only when DMARC passed aligned with it, the model's
p(suspicious) was below 0.95 (a mail it was sure of, or could not judge, teaches nothing) and it is not a public mailbox
provider's. A public mailbox provider (`gmail.com`, `outlook.com`, `qq.com`, `163.com`, ...; a small fixed list,
`decide.ts` SHARED_MAILBOX_DOMAINS, and their subdomains) is never a trusted domain, seeded or learned: anyone can send
DMARC-aligned mail from one, so a person writing from such an address stays uncertain for a trust label. The review
item carries that domain (ReviewItem.teachable_domain) and 待审 names it in a question before any answer that would add
it, whatever the item's reason, and never makes such an answer the primary one (§9): one tap never trusts a sender.

Schema version 5 seeded the first ones from the store's active sender rules of trust labels and the rules with
`require_dmarc` (an address rule's domain, exact; a domain rule's own, with its subdomains; list and delivered-to rules
name no sender; a public mailbox provider's never), origin `seed`, in the same transaction that dropped the rules
(`store.ts` SCHEMA_V5). 标签 shows a trust label's list with 删除 on each (RemoveTrustedDomain); deleting the label
deletes its list. A Gmail-side correction never adds a domain: only the review queue's explicit answer does. This
departs from the plan's organisational match (a listed domain covering all its subdomains) on purpose: that widened a
former exact-address rule to a whole domain and made one answer for a shared provider trust every account there.

### 3.3 Modes and limits

| Mode | Reads Gmail | Decides | Writes Gmail |
| --- | --- | --- | --- |
| off | no | no | no |
| shadow (default) | yes | yes: confident decisions only recorded and counted; a few uncertain ones asked in the review queue (§5) | no |
| live | yes | yes | confident decisions of enabled labels (label, and archive unless the label keeps it), and the owner's review choices |

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
breaker) and the write grant; for an automatic row also the label's 启用, for a trust label a sender still trusted (the
decision authenticated and its From domain still trusted: the owner may have deleted the domain, or turned 可信 on,
since), and both caps. So shadow, `off`,
`MAILSORT_MODE=shadow`, a tripped breaker (also one tripped by this pass's own previous write) or a label disabled stop
every write not yet made. The same transaction lowers a row recorded to archive to keep when its label's
归档 has been turned off since (`writes.ts` keepIfLabelKeeps, its flow count moved along): keeping is the direction the
owner just chose. Never the other way: a row that keeps never starts archiving. A refused row fails (`mode_changed`, `label_disabled`, `untrusted_sender`,
`daily_limit`, `run_limit`), and its decision stays only recorded (`suggested`), like any write that failed for good: the mail is left
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
     `Authentication-Results` (§4.3), the From address's salted hash and its domain; then the nearest examples (when
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
     inbox (`unsure`, shown or not). Every decision records both views' probabilities, the higher p(suspicious), the
     reason, whether it was shown, the model, and the description versions of the labels.
6. **Embeddings** of new examples, 8 per pass (one batched call).
7. **The replay evaluation**, when one runs (§5.1): last, with the subrequests the pass has left.
8. **Daily** (once per UTC day): weak accepts (§6) and the retention cleanup.

### 4.1 Workers AI budget

Neurons are estimated from each answer's reported input tokens at the published prices (Clef 21,818, Clef-flash 8,182,
bge-m3 1,075 neurons per million input tokens). Past 70 % of the owner's daily neuron budget (default 9,500: 95 % of the
account's 10,000, which nothing else uses) the rest of the UTC day uses Clef-flash; past the budget, or when Workers AI refuses for quota (its
daily free allocation), every waiting mail is deferred to the next UTC day: deferred, never failed, never unsure. A mail
asks up to two Clef calls (view 2 is cheaper: three labels' criteria instead of all of them), and the model is chosen
once per mail, so its two views always use the same one. The replay evaluation shares the same budget, after the live pipeline in every pass
(§5.1). Home's guard (its 80 % rule) sheds deferrable work: Clef-flash only, no replay
evaluation, no embedding rebuild.

### 4.2 What the model reads

The sender's display name and domain (masked), whether the sender is authenticated (`sender_authenticated`: `yes` when
DMARC passed aligned with the From domain, else `no`), the sender history, a short code for the delivered-to address
(`to-` and 6 hex of a hash, never the address), whether there is a mailing list, the subject (200 characters), Gmail's
snippet (300), the first text/plain part or the stripped first text/html part (2,000), Gmail's category, and the
neighbours' summaries.

The sender history (`sender_history`, `judge.ts` senderHistory) says what the sender's earlier mail of the last 180 days
got: for each earlier decision of the same From address and the same authentication (by its salted hash; at most the
newest 200; an authenticated mail reads the address's authenticated mail, any other mail its unauthenticated mail, so a
forged From neither reads the real sender's verdicts nor adds its own labels to them), the owner's verdict when there is
one (a label, or `none` for 都不是; a verdict counts only from the time it was given), else the
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

1. **View 1**: one Clef call with a `choice` over the offered labels plus `none`, and two `noul` questions:
   `suspicious` (phishing, a scam, an impersonation) and `bulk` (recorded, not decided on).
2. **View 2**, only when view 1's top option is a label with p ≥ 0.4: a second call with the same state and the same
   two noul questions, over view 1's three most likely labels plus `none`, in reverse order (an answer that only
   follows the options' order cannot agree with itself). The same noul questions in both views, chosen over none in
   view 2: the trust gate reads the higher p(suspicious) of the two (a second opinion on phishing); they cost little
   next to the labels' criteria, and the code reads both answers the same way.
3. **Accept label L** (confident) when both views' top is L, the mean of their p(L) is at least `AUTO_THRESHOLD` (0.7,
   a constant in `limits.ts`, not owner-facing), L is enabled and, for a sender that is not authenticated (§4.3),
   the higher p(suspicious) is below 0.6. The mean is
   taken on view 1's scale (`decide.ts` combined): view 2 chose only among view 1's top three labels and none, so its
   p(L) is relative to those options (a model consistent with itself answers p1(L) / p1(options), which would lift the
   mean above view 1's own p(L) by the narrower question alone); it is multiplied by the share view 1 gave those
   options, so view 2 confirms or doubts view 1's probability and a sharper second opinion still counts. A **trust
   label** also needs an authenticated sender (§4.3) whose From domain is one of L's trusted domains or a subdomain of
   one (§3.2), and p(suspicious) below 0.95.
4. **Confident none** when view 1's top is `none` with p ≥ 0.6, or both views' top is `none` (view 2 runs only after a
   label top, so in practice the first): no label, the mail left in the inbox, not shown.
5. Anything else is **uncertain**, with the first reason that holds, in the code's order: `suspicious` (an unauthenticated sender at p ≥ 0.6);
   `low_confidence` (view 2 did not run); `views_disagree` (view 2's top is another option, whatever the mean);
   `low_confidence` (the mean below 0.7, or the label disabled since); `untrusted_sender` (a trust label without an
   authenticated sender of a trusted domain); `suspicious` for a trust label at p ≥ 0.95. And `model_unavailable` after
   the retries; `no_labels` when no enabled label has a description (nothing to ask, never shown). A none top of view 1
   below 0.6 is `low_confidence` too. Its combined probability is that of view 1's top label as in step 3 (view 1's
   alone when view 2 did not run).
6. **Archive**: a confident label is added and the mail archived (`UNREAD` untouched) unless the label's 归档 is off
   (§3.1). Until 2026-10-11 both views also asked `needs_action` (a pickup or verification code, a payment due, a
   deadline, a reply wanted) and a mail at p ≥ 0.6 kept its label in the inbox; the owner's decision of that day
   dropped the exception and the question with it. The decisions' `needs_action` column stays, written NULL since
   (dropping it needs a migration for nothing), and the replay leaves its `needs_action_probability` unset (§5.1).

## 5. The review queue

待审 holds only uncertain mail (§4.4), and at most a daily quota of it: `max(1, ceil(0.05 × the average daily mail of the
7 UTC days before today))`, at least 1 and at most 5 (`decide.ts` reviewQuota over the days' `usage.decided`). An
uncertain mail joins while today's quota has room (`decide.ts` joinsReview, in the transaction that records it); the
informative band is preferred: a mail whose most likely label's combined probability is in [0.35, 0.7) (when view 1's
top was none, not likely enough, its most likely label after none: whether a label applies at all is the question), two
views that disagree, or a trust label for an untrusted sender joins while the quota has room, any other only while two places are
left, so the day's last place is kept for the informative band (a quota of 1 is the band's only). A mail with nothing
to ask (`no_labels`) never joins. The rest stays in the inbox untouched, recorded as uncertain and not shown
(`decisions.shown` says which, and only uncertain decisions count against the quota). Schema version 5 started the queue
empty: every pending item of version 4 went (its shadow suggestions, audit samples and the uncertain mail it asked
about, all of it, so 待审 holds the quota from the first day), and no decision before it reads as shown. There are no
shadow suggestions, no audit sample and no confident decisions in 待审: in
shadow mode confident decisions are only recorded and counted (概览). Each item shows the masked subject and sender
(kept 14 days), the reason, and the model's most likely options as one-tap answers (of its three, the first always and
the others from 5 %; §9).

The owner's choices (ResolveReviewItem, SkipReviewItem): a label (the top candidates first), 都不是, or 跳过. A label
or 都不是 is a verdict (§6): with a label it makes an example, and for a trust label it adds the item's teachable domain
(authenticated, not suspicious, not a public mailbox provider's) to that label's trusted domains (§3.2). In live mode a label is also written to Gmail
(added, and INBOX removed unless the label keeps it); 都不是 writes nothing. 跳过 leaves the
mail without a verdict.

### 5.1 The replay evaluation

Before Gmail labelling goes live, the owner checks the new decision against their own answers (`replay.ts`):

- **StartReplayEvaluation** (POST `/api/v2/replayEvaluation:start`, idempotent by `request_id`: a repeat answers the
  first start) takes every review item the owner resolved in the last 14 days with a label or 都不是, at most 200,
  newest first (one per mail, its newest answer), and writes one row per mail with the owner's answer and the original
  decision's time, next to the job's own row, in the one table `replay`. A running job cannot be replaced by a new
  request; the same request returns its original receipt. A new run can replace a finished job. Consolidation pauses
  evaluation, and old answer IDs compare through the canonical mapping without changing the original time boundary.
- Each alarm pass, after the drain and the embeddings and with the subrequests the pass has left (5 per mail: the
  read and its metadata fallback, the embedding, two views), decides up to 6 waiting mails again, oldest first: it
  re-reads the mail (metadata and body, as the drain does, with the read grant), gathers the same evidence and asks
  the same two views (`judge.ts`), as of the original decision, always with the full Clef: the sender history (decisions
  and verdicts before it), the examples (made before it; never the one the owner's answer to the same mail made, its own
  summary labelled with the answer) and the trusted domains (learned before it; a seeded one at any time, since the
  owner's former rule it stands for decided the mail before the migration of 2026-10-10 recorded it) are what live had
  then. So nothing the owner's answers taught later decides a mail: a trust-label mail whose domain its own answer
  taught is uncertain (`untrusted_sender`), and the summary does not count answers the model was shown. Each row keeps
  the decision's numbers, never content (`replay.ts` numbersOf, schema version 6): view 1's top option and its
  probability, the runner-up's probability, view 2's probability of that label as it answered, the combined
  probability, the higher p(suspicious), whether the sender was authenticated, whether the top
  label is a trust label, and the uncertain reason. It writes nothing to Gmail and makes no decision, verdict,
  example, review item, ledger row or flow count: only its own rows and the day's usage (Gmail calls, neurons). It
  also records whether the review quota of the mail's own day would have shown an uncertain decision, the replayed
  mails of that day competing as they arrived. A mail Gmail no longer gives (deleted, unreadable) is skipped; Gmail's rate, a refused grant or an
  outage stops the pass like any Google failure. A model outage backs the mail off as the drain does (5 minutes
  doubling, `replay.not_before`; the replay calls the model no more that pass and decides the other mails meanwhile)
  and gives it up after 7 tries, about five hours; a refused answer is tried 3 times; only then is it counted as
  uncertain (`model_unavailable`).
- It runs last in a pass, after the live pipeline, only while the day's neurons are below the owner's budget and
  Workers AI's quota lasts (else it waits for the next UTC day), never while Home's guard sheds (§10), and not in
  off mode (no Gmail read). It is a backtest without hindsight: how live would have decided each mail when it came,
  which understates what a sender's later mail gets once the owner has taught its domain, the safe direction for the
  check before going live.
- **GetReplayEvaluation** (GET `/api/v2/replayEvaluation`) answers counts, label names and numbers, no content: how many
  mails it covers, evaluated and skipped; confident labels and how many matched the owner; confident nones and how many
  matched 都不是; uncertain and how many the quota would have shown; the mismatching confident decisions as label
  pairs (decided, owner's), the most frequent first; the uncertain mails per reason (`reason_counts`); and `cases`, each
  evaluated mail's numbers with the owner's answer and the outcome (at most 200, in the order of the original
  decisions, no message ID; a mail evaluated before version 6 has none), which calibrate the thresholds: what precision
  and coverage another gating rule would have had. NOT_FOUND before the first start and after its rows were pruned
  (7 days after the start). Settings shows the counts, progress and main mismatches through 检查分类效果.

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

A row archives (removes INBOX) unless its label keeps the mail in the inbox (its 归档 off, §3.1); the owner's review
choices follow the same switch. Undo removes exactly the row's label and restores INBOX when it archived. It is refused (`NOT_UNDOABLE`, before any
intent is written) for a mail the owner has since moved to another label, and for a label that is no longer the
app's: deleted in 标签 (the Gmail label and its mails stay as they are) or missing in Gmail. Each entry says whether
it is `undoable`, with the mail's masked subject and sender while they are kept. 设置's 撤销 undoes a time range (1
小时, 24 小时, 7 天 or the owner's own, at most 31 days), of one label when one is chosen (UndoLedgerEntries' `label`):
预览 first counts the range's undoable entries from ListLedgerEntries (newest first, the label filter, at most 20
pages of 50; "至少" when it stopped there), and only 确认撤销 undoes them: the server undoes at most 20 per call and
answers how many are left; the page repeats the call until none is left (or a call undoes nothing) and shows the
totals. A preset range ends ten minutes after the browser's clock, so a write the Worker dated later is in it.
UndoLedgerEntry (one entry) stays in the API; the UI no longer lists the ledger. Labels are created in Gmail with their single-level English name just before the
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
unchanged), the UI 59.0 → 55.0 KiB gzip (budget 67 unchanged). Subrequests per mail: 6 (§4). Then the model-first UI
(§9; the Worker unchanged): 55.9 KiB gzip (budget unchanged: the one-tap answers, today's tally, the 7-day table; the
⋯ menu and the confidence bar gone). Then the review's fixes (view 2 on view 1's scale, the evidence as of a mail's
time, exact trusted domains, the teachable domain, the retry's trust check): the alarm pass at its bounds 30.5 ms, a
replay pass of 6 mails 10.8, MailsortState's API at most 7.8 first run (GetMailFlow; ListReviewItems with each item's
teachable domain 3.0), the fetch handler's very first request 2.0 (bounds unchanged); the Worker 121.9 → 123.0 KiB
gzip, the UI 55.9 → 56.2 KiB gzip (budgets unchanged). Then the replay's calibration numbers (2026-10-10: 200 cases in
GetReplayEvaluation): its answer over 200 mails 4.2 ms first run and 3.0 warm in MailsortState, the fetch handler 0.4
first and 0.8 warm; a replay pass of 6 mails 12.3; the Worker 123.0 → 124.6 KiB gzip, the UI 56.2 → 56.6 KiB gzip (the
descriptors; budgets unchanged).

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
about 18 neurons per Clef call, the default budget of 9,500 covers roughly 370 Clef calls a day before the switch to
Clef-flash (at 70 %), far above the expected volume.

Calibrated on the replay of the owner's answers (§5.1, 2026-10-10; 81 mails the owner had labelled, the numbers only):
Clef's most likely label matched the owner's in 70 of 81, and was none in 7. p(suspicious) did not tell ordinary mail
apart: it ranged 0.1–0.9 on the owner's own mail, 0.8–0.9 on real bank and account notices, so with the first gate
(below 0.3 for every label) 53 of 57 uncertain mails were uncertain for it alone and only 19 were labelled (all
right). Gating it only for unauthenticated senders (below 0.6) and trust labels (below 0.95), with the mean at 0.7,
labels about 59–62 of the 81 at about 97 % precision (the two misses: a travel company's offer the owner filed under
出行, labelled 购物/促销); 0.75 gives about 54 at 98 %. Phishing stays gated by what a sender cannot fake: DMARC aligned
with the From domain, and for a trust label the trusted domains.

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
diagram at zero, import and the ledger page not needed; redesigned again for the model-first decision on 2026-10-10:
the owner answers a few uncertain mails, not every one, so 待审 is a short list of one-tap answers, 概览 says what the
model did, and 标签 has neither rules nor 正式打). Plain TypeScript DOM (`web/src/dom.ts`, `components.ts`), no
framework; Chinese, short plain words, at most one hint line where needed.

- **Design system** (`styles.css`, unchanged since 2026-10-07): light and dark from `prefers-color-scheme` through CSS
  tokens (neutral `--bg`, `--surface`, `--sunken`, `--ink`, `--muted`, `--line`, and `--track` for an off switch, at
  least 3:1; one accent `--accent` with `--accent-soft`; `--warn` and `--danger` for state only; the flow's eight series
  and its zero gray), an 8 px spacing scale, a 10 px radius, 1 px hairlines, no heavy shadows, the system font with
  PingFang SC and Noto Sans SC, tabular figures for every number, a 2 px accent focus ring. One set of components:
  primary, ghost (the plain button) and quiet buttons, chips, a segmented control, a toggle switch, a disclosure (高级),
  a textarea that grows with its text, a card, a compact list row, a KPI number with an optional quiet line under it, a
  meter, a small table, an empty state, and the searchable label picker. A 48rem column with 16 px gutters; works at
  360 px: each page is one `minmax(0, 1fr)` grid column, so no child widens it (the flow diagram scrolls inside its own
  box below 600 px), and `check-layout.test.ts` pins the rules this depends on. (The ⋯ menu and the small bar went with
  the rules and the confidence bar.)
- **Shell** (`app.ts`): a sticky header with 邮件分拣 and, on the same row (wrapping under it on a phone), one quiet
  status line from ServiceStatus: the mode in force as a chip (影子 neutral, 正式 accent, 关闭 warn), `Gmail ✓ 只读`
  or `可写` (or the problem: 授权失效, 未授权, 未连接, in the warning color) and `下次运行 3 分钟后` (马上 within a
  minute); under it exactly four tabs, 待审 (with the queue's count as a chip, hidden at 0) · 概览 · 标签 · 设置, the
  current one underlined in the accent. The tabs are built once and only marked, so one chosen by keyboard keeps the
  focus. The status is read once per navigation and again after a review answer or a mode change. There is no other
  page (`/rules` answers 找不到这个页面).
- **待审** (`/`, `views/review.ts`): only uncertain mail, at most the daily quota (§5), newest first, one compact row
  each: the masked subject (one line, cut with …) and the time, the masked sender, why the model was uncertain in plain
  words (把握不够, 两次判断不一致, 疑似钓鱼, 发件人还不可信, 模型暂不可用), and the answers as one-tap buttons on one line:
  the model's options in its order, each with its probability after the name (`金融/银行 92%`; the first always, and
  primary; the others only from 5 %, so a 2 % option is no button), 都不是 where the model ranked it or after them,
  then 其他… (quiet: the searchable picker over every label, the first label the buttons do not offer highlighted and
  scrolled into sight; typing filters, ↑ ↓ move, Enter chooses, Escape closes) and, at the line's end, 跳过 (quiet).
  A label or 都不是 is ResolveReviewItem, 跳过 SkipReviewItem; the toast says 已确认 (the first option), 已改为, or 已选
  for a mail the model gave no options for. A suspected phishing mail and a trust label for a sender not trusted yet
  show one warning line instead of the reason (`疑似钓鱼：先在 Gmail 里核对发件人和链接`, `发件人还不可信：先在 Gmail 里核对发件人`);
  then no answer is primary and a label asks first (`…仍然选“银行”？`). Whatever the reason, an answer that would teach a
  trust label a domain (the item's `teachable_domain`, not yet in that label's list, §3.2) asks first and names it
  (`选“银行”？这会把 bank-alerts.example.net 记为“银行”的可信域名，以后这个域名的邮件可以自动打上它。`), and is never
  primary, so neither one tap nor Enter trusts a sender; 都不是 never asks. A mail the model gave no options for
  (`模型暂不可用`) says `：可用 其他… 选标签` after the reason and has no primary answer: 都不是 is a plain button, and
  Enter opens 其他…. Keyboard: j / k move between rows (the active one has an accent edge), 1 to 4 choose that answer,
  Enter the first (asking where it would), c opens 其他…, s skips; a hint line shows the keys where there is a fine pointer. An answer leaves the
  list at once and the next row takes the focus. With nothing to answer the page says 没有需要你确认的邮件 and one hint
  line, 只有模型拿不准的少数邮件会来这里. At 375 px a row's answers (one label, 都不是, 其他…, 跳过) are one line; at
  360 px 跳过 wraps to the right of the next.
- **概览** (`/overview`, `views/overview.ts`): from the top, one status line (what the mode in force does, as 设置 says
  it, or `正式：Gmail 只读授权，还不会写入` for live with a read-only grant; `上次同步 2 分钟前`; `2 封待判断` while mail
  waits); four KPI numbers for the UTC day, each with its last 7 days under it (`7 天 50`): 处理, 有把握 (a confident
  label, written or only recorded), 都不是 and 拿不准, today's from the flow's counters (the diagram's own numbers) and
  the week's from the label report; 2 × 2 on a phone. Then the card 今天的流程 with the Sankey diagram (§10), always
  drawn: with no mail the skeleton at zero (its nodes named, but not Tab stops) and the line 今天还没有邮件; where it
  scrolls in its box (a phone) it starts at its right end, where the mail went. Then, side by side from 640 px, 各标签 ·
  最近 7 天 (a table of each label with mail this week: 自动, 改正 (in Gmail and in 待审) and 拿不准, its name cut with …;
  else one line: 最近 7 天还没有邮件归到标签 when the week had mail but none on a label, 最近 7 天还没有邮件 when it had none) and 模型额度 (today's estimated neurons over the budget as a thin meter, warn from
  70 %, danger when used up, and a line only when Clef-flash is in use, the quota is gone or mail waits for tomorrow).
  No error box: the codes are never cleared and carry no time, so one transient `gmail_429` would stay for good
  (ServiceStatus still lists them).
- **标签** (`/labels`, `views/labels.ts` and `label-detail.ts`): a flat searchable list with each label's full name,
  7-day count and enable switch. Legacy names stay visible in full until consolidation; there are no grouping headers
  or indented tree rows. Expanding a row shows Chinese criteria, archive/trust/sensitive settings, trusted domains and
  examples. Advanced settings retain rename and deletion of the app record. Name validation matches the Worker.
  Gmail conflicts, missing labels, invalid external names and labels with children show a specific next action.
  Each update sends only changed fields and the current etag. The page retains empty, unavailable and narrow-screen
  states. During consolidation, mutation controls are disabled and the status points to Settings.
- **设置** (`/settings`): 模式: a segmented 关闭 · 影子 · 正式 (正式 asks first: 启用的标签会在
  Gmail 里给有把握的邮件打标签（按归档设置移出收件箱），待审里的选择也会写入; a choice sends only
  `mode` and the etag) and one line: what the mode does, or the
  deployment's ceiling (`受部署上限限制，按影子运行`), or the tripped breaker in words with 解除熔断, or, for 正式 with a
  read-only grant, `Gmail 只读授权，还不会写入：在本机运行 mint-token.mjs --scope modify` in the warning color (§12).
  撤销 (the safety net that replaced 操作记录, §7): a segmented 1 小时 · 24 小时 · 7 天 · 自定义 (two date-time fields),
  a label select (全部标签 first) and 预览, which shows `将撤销“出行”的 12 条` with 确认撤销 and 取消, or
  这段时间没有可撤销的写入. Gmail: one row, 从 Gmail 同步 (a toast says what the sync did). The write limits and the
  neuron budget are not in the UI; their stored values stand.
  检查分类效果 uses StartReplayEvaluation/GetReplayEvaluation: start, refresh, current progress, completed time,
  sample/agreement/unsure/skipped counts and main confusions. It explains the 14-day sample boundary and model cost;
  no samples, off mode, budget/quota waiting and dependency failure are distinct states. A running job disables start.
  整理标签 is folded by default: private JSON, current-ID/etag resolution, preview and explicit start. It shows durable
  phase, processed memberships, error and resume for the same task. No production mapping is embedded in assets.

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
  tokens, each complete label name gets its own color slot in label order, enabled labels first.
  The first eight keep their colors; later visible labels reuse colors absent from that day's graph.
  More than eight visible labels use gray for the remainder, explained by the legend; every node has its count;
  hover or focus for exact numbers and shares, and for an outcome what it means; no motion under
  prefers-reduced-motion; on a phone it scrolls inside its own box). On the right, under the labels written to Gmail:
  都不是（留在收件箱） in the pipeline's neutral color (a decision, not a warning), 拿不准 in the warning color and split
  by whether the mail went to 待审 (进了待审, 没进待审: the quota was full or there was nothing to ask), and
  影子建议（未写入）. A day without mail draws the skeleton (`skeletonGraph`): 新邮件, the five stages, and 打标签, 都不是,
  both 拿不准 and 影子建议 with every path a mail can take, laid out as one mail per path and drawn with hairline links,
  muted nodes and every count 0, so the diagram is never missing.
- **Emergency stop**, from fastest: 设置 → 关闭; the GitHub variable `MAILSORT_MODE=off` (or `shadow`) and a redeploy;
  revoking the grant at https://myaccount.google.com/permissions (Google account → Security → Third-party access).
- **Logs**: one line per alarm (mode, counts, a code) and per refused request (request ID, status, reason).

## 11. Tests

All data is synthetic (Chinese and English mails from example.com-style domains, `worker/test/fakes/fixtures.ts`);
the fake Gmail (`fake-gmail.ts`) and fake Workers AI (`fake-ai.ts`, Clef and bge-m3) answer every request.

- `worker/test/*.test.ts` (Node): the guard and the fuzz (nested names, only the store's planned names, a rename only
  to its label's planned path), masking, MIME, DMARC (forged and look-alike From, planted results); `decide.test.ts`
  the decision table (both views agreeing, the mean at the threshold, view 2 on view 1's scale, views that disagree,
  view 2 not run, suspicious in either view, confident none, the trust gate: authenticated, trusted domain,
  p(suspicious) below 0.95, an unauthenticated sender's p(suspicious), a disabled label), view 2's labels, the review
  quota and its informative band (a none top with a label in the band among it), the teachable domain and the public
  mailbox providers, the sender history's text, Clef's request (two noul questions, never needs_action, the options'
  order, path keys, lean state with the sender evidence) and strict read (a needs_action answer is an extra key);
  `store.test.ts` over the store's SQL on Node's SQLite: paths, IDs and option keys, the schema migrations (version 4
  to 5 seeds the trusted domains from the right rules, exact for an address rule and with subdomains for a domain rule,
  never a public mailbox provider, drops the rules, keeps labels and decisions with the sender as its hash and none
  shown, empties the queue's pending items, and runs again harmlessly; a migration cut short leaves version 4 as it
  was; versions 1 to 3 go straight to the current one; version 5 to 6 gives the replay its decision numbers, unset for
  the rows it has, once), the trusted domains (exact or with subdomains, never a look-alike, a learned one as of a time
  and a seeded one at any time, never a public mailbox provider, the bound of 50),
  the flow counters and the retention cleanup (the hash outliving the content, the replay's 7 days); `replay.test.ts`
  the replay's decision numbers from the two views, its cases (in order, at most 200, none for a mail evaluated before
  version 6) and reason counts, and the answer's wire JSON (only those fields, an unset probability left out); ops-v1's
  golden bytes (two are contract fixtures).
- `worker/test/runtime/*.test.ts` (workerd, a real SQLite MailsortState): `pipeline.test.ts` the pipeline in shadow and
  live (two views, view 2 over view 1's three labels reversed, only recorded in shadow, label and archive in live,
  confident none left in the inbox, a mail asking for action archived like any other and no needs_action asked), undo,
  a Gmail correction into an example, a trust label waiting until the owner's review choice teaches its domain (the
  item's teachable domain, the next mail written, the sender history in the model's state, a forged copy uncertain and
  reading no history), the daily review quota, skips, the resync, the auth stop, the Clef-flash switch with two views a
  mail, the quota deferral, the breaker (a refused write only recorded), a read-only
  grant; `replay.test.ts` the replay evaluation (no write even in live mode, no decision, verdict, example, review item,
  ledger row or flow count; the evidence as of each mail: an older example as a neighbour, never the mail's own or a
  later one, and a trust domain its own answer taught not yet trusted; a deleted mail skipped; a model outage backing
  a mail off without using up its tries; the summary's counts, label pairs, reason counts and each mail's numbers
  without content; a repeated request ID; a fresh start once the last one finished, with a seeded trusted domain
  counted at any time; waiting while shed and past the day's budget);
  `labels.test.ts` flat English labels without grouping creation, a trust label's
  domain learned and removed (RemoveTrustedDomain, etag and request ID), forged and look-alike From headers never
  borrowing it (the look-alike's own domain the only teachable one), Gmail labels adopted by the sync only (never at once, never a parent), renames, rejection of new
  Chinese or nested names, the flow counters and the label report, sensitive labels, retired IDs and a label-filtered range undo;
  `api.test.ts` the HTTP surface (the old `/api/v1` paths answering 410 RELOAD_REQUIRED), the owner API and ops-v1 over
  a service binding; `failures.test.ts`, the review's findings each as a regression test: a leftover write stopped by
  shadow, the breaker, the `MODE` ceiling and a disabled label (each left only recorded); retries against the run cap;
  a breaker tripped mid-pass; a trust label's retry after its domain was deleted (`untrusted_sender`); a poison mail (400, a lasting 500, a refused ID) never blocking the queue; a deleted or
  missing label's undo; the resync's read order and its install-time cutoff; a model outage backing off; one label per
  conversation after undo; a retry that finds the mail archived or filed by the owner (`mail_changed`); the content
  cleanup after 20 days off; the owner's own Gmail labels never taken over (a write never adopts, a label already on
  the mail is never written so its undo cannot take it off, no adoption of a label with sublabels, a 409 is the
  owner's); `cpu.test.ts` the CPU bounds (§8).
- `worker/test/smoke/smoke.mts`: the real `wrangler dev` (`../wrangler.test.toml`) against the fakes on loopback, the
  owner's whole loop through the HTTP API: two views in shadow, live labels, confident none, a pickup code archived and
  a label with 归档 off keeping its mail in the inbox, undo, a trust label's domain learned from the review queue and a
  forged From, Gmail corrections into examples, an adoption, a flat English label, the replay evaluation, the Clef-flash
  switch, the quota deferral, the flow API, a rename preserving its Gmail ID, a label-filtered range undo, the
  old `/api/v1` paths' 410 and the auth failure.
- `web/src/*.test.ts`: the views against a fake API on the shared transcoder: `app.test.ts` the shell (four tabs, the
  focus kept on a tab, the status line, 马上, the queue's count), 待审 (the one-tap answers in the model's order with
  their probabilities and the 5 % floor, 都不是 ranked or appended, ResolveReviewItem with a label or 都不是 and
  SkipReviewItem with CSRF and a request ID, 其他…'s picker and its highlighted label scrolled into sight, the keyboard
  with the digits, the caution for phishing and an untrusted sender, the question naming the domain before any answer
  that would teach one (never primary, Enter too), a mail without the model's options (no primary, Enter opens 其他…),
  the reasons in words, the quiet state 没有需要你确认的邮件), 设置 (the mode's mask and question, the ceiling, the breaker, 正式 with a
  read-only grant, the undo's preview and rounds, one label's undo, the custom range, the sync; no filter export);
  `labels.test.ts` 标签 (the flat list, the one-line row with its 7-day count, also without the report, and 启用
  with its mask, etag and refusal, one detail open at a time, the search over names, the description on blur, 归档
  saving `keep_in_inbox` inverted, a trust label's trusted domains with 删除 and their empty line once 可信 is turned
  on, the examples on demand, the Gmail state lines, 高级 without 启用 and with 敏感's question, the visible 未启用,
  rename and delete, a new label, also when there is none; the fake refuses a stale etag and changes only masked
  fields); `overview.test.ts` the flow graph and diagram (hues, 都不是 apart from 拿不准 and in the neutral color,
  拿不准 split by 待审, size, tooltip, tokens, the zero skeleton out of the Tab order, the phone's start at the
  outcomes) and 概览 with and without mail (the status line, also live with a read-only grant, today's tally and the 7
  days under each number, the per-label table and its two empty lines), without an error box; `check-layout.test.ts` the switch rows and the
  phone-width rules (one column per page and per 待审 row, the time on one line, the settings rows, the label list's
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
created. Mailsort is already enabled in the release workflow (`CHECK_ONLY` is empty); follow the root rebuild
runbook for a new environment. After the first deploy, the `MailsortState` namespace id goes into `config/resources.toml`
`[durable_objects]` as `mailsort-state`.

Start in shadow to check the model's recorded decisions; shadow does not create review items. For live sorting,
grant `gmail.modify` (mint-token `--scope modify`), set `MAILSORT_MODE=live` and choose 正式 in 设置. Answer the
uncertain samples in 待审, then use Settings' classification-effect check (§5.1) and inspect trusted domains in 标签.
Every enabled label participates in live sorting. Eligible operations remain available in 设置 → 撤销.
