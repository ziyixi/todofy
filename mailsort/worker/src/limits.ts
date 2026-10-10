/**
 * Every bound of the Worker "mailsort" in one place (../../docs/design.md §8). Workers Free: 10 ms of CPU per Worker
 * request, 30 s of CPU per Durable Object invocation (an alarm, a request), 50 subrequests per invocation, and Workers
 * AI's 10,000 neurons a day shared by the whole account. The numbers below keep each alarm well inside those.
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ---- scheduling --------------------------------------------------------------------------------------------------

/** The alarm's period when nothing is waiting. */
export const ALARM_IDLE_MS = 5 * MINUTE;
/** The next alarm while a backlog waits (pending mails, unembedded examples, intended writes). */
export const ALARM_BACKLOG_MS = 30 * SECOND;
/**
 * Mail received this long before the install-time cursor was stored is never decided (no backfill), even when a lost
 * cursor's resync lists it. The grace covers the clocks of Google and the Worker.
 */
export const INSTALL_GRACE_MS = 5 * MINUTE;
/** How soon an API call that needs the pipeline (a new mode, a review choice) brings the alarm forward. */
export const WAKE_MS = SECOND;
/** After an alarm that threw: try again this much later. */
export const ALARM_ERROR_RETRY_MS = MINUTE;

// ---- subrequests (50 per invocation on Workers Free) --------------------------------------------------------------

/**
 * The subrequests one alarm may make (Google and Workers AI together), below the 50 of the platform so that a retry
 * inside the run never hits the limit. Each step checks what is left before it starts.
 */
export const ALARM_SUBREQUESTS = 40;
/**
 * A mail's worst case: messages.get (and its metadata fallback), an embedding, the decision model's two views, a
 * modify. A label's creation in Gmail before its first write is checked apart (writes.ts executeWrites).
 */
export const MAIL_SUBREQUESTS = 6;
/** Mails decided per alarm at most: 6 x 6 = 36, after the token and up to three history pages (40 in all). */
export const DRAIN_MAX = 6;
/** History pages read per alarm (each up to HISTORY_PAGE_SIZE records). */
export const HISTORY_PAGES_MAX = 3;
export const HISTORY_PAGE_SIZE = 100;
/** After a lost history cursor (404): the inbox's mails of the last two days, at most this many. */
export const RESYNC_MAX = 100;
export const RESYNC_QUERY = 'newer_than:2d';
/** Examples embedded per alarm (one batched call). */
export const EMBED_BATCH = 8;

// ---- Gmail reads -----------------------------------------------------------------------------------------------------

/** The most bytes of one messages.get answer the Worker reads; a larger mail is read again as metadata only. */
export const MESSAGE_MAX_BYTES = 512 * 1024;
/** The most bytes of any other Google answer (history, labels, token). */
export const RESPONSE_MAX_BYTES = 1024 * 1024;
/** A Google request's timeout. */
export const GOOGLE_TIMEOUT_MS = 15 * SECOND;
/** The access token is reused this long (Google's last an hour). */
export const ACCESS_TOKEN_TTL_MS = 55 * MINUTE;
/** Consecutive refusals of the grant (invalid_grant, 401) before the Worker stops calling Google. */
export const AUTH_FAILURES_STOP = 3;

// ---- what the model reads --------------------------------------------------------------------------------------------

export const SUBJECT_CHARS = 200;
export const SENDER_CHARS = 120;
export const SNIPPET_CHARS = 300;
export const BODY_CHARS = 2000;
/** Base64 characters of a body part decoded at most (about 24 KiB of text, far more than BODY_CHARS needs). */
export const BODY_BASE64_MAX = 32 * 1024;
/** MIME parts visited at most, and the deepest nesting. */
export const MIME_PARTS_MAX = 60;
export const MIME_DEPTH_MAX = 6;
/** An example's summary, and the share of it one neighbour may put into the model's state. */
export const EXAMPLE_SUMMARY_CHARS = 200;
export const NEIGHBOUR_TOKENS_MAX = 120;
/** Neighbours retrieved and shown to the model. */
export const NEIGHBOURS = 3;

