/**
 * Stage 0 of the noise pipeline (../../docs/design.md §4, §5): getting an answer for a watch's settings, with the
 * etiquette that needs state (WatchState's tables), for a scheduled check and for PreviewWatch alike. Every request
 * of a page fetch, the first and each redirect hop, passes one gate (`pageGate`), so a redirect's target gets exactly
 * the etiquette of the watched host:
 *
 * - robots.txt of the request's host, unless the watch ignores it: one cached verdict per host for ROBOTS_TTL_MS. A
 *   5xx, no answer or a redirect our policy refuses reads as "disallow everything" (cached ROBOTS_ERROR_TTL_MS); a 4xx
 *   as "no robots.txt"; a file over ROBOTS_MAX_BYTES is read up to that size (RFC 9309 §2.5). robots.txt may be read
 *   over `http:` behind a redirect (it is public and nothing private is sent). It is fetched right before the first
 *   request to a host it is missing for, as crawlers do: the 30 s spacing is between page requests. The robots.txt
 *   requests of one check share a budget of ROBOTS_REQUESTS_PER_CHECK;
 * - the host: no request while it backs off (a 429 or 503: its Retry-After, capped, or an exponential default) or
 *   before HOST_SPACING_MS after the previous request to it started (a hop to the same host as the request before it
 *   follows at once). A request is reserved before it is sent (the host's next_at written synchronously) and runs under
 *   the host's lock (host-locks.ts): one request at a time per host. A busy host refuses the hop: the check is
 *   deferred, never failed;
 * - the page itself, by the watch's fetcher: a plain GET (fetcher.ts) or a browser render (browser.ts, its ledger);
 * - every external request counts against the caller's budget (an alarm's ALARM_FETCH_BUDGET) and the day's ledger,
 *   and the watched URL's fetch time is kept (`url_fetches`): the same URL is never fetched again within
 *   URL_MIN_SPACING_MS, by a check or a preview.
 *
 * Whether a check may start now (the host's spacing and backoff, the page's own 15 minutes) is asked first by the
 * caller (etiquette.ts earliestFetch); the gate asks again for every hop, because time passes and lanes run side by
 * side.
 */
import { browserAllowed, type BrowserRenderer } from './browser.ts';
import { acceptFor, type WatchConfig } from './config.ts';
import { backoffMs, hostNextAt, nextUtcMidnight, retryAfterMs, utcDay } from './etiquette.ts';
import { fetchPage, type FetchFn, type HopGate, type HopRefusal } from './fetcher.ts';
import { isChallenge, statusFailure, type FailureCode } from './health.ts';
import type { HostLocks } from './host-locks.ts';
import { BROWSER_SPACING_MS, FETCH_MAX_BYTES, MAX_REDIRECTS, ROBOTS_ERROR_TTL_MS, ROBOTS_MAX_BYTES, ROBOTS_TTL_MS } from './limits.ts';
import { robotsAllows, robotsFromAnswer, type RobotsVerdict } from './robots.ts';
import type { HostRow, Store } from './store.ts';
import { checkUri } from './url-policy.ts';

/** The robots.txt requests one check may make, over every host its redirects reach (each with its own redirects). */
export const ROBOTS_REQUESTS_PER_CHECK = MAX_REDIRECTS + 1;
/** The most requests one check can make: the page with its redirects, and the robots.txt files of their hosts. */
export const REQUESTS_PER_CHECK = MAX_REDIRECTS + 1 + ROBOTS_REQUESTS_PER_CHECK;

export interface ObtainDeps {
  readonly store: Store;
  readonly fetch: FetchFn;
  /** The browser renderer, or null when the deployment has none. */
  readonly browser: BrowserRenderer | null;
  readonly timeoutMs: number;
  /** The time now (epoch milliseconds): every request is stamped when it starts, minutes into an alarm too. */
  readonly now: () => number;
  /** One request at a time per host, shared by the alarm and the owner API. */
  readonly hosts: HostLocks;
}

/** External requests left to the caller (an alarm's budget); obtain subtracts what it uses. */
export interface Budget {
  requests: number;
  /** Requests made, for the day's ledger (written once by the caller). */
  used: number;
  /** Body bytes read (pages and renders; robots.txt is small). */
  bytes: number;
}

export interface AnswerMeta {
  readonly status: number;
  readonly finalUrl: string;
  readonly redirects: number;
  readonly robotsAllowed: boolean;
  /** At least one request was sent to the watched URL (its last fetch time moves). */
  readonly fetched: boolean;
  /** When the request to the watched URL started (null: none was sent). */
  readonly fetchedAt: number | null;
}

