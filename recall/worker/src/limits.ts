/**
 * Every bound of the Worker "recall" in one place (../../docs/design.md §4-§6). Workers Free: 10 ms of CPU per Worker
 * request and 30 s per Durable Object invocation; 100,000 Durable Object rows written and 5 million read a day, shared
 * by every app of the account (recall holds itself to DAILY_ROW_BUDGET and DAILY_READ_BUDGET of them). The value rules of recall.ui.v1 that the IDL cannot state are here too (its service
 * header names this file).
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const KIB = 1024;
export const MIB = 1024 * KIB;

// ---- the machine routes (machine.ts) ------------------------------------------------------------------------------

/** An upload on the wire (gzip): larger is 413, by Content-Length first and then while reading. */
export const BATCH_MAX_WIRE_BYTES = MIB;
/** An upload once decompressed (RecallState): larger is 413. */
export const BATCH_MAX_JSON_BYTES = 4 * MIB;
/** A bearer token longer than this is refused before it is hashed. */
export const TOKEN_MAX_CHARS = 256;
/** The change feed's page size: its default and its maximum (contracts/recall-archive-v1 §1). */
export const FEED_DEFAULT_LIMIT = 200;
export const FEED_MAX_LIMIT = 500;
/** Archive consumers recorded at most (the one unseen longest goes first). */
export const CONSUMERS_MAX = 8;

// ---- the machine tokens (tokens.ts, machine.ts) -------------------------------------------------------------------

/** A regenerated token's predecessor keeps working this long, so the extension uploads until it has the new one. */
export const TOKEN_GRACE_MS = DAY;
/**
 * The Worker keeps RecallState's token digests in memory this long: a new, revoked or deleted token holds everywhere
 * within it. A bearer the kept digests refuse asks RecallState again once they are TOKEN_RECHECK_MS old, so a new token
 * works within seconds while refused requests reach the object at most once per TOKEN_RECHECK_MS and isolate.
 */
export const TOKEN_CACHE_MS = MINUTE;
export const TOKEN_RECHECK_MS = 10 * SECOND;

// ---- the archive and its backup to Dropbox (archive.ts, backup.ts, dropbox.ts) ---------------------------------------

/** A change waits about this long for the archive: the alarm comes this soon after a change, unless it is due sooner. */
export const ARCHIVE_INTERVAL_MS = HOUR;
/** Changes of each table one pass reads (their seq and commit time only) to find the days they touched. */
export const ARCHIVE_SCAN_ROWS = 10_000;
/**
 * Subrequests one pass may make: R2 reads and Dropbox calls (Workers Free allows 50 per invocation; the purge and the
 * retention step in the same alarm take one or two each).
 */
export const ARCHIVE_SUBREQUESTS = 40;
/** A pass starts no new day after rendering this many changes (CPU), nor any call after this long (wall time). */
export const ARCHIVE_RENDER_MAX = 20_000;
export const ARCHIVE_PASS_MS = 5 * MINUTE;
/** The backoff after a failed pass: the first, doubled up to the last; Dropbox's Retry-After when it gives one. */
export const ARCHIVE_RETRY_FIRST_MS = MINUTE;
export const ARCHIVE_RETRY_MAX_MS = HOUR;
/** ops-v1's archive_behind: a change committed longer ago than this is not in Dropbox yet. */
export const ARCHIVE_BEHIND_MS = DAY;
/** A Dropbox call's timeout. */
export const DROPBOX_TIMEOUT_MS = 30 * SECOND;
/** An access token is refreshed this long before Dropbox said it expires. */
export const DROPBOX_TOKEN_MARGIN_MS = 5 * MINUTE;
/** A connection the owner started and did not finish at Dropbox expires after this. */
export const DROPBOX_CONNECT_MS = 15 * MINUTE;

// ---- ingest (ingest.ts) -------------------------------------------------------------------------------------------

/** An item's time may be at most this far after its batch's sent_time (the same clock). */
export const ITEM_CLOCK_LEEWAY_MS = MINUTE;
/** A visit lasts at most this long after its first focus; the timeline's overlap scan relies on it. */
export const VISIT_MAX_MS = 6 * HOUR;
/** A device's clock skew is recorded when it passes this. */
export const CLOCK_SKEW_RECORDED_MS = 2 * MINUTE;
/** The highest part of a Chrome extension version. */
export const VERSION_PART_MAX = 65_535;
/**
 * The daily write budget: rows the object wrote today (UTC), past which uploads are answered 429 until the next UTC
 * day (plus up to OVER_BUDGET_JITTER_MS). A fifth of the account's 100,000; the owner's own mutations still pass.
 */
export const DAILY_ROW_BUDGET = 20_000;
export const OVER_BUDGET_JITTER_MS = 10 * MINUTE;
/**
 * The daily read budget: rows the object read today (UTC), counted as it counts rows written. Past FEED_READ_LIMIT the
 * change feed answers 429 until the next UTC day (an archive catching up waits, leaving the rest to the owner's
 * searches); past DAILY_READ_BUDGET searches are SEARCH_OVER_BUDGET. Under a third of the account's 5 million.
 */
