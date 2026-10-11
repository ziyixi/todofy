/**
 * Every bound and starting constant of the Worker "brief" in one place (../../docs/design.md §2-§14). Workers Free:
 * 10 ms of CPU per Worker request, 30 s of CPU per Durable Object invocation (an alarm, a request), 15 minutes of wall
 * time per alarm, 50 subrequests per invocation, 128 MB; Workers AI's 10,000 neurons a day are shared by the whole
 * account. The constants marked "starting value" are the ones the shadow week sets (design §16).
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ---- the schedule (America/Los_Angeles, design §2) -------------------------------------------------------------------

export const TIME_ZONE = 'America/Los_Angeles';
/** The fetch rounds of every day ("HH:MM" local). */
export const FETCH_ROUNDS = ['12:30', '18:30', '23:30'] as const;
/** The cutoff round, Monday to Saturday: the last fetch before the day's pick. */
export const CUTOFF_ROUND = '03:30';
/** The round that reads sources with `poll_per_day: 1` (after arXiv's evening announcement). */
export const DAILY_ROUND = '18:30';
/** The send times: weekdays and Saturday; nothing is sent after the cutoff. */
export const SEND_WEEKDAY = '06:30';
export const SEND_SATURDAY = '07:30';
export const SEND_CUTOFF = '12:00';
/** The weekly learning (Sunday). */
export const LEARN_TIME = '12:00';
/** `issue_late` past this on an issue day (weekdays and Saturday). */
export const LATE_TIME = '07:30';

// ---- the alarm chain (design §14) ------------------------------------------------------------------------------------

/** The next alarm while a step has more to do. */
export const ALARM_NEXT_MS = SECOND;
/** After an alarm that threw: try again this much later. */
export const ALARM_ERROR_RETRY_MS = 5 * MINUTE;
/** How soon an API call that needs the pipeline (resume, a new budget) brings the alarm forward. */
export const WAKE_MS = SECOND;
/** The platform's wall time of one alarm invocation. */
export const ALARM_WALL_MS = 15 * MINUTE;
/**
 * The wall time a fetching step (collect, read) gives itself in one alarm, its own AbortSignal included: well inside
 * the 15 minutes, so that host spacing never runs an alarm into the platform's limit; what is left goes on in the next.
 */
export const STEP_WALL_MS = 4 * MINUTE;
/** The external requests one alarm may make (feeds, pages, Workers AI, Claude, Resend), below the platform's 50. */
export const ALARM_SUBREQUESTS = 40;
/**
 * A step that started and never committed (the isolate died: the CPU or memory limit, the wall time, a crash) counts
 * one crash; a deploy that killed it (an older BUILD_SHA) does not. After this many crashes the step gives up with a
 * code instead of crashing every alarm.
 */
export const STEP_CRASHES_MAX = 3;
/** No alarm progress for this long: status() re-arms the alarm and says `scheduler_stale`. */
export const SCHEDULER_STALE_MS = 12 * HOUR;

// ---- fetching (design §3) ---------------------------------------------------------------------------------------------

