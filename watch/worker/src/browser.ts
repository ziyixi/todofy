/** Browser Run transport and bounded page capture; the official client handles the browser protocol, and every
 * navigation reaches the existing hop gate. Tests inject a synthetic launcher.
 */
import puppeteer, { type Browser, type HTTPRequest, type HTTPResponse } from '@cloudflare/puppeteer';
import type { SourceConfig } from './config.ts';
import { CAPTURE_SCREENSHOT_MAX, extractCapture, type CaptureDocument } from './evidence-extract.ts';
import type { HopGate, HopRefusal, TransportFailure } from './fetcher.ts';
import { BROWSER_DAILY_MS, BROWSER_RESERVE_MS, MAX_REDIRECTS, USER_AGENT } from './limits.ts';
import { checkUri } from './url-policy.ts';

export interface RenderRequest {
  readonly url: string;
  readonly locale: string;
  readonly timeoutMs: number;
  readonly allowHttp?: boolean;
  readonly source?: SourceConfig;
  readonly gate?: HopGate;
}

export type RenderResult =
  | { readonly kind: 'rendered'; readonly status: number; readonly html: Uint8Array; readonly browserMs: number; readonly finalUrl: string | null; readonly evidence?: CaptureDocument; readonly headers?: Headers; readonly redirects?: number }
  | { readonly kind: 'quota' }
  | { readonly kind: 'refused'; readonly refusal: HopRefusal; readonly browserMs: number }
  | { readonly kind: 'failed'; readonly failure: TransportFailure; readonly browserMs: number; readonly error?: Error };

export interface BrowserRenderer {
  render(request: RenderRequest): Promise<RenderResult>;
}

export type BrowserLauncher = (binding: Fetcher) => Promise<Pick<Browser, 'newPage' | 'close'>>;
const VIEWPORT = { width: 1280, height: 960, deviceScaleFactor: 1 };

/** Only baseline/progressive JPEGs from our fixed viewport are accepted; no decoding or image library is needed. */
export function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;
    const size = view.getUint16(at + 2);
    if (size < 2 || at + 2 + size > bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (size < 8) return null;
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      return width > 0 && width <= VIEWPORT.width && height > 0 && height <= VIEWPORT.height ? { width, height } : null;
    }
    at += 2 + size;
  }
  return null;
}