// ---- decisions (../../docs/design.md §4) ----------------------------------------------------------------------------

/** A label is accepted when both views chose it and the mean of their probabilities reaches this. Not owner-facing. */
export const AUTO_THRESHOLD = 0.7;
/** The second view runs only when the first view's top option is a label at least this likely. */
export const SECOND_VIEW_MIN = 0.4;
/** The second view's options: the first view's most likely labels, this many (plus none). */
export const SECOND_VIEW_LABELS = 3;
/** "No label fits" is confident when the first view's top option is none with at least this probability. */
export const NONE_CONFIDENT = 0.6;
/** No label is accepted while p(suspicious), the higher of the two views', reaches this. */
export const SUSPICIOUS_MAX = 0.3;
/** ... and no trust label while it reaches this. */
export const TRUST_SUSPICIOUS_MAX = 0.1;
/** A mail whose p(needs_action), the higher of the two views', reaches this stays in the inbox with its label. */
export const NEEDS_ACTION_KEEP = 0.6;
/** Sender history: the labels of the sender's earlier mail this far back, the most frequent this many. */
export const SENDER_HISTORY_MS = 180 * DAY;
export const SENDER_HISTORY_TOP = 3;
/** ... read from at most this many of the sender's newest decisions. */
export const SENDER_HISTORY_ROWS = 200;
/** Trusted domains per label at most (a review choice adds one; the oldest goes first past it). */
export const TRUSTED_DOMAINS_PER_LABEL_MAX = 50;
/** An applied label untouched this long is a weak accept. */
export const WEAK_ACCEPT_MS = 3 * DAY;
/** Weak-accept examples are added only while the label has fewer examples than this. */
export const WEAK_EXAMPLES_BELOW = 50;

// ---- the review queue (../../docs/design.md §5) ---------------------------------------------------------------------

/**
 * The daily quota of uncertain mails shown in the review queue: this share of the last 7 UTC days' average daily
 * mail, rounded up, within REVIEW_QUOTA_MIN and REVIEW_QUOTA_MAX.
 */
export const REVIEW_SHARE = 0.05;
export const REVIEW_QUOTA_MIN = 1;
export const REVIEW_QUOTA_MAX = 5;
/** The informative band: an uncertain mail whose top label's combined probability is in [this, AUTO_THRESHOLD). */
export const INFORMATIVE_MIN = 0.35;

// ---- the replay evaluation (../../docs/design.md §5.1) ---------------------------------------------------------------

/** The review items it covers: resolved in this window before the start, at most this many. */
export const REPLAY_WINDOW_MS = 14 * DAY;
export const REPLAY_ITEMS_MAX = 200;
/** Mails decided again per alarm at most, each needing this many of the pass's leftover subrequests. */
export const REPLAY_BATCH = 6;
export const REPLAY_SUBREQUESTS = 5;
/** The replay calls the model only while the day's neurons are below this share of the owner's budget. */
export const REPLAY_NEURON_SHARE = 0.5;
/** Its rows are pruned this long after it started. */
export const REPLAY_KEPT_MS = 7 * DAY;

// ---- Workers AI ----------------------------------------------------------------------------------------------------------

export const CLEF = '@cf/cloudflare/clef';
export const CLEF_FLASH = '@cf/cloudflare/clef-flash';
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
/** Neurons per million input tokens (Workers AI pricing, 2026-10). */
export const NEURONS_PER_M_TOKENS: Readonly<Record<string, number>> = { [CLEF]: 21_818, [CLEF_FLASH]: 8_182, [EMBEDDING_MODEL]: 1_075 };
/** Past this share of the daily neuron budget the rest of the UTC day uses Clef-flash. */
export const FLASH_SWITCH_SHARE = 0.7;
export const DEFAULT_DAILY_NEURON_BUDGET = 7_000;
export const NEURON_BUDGET_MIN = 500;
export const NEURON_BUDGET_MAX = 10_000;
/**
 * A mail whose read or model call failed (Gmail or Workers AI unavailable, not the quota) waits RETRY_BASE_MS, doubling
 * per failure up to RETRY_MAX_MS, and is given up after MAIL_ATTEMPTS_MAX tries: 5+10+20+40+80+160 minutes, about
 * five hours, so a short outage never turns waiting mail into unsure decisions. The backoff is per mail, so one mail
 * Gmail cannot answer for never holds up the mail behind it.
 */