export type Obtained =
  | (AnswerMeta & { readonly kind: 'answer'; readonly contentType: string | null; readonly etag: string | null; readonly lastModified: string | null; readonly body: Uint8Array })
  | (AnswerMeta & { readonly kind: 'not_modified' })
  | (AnswerMeta & { readonly kind: 'failed'; readonly failure: FailureCode; readonly retryAfter: number | null })
  /** A host on the way was busy (spacing) or backing off: try again at `until`. Not a failure of the page. */
  | (AnswerMeta & { readonly kind: 'deferred'; readonly until: number });

/** Whether `host`'s row lets a request start at `now`: null, or the refusal (backoff first). */
export function hostRefusal(row: HostRow | undefined, now: number): HopRefusal | null {
  if (row?.backoff_until != null && row.backoff_until > now) return { kind: 'host', until: row.backoff_until, backoff: true };
  if (row !== undefined && row.next_at > now) return { kind: 'host', until: row.next_at, backoff: false };
  return null;
}

/** Reserves a request to `host` starting at `now`: the next one no sooner than HOST_SPACING_MS later. */
function reserveHost(store: Store, host: string, now: number): void {
  const row = store.host(host);
  store.putHost({ host, next_at: Math.max(row?.next_at ?? 0, hostNextAt(now)), backoff_until: row?.backoff_until ?? null, backoff_level: row?.backoff_level ?? 0 });
}

/** Records the answer of a request to `host` that started at `start`: a 429 or 503 backs it off, another answer resets that. */
function recordAnswer(store: Store, host: string, start: number, status: number, retryAfter: number | null): void {
  if (status === 0) return;
  const row = store.host(host);
  const next_at = Math.max(row?.next_at ?? 0, hostNextAt(start));
  if (status === 429 || status === 503) {
    const level = row?.backoff_level ?? 0;
    store.putHost({ host, next_at, backoff_until: start + (retryAfter ?? backoffMs(level)), backoff_level: level + 1 });
  } else {
    store.putHost({ host, next_at, backoff_until: null, backoff_level: 0 });
  }
}

/** The robots.txt rules a check has left to fetch (shared by its hops). */
interface RobotsAllowance {
  left: number;
}

/** The robots.txt verdict for `url`'s host, from the cache or a fetch (null: the check has no requests left for it). */
async function robotsVerdict(deps: ObtainDeps, url: URL, config: WatchConfig, budget: Budget, allowance: RobotsAllowance): Promise<RobotsVerdict | null> {
  const host = url.hostname.toLowerCase();
  const now = deps.now();
  const cached = deps.store.robots(host, now);
  if (cached !== null) return JSON.parse(cached) as RobotsVerdict;
  if (allowance.left <= 0) return null;
  let release: (() => void) | null = null;
  const gate: HopGate = {
    async enter(hopUrl) {
      release = await deps.hosts.acquire(hopUrl.hostname.toLowerCase());
      return null;
    },
    leave() {
      release?.();
      release = null;
    },
  };
  const answer = await fetchPage(deps.fetch, {
    url: `${url.protocol}//${url.host}/robots.txt`,
    accept: 'text/plain, */*;q=0.1',
    locale: config.locale,
    // robots.txt is public and the request carries nothing private: an https file that moved to http is still read.
    allowHttp: true,
    conditional: null,
    timeoutMs: deps.timeoutMs,
    maxBytes: ROBOTS_MAX_BYTES,
    truncate: true,
    maxRequests: allowance.left,
    gate,
  });
  allowance.left -= answer.requests;
  budget.requests -= answer.requests;
  budget.used += answer.requests;
  // A 4xx is "no robots.txt"; a 5xx, no answer, or a redirect our policy refuses (an IP literal, the own zone, a sixth
  // hop) is "unreachable": everything disallowed for a while (RFC 9309 §2.3.1.3-4), which the owner may override.
  const verdict = answer.kind === 'answer' ? robotsFromAnswer(answer.status, new TextDecoder().decode(answer.body)) : robotsFromAnswer(0, null);
  const failed = answer.kind !== 'answer' || answer.status >= 500;
  deps.store.putRobots(host, JSON.stringify(verdict), now + (failed && verdict.kind === 'disallow_all' ? ROBOTS_ERROR_TTL_MS : ROBOTS_TTL_MS));
  return verdict;
}

