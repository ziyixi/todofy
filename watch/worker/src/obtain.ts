/**
 * Stage 0 of the noise pipeline (../../docs/design.md §4, §5): getting an answer for a watch's settings, with the
 * etiquette that needs state (WatchState's tables), for a scheduled check and for PreviewWatch alike:
 *
 * - robots.txt, unless the watch ignores it: one cached verdict per host for ROBOTS_TTL_MS (a 5xx or no answer reads
 *   as "disallow everything", cached ROBOTS_ERROR_TTL_MS). It is fetched right before the first page request of a host
 *   it is missing for, as crawlers do; the host's 30 s spacing is between page requests;
 * - the page itself, by the watch's fetcher: a plain GET (fetcher.ts) or a browser render (browser.ts, its ledger);
 * - the host's row: the next page request no sooner than HOST_SPACING_MS after this one started, and a 429 or 503
 *   backs the host off for its Retry-After (capped) or an exponential default;
 * - every external request counts against the caller's budget (an alarm's ALARM_FETCH_BUDGET) and the day's ledger.
 *
 * Whether a check may start now (the host's spacing and backoff, the page's own 15 minutes) is the caller's question
 * (etiquette.ts earliestFetch); this module assumes it may.
 */
import { browserAllowed, type BrowserRenderer } from './browser.ts';
import { acceptFor, type WatchConfig } from './config.ts';
import { backoffMs, hostNextAt, nextUtcMidnight, retryAfterMs, utcDay } from './etiquette.ts';
import { fetchPage, type FetchFn } from './fetcher.ts';
import { isChallenge, statusFailure, type FailureCode } from './health.ts';
import { BROWSER_SPACING_MS, FETCH_MAX_BYTES, MAX_REDIRECTS, ROBOTS_ERROR_TTL_MS, ROBOTS_MAX_BYTES, ROBOTS_TTL_MS } from './limits.ts';
import { robotsAllows, robotsFromAnswer, type RobotsVerdict } from './robots.ts';
import type { Store } from './store.ts';

/** The most requests one check can make: robots.txt and a page, each with its redirects. */
export const REQUESTS_PER_CHECK = 2 * (MAX_REDIRECTS + 1);

export interface ObtainDeps {
  readonly store: Store;
  readonly fetch: FetchFn;
  /** The browser renderer, or null when the deployment has none. */
  readonly browser: BrowserRenderer | null;
  readonly timeoutMs: number;
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
  /** At least one request was sent (the page's last_fetch_at moves). */
  readonly fetched: boolean;
}

export type Obtained =
  | (AnswerMeta & { readonly kind: 'answer'; readonly contentType: string | null; readonly etag: string | null; readonly lastModified: string | null; readonly body: Uint8Array })
  | (AnswerMeta & { readonly kind: 'not_modified' })
  | (AnswerMeta & { readonly kind: 'failed'; readonly failure: FailureCode; readonly retryAfter: number | null });

/** The robots.txt verdict for `url`'s host, from the cache or one request. */
async function robotsVerdict(deps: ObtainDeps, url: URL, config: WatchConfig, now: number, budget: Budget): Promise<{ verdict: RobotsVerdict; requests: number }> {
  const cached = deps.store.robots(url.hostname, now);
  if (cached !== null) return { verdict: JSON.parse(cached) as RobotsVerdict, requests: 0 };
  const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
  const answer = await fetchPage(deps.fetch, {
    url: robotsUrl,
    accept: 'text/plain, */*;q=0.1',
    locale: config.locale,
    allowHttp: config.allowHttp,
    conditional: null,
    timeoutMs: deps.timeoutMs,
    maxBytes: ROBOTS_MAX_BYTES,
  });
  budget.requests -= answer.requests;
  budget.used += answer.requests;
  // A file over the size cap is read as no file: RFC 9309 asks for at least 500 KiB, so a larger one is not a robots.txt.
  const verdict =
    answer.kind === 'answer'
      ? robotsFromAnswer(answer.status, new TextDecoder().decode(answer.body))
      : answer.failure === 'TOO_LARGE' || answer.failure === 'REDIRECT_REFUSED'
        ? robotsFromAnswer(404, null)
        : robotsFromAnswer(0, null);
  const failed = answer.kind === 'failed' || answer.status >= 500;
  deps.store.putRobots(url.hostname, JSON.stringify(verdict), now + (failed && verdict.kind === 'disallow_all' ? ROBOTS_ERROR_TTL_MS : ROBOTS_TTL_MS));
  return { verdict, requests: answer.requests };
}

