/**
 * The value rules and bounds of the watch app (../../docs/design.md §3, §4 and §8), in one place: the Worker and
 * WatchState enforce them, the UI (../../web) imports the ones it checks before sending, and watch.ui.v1 repeats each
 * in its field's comment (proto/watch/ui/v1).
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ---- watches -------------------------------------------------------------------------------------------------------

/** The most watches the store holds: it bounds every list, each alarm's work and the Durable Object's storage. */
export const WATCHES_MAX = 50;
/** A watch ID (AIP-122): 1-40 characters of a-z, 0-9 and `-`, starting with a letter. */
export const WATCH_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
/** A change ID: 16 characters of a-z and 0-9 (9 of time, 7 random), ordered by creation. */
export const CHANGE_ID_PATTERN = /^[a-z0-9]{16}$/;
export const DISPLAY_NAME_MAX = 80;
export const URI_MAX = 2048;
export const SELECTORS_MAX = 10;
export const SELECTOR_MAX = 200;
export const IGNORED_LINES_MAX = 100;
export const IGNORED_LINE_MAX = 300;
export const TRIGGER_TEXT_MAX = 200;
export const NUMBER_LABEL_MAX = 100;
export const LOCALE_MAX = 100;
export const AI_INTENT_MAX = 200;
export const JSON_PATH_STEPS_MAX = 16;
export const DEFAULT_LOCALE = 'zh-CN,zh;q=0.9,en;q=0.8';

/** check_interval_minutes: default and range, for HTTP and for the browser (whose daily seconds are scarce). */
export const INTERVAL = {
  http: { defaultMinutes: 360, min: 60, max: 10_080 },
  browser: { defaultMinutes: 1440, min: 360, max: 10_080 },
} as const;
/** Every scheduled check moves by up to this share of its interval, either way (deterministic per watch and slot). */
export const JITTER = 0.1;

/** AnyChangeTrigger and NewItemTrigger bounds. */
export const MIN_CHANGED_LINES_MAX = 1000;
export const MIN_NEW_ITEMS_MAX = 100;
export const CHANGE_PERCENT_MAX = 10_000;

/** Stability: the confirmation fetch of HTML sources. */
export const CONFIRM_DELAY = { defaultMinutes: 15, min: 15, max: 120 } as const;
/** A pending change seen as a third version this many times is decided against its latest version. */
export const CONFIRM_ATTEMPTS_MAX = 3;
/**
 * The confirmation window of a pending change, in confirmation delays from its detection (plus the URL's spacing):
 * within it a failed confirmation fetch is retried at the confirmation pace and A -> B -> A is a flicker; past it the
 * watch returns to its regular interval and the change is decided as it was seen.
 */
export const CONFIRM_WINDOW_DELAYS = CONFIRM_ATTEMPTS_MAX + 1;

/** Shadow mode runs this long from the write that sets it. */
export const SHADOW_PERIOD_MS = 7 * DAY;

// ---- etiquette (docs/design.md §4) ------------------------------------------------------------------------------

/** The same URL is never fetched again sooner than this (a confirmation fetch, an owner's check included). */
export const URL_MIN_SPACING_MS = 15 * MINUTE;
/** One request at a time per host, and this long between the starts of two requests to it. */
export const HOST_SPACING_MS = 30 * SECOND;
/** A 429 or 503 without a usable Retry-After backs off this long, doubling per repeat up to the cap. */
export const BACKOFF_BASE_MS = 15 * MINUTE;
export const BACKOFF_MAX_MS = DAY;
/** A Retry-After longer than this is read as this. */
export const RETRY_AFTER_MAX_MS = 7 * DAY;
/** robots.txt is cached this long; a 5xx answer (read as "disallow everything") only this long. */
export const ROBOTS_TTL_MS = DAY;
export const ROBOTS_ERROR_TTL_MS = HOUR;
export const ROBOTS_MAX_BYTES = 512 * 1024;
/** The robots.txt product token of this agent, and the User-Agent it sends (no address in it). */
export const ROBOTS_AGENT = 'ziyixi-watch';
export const USER_AGENT = 'Mozilla/5.0 (compatible; ziyixi-watch/1.0; personal page-change monitor)';

/** One response: at most this many bytes, within this many milliseconds (the timer is always cleared). */
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15 * SECOND;
export const MAX_REDIRECTS = 5;

/** Each alarm: at most this many external requests (pages, robots.txt, redirects) and this much wall time. */
export const ALARM_FETCH_BUDGET = 40;
/**
 * Each alarm reads at most this many body bytes (a check starts only with FETCH_MAX_BYTES left for each check in
 * flight): parsing is what costs CPU, about 0.35 s per 2 MiB page on the reference machine, so a pass stays at a few
 * seconds of the 30 s a Durable Object invocation may use (test/runtime/cpu.test.ts).
 */
