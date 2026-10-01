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
 * `ledger.browser_ms`) under BROWSER_DAILY_MS: a render starts only with BROWSER_RESERVE_MS left, and every render that
 * reached the binding is charged, a failed one too (TOO_LARGE, TIMEOUT, NETWORK_ERROR: the browser ran), with the time
 * the renderer reports (`x-browser-ms-used`) or the reserve when it reports none. A 429 from Browser Run marks the day
 * exhausted. Until 00:00 UTC such checks fail as JS_QUOTA_EXHAUSTED, which the UI shows as "JS quota exhausted today",
 * never as "no change". Renders are spaced BROWSER_SPACING_MS apart (one quick action per 10 seconds), and each is one
 * request of the caller's budget.
 *
 * The rendered HTML is read through readCapped, so an answer over the cap is never buffered whole. Where the browser
 * ended up is checked like a redirect (url-policy.ts) when the renderer reports it (`x-final-url`); Browser Run's
 * `content` action does not, so before the binding is enabled in production (a later step) the render must be limited
 * to the watch's own host by request interception, or the final URL obtained another way. Until then the flag stays
 * off.
 */
import { readCapped } from './fetcher.ts';
import { BROWSER_DAILY_MS, BROWSER_RESERVE_MS } from './limits.ts';

export interface RenderRequest {
  readonly url: string;
  readonly locale: string;
  readonly timeoutMs: number;
}

export type RenderResult =
  /** `finalUrl`: where the browser ended up, when the renderer says (null: unknown). */
  | { readonly kind: 'rendered'; readonly status: number; readonly html: Uint8Array; readonly browserMs: number; readonly finalUrl: string | null }
  | { readonly kind: 'quota' }
  /** `browserMs`: what the failed render cost (it is charged too). */
  | { readonly kind: 'failed'; readonly failure: 'TIMEOUT' | 'NETWORK_ERROR' | 'TOO_LARGE'; readonly browserMs: number };

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
        const browserMs = Number.isFinite(used) && used > 0 ? Math.round(used) : BROWSER_RESERVE_MS;
        const html = await readCapped(response, maxBytes);
        if (html === null) return { kind: 'failed', failure: 'TOO_LARGE', browserMs };
        // The page's own status, when the renderer reports it; else the action's.
        const status = Number(response.headers.get('x-page-status') ?? response.status);
        return { kind: 'rendered', status: Number.isInteger(status) ? status : response.status, html, browserMs, finalUrl: response.headers.get('x-final-url') };
      } catch {
        // The browser may have run up to the timeout: charged as the reserve (the render's own timeout).
        return { kind: 'failed', failure: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', browserMs: Math.max(BROWSER_RESERVE_MS, controller.signal.aborted ? timeoutMs : 0) };
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