/** Official Puppeteer handles CDP; this adapter only applies Watch's request policy and captures bounded evidence. */
export function puppeteerRenderer(binding: Fetcher, maxBytes: number, launch: BrowserLauncher = endpoint => puppeteer.launch(endpoint), now: () => number = Date.now): BrowserRenderer {
  return {
    async render(request) {
      const gate = request.gate;
      if (gate === undefined || checkUri(request.url, { allowHttp: request.allowHttp === true }) === null)
        return { kind: 'failed', failure: 'REDIRECT_REFUSED', browserMs: 0 };
      const started = now();
      const state: {
        browser: Pick<Browser, 'newPage' | 'close'> | null; timedOut: boolean; stopped: boolean; quota: boolean;
        navigation: URL | null; refusal: HopRefusal | null; failure: TransportFailure | null; gateError: Error | null;
      } = { browser: null, timedOut: false, stopped: false, quota: false, navigation: null, refusal: null, failure: null, gateError: null };
      let reportedMs = 0;
      let outcome: RenderResult;
      let navigationCount = 0;
      const active = new Map<HTTPRequest, URL>();
      const pending = new Set<Promise<void>>();
      const isStopped = () => state.stopped;
      const cost = () => Math.max(BROWSER_RESERVE_MS, reportedMs, Math.ceil(now() - started));
      const metered = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await binding.fetch(input, init);
        state.quota ||= response.status === 429;
        const used = Number(response.headers.get('x-browser-ms-used') ?? '');
        if (Number.isFinite(used) && used > 0) reportedMs += used;
        return response;
      } } as Fetcher;
      const release = (url: URL, status: number, headers: Headers | null) => {
        try { gate.leave(url, status, headers); }
        catch (error) { state.gateError = error instanceof Error ? error : new Error('browser_gate_failed'); state.stopped = true; }
      };
      const leave = (req: HTTPRequest, response: HTTPResponse | null) => {
        const url = active.get(req);
        if (url === undefined) return;
        active.delete(req);
        release(url, response?.status() ?? 0, response === null ? null : new Headers(response.headers()));
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = (async (): Promise<RenderResult> => {
          state.browser = await launch(metered);
          if (isStopped()) { await state.browser.close(); throw new Error('capture_stopped'); }
          const page = await state.browser.newPage();
          await page.setViewport(VIEWPORT);
          await page.setExtraHTTPHeaders({ 'Accept-Language': request.locale });
          await page.setUserAgent(USER_AGENT);
          await page.setRequestInterception(true);
          const intercept = async (req: HTTPRequest) => {
            const resourceUrl = req.url();
            // Inline images/fonts and page-created blobs make no network request.
            if (!isStopped() && !req.isNavigationRequest() && (resourceUrl.startsWith('data:') || resourceUrl.startsWith('blob:'))) {
              await req.continue();
              return;
            }
            const url = checkUri(resourceUrl, { allowHttp: request.allowHttp === true });
            const main = req.isNavigationRequest() && req.frame() === page.mainFrame();
            if (isStopped() || url === null) {
              if (main && url === null) state.failure = 'REDIRECT_REFUSED';
              await req.abort('blockedbyclient');
              return;
            }
            if (main) {
              if (navigationCount > MAX_REDIRECTS) { state.failure = 'REDIRECT_REFUSED'; await req.abort('blockedbyclient'); return; }
              let denied: HopRefusal | null;
              try { denied = await gate.enter(url, navigationCount, state.navigation); }
              catch (error) { state.gateError = error instanceof Error ? error : new Error('browser_gate_failed'); state.stopped = true; await req.abort('failed'); return; }
              if (denied) { state.refusal = denied; await req.abort('blockedbyclient'); return; }
              if (isStopped()) { release(url, 0, null); await req.abort('blockedbyclient'); return; }
              active.set(req, url);
              state.navigation = url;
              navigationCount++;
            }
            await req.continue();
          };
          page.on('request', req => {
            const task = intercept(req).catch(async () => { state.failure ??= 'NETWORK_ERROR'; await req.abort('failed').catch(() => undefined); });
            pending.add(task);
            void task.finally(() => { pending.delete(task); });
          });
          page.on('response', response => { leave(response.request(), response); });
          page.on('requestfailed', req => { leave(req, null); });
          let response: HTTPResponse | null;
          try { response = await page.goto(request.url, { waitUntil: 'networkidle2', timeout: request.timeoutMs }); }
          catch (error) {
            if (state.gateError !== null) throw state.gateError;
            if (state.refusal !== null) return { kind: 'refused', refusal: state.refusal, browserMs: cost() };
            if (state.failure !== null) return { kind: 'failed', failure: state.failure, browserMs: cost() };
            throw error;
          }
          await Promise.allSettled([...pending]);
          if (state.gateError !== null) throw state.gateError;
          if (state.refusal !== null) return { kind: 'refused', refusal: state.refusal, browserMs: cost() };
          const finalUrl = page.url();
          const checkedFinalUrl = checkUri(finalUrl, { allowHttp: request.allowHttp === true });
          const admitted = state.navigation;
          if (state.failure !== null || admitted === null || checkedFinalUrl === null || checkedFinalUrl.href !== admitted.href)
            return { kind: 'failed', failure: state.failure ?? 'REDIRECT_REFUSED', browserMs: cost() };
          // The string is bounded in the remote browser before it crosses the CDP connection.
          const content: unknown = await page.evaluate(`(() => { const html = document.documentElement.outerHTML; return new TextEncoder().encode(html).length <= ${String(maxBytes)} ? html : null; })()`);
          if (typeof content !== 'string') return { kind: 'failed', failure: 'TOO_LARGE', browserMs: cost() };
          const html = new TextEncoder().encode(content);
          if (html.byteLength > maxBytes) return { kind: 'failed', failure: 'TOO_LARGE', browserMs: cost() };
          let evidence = await extractCapture({ body: html, contentType: 'text/html; charset=utf-8', finalUrl, ...(request.source ? { source: request.source } : {}) });
          evidence = { ...evidence, metadata: [...evidence.metadata, { name: 'screenshot_scope', content: 'viewport:1280x960' }] };
          try {
            const bytes = new Uint8Array(await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, captureBeyondViewport: false }));
            const dimensions = bytes.length <= CAPTURE_SCREENSHOT_MAX ? jpegDimensions(bytes) : null;
            evidence = dimensions === null
              ? { ...evidence, errors: [...evidence.errors, bytes.length > CAPTURE_SCREENSHOT_MAX ? 'too_large' : 'screenshot_failed'] }
              : { ...evidence, screenshot: { bytes, ...dimensions, mimeType: 'image/jpeg' } };
          } catch { evidence = { ...evidence, errors: [...evidence.errors, 'screenshot_failed'] }; }
          return { kind: 'rendered', status: response?.status() ?? 0, html, browserMs: cost(), finalUrl, evidence,
            headers: response === null ? new Headers() : new Headers(response.headers()), redirects: Math.max(0, navigationCount - 1) };
        })();
        outcome = await Promise.race([work, new Promise<RenderResult>(resolve => {
          timer = setTimeout(() => { state.timedOut = true; state.stopped = true; resolve({ kind: 'failed', failure: 'TIMEOUT', browserMs: cost() }); }, request.timeoutMs);
        })]);
      } catch (error) {
        state.timedOut ||= error instanceof Error && error.name === 'TimeoutError';
        outcome = state.quota ? { kind: 'quota' } : { kind: 'failed', failure: state.timedOut ? 'TIMEOUT' : state.failure ?? 'NETWORK_ERROR', browserMs: cost() };
      } finally {
        state.stopped = true;
        clearTimeout(timer);
        for (const [req] of active) leave(req, null);
        if (state.browser !== null) {
          // CDP's default protocol timeout is longer than a check; cleanup must not extend it by minutes.
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([state.browser.close().catch(() => undefined), new Promise<void>(resolve => {
            closeTimer = setTimeout(resolve, Math.min(1000, request.timeoutMs));
          })]); }
          finally { clearTimeout(closeTimer); }
        }
      }
      if (state.gateError !== null) return { kind: 'failed', failure: 'NETWORK_ERROR', browserMs: cost(), error: state.gateError };
      return outcome.kind === 'quota' ? outcome : { ...outcome, browserMs: cost() };
    },
  };
}

/** Whether today's ledger allows one more render. */
export function browserAllowed(ledger: { readonly browser_ms: number; readonly browser_exhausted: number }): boolean {
  return ledger.browser_exhausted === 0 && ledger.browser_ms + BROWSER_RESERVE_MS <= BROWSER_DAILY_MS;
}