/** The honest user agent: no address, no cookie (design §3.3). */
export const USER_AGENT = 'Mozilla/5.0 (compatible; ziyixi-brief/1.0; personal research digest)';
/** The product token a robots.txt may name to keep the brief out (its Disallow rules are honoured). */
export const ROBOTS_TOKEN = 'ziyixi-brief';
export const FETCH_TIMEOUT_MS = 15 * SECOND;
export const MAX_REDIRECTS = 5;
/** A feed's default read size (sources.yaml `max_bytes`). */
export const FEED_MAX_BYTES = 1024 * 1024;
/** A page's read size for full text. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** robots.txt is read up to this size (RFC 9309 §2.5 asks for at least 500 KiB). */
export const ROBOTS_MAX_BYTES = 512 * 1024;
/** Per host: at least this long between two requests, or the host's Crawl-delay when longer. */
export const HOST_SPACING_MS = 3 * SECOND;
/** The longest Crawl-delay honoured (a larger one defers the host to later alarms at this spacing). */
export const CRAWL_DELAY_MAX_MS = 60 * SECOND;
/** A host's wait this short is slept through inside the alarm; a longer one defers its sources to a later alarm. */
export const HOST_WAIT_SLEEP_MAX_MS = 16 * SECOND;
/** 429 and 503 back off for Retry-After or this long, doubling, up to the maximum. */
export const HOST_BACKOFF_MS = 15 * MINUTE;
export const HOST_BACKOFF_MAX_MS = 6 * HOUR;
/** robots.txt verdicts are kept this long; a 5xx or no answer only this long. */
export const ROBOTS_TTL_MS = DAY;
export const ROBOTS_ERROR_TTL_MS = HOUR;
/** A sitemap URL whose page fails for a moment (a 5xx, a timeout) is tried in this many rounds, then skipped. */
export const SITEMAP_URL_TRIES = 3;
/** A failed poll (status, timeout, parse error, too large) counts; this many in a row pause the source. */
export const SOURCE_FAILURES_PAUSE = 5;
/** A paused source is tried this often. */
export const PAUSED_RETRY_MS = DAY;
/** arXiv: each query reads the submissions of this window, in pages of ARXIV_PAGE, at most ARXIV_PAGES pages. */
export const ARXIV_WINDOW_DAYS = 7;
export const ARXIV_PAGE = 100;
export const ARXIV_PAGES = 5;
/** Stale: silent for this many times the source's usual gap, at least STALE_MIN_MS; a sparse source STALE_SPARSE_MS. */
export const STALE_FACTOR = 3;
export const STALE_MIN_MS = 7 * DAY;
export const STALE_SPARSE_MS = 30 * DAY;
export const STALE_SPARSE_BELOW = 4;
export const ACCEPT_HISTORY_MS = 60 * DAY;
/** The accepted-item times a source keeps for its usual gap. */
export const ACCEPT_HISTORY_MAX = 120;

// ---- items, deduplication and clusters (design §4) -------------------------------------------------------------------

export const TITLE_MAX = 300;
export const SUMMARY_MAX = 2000;
export const LINK_MAX = 1000;
/** World items stay eligible this long; research this long. */
export const WORLD_ELIGIBLE_MS = 3 * DAY;
export const RESEARCH_ELIGIBLE_MS = 7 * DAY;
/**
 * An entry whose date is older than this is not ingested: past its eligibility (research 7 days, world 3) with room for
 * a late feed, and shorter than ITEMS_KEPT_MS, so an entry a feed keeps listing never comes back as new after its item
 * is pruned.
 */
export const RESEARCH_ENTRY_MAX_AGE_MS = 21 * DAY;
export const WORLD_ENTRY_MAX_AGE_MS = 7 * DAY;
/** Mentions name items fetched within this window. */
export const MENTION_WINDOW_MS = 7 * DAY;
/** An item at this cosine or above to one that ran in the last HELD_BACK_WINDOW_MS is held back (已报道). */
export const HOLD_BACK_COSINE = 0.88;
export const HOLD_BACK_WINDOW_MS = 7 * DAY;
/** A world item joins the most similar cluster of the last CLUSTER_WINDOW_MS at this cosine (starting value). */
export const CLUSTER_COSINE = 0.86;
export const CLUSTER_WINDOW_MS = 72 * HOUR;
/** Pairs within this distance of the threshold are logged (IDs and cosines only) for the shadow week. */
export const CLUSTER_NEAR = 0.03;
/** Embeddings: the title and the summary's first characters, this many texts a call. */
export const EMBED_SUMMARY_CHARS = 600;
export const EMBED_BATCH = 50;
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;
/** Neurons per million input tokens (Workers AI pricing, 2026-10). */
export const NEURONS_PER_M_TOKENS = 1075;
/** The brief's own daily cap on neurons (the account's free 10,000 are mostly mailsort's). */
export const DAILY_NEURON_CAP = 500;

// ---- the gate (design §5.1) ------------------------------------------------------------------------------------------

export const GATE_MODEL = 'claude-haiku-5-5';
export const GATE_GROUP = 12;
export const GATE_CALLS_PER_ROUND = 10;
export const GATE_DAILY_MAX = 400;
export const GATE_SUMMARY_CHARS = 1200;
export const GATE_MAX_TOKENS = 4096;
/** Passing scores: a research card needs this; a world cluster this; the fallback shortlist's world clusters this. */
export const GATE_PASS = 6;
export const WORLD_FALLBACK_PASS = 7;
/** A world candidate Haiku refused passes when this many independent sources carry its story. */
export const WORLD_REFUSED_SOURCES = 3;
/** `gate_refused_high` above this share of a day's candidates. */
export const GATE_REFUSED_WARN = 0.05;

