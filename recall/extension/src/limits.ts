/**
 * Every bound of the extension in one place (../../docs/design.md §3). The upload's bounds are the Worker's
 * (recall/worker/src/limits.ts): 50 items, 1 MiB of JSON and 1 MiB on the wire.
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MIB = 1024 * 1024;

// ---- focus (focus.ts) ------------------------------------------------------------------------------------------------

/** No input for this long is idle (chrome.idle), and going idle backdates the focus's end by it. */
export const IDLE_SECONDS = 180;
/** The alarm `tick`: every minute it records that the extension is alive, maintains the visits and flushes. */
export const TICK_MINUTES = 1;
/** A longer silence (Chrome closed, the Mac asleep, the worker killed) closes an open span at the last beat. */
export const GAP_MS = 2 * MINUTE;

// ---- visits (visits.ts) ----------------------------------------------------------------------------------------------

/** A visit ends after this long without focus; the next focus starts a new one. */
export const VISIT_UNFOCUSED_MS = 30 * MINUTE;
/** A visit ends this long after its first focus (the Worker refuses a longer one). */
export const VISIT_MAX_MS = 6 * HOUR;
/** A visit that lasts is queued again this often when it changed. */
export const VISIT_REQUEUE_MS = 30 * MINUTE;
/** A visit with less focus is never uploaded. */
export const VISIT_MIN_FOCUS_MS = SECOND;
/** A visit that would need more spans ends. */
export const SPANS_MAX = 200;

// ---- captures (capture.ts) -------------------------------------------------------------------------------------------

/** A page is captured once its visit had this much focus. */
export const CAPTURE_FOCUS_MS = 10 * SECOND;
/** Past this much of the extension's storage, texts are no longer captured (visits continue). */
export const CAPTURE_STORAGE_MAX_BYTES = 200 * 1000 * 1000;
/** The `<day>:<page id>` keys of today's captures are kept this many UTC days (today and yesterday). */
export const CAPTURE_KEY_DAYS = 2;

// ---- uploads (upload.ts) ---------------------------------------------------------------------------------------------

/** The outbox is flushed when its oldest upload is this old, or when it holds FLUSH_ITEMS items. */
export const FLUSH_INTERVAL_MS = 5 * MINUTE;
export const FLUSH_ITEMS = 25;
/** A batch: at most this many items, this much JSON, and this much gzip on the wire. */
export const BATCH_MAX_ITEMS = 50;
export const BATCH_MAX_JSON_BYTES = MIB;
export const BATCH_MAX_WIRE_BYTES = MIB;
/** An upload that takes longer is abandoned (a response slower than 30 s would get the worker killed). */
export const UPLOAD_TIMEOUT_MS = 25 * SECOND;
/** Failed uploads back off from a minute, doubling to an hour. */
export const BACKOFF_MIN_MS = MINUTE;
export const BACKOFF_MAX_MS = HOUR;
/** A Retry-After longer than this is read as this (recall's longest is to the next UTC midnight). */
export const RETRY_AFTER_MAX_MS = 25 * HOUR;
/** The badge shows `!` after this long of failing uploads. */
export const FAILING_BADGE_MS = HOUR;
/** When nothing was uploaded for this long, `tick` sends an empty batch: the heartbeat. */
export const HEARTBEAT_MS = 30 * MINUTE;
/** The device reports its last error code for this long. */
export const ERROR_REPORTED_MS = DAY;
/** An item recall could not read yet (`unsupported_item`: recall is older than this build) is sent again after this. */
export const UNSUPPORTED_HOLD_MS = 6 * HOUR;

// ---- settings (settings.ts) ------------------------------------------------------------------------------------------

/** The device label: 1 to 64 characters (recall.ingest.v1 DeviceReport.label). */
export const LABEL_MAX_CHARS = 64;
/** The label until the owner sets one. */
export const DEFAULT_LABEL = 'Chrome';