export const DAILY_READ_BUDGET = 1_500_000;
export const FEED_READ_LIMIT = 1_000_000;

// ---- storage (store.ts, the alarm) --------------------------------------------------------------------------------

/** The search index holds the first this many bytes (UTF-8) of a page's latest text. */
export const INDEXED_TEXT_MAX_BYTES = 32 * KIB;
/** The object's database budget, and the size past which the status warns and the index sheds old texts. */
export const STORAGE_BUDGET_MIB = 900;
export const STORAGE_HIGH_MIB = 850;
/** The indexed text past which the oldest pages keep only their title and URL in the index. */
export const INDEXED_TEXT_BUDGET_BYTES = 500 * MIB;
/** Pages moved out of the text index per alarm run. */
export const DEMOTE_BATCH = 2000;
/** Rows (visits and documents) of deleted pages removed per alarm run, with their R2 objects. */
export const PURGE_BATCH = 500;
/**
 * The alarm's purges, index demotions and retention steps stop for the day once today's rows written reach this (half
 * the daily write budget), so that uploads keep the other half; they go on the next day.
 */
export const MAINTENANCE_ROW_LIMIT = DAILY_ROW_BUDGET / 2;
/**
 * Settings.text_retention_days: how long a captured text stays in Cloudflare after its capture, until the owner
 * changes it, and the range they may choose (or none: every text stays). Past it the files leave R2 only
 * once the Dropbox archive confirmed holding it (retention.ts).
 */
export const TEXT_RETENTION_DEFAULT_DAYS = 7;
export const TEXT_RETENTION_MIN_DAYS = 7;
export const TEXT_RETENTION_MAX_DAYS = 3650;
/**
 * Texts past the window one alarm run moves out of Cloudflare (their R2 objects in one call, a few rows written each),
 * found among at most RETENTION_SCAN of the oldest texts still in Cloudflare (a text the archive never confirmed, a
 * lost blob, stays among them and is looked at again).
 */
export const RETENTION_BATCH = 100;
export const RETENTION_SCAN = 1000;
/** The daily alarm's hour (UTC), and how soon the alarm comes back while work is left. */
export const ALARM_HOUR_UTC = 4;
export const ALARM_BACKLOG_MS = MINUTE;
/** How soon a deletion brings the alarm forward. */
export const WAKE_MS = SECOND;
/** The answers of the owner's mutations, by request ID (AIP-155). */
export const REQUEST_ID_TTL_MS = DAY;
/** Daily usage counters are kept this many days. */
export const USAGE_KEPT_DAYS = 400;
export const ERRORS_KEPT = 8;

// ---- the owner API (api.ts, search.ts, timeline.ts) ---------------------------------------------------------------

/** A request body at most (UpdateSettings: 200 patterns of 200 characters fit). */
export const MAX_BODY_BYTES = 64 * KIB;
/** SearchPagesRequest.query: at most this many characters and terms. */
export const QUERY_MAX_CHARS = 200;
export const QUERY_MAX_TERMS = 10;
export const SITE_MAX_CHARS = 253;
export const MIN_FOCUS_MAX_SECONDS = 86_400;
/** Search results per page (each snippet reads its text from R2), and the most a search reaches. */
export const SEARCH_PAGE_SIZE = 10;
export const SEARCH_MAX_RESULTS = 200;
/** A search with a time range reads at most the range's newest this many visits. */
export const SEARCH_MAX_VISITS = 20_000;
/** A search with words reads at most this many of the index's matches (the best for 相关, any for 最新). */
export const SEARCH_MAX_MATCHES = 2000;
/** A search by a site reads the site's pages when it has at most this many. */
export const SITE_MAX_PAGES = 5000;
/** Otherwise a search scans the pages by their latest visit, this many a statement, at most SEARCH_SCAN_PAGES. */
export const SCAN_CHUNK = 500;
export const SEARCH_SCAN_PAGES = 5000;
/** Answered searches kept in memory for their next pages (加载更多), and how long. */
export const SEARCH_CACHE_ENTRIES = 16;
export const SEARCH_CACHE_MS = 10 * MINUTE;
/** A snippet's length around the first match, in characters. */
export const SNIPPET_CHARS = 160;
/** ListVisits: the default and the most per page. */
export const VISIT_PAGE_DEFAULT = 200;
export const VISIT_PAGE_MAX = 500;
/** ListSites: the default and the most per page. */
export const SITE_PAGE_DEFAULT = 100;
export const SITE_PAGE_MAX = 200;
/** ServiceStatus: changes behind a consumer that pulled within STALE_MS, or behind Dropbox, are counted up to this. */
export const BEHIND_COUNT_MAX = 500;
/** A device or a consumer without news for this long is stale; one seen within ACTIVE_MS is watched by ops-v1. */
export const STALE_MS = DAY;
export const ACTIVE_MS = 30 * DAY;
/** ServiceStatus.rejected_items covers this many days. */
export const REJECTED_WINDOW_DAYS = 7;
