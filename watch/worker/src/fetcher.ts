/**
 * Fetch tiers 1 and 2 (../../docs/design.md §4): one plain HTTP GET of a page, conditional when the last answer gave
 * validators, with every rule of the etiquette that applies to a single request:
 *
 * - redirects are followed by hand (`redirect: 'manual'`), at most MAX_REDIRECTS, and every hop's Location is checked
 *   like a saved URI (url-policy.ts), so a page can never lead the Worker to an IP literal, an own-zone host or `http:`
 *   (unless the watch allows it);
 * - one timer of `timeoutMs` covers the whole chain and the body, and is always cleared;
 * - the body is read as a stream and abandoned beyond `maxBytes` (TOO_LARGE), after a Content-Length check;
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

export interface PageRequest {
  readonly url: string;
  readonly accept: string;
  readonly locale: string;
  readonly allowHttp: boolean;
  /** The last answer's validators, when the settings did not change since. */
  readonly conditional: { readonly etag: string | null; readonly lastModified: string | null } | null;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** The most requests this fetch may make (a redirect is one more). */
  readonly maxRequests?: number;
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
  | { readonly kind: 'failed'; readonly failure: TransportFailure; readonly status: number; readonly finalUrl: string; readonly redirects: number; readonly requests: number };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The body of `response` up to `maxBytes`, or null when it is larger. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const length = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > maxBytes) {
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
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
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

/** One page fetch with its redirects. Never throws. */
export async function fetchPage(fetchFn: FetchFn, page: PageRequest): Promise<PageAnswer> {
  const timeoutMs = page.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = page.maxBytes ?? FETCH_MAX_BYTES;
  const maxRequests = page.maxRequests ?? MAX_REDIRECTS + 1;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let url = new URL(page.url);
  let redirects = 0;
  let requests = 0;
  let status = 0;
  const failed = (failure: TransportFailure): PageAnswer => ({ kind: 'failed', failure, status, finalUrl: url.href, redirects, requests });
  try {
    for (;;) {
      if (requests >= maxRequests) return failed('REDIRECT_REFUSED');
      requests += 1;
      // Validators only on the first request: a redirect's target is another resource.
      const headers = requestHeaders({ ...page, conditional: redirects === 0 ? page.conditional : null });
      const response = await fetchFn(new Request(url.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal }));
      status = response.status;
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        const next = location === null ? null : checkRedirect(location, url, { allowHttp: page.allowHttp });
        if (next === null || redirects >= MAX_REDIRECTS) return failed('REDIRECT_REFUSED');
        redirects += 1;
        url = next;
        continue;
      }
      const body = response.status === 304 ? new Uint8Array(0) : await readCapped(response, maxBytes);
      if (body === null) return failed('TOO_LARGE');
      return { kind: 'answer', status: response.status, finalUrl: url.href, redirects, headers: response.headers, body, requests };
    }
  } catch {
    return failed(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}