// ---- corroboration and the order (design §5.2; starting values) -------------------------------------------------------

export const ORDER_SOURCES = 0.75;
export const ORDER_MENTIONED = 1;
export const ORDER_UPVOTES = 1.5;
export const ORDER_CORROBORATION_MAX = 3;
export const ORDER_WORLD_SOURCES = 0.5;
export const ORDER_WORLD_SIGNAL = 0.5;
export const ORDER_WORLD_READABLE = 1;

// ---- cards, the pick and the shortlist (design §5.3, §6) ---------------------------------------------------------------

export const RESEARCH_CARDS = 40;
export const RESEARCH_CARDS_PER_TOPIC = 10;
/**
 * Every topic's best cards are kept first (the 专业 topics' more), then the rest fills by order: corroboration
 * (sources, mentions, upvotes) reaches ML papers only, so order alone can leave the owner's own field without a card.
 */
export const CARDS_FLOOR = 3;
export const CARDS_FLOOR_PROFESSIONAL = 5;
/** The deep read's week of cards: every topic's best 2 (the 专业 topics' 3) first. */
export const DEEP_CARDS_FLOOR = 2;
export const DEEP_CARDS_FLOOR_PROFESSIONAL = 3;
export const WORLD_CARDS = 10;
export const CARD_SUMMARY_CHARS = 800;
export const PICK_RESEARCH_MAX = 8;
export const PICK_WORLD_MAX = 3;
export const PICK_PER_TOPIC = 2;
/** The issue's items in all (policy.md: 5-8 items, about a 3-minute read): research takes what world leaves. */
export const PICK_TOTAL_MAX = 8;
export const PICK_REASON_MAX = 60;
export const MORE_ITEMS_MAX = 5;
/** The pick and its one retry, then the gate order. */
export const PICK_ATTEMPTS = 2;

// ---- full text (design §6) ----------------------------------------------------------------------------------------------

/** A document is cut to this many characters, a quarter of them kept for the conclusion or discussion. */
export const DOCUMENT_CHARS = 16_000;
export const CONCLUSION_SHARE = 0.25;
/** A page whose extraction yields less than this is no full text (a paywall, a login, a script-only page). */
export const PAGE_TEXT_MIN = 1200;
/** Each page is tried this many times (in later alarms), then the feed's text is used. */
export const PAGE_ATTEMPTS = 2;
/**
 * The read waits for a host that is not ready at most this long at a time, and never past an hour before the send:
 * a host backing off for longer leaves its document with the feed's text.
 */
export const READ_WAIT_MAX_MS = 10 * MINUTE;
export const READ_SEND_MARGIN_MS = 60 * MINUTE;
/** World packets: the cluster's best candidate documents, at most this many. */
export const WORLD_DOCUMENTS = 2;
/** The deep read's thread: at most this many documents. */
export const DEEP_DOCUMENTS = 8;
/** After a deep read ran out of tokens or time, its next attempts read the thread's first this many documents. */
export const DEEP_RETRY_DOCUMENTS = 4;
/** Fetched full text is kept this long after its issue. */
export const TEXT_KEPT_MS = 7 * DAY;

// ---- the model calls (design §7, §9, §13) ---------------------------------------------------------------------------------

