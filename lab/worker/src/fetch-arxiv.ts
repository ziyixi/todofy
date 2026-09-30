/**
 * The only two outbound requests Lab makes (docs/design.md §4), both to fixed arXiv hosts: the daily RSS
 * feed and the seed lookup in the arXiv API. One request each, a proper User-Agent, no redirects
 * followed, a timeout, and the body read as a stream and abandoned past a size cap. No URL from any
 * content is ever fetched.
 */

export const USER_AGENT = 'ziyixi-lab/1.0 (+https://github.com/ziyixi/todofy)';
export const FEED_HOST = 'rss.arxiv.org';
export const API_HOST = 'export.arxiv.org';
export const FEED_MAX_BYTES = 5 * 1024 * 1024;
export const ATOM_MAX_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
/** arXiv's API terms: at most one request every 3 seconds. */
export const ARXIV_MIN_GAP_MS = 3_000;

const CATEGORY_RE = /^[a-z][a-z-]{0,19}\.[A-Za-z-]{1,20}$/;

export type FetchOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly etag: string | null; readonly lastModified: string | null }
  | { readonly kind: 'not_modified' }
  | { readonly kind: 'error'; readonly code: string };

export function feedUrl(categories: readonly string[]): string {
  const valid = categories.filter((c) => CATEGORY_RE.test(c)).slice(0, 6);
  if (valid.length === 0) throw new Error('no_categories');
  return `https://${FEED_HOST}/rss/${valid.join('+')}`;
}

/** `ids` are validated arXiv IDs (arxiv.ts isArxivId: letters, digits, ".", "-", "/"), used as they are. */
export function apiUrl(ids: readonly string[]): string {
  const list = ids.slice(0, 20).join(',');
  return `https://${API_HOST}/api/query?id_list=${list}&max_results=${String(Math.min(ids.length, 20))}`;
}

/** Reads at most `limit` bytes of the body as UTF-8; null when it is larger (the stream is cancelled). */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return '';
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder('utf-8');
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export interface Conditional {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

/** One GET of a fixed arXiv URL. Never throws: every failure is an error code. */
export async function fetchArxiv(
  url: string,
  limit: number,
  conditional: Conditional | null = null,
  fetcher: typeof fetch = fetch,
): Promise<FetchOutcome> {
  const host = new URL(url).hostname;
  if (host !== FEED_HOST && host !== API_HOST) return { kind: 'error', code: 'host_not_allowed' };
  const headers = new Headers({ 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9' });
  if (conditional?.etag) headers.set('if-none-match', conditional.etag);
  if (conditional?.lastModified) headers.set('if-modified-since', conditional.lastModified);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { headers, redirect: 'manual', signal: controller.signal });
    if (response.status === 304) {
      await response.body?.cancel();
      return { kind: 'not_modified' };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { kind: 'error', code: response.status >= 300 && response.status < 400 ? 'redirected' : `http_${String(response.status)}` };
    }
    const text = await readCapped(response, limit);
    if (text === null) return { kind: 'error', code: 'too_large' };
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    return {
      kind: 'ok',
      text,
      etag: etag !== null && etag.length <= 200 ? etag : null,
      lastModified: lastModified !== null && lastModified.length <= 100 ? lastModified : null,
    };
  } catch {
    return { kind: 'error', code: controller.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