export const RETRY_BASE_MS = 5 * MINUTE;
export const RETRY_MAX_MS = 6 * HOUR;
export const MAIL_ATTEMPTS_MAX = 7;
/** A Clef answer this code refused (clef_bad_*): a few tries only, it is the answer, not an outage. */
export const BAD_ANSWER_ATTEMPTS_MAX = 3;

// ---- writes and the breaker -----------------------------------------------------------------------------------------------

export const DEFAULT_RUN_WRITE_LIMIT = 10;
export const RUN_WRITE_LIMIT_MAX = 10;
export const DEFAULT_DAILY_WRITE_LIMIT = 150;
export const DAILY_WRITE_LIMIT_MAX = 500;
/** The breaker's label-share rule: at least this many writes today, and one label's share above both bounds. */
export const SHARE_MIN_WRITES = 15;
export const SHARE_MAX = 0.6;
/** ... and more than this many times its share of the last 7 days. */
export const SHARE_JUMP = 2;
/** A Gmail write is retried by this many alarms before its ledger entry fails. */
export const WRITE_ATTEMPTS_MAX = 5;
/** UndoLedgerEntries undoes at most this many entries per call. */
export const UNDO_BATCH = 20;
export const UNDO_RANGE_MAX_MS = 31 * DAY;

// ---- stores and retention -----------------------------------------------------------------------------------------------------

export const LABELS_MAX = 24;
export const EXAMPLES_MAX = 2000;
export const EXAMPLES_PER_LABEL_MAX = 200;
/** Subjects, senders and summaries of decided mails (and the review queue) are kept this long. */
export const CONTENT_KEPT_MS = 14 * DAY;
/** Decisions and the ledger (IDs, labels, probabilities) are kept this long. */
export const DECISIONS_KEPT_MS = 180 * DAY;
export const REQUEST_ID_TTL_MS = DAY;
export const ERRORS_KEPT = 8;

// ---- the owner API -----------------------------------------------------------------------------------------------------

/** A request body at most: the largest is a label with its description. */
export const MAX_BODY_BYTES = 16 * 1024;
export const PAGE = 50;
export const LABEL_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
/**
 * A label's path (Label.display_name), which is also its Gmail name: at most LABEL_DEPTH_MAX segments of
 * LABEL_SEGMENT_MAX characters each, DISPLAY_NAME_MAX in all. Gmail shows `开发/CI通知` nested under `开发`.
 */
export const LABEL_DEPTH_MAX = 3;
export const LABEL_SEGMENT_MAX = 40;
export const DISPLAY_NAME_MAX = 100;
export const DESCRIPTION_MAX = 300;
/**
 * The prefix the labels had in Gmail until 2026-10-07 (`分拣/开发/CI通知`). It is never written; on input (a path typed
 * in 标签) it is read as nothing, so `分拣/x` is `x` at every entry point.
 */
export const LEGACY_LABEL_PREFIX = '分拣/';
/** The legacy prefix's own segment: no path starts with it, so `分拣/x` always reads as `x`. */
export const LEGACY_LABEL_ROOT = '分拣';
/** The flow counters (flow.ts) are kept this many UTC days, like the daily usage. */
export const FLOW_KEPT_DAYS = 400;
/** GetMailFlow answers at most this many counters. */
export const FLOW_COUNTS_MAX = 2000;
/** The model's option for "no label fits"; never a label ID. */
export const NONE = 'none';