export const OPUS_MODEL = 'claude-opus-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** The SDK's timeout covers only the time to response headers; the stream has its own deadline. */
export const SDK_TIMEOUT_MS = 120 * SECOND;
/** A model stream's own deadline, never past the alarm's time left minus a minute. */
export const MODEL_DEADLINE_MS = 13 * MINUTE;
export const MODEL_DEADLINE_MARGIN_MS = 60 * SECOND;
/** An Opus call never starts with less than this left in its alarm (it is the first thing its alarm does). */
export const MODEL_MIN_LEFT_MS = 11 * MINUTE;
/** No byte of the stream (pings included) for this long is a stall. */
export const STREAM_STALL_MS = 3 * MINUTE;
export const PICK_MAX_TOKENS = 32_000;
export const WRITE_MAX_TOKENS = 64_000;
export const REPAIR_MAX_TOKENS = 32_000;
export const DEEP_PICK_MAX_TOKENS = 32_000;
export const DEEP_WRITE_MAX_TOKENS = 64_000;
export const ENTAIL_MAX_TOKENS = 8192;
/** Writes: 3 attempts 15 minutes apart; repairs 2; bisection at most 4 extra calls. */
export const WRITE_ATTEMPTS = 3;
export const WRITE_RETRY_MS = 15 * MINUTE;
export const REPAIR_ATTEMPTS = 2;
export const BISECT_CALLS_MAX = 4;
/** Paused (设置) or switched off (BRIEF_MODE=off) mid-run: the step makes no call and looks again this much later. */
export const PAUSED_RECHECK_MS = 10 * MINUTE;
/** 408, 409, 429, 529 or 5xx before a stream: retried after this, doubling, until the send cutoff. */
export const TRANSIENT_RETRY_MS = MINUTE;
export const TRANSIENT_RETRY_MAX_MS = 15 * MINUTE;
/** The deep-read pick reads this many cards and the titles of the last deep reads. */
export const DEEP_CARDS = 30;
export const DEEP_RECENT = 4;
export const DEEP_THREAD_MIN = 3;
export const DEEP_THREAD_MAX = 8;
/** The deep read's length in characters (outside the hard bounds is a failure for the repair). */
export const DEEP_CHARS_MIN = 1500;
export const DEEP_CHARS_MAX = 2500;
export const DEEP_HARD_MIN = 1200;
export const DEEP_HARD_MAX = 3000;
/** More than this share of the deep read cut by the check: it is not sent. */
export const DEEP_CUT_MAX = 0.25;

// ---- the grounding check (design §8) ------------------------------------------------------------------------------------

export const QUOTE_MIN = 20;
export const QUOTE_MIN_CJK = 8;
export const QUOTE_MAX = 300;
/** The alignment's share of the quote's tokens found in order, and the window's length over the quote's. */
export const ALIGN_MIN_SHARE = 0.9;
export const ALIGN_WINDOW = 1.2;
/** A written quantity is at most this far from its source number, whatever its precision (10 倍 is not 5.2x). */
export const QUANTITY_MAX_ERROR = 0.1;
/** An item that loses more than this share of its characters is dropped. */
export const ITEM_CUT_MAX = 1 / 3;
/** `ground_drop_high` when more than this share of an issue's items is dropped. */
export const DROP_WARN = 0.4;

// ---- the budget (design §13) ----------------------------------------------------------------------------------------------

export const DEFAULT_MONTHLY_BUDGET_USD = 40;
export const MONTHLY_BUDGET_MIN = 5;
export const MONTHLY_BUDGET_MAX = 100;

// ---- delivery (design §11, §12) -------------------------------------------------------------------------------------------

export const RESEND_URL = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 30 * SECOND;
export const EMAIL_HTML_MAX = 60 * 1024;

// ---- feedback and learning (design §10) -----------------------------------------------------------------------------------

export const FEEDBACK_TTL_MS = 30 * DAY;
export const LEARN_WINDOW_MS = 8 * 7 * DAY;
export const LEARN_PRIOR = 10;
export const WEIGHT_MIN = 0.6;
export const WEIGHT_MAX = 1.4;

// ---- retention (design §14) ---------------------------------------------------------------------------------------------------

export const ITEMS_KEPT_MS = 30 * DAY;
export const EMBEDDINGS_KEPT_MS = 14 * DAY;
export const VOTED_EMBEDDINGS_KEPT_MS = 90 * DAY;
export const CLUSTERS_KEPT_MS = 14 * DAY;
export const ISSUES_KEPT_MS = 2 * 365 * DAY;
export const LEDGER_KEPT_MS = 400 * DAY;
export const REQUEST_ID_TTL_MS = DAY;
export const ERRORS_KEPT = 8;
/** Rows a prune deletes per table per alarm at most. */
export const PRUNE_BATCH = 500;

// ---- the owner API ----------------------------------------------------------------------------------------------------------

export const MAX_BODY_BYTES = 4 * 1024;
export const ISSUES_PAGE = 30;
export const ISSUES_PAGE_MAX = 60;
export const ITEMS_PAGE = 20;
export const SOURCES_PAGE = 100;