/** Records a page request on its host: the spacing, and the backoff of a 429 or 503 (reset by any other answer). */
function recordHost(store: Store, host: string, start: number, status: number, retryAfter: number | null): void {
  const row = store.host(host);
  if (status === 429 || status === 503) {
    const level = row?.backoff_level ?? 0;
    store.putHost({ host, next_at: hostNextAt(start), backoff_until: start + (retryAfter ?? backoffMs(level)), backoff_level: level + 1 });
  } else {
    store.putHost({ host, next_at: hostNextAt(start), backoff_until: null, backoff_level: 0 });
  }
}

/** The earliest next browser render (the spacing between quick actions), from meta. */
export function browserNextAt(store: Store): number {
  return Number(store.getMeta('browser_next_at') ?? '0');
}

/** Stage 0 for `config` at `now`. Never throws for a site's behaviour; a storage failure propagates. */
export async function obtain(deps: ObtainDeps, config: WatchConfig, now: number, budget: Budget, conditional: { etag: string | null; lastModified: string | null } | null): Promise<Obtained> {
  const url = new URL(config.uri);
  const blank = { status: 0, finalUrl: config.uri, redirects: 0, robotsAllowed: true, fetched: false };
  const failed = (failure: FailureCode, meta: Partial<AnswerMeta> = {}, retryAfter: number | null = null): Obtained => ({ ...blank, ...meta, kind: 'failed', failure, retryAfter });

  if (config.fetcher === 'browser') {
    if (deps.browser === null) return failed('BROWSER_UNAVAILABLE');
    if (!browserAllowed(deps.store.ledger(utcDay(now)))) return failed('JS_QUOTA_EXHAUSTED');
  }
  let robotsAllowed = true;
  if (!config.ignoreRobots) {
    const { verdict, requests } = await robotsVerdict(deps, url, config, now, budget);
    robotsAllowed = robotsAllows(verdict, `${url.pathname}${url.search}`);
    if (!robotsAllowed) return failed('ROBOTS_DISALLOWED', { robotsAllowed, fetched: requests > 0 });
  }

  if (config.fetcher === 'browser' && deps.browser !== null) {
    const rendered = await deps.browser.render({ url: config.uri, locale: config.locale, timeoutMs: deps.timeoutMs });
    deps.store.setMeta('browser_next_at', String(now + BROWSER_SPACING_MS));
    const day = utcDay(now);
    if (rendered.kind === 'quota') {
      deps.store.addLedger(day, 0, 0, true);
      return failed('JS_QUOTA_EXHAUSTED', { robotsAllowed, fetched: true }, nextUtcMidnight(now) - now);
    }
    if (rendered.kind === 'failed') return failed(rendered.failure, { robotsAllowed, fetched: true });
    deps.store.addLedger(day, 0, rendered.browserMs);
    budget.bytes += rendered.html.byteLength;
    recordHost(deps.store, url.hostname, now, rendered.status, null);
    const meta = { status: rendered.status, finalUrl: config.uri, redirects: 0, robotsAllowed, fetched: true };
    const failure = statusFailure(rendered.status);
    if (isChallenge(rendered.status, new Headers(), rendered.html)) return failed('CHALLENGE_PAGE', meta);
    if (failure !== null) return failed(failure, meta);
    return { ...meta, kind: 'answer', contentType: 'text/html; charset=utf-8', etag: null, lastModified: null, body: rendered.html };
  }

  const answer = await fetchPage(deps.fetch, {
    url: config.uri,
    accept: acceptFor(config.source),
    locale: config.locale,
    allowHttp: config.allowHttp,
    conditional,
    timeoutMs: deps.timeoutMs,
    maxBytes: FETCH_MAX_BYTES,
  });
  budget.requests -= answer.requests;
  budget.used += answer.requests;
  if (answer.kind === 'answer') budget.bytes += answer.body.byteLength;
  const meta = { status: answer.status, finalUrl: answer.finalUrl, redirects: answer.redirects, robotsAllowed, fetched: answer.requests > 0 };
  if (answer.kind === 'failed') {
    recordHost(deps.store, url.hostname, now, answer.status, null);
    return failed(answer.failure, meta);
  }
  const retryAfter = retryAfterMs(answer.headers.get('retry-after'), now);
  recordHost(deps.store, url.hostname, now, answer.status, retryAfter);
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
