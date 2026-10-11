/**
 * One HTTP GET of a feed, an API page, a robots.txt or an article page (../../../docs/design.md §3.2), with every rule
 * that applies to a single request:
 *
 * - redirects are followed by hand (`redirect: 'manual'`), at most MAX_REDIRECTS, and every hop's Location is checked
 *   by the URL policy (policy.ts);
 * - every request, the first and each redirect hop, passes the caller's gate first (hosts.ts: the host's spacing and
 *   backoff, the step's subrequests) and reports its answer to it afterwards;
 * - each request has a timer of `timeoutMs` that covers it and its body, always cleared, and the step's own signal;
 * - the body is read as a stream up to `maxBytes`: a feed keeps what it got (parsed as far as it got, `truncate`), a
 *   page or an API answer beyond it is TOO_LARGE;
 * - the request names the brief honestly (USER_AGENT), asks for what it can read, sends no cookie, and on the first
 *   request the source's validators (a conditional GET).
 *
 * It never decides what the answer means; nothing here logs.
 */
import { FETCH_TIMEOUT_MS, MAX_REDIRECTS, USER_AGENT } from '../limits.ts';
import { checkRedirect } from './policy.ts';

export type FetchFn = (request: Request) => Promise<Response>;

export type TransportFailure = 'timeout' | 'network_error' | 'too_large' | 'redirect_refused' | 'aborted';

/** Why a gate stopped a request before it was sent. */
export type GateRefusal = { readonly kind: 'host'; readonly until: number } | { readonly kind: 'budget' } | { readonly kind: 'robots' };

export interface Gate {
  enter(url: URL, hop: number): Promise<GateRefusal | null>;
  leave(url: URL, status: number, headers: Headers | null): void;
}

export interface GetRequest {
  readonly url: URL;
  readonly accept: string;
  readonly own: readonly string[];
  readonly gate: Gate;
  readonly signal: AbortSignal;
  readonly conditional?: { readonly etag: string | null; readonly lastModified: string | null } | null;
  readonly timeoutMs?: number;
  readonly maxBytes: number;
  readonly truncate?: boolean;
}

export type GetAnswer =
  | { readonly kind: 'answer'; readonly status: number; readonly finalUrl: string; readonly headers: Headers; readonly body: Uint8Array; readonly truncated: boolean }
  | { readonly kind: 'failed'; readonly failure: TransportFailure; readonly status: number; readonly finalUrl: string }
  | { readonly kind: 'refused'; readonly refusal: GateRefusal; readonly finalUrl: string };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Read through a call, so a check earlier in the function does not narrow it (a signal aborts at any time). */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** The body up to `maxBytes`; beyond it null, or with `truncate` its first `maxBytes` (and `truncated`). */
export async function readCapped(response: Response, maxBytes: number, truncate: boolean): Promise<{ body: Uint8Array; truncated: boolean } | null> {
  const length = Number(response.headers.get('content-length') ?? '');
  if (!truncate && Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return { body: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      if (!truncate) return null;
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
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
  return { body: out, truncated };
}

function headersFor(request: GetRequest, first: boolean): Headers {
  const headers = new Headers({ 'user-agent': USER_AGENT, accept: request.accept, 'accept-language': 'en, zh-CN;q=0.8, *;q=0.5' });
  if (first && request.conditional?.etag) headers.set('if-none-match', request.conditional.etag);
  if (first && request.conditional?.lastModified) headers.set('if-modified-since', request.conditional.lastModified);
  return headers;
}

/** One GET with its redirects. Never throws for a site's behaviour (a gate's storage error propagates). */
export async function httpGet(fetchFn: FetchFn, request: GetRequest): Promise<GetAnswer> {
  const timeoutMs = request.timeoutMs ?? FETCH_TIMEOUT_MS;
  let url = request.url;
  let status = 0;
  for (let hop = 0; ; hop++) {
    if (request.signal.aborted) return { kind: 'failed', failure: 'aborted', status, finalUrl: url.href };
    const refusal = await request.gate.enter(url, hop);
    if (refusal !== null) return { kind: 'refused', refusal, finalUrl: url.href };
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(new Request(url.href, { method: 'GET', headers: headersFor(request, hop === 0), redirect: 'manual', signal: controller.signal }));
    } catch {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      request.gate.leave(url, 0, null);
      return { kind: 'failed', failure: aborted(request.signal) ? 'aborted' : aborted(controller.signal) ? 'timeout' : 'network_error', status, finalUrl: url.href };
    }
    status = response.status;
    try {
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel();
        request.gate.leave(url, response.status, response.headers);
        const location = response.headers.get('location');
        const next = location === null ? null : checkRedirect(location, url, request.own);
        if (next === null || hop >= MAX_REDIRECTS) return { kind: 'failed', failure: 'redirect_refused', status, finalUrl: url.href };
        url = next;
        continue;
      }
      const read = response.status === 304 ? { body: new Uint8Array(0), truncated: false } : await readCapped(response, request.maxBytes, request.truncate === true);
      request.gate.leave(url, response.status, response.headers);
      if (read === null) return { kind: 'failed', failure: 'too_large', status, finalUrl: url.href };
      return { kind: 'answer', status, finalUrl: url.href, headers: response.headers, body: read.body, truncated: read.truncated };
    } catch {
      request.gate.leave(url, response.status, response.headers);
      return { kind: 'failed', failure: aborted(request.signal) ? 'aborted' : aborted(controller.signal) ? 'timeout' : 'network_error', status, finalUrl: url.href };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
    }
  }
}