export const ALARM_BYTES_BUDGET = 24 * 1024 * 1024;
export const ALARM_WALL_BUDGET_MS = 8 * MINUTE;
/** A check that might still need FETCH_TIMEOUT_MS is not started this close to the wall budget. */
export const ALARM_START_MARGIN_MS = 2 * FETCH_TIMEOUT_MS;
/** Watches checked at the same time in one alarm (each on another host): each holds REQUESTS_PER_CHECK (obtain.ts). */
export const ALARM_CONCURRENCY = 3;
/** The most due watches one alarm looks at. */
export const ALARM_DUE_MAX = 60;
/** The next alarm after one that failed unexpectedly, and the longest sleep while nothing is due. */
export const ALARM_ERROR_RETRY_MS = 5 * MINUTE;
export const ALARM_IDLE_MS = 6 * HOUR;
/** A woken alarm (an owner's write, a check request) runs this soon. */
export const WAKE_MS = SECOND;

// ---- the health gate and the pipeline (docs/design.md §5) ------------------------------------------------------

/** The extracted text of an HTML page must hold at least this many characters. */
export const MIN_TEXT_CHARS = 20;
/** Mojibake: at least this many U+FFFD characters and more than this share of the text. */
export const MOJIBAKE_MIN_COUNT = 3;
export const MOJIBAKE_RATIO = 0.01;
/** Failed checks in a row that make a watch BROKEN (and enqueue its digest line). */
export const BROKEN_AFTER_FAILURES = 3;
/** A watch broken this long is paused by the Worker. */
export const AUTO_PAUSE_AFTER_MS = 14 * DAY;
/** The lines one snapshot keeps, each at most LINE_MAX characters; a snapshot is at most SNAPSHOT_MAX_GZIP bytes. */
export const LINES_MAX = 5000;
export const LINE_MAX = 2000;
export const SNAPSHOT_MAX_GZIP = 64 * 1024;
/** Snapshots kept per watch (the notified state and a pending candidate are always kept besides). */
export const SNAPSHOTS_KEPT = 20;
/** Feed and JSON items kept per snapshot. */
export const ITEMS_MAX = 500;
/** The diff: its edit search stops beyond this many edits (the result is then a plain set difference). */
export const DIFF_MAX_EDITS = 1000;
/**
 * A change keeps at most this many diff lines of at most this many characters, and at most DIFF_JSON_MAX bytes of them
 * as stored (UTF-8 JSON): 200 lines of 500 CJK characters would be ~300 KB a row.
 */
export const DIFF_LINES_KEPT = 200;
export const DIFF_LINE_MAX = 500;
export const DIFF_JSON_MAX = 32 * 1024;
/**
 * Changes kept per watch: suppressed ones, and all of them. Over CHANGES_KEPT the oldest acknowledged ones go first,
 * then suppressed ones, then confirmed ones beyond the CONFIRMED_KEPT newest (never a pending one).
 */
export const SUPPRESSED_KEPT = 50;
export const CHANGES_KEPT = 200;
export const CONFIRMED_KEPT = 50;

// ---- the browser (Browser Run, docs/design.md §4) -----------------------------------------------------------------

/** The app's own daily ledger of browser time, under Browser Run's 10 minutes a day for the whole account. */
export const BROWSER_DAILY_MS = 480 * SECOND;
/** What one render is assumed to cost before it reports its time (a render is not started without it left). */
export const BROWSER_RESERVE_MS = 15 * SECOND;
/** Browser Run allows one quick action per 10 seconds. */
export const BROWSER_SPACING_MS = 10 * SECOND;

// ---- the owner API -----------------------------------------------------------------------------------------------

/** The largest request body the owner API reads. */
export const MAX_BODY_BYTES = 64 * 1024;
/** ListWatches and ListChanges: the default and largest page. */
export const WATCH_PAGE = 50;
export const CHANGE_PAGE = 50;
/** ListWatches filter: at most this many characters and literals. */
export const FILTER_MAX = 200;
export const FILTER_LITERALS_MAX = 8;
/** A request_id is answered with its first response for this long (AIP-155). */
export const REQUEST_ID_TTL_MS = DAY;
/** PreviewWatch: a page fetched this recently is previewed again from its stored fetch (no new request). */
export const PREVIEW_CACHE_MS = URL_MIN_SPACING_MS;
export const PREVIEW_CACHE_ENTRIES = 4;
/** PreviewWatch answers at most this many blocks, lines and items. */
export const PREVIEW_BLOCKS_MAX = 200;
export const PREVIEW_LINES_MAX = 300;
export const PREVIEW_ITEMS_MAX = 100;
export const PREVIEW_TEXT_MAX = 300;

// ---- notifications (the interface step W3 plugs into) ---------------------------------------------------------------

/** Notification outbox rows are kept this long (delivered or not) and at most this many. */
export const NOTIFICATIONS_KEPT_MS = 30 * DAY;
export const NOTIFICATIONS_MAX = 500;