/** What one fetch's gate saw (obtain reads it after the fetch). */
interface GateState {
  robotsAllowed: boolean;
  /** When the request to the watched URL started (hop 0). */
  firstAt: number | null;
  /** The start of the request now in flight, per host. */
  readonly starts: Map<string, number>;
}

/**
 * The gate of every request of a page fetch: the host's robots.txt (unless the watch ignores it), its backoff and
 * spacing (unless it is the same host as the request before), then its lock and a reservation.
 */
function pageGate(deps: ObtainDeps, config: WatchConfig, budget: Budget, state: GateState): HopGate {
  const allowance: RobotsAllowance = { left: ROBOTS_REQUESTS_PER_CHECK };
  let release: (() => void) | null = null;
  return {
    async enter(url, hop, previous) {
      const host = url.hostname.toLowerCase();
      const follows = previous !== null && previous.hostname.toLowerCase() === host;
      if (!follows) {
        const busy = hostRefusal(deps.store.host(host), deps.now());
        if (busy !== null) return busy;
      }
      if (!config.ignoreRobots) {
        const verdict = await robotsVerdict(deps, url, config, budget, allowance);
        if (verdict === null) return { kind: 'budget' };
        if (!robotsAllows(verdict, `${url.pathname}${url.search}`)) {
          state.robotsAllowed = false;
          return { kind: 'robots' };
        }
      }
      const held = await deps.hosts.acquire(host);
      try {
        const now = deps.now();
        if (!follows) {
          // Asked again under the lock: a request that just finished reserved the host for its spacing.
          const busy = hostRefusal(deps.store.host(host), now);
          if (busy !== null) {
            held();
            return busy;
          }
        }
        reserveHost(deps.store, host, now);
        if (hop === 0) {
          state.firstAt = now;
          deps.store.putUrlFetch(config.uri, now);
        }
        state.starts.set(host, now);
      } catch (error) {
        // A storage error must not leave the host locked for the object's lifetime.
        held();
        throw error;
      }
      release = held;
      return null;
    },
    leave(url, status, headers) {
      try {
        const host = url.hostname.toLowerCase();
        const start = state.starts.get(host) ?? deps.now();
        recordAnswer(deps.store, host, start, status, retryAfterMs(headers?.get('retry-after') ?? null, start));
      } finally {
        release?.();
        release = null;
      }
    },
  };
}

/** The earliest next browser render (the spacing between quick actions), from meta. */
export function browserNextAt(store: Store): number {
  return Number(store.getMeta('browser_next_at') ?? '0');
}

/** Stage 0 for `config`. Never throws for a site's behaviour; a storage failure propagates. */
export async function obtain(
  deps: ObtainDeps,
  config: WatchConfig,
  budget: Budget,
  conditional: { etag: string | null; lastModified: string | null } | null,
  accept: string = acceptFor(config.source),
): Promise<Obtained> {
  const blank: AnswerMeta = { status: 0, finalUrl: config.uri, redirects: 0, robotsAllowed: true, fetched: false, fetchedAt: null };
  const failed = (failure: FailureCode, meta: Partial<AnswerMeta> = {}, retryAfter: number | null = null): Obtained => ({ ...blank, ...meta, kind: 'failed', failure, retryAfter });
  if (config.fetcher === 'browser') return render(deps, config, budget, failed);

  const state: GateState = { robotsAllowed: true, firstAt: null, starts: new Map() };
  const answer = await fetchPage(deps.fetch, {
    url: config.uri,
    accept,
    locale: config.locale,
    allowHttp: config.allowHttp,
    conditional,
    timeoutMs: deps.timeoutMs,
    maxBytes: FETCH_MAX_BYTES,
    gate: pageGate(deps, config, budget, state),
  });
  // Page requests (robots.txt counted its own in the gate).
  budget.requests -= answer.requests;
  budget.used += answer.requests;
  if (answer.kind === 'answer') budget.bytes += answer.body.byteLength;
  const meta: AnswerMeta = {
    status: answer.status,
    finalUrl: answer.finalUrl,
    redirects: answer.redirects,
    robotsAllowed: state.robotsAllowed,
    fetched: state.firstAt !== null,
    fetchedAt: state.firstAt,
  };
  if (answer.kind === 'refused') {
    const { refusal } = answer;
    if (refusal.kind === 'robots') return failed('ROBOTS_DISALLOWED', meta);
    if (refusal.kind === 'budget') return failed('REDIRECT_REFUSED', meta);
    return { ...meta, kind: 'deferred', until: refusal.until };
  }
  if (answer.kind === 'failed') return failed(answer.failure, meta);
  const retryAfter = retryAfterMs(answer.headers.get('retry-after'), state.firstAt ?? deps.now());
  if (isChallenge(answer.status, answer.headers, answer.body)) return failed('CHALLENGE_PAGE', meta);
  if (answer.status === 304) return { ...meta, kind: 'not_modified' };
  const failure = statusFailure(answer.status);
  if (failure !== null) return failed(failure, meta, failure === 'RATE_LIMITED' ? retryAfter : null);
  return {
    ...meta,
    kind: 'answer',
    contentType: answer.headers.get('content-type'),
    etag: answer.headers.get('etag'),
    lastModified: answer.headers.get('last-modified'),
    body: answer.body,
  };
}

