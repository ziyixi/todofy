/**
 * The value rules and bounds of the links app (../../docs/design.md §3 and §8), in one place: the Worker enforces
 * them and the UI (../../web) imports the ones it checks before sending. links.ui.v1 repeats each in its field's
 * comment (proto/links/ui/v1).
 */

/** A key: 1-63 characters of a-z, 0-9 and `-`, starting with a letter or digit (stored and answered in lower case). */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Keys the service keeps for itself: `_` (the owner's UI and API), the words a later version may route (`s`, `api`,
 * `v1`, `search`) and the paths a browser, crawler or Cloudflare itself asks for. Most of them fail KEY_PATTERN
 * already; listing them makes the refusal say "reserved" instead of "invalid".
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['_', 's', 'api', 'v1', 'search', 'cdn-cgi', 'favicon.ico', 'robots.txt', '.well-known']);

/** The longest target (characters), as stored. */
export const TARGET_MAX = 2048;
/** The placeholder a TEMPLATE target holds exactly once. */
export const PATH_PLACEHOLDER = '{path}';
/** The longest description (characters). */
export const DESCRIPTION_MAX = 500;
/** At most this many tags per link, each matching TAG_PATTERN. */
export const TAGS_MAX = 8;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The most links the store holds, deleted ones included until they are purged: it bounds every list, the export
 * and the import, so each request stays far below Workers Free's 10 ms of CPU and D1's per-request limits.
 */
export const LINKS_MAX = 1000;
/** ListLinks: the default and largest page. */
export const LIST_PAGE = 100;
/** ExportLinks: the default and largest page (a page of LINKS_MAX would cost about 5 ms of CPU). */
export const EXPORT_PAGE = 250;
/** ListLinks filter: at most this many characters and literals. */
export const FILTER_MAX = 200;
export const FILTER_LITERALS_MAX = 8;
/** ListLinkRevisions: the revisions kept per link (older ones are dropped as new ones are made), one page. */
export const REVISIONS_KEPT = 20;
/** ImportLinks: at most this many links and characters per request (the UI sends a larger file in parts). */
export const IMPORT_LINES_MAX = 100;
export const IMPORT_CHARS_MAX = 65_536;
/** The largest request body the owner API reads (an import with its JSON escaping). */
export const MAX_BODY_BYTES = 128 * 1024;

/** A deleted link is purged this long after its deletion (AIP-164), lazily by the next list or write. */
export const PURGE_AFTER_MS = 30 * 86_400_000;
/** A request_id is answered with its first response for this long (AIP-155). */
export const REQUEST_ID_TTL_MS = 86_400_000;

/** The longest path after the key that a redirect passes through (characters, as received). */
export const REST_MAX = 1024;
/** The longest URL a redirect sends. */
export const LOCATION_MAX = 4096;
