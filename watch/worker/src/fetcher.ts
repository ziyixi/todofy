/**
 * Fetch tiers 1 and 2 (../../docs/design.md §4): one plain HTTP GET of a page, conditional when the last answer gave
 * validators, with every rule of the etiquette that applies to a single request:
 *
 * - redirects are followed by hand (`redirect: 'manual'`), at most MAX_REDIRECTS, and every hop's Location is checked
 *   like a saved URI (url-policy.ts), so a page can never lead the Worker to an IP literal, an own-zone host or `http:`
 *   (unless the watch allows it);
 * - every request, the first and each redirect hop, passes the caller's HopGate first (obtain.ts: that host's
 *   robots.txt, its backoff and spacing, one request at a time per host) and reports its answer to it afterwards;
 * - each request has a timer of `timeoutMs` that covers it and its body, and is always cleared;
 * - the body is read as a stream and abandoned beyond `maxBytes` (TOO_LARGE), after a Content-Length check; with
 *   `truncate` the first `maxBytes` are kept instead (robots.txt, RFC 9309 §2.5);
 * - the request names this agent (USER_AGENT), what the source can read (Accept) and the watch's Accept-Language.
 *
 * It never decides what the answer means beyond the transport: health.ts does. Nothing here logs.
 */
import { FETCH_MAX_BYTES, FETCH_TIMEOUT_MS, MAX_REDIRECTS, USER_AGENT } from './limits.ts';
import { checkRedirect } from './url-policy.ts';

/** How the Worker makes one request (globalThis.fetch, or the dev rewrite to a local fake site). */
export type FetchFn = (request: Request) => Promise<Response>;

/** A transport failure: no usable answer. */
export type TransportFailure = 'TIMEOUT' | 'NETWORK_ERROR' | 'TOO_LARGE' | 'REDIRECT_REFUSED';

/**
 * Why a gate stopped a request before it was sent: the host's robots.txt disallows the URL; the host is backing off or
 * within its spacing until `until`; or the check has no requests left for another robots.txt.
 */
export type HopRefusal =
  | { readonly kind: 'robots' }
  | { readonly kind: 'host'; readonly until: number; readonly backoff: boolean }
  | { readonly kind: 'budget' };

/** What every request of a fetch passes (obtain.ts makes one per check or preview). */
export interface HopGate {
  /**
   * Before the request to `url` (`hop` 0 is the first; `previous` the URL of the request before it): null to send it,
   * or why not. A gate that answers null holds the host until `leave`.
   */
  enter(url: URL, hop: number, previous: URL | null): Promise<HopRefusal | null>;
  /** After that request: its status (0: no answer) and headers. Always called once per `enter` that answered null. */
  leave(url: URL, status: number, headers: Headers | null): void;
}

export interface PageRequest {
  readonly url: string;
  readonly accept: string;
  readonly locale: string;
  readonly allowHttp: boolean;
  /** The last answer's validators, when the settings did not change since. */
  readonly conditional: { readonly etag: string | null; readonly lastModified: string | null } | null;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Keep the first `maxBytes` of a larger body instead of failing TOO_LARGE. */
  readonly truncate?: boolean;
  /** The most requests this fetch may make (a redirect is one more). */
  readonly maxRequests?: number;
  readonly gate?: HopGate;
}

export type PageAnswer =
  | {
      readonly kind: 'answer';
      /** The final answer's status (2xx, 304, or an error status). */
      readonly status: number;
      readonly finalUrl: string;
      readonly redirects: number;
      readonly headers: Headers;
      /** The body (empty for 304 and HEAD-like answers). */
      readonly body: Uint8Array;
      readonly requests: number;
    }
  | { readonly kind: 'failed'; readonly failure: TransportFailure; readonly status: number; readonly finalUrl: string; readonly redirects: number; readonly requests: number }
  | { readonly kind: 'refused'; readonly refusal: HopRefusal; readonly status: number; readonly finalUrl: string; readonly redirects: number; readonly requests: number };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The body of `response` up to `maxBytes`, or null when it is larger (with `truncate`: its first `maxBytes`). */
export async function readCapped(response: Response, maxBytes: number, truncate = false): Promise<Uint8Array | null> {
  const length = Number(response.headers.get('content-length') ?? '');
  if (!truncate && Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      if (!truncate) return null;
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The request headers of a fetch. */
export function requestHeaders(request: Pick<PageRequest, 'accept' | 'locale' | 'conditional'>): Headers {
  const headers = new Headers({ 'user-agent': USER_AGENT, accept: request.accept, 'accept-language': request.locale });
  if (request.conditional?.etag) headers.set('if-none-match', request.conditional.etag);
  if (request.conditional?.lastModified) headers.set('if-modified-since', request.conditional.lastModified);
  return headers;
}

/** One request of a fetch (a hop), with its own timer; never throws. */
async function oneRequest(
  fetchFn: FetchFn,
  url: URL,
  headers: Headers,
  timeoutMs: number,
  read: (response: Response) => Promise<Uint8Array | null>,
): Promise<{ readonly response: Response; readonly body: Uint8Array | null; readonly redirect: boolean } | { readonly failure: 'TIMEOUT' | 'NETWORK_ERROR' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchFn(new Request(url.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal }));
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel();
      return { response, body: null, redirect: true };
    }
    const body = response.status === 304 ? new Uint8Array(0) : await read(response);
    return { response, body, redirect: false };
  } catch {
    return { failure: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

/** One page fetch with its redirects. Never throws for a site's behaviour (a gate's storage error propagates). */
export async function fetchPage(fetchFn: FetchFn, page: PageRequest): Promise<PageAnswer> {
  const timeoutMs = page.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = page.maxBytes ?? FETCH_MAX_BYTES;
  const maxRequests = page.maxRequests ?? MAX_REDIRECTS + 1;
  let url = new URL(page.url);
  let previous: URL | null = null;
  let redirects = 0;
  let requests = 0;
  let status = 0;
  const failed = (failure: TransportFailure): PageAnswer => ({ kind: 'failed', failure, status, finalUrl: url.href, redirects, requests });
  for (;;) {
    if (requests >= maxRequests) return failed('REDIRECT_REFUSED');
    const refusal = page.gate === undefined ? null : await page.gate.enter(url, redirects, previous);
    if (refusal !== null) return { kind: 'refused', refusal, status, finalUrl: url.href, redirects, requests };
    requests += 1;
    // Validators only on the first request: a redirect's target is another resource.
    const headers = requestHeaders({ ...page, conditional: redirects === 0 ? page.conditional : null });
    const result = await oneRequest(fetchFn, url, headers, timeoutMs, (response) => readCapped(response, maxBytes, page.truncate === true));
    page.gate?.leave(url, 'failure' in result ? 0 : result.response.status, 'failure' in result ? null : result.response.headers);
    if ('failure' in result) return failed(result.failure);
    status = result.response.status;
    if (result.redirect) {
      const location = result.response.headers.get('location');
      const next = location === null ? null : checkRedirect(location, url, { allowHttp: page.allowHttp });
      if (next === null || redirects >= MAX_REDIRECTS) return failed('REDIRECT_REFUSED');
      redirects += 1;
      previous = url;
      url = next;
      continue;
    }
    if (result.body === null) return failed('TOO_LARGE');
    return { kind: 'answer', status, finalUrl: url.href, redirects, headers: result.response.headers, body: result.body, requests };
  }
}
