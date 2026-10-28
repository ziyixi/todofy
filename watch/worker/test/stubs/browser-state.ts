/**
 * The Worker "watch" of the workerd browser suite (../runtime/harness.ts with `browser: true`): src/index.ts with a
 * WatchState whose Browser Run client is the production puppeteerRenderer on a synthetic launcher. The fake BROWSER
 * binding answers each render's page, its final URL, the browser time it reports or a 429; the launcher plays that
 * through the renderer's own request interception, so every navigation passes Watch's gate. No browser runs.
 */
import type { Browser, HTTPRequest, HTTPResponse, Page } from '@cloudflare/puppeteer';
import { puppeteerRenderer, type BrowserLauncher, type BrowserRenderer } from '../../src/browser.ts';
import { FETCH_MAX_BYTES } from '../../src/limits.ts';
import { WatchState as ProductionState } from '../../src/state.ts';

export { default, Ops, WatchApi } from '../../src/index.ts';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9]);

/** One session: `goto` asks the metered binding for the page, then navigates to it (and to its final URL, if moved). */
const launch: BrowserLauncher = (metered) => {
  const listeners = new Map<string, (value: unknown) => void>();
  const frame = {};
  let html = '';
  let current = '';
  const navigate = async (target: string, status: number): Promise<HTTPResponse | null> => {
    let decide: (allowed: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => { decide = resolve; });
    const request = {
      url: () => target, isNavigationRequest: () => true, frame: () => frame,
      continue: () => { decide(true); return Promise.resolve(); },
      abort: () => { decide(false); return Promise.resolve(); },
    } as unknown as HTTPRequest;
    listeners.get('request')?.(request);
    if (!await decision) {
      listeners.get('requestfailed')?.(request);
      return null;
    }
    const response = { request: () => request, status: () => status, headers: () => ({ 'content-type': 'text/html' }) } as unknown as HTTPResponse;
    listeners.get('response')?.(response);
    current = target;
    return response;
  };
  const page = {
    setViewport: () => Promise.resolve(), setExtraHTTPHeaders: () => Promise.resolve(),
    setUserAgent: () => Promise.resolve(), setRequestInterception: () => Promise.resolve(),
    on: (event: string, listener: (value: unknown) => void) => { listeners.set(event, listener); },
    mainFrame: () => frame,
    async goto(url: string) {
      const answer = await metered.fetch('https://browser.invalid/session', { method: 'POST', body: JSON.stringify({ url }) });
      if (answer.status === 429) throw new Error('synthetic_quota');
      html = await answer.text();
      const status = Number(answer.headers.get('x-page-status') ?? '200');
      const moved = answer.headers.get('x-final-url');
      const first = await navigate(url, moved === null ? status : 302);
      const response = moved === null || first === null ? first : await navigate(moved, status);
      if (response === null) throw new Error('synthetic_navigation_blocked');
      return response;
    },
    url: () => current,
    evaluate: () => Promise.resolve(html),
    screenshot: () => Promise.resolve(JPEG),
  } as unknown as Page;
  return Promise.resolve({ newPage: () => Promise.resolve(page), close: () => Promise.resolve() } as unknown as Browser);
};

export class WatchState extends ProductionState {
  protected override browser(): BrowserRenderer | null {
    return this.env.BROWSER === undefined ? null : puppeteerRenderer(this.env.BROWSER, FETCH_MAX_BYTES, launch);
  }
}
