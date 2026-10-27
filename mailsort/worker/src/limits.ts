/**
 * Every bound of the Worker "mailsort" in one place (../../docs/design.md §8). Workers Free: 10 ms of CPU per Worker
 * request, 30 s of CPU per Durable Object invocation (an alarm, a request) and 50 subrequests per invocation. The
 * selected model is called through Model Router once per bounded batch.
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ---- scheduling --------------------------------------------------------------------------------------------------

/** The alarm's period when nothing is waiting. */
export const ALARM_IDLE_MS = 5 * MINUTE;
/** The next alarm while a backlog waits (pending mails, intended writes). */
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
 * The subrequests one alarm may make (Google and Claude together), below the 50 of the platform so that a retry
 * inside the run never hits the limit. Each step checks what is left before it starts.
 */
export const ALARM_SUBREQUESTS = 40;
/**
 * Per-mail allowance for a Gmail read (with metadata fallback) and a write. One Claude request serves the batch.
 * A label's creation in Gmail before its first write is checked apart (writes.ts executeWrites).
 */
export const MAIL_SUBREQUESTS = 3;
/** Mails sent in one Claude request per alarm, subject to the remaining Gmail request budget. */
export const DRAIN_MAX = 10;
/** History pages read per alarm (each up to HISTORY_PAGE_SIZE records). */
export const HISTORY_PAGES_MAX = 3;
export const HISTORY_PAGE_SIZE = 100;
/** After a lost history cursor (404): the inbox's mails of the last two days, at most this many. */
export const RESYNC_MAX = 100;
export const RESYNC_QUERY = 'newer_than:2d';
/** Automatic catch-up stays in the same two-day Inbox window and excludes existing priorities. */
export const RECENT_CLASSIFICATION_AGE_MS = 2 * DAY;
export const RECENT_CLASSIFICATION_QUERY = `${RESYNC_QUERY} -label:P1 -label:P2 -label:P3 -label:P4`;

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
export const BODY_CHARS = 12000;
/** Base64 characters decoded at most (96 KiB of bytes, enough for 12000 Unicode body characters). */
export const BODY_BASE64_MAX = 128 * 1024;
/** MIME parts visited at most, and the deepest nesting. */
export const MIME_PARTS_MAX = 60;
export const MIME_DEPTH_MAX = 6;
/** A decision's masked summary, kept with its content for CONTENT_KEPT_MS. */
export const EXAMPLE_SUMMARY_CHARS = 200;

// ---- the retired replay evaluation's stored results -------------------------------------------------------------------

/** Its rows are pruned this long after it started. */
export const REPLAY_KEPT_MS = 7 * DAY;
/** GetReplayEvaluation answers at most this many cases (each evaluated mail's numbers). */
export const REPLAY_CASES_MAX = 200;

// ---- model failures ------------------------------------------------------------------------------------------------

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
/** Trusted domains per label at most (historical; the oldest goes first past it). */
export const TRUSTED_DOMAINS_PER_LABEL_MAX = 50;
export const EXAMPLES_MAX = 2000;
export const EXAMPLES_PER_LABEL_MAX = 200;
/** Subjects, senders and summaries of decided mails (and the review queue) are kept this long. */
export const CONTENT_KEPT_MS = 14 * DAY;
/** Decisions and the ledger (IDs, labels, probabilities) are kept this long. */
export const DECISIONS_KEPT_MS = 180 * DAY;
export const REQUEST_ID_TTL_MS = DAY;
export const ERRORS_KEPT = 8;

// ---- the owner API -----------------------------------------------------------------------------------------------------

/** Maximum owner request body, including a bounded private consolidation plan. */
export const MAX_BODY_BYTES = 32 * 1024;
export const PAGE = 50;
export const LABEL_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
/** New labels use a single English name. Older paths remain readable during label consolidation. */
export const LABEL_NAME_MAX = 40;
/** Legacy path limits; never used to accept a new owner-supplied label name. */
export const LABEL_DEPTH_MAX = 3;
export const LABEL_SEGMENT_MAX = 40;
export const DISPLAY_NAME_MAX = 100;
export const DESCRIPTION_MAX = 300;
/** Reserved former grouping root, used only while reading legacy paths. */
export const LEGACY_LABEL_ROOT = '分拣';
/** The flow counters (flow.ts) are kept this many UTC days, like the daily usage. */
export const FLOW_KEPT_DAYS = 400;
/** GetMailFlow answers at most this many counters. */
export const FLOW_COUNTS_MAX = 2000;
/** The model's option for "no label fits"; never a label ID. */
export const NONE = 'none';