/** Stage 0 by the browser: robots.txt and the host's etiquette for the watched URL, the ledger, one render. */
async function render(deps: ObtainDeps, config: WatchConfig, budget: Budget, failed: (failure: FailureCode, meta?: Partial<AnswerMeta>, retryAfter?: number | null) => Obtained): Promise<Obtained> {
  if (deps.browser === null) return failed('BROWSER_UNAVAILABLE');
  if (!browserAllowed(deps.store.ledger(utcDay(deps.now())))) return failed('JS_QUOTA_EXHAUSTED');
  const url = new URL(config.uri);
  const host = url.hostname.toLowerCase();
  const busy = hostRefusal(deps.store.host(host), deps.now());
  if (busy?.kind === 'host') return { status: 0, finalUrl: config.uri, redirects: 0, robotsAllowed: true, fetched: false, fetchedAt: null, kind: 'deferred', until: busy.until };
  if (!config.ignoreRobots) {
    const verdict = await robotsVerdict(deps, url, config, budget, { left: ROBOTS_REQUESTS_PER_CHECK });
    if (verdict === null || !robotsAllows(verdict, `${url.pathname}${url.search}`)) return failed('ROBOTS_DISALLOWED', { robotsAllowed: false });
  }
  const release = await deps.hosts.acquire(host);
  try {
    const now = deps.now();
    const again = hostRefusal(deps.store.host(host), now);
    if (again?.kind === 'host') return { status: 0, finalUrl: config.uri, redirects: 0, robotsAllowed: true, fetched: false, fetchedAt: null, kind: 'deferred', until: again.until };
    reserveHost(deps.store, host, now);
    deps.store.putUrlFetch(config.uri, now);
    deps.store.setMeta('browser_next_at', String(now + BROWSER_SPACING_MS));
    // A render is a subrequest of the invocation like any fetch.
    budget.requests -= 1;
    budget.used += 1;
    const rendered = await deps.browser.render({ url: config.uri, locale: config.locale, timeoutMs: deps.timeoutMs });
    const day = utcDay(now);
    const sent = { robotsAllowed: true, fetched: true, fetchedAt: now };
    if (rendered.kind === 'quota') {
      deps.store.addLedger(day, 0, 0, true);
      return failed('JS_QUOTA_EXHAUSTED', sent, nextUtcMidnight(now) - now);
    }
    // Every render that reached the binding is charged, a failed one too.
    deps.store.addLedger(day, 0, rendered.browserMs);
    if (rendered.kind === 'failed') return failed(rendered.failure, sent);
    budget.bytes += rendered.html.byteLength;
    recordAnswer(deps.store, host, now, rendered.status, null);
    const finalUrl = rendered.finalUrl ?? config.uri;
    const meta = { ...sent, status: rendered.status, finalUrl };
    // Where the browser ended up obeys the same rule as a redirect (when the renderer tells).
    if (rendered.finalUrl !== null && checkUri(rendered.finalUrl, { allowHttp: config.allowHttp }) === null) return failed('REDIRECT_REFUSED', meta);
    const failure = statusFailure(rendered.status);
    if (isChallenge(rendered.status, new Headers(), rendered.html)) return failed('CHALLENGE_PAGE', meta);
    if (failure !== null) return failed(failure, meta);
    return { ...blankAnswer(meta), kind: 'answer', contentType: 'text/html; charset=utf-8', etag: null, lastModified: null, body: rendered.html };
  } finally {
    release();
  }
}

function blankAnswer(meta: Partial<AnswerMeta>): AnswerMeta {
  return { status: 0, finalUrl: '', redirects: 0, robotsAllowed: true, fetched: false, fetchedAt: null, ...meta };
}
