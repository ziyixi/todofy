/**
 * Fetch tier 3, the browser (../../docs/design.md §4): pages that need JavaScript (Watch.fetcher FETCHER_BROWSER),
 * rendered by Browser Run. Behind a feature flag in v1: the production config binds no browser, so such watches are
 * refused (BROWSER_NOT_AVAILABLE) and this module is reached only by the workerd tests, which bind a fake renderer.
 *
 * The renderer is Browser Run's `content` quick action (rendered HTML of one URL), through a Fetcher. Never `/json`,
 * `/crawl`, screenshots, PDFs or a kept-alive session: one render answers one check. Images, media and fonts are not
 * loaded.
 *
 * Browser Run's free allowance is 10 minutes a day for the whole account, so the app keeps its own ledger (store.ts
 * `ledger.browser_ms`) under BROWSER_DAILY_MS: a render starts only with BROWSER_RESERVE_MS left, adds the time the
 * renderer reports (`x-browser-ms-used`, or the reserve when it reports none), and a 429 from Browser Run marks the day
 * exhausted. Until 00:00 UTC such checks fail as JS_QUOTA_EXHAUSTED, which the UI shows as "JS quota exhausted today",
 * never as "no change". Renders are spaced BROWSER_SPACING_MS apart (one quick action per 10 seconds).
 */
import { BROWSER_DAILY_MS, BROWSER_RESERVE_MS } from './limits.ts';

export interface RenderRequest {
  readonly url: string;
  readonly locale: string;
  readonly timeoutMs: number;
}

export type RenderResult =
  | { readonly kind: 'rendered'; readonly status: number; readonly html: Uint8Array; readonly browserMs: number }
  | { readonly kind: 'quota' }
  | { readonly kind: 'failed'; readonly failure: 'TIMEOUT' | 'NETWORK_ERROR' | 'TOO_LARGE' };

export interface BrowserRenderer {
  render(request: RenderRequest): Promise<RenderResult>;
}

/** The `content` quick action through a Fetcher (the browser binding, or the tests' fake). */
export function quickActionRenderer(binding: Fetcher, maxBytes: number): BrowserRenderer {
  return {
    async render({ url, locale, timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await binding.fetch('https://browser.invalid/content', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url,
            gotoOptions: { waitUntil: 'networkidle2', timeout: timeoutMs },
            setExtraHTTPHeaders: { 'Accept-Language': locale },
            rejectResourceTypes: ['image', 'media', 'font'],
          }),
          signal: controller.signal,
        });
        if (response.status === 429) {
          await response.body?.cancel();
          return { kind: 'quota' };
        }
        const used = Number(response.headers.get('x-browser-ms-used') ?? '');
        const html = new Uint8Array(await response.arrayBuffer());
        if (html.byteLength > maxBytes) return { kind: 'failed', failure: 'TOO_LARGE' };
        // The page's own status, when the renderer reports it; else the action's.
        const status = Number(response.headers.get('x-page-status') ?? response.status);
        return { kind: 'rendered', status: Number.isInteger(status) ? status : response.status, html, browserMs: Number.isFinite(used) && used > 0 ? Math.round(used) : BROWSER_RESERVE_MS };
      } catch {
        return { kind: 'failed', failure: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Whether today's ledger allows one more render. */
export function browserAllowed(ledger: { readonly browser_ms: number; readonly browser_exhausted: number }): boolean {
  return ledger.browser_exhausted === 0 && ledger.browser_ms + BROWSER_RESERVE_MS <= BROWSER_DAILY_MS;
}
