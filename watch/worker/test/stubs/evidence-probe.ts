/** Native HTMLRewriter and injected browser primitives; this worker never makes an outbound request. */
import { puppeteerRenderer } from '../../src/browser.ts';
import { extractCapture } from '../../src/evidence-extract.ts';
import type { SourceConfig } from '../../src/config.ts';
import type { Browser, HTTPRequest, HTTPResponse, Page } from '@cloudflare/puppeteer';

interface Probe {
  readonly html?: string;
  readonly contentType?: string;
  readonly url?: string;
  readonly source?: SourceConfig;
  readonly urls?: readonly string[];
  readonly assets?: readonly string[];
  readonly frames?: readonly string[];
  readonly denyUrl?: string;
  readonly screenshotError?: boolean;
  readonly screenshotLarge?: boolean;
  readonly accessibilityLarge?: boolean;
  readonly contentLarge?: boolean;
  readonly timeout?: boolean;
  readonly protocolTimeout?: boolean;
  readonly closeStalls?: boolean;
  readonly quota?: boolean;
  readonly gateError?: boolean;
  readonly gateLeaveError?: boolean;
  readonly timeoutWithNavigation?: boolean;
  /** A same-document SPA navigation has no intercepted network request. */
  readonly documentUrl?: string;
}
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9]);

export default {
  async fetch(request: Request) {
    const input = await request.json<Probe>();
    const url = input.url ?? 'https://page.example.com/article';
    const html = input.html ?? '<html><head><title>Capture fixture</title></head><body><h1>Stable heading</h1><p>Version 12 is available.</p></body></html>';
    if (new URL(request.url).pathname === '/extract') return Response.json(await extractCapture({
      body: new TextEncoder().encode(html), contentType: input.contentType ?? 'text/html', finalUrl: url,
      ...(input.source ? { source: input.source } : {}),
    }));
    const frame = {};
    const resourceFrame = {};
    const listeners = new Map<string, (value: unknown) => void>();
    const admitted: string[] = [];
    const denied: string[] = [];
    const gates: string[] = [];
    let closed = false;
    let launches = 0;
    let finalUrl = url;
    let screenshotOptions: unknown;
    let viewport: unknown;
    let axOptions: unknown;
    const navigate = async (target: string, main: boolean, respond = true, navigation = main) => {
      let decide: (allowed: boolean) => void = () => undefined;
      const decision = new Promise<boolean>(resolve => { decide = resolve; });
      const req = {
        url: () => target, isNavigationRequest: () => navigation, frame: () => main ? frame : resourceFrame,
        continue: () => { admitted.push(target); decide(true); return Promise.resolve(); },
        abort: () => { denied.push(target); decide(false); return Promise.resolve(); },
      } as unknown as HTTPRequest;
      listeners.get('request')?.(req);
      if (!await decision) { listeners.get('requestfailed')?.(req); return false; }
      if (!respond) return new Promise<HTTPResponse>(() => undefined);
      const response = { request: () => req, status: () => 200, headers: () => ({ 'content-type': 'text/html' }) } as unknown as HTTPResponse;
      listeners.get('response')?.(response);
      if (main) finalUrl = target;
      return response;
    };
    const page = {
      setViewport: (value: unknown) => { viewport = value; return Promise.resolve(); },
      setExtraHTTPHeaders: () => Promise.resolve(), setUserAgent: () => Promise.resolve(), setRequestInterception: () => Promise.resolve(),
      on: (event: string, listener: (value: unknown) => void) => { listeners.set(event, listener); },
      mainFrame: () => frame,
      goto: async () => {
        if (input.protocolTimeout) { const error = new Error('synthetic_timeout'); error.name = 'TimeoutError'; throw error; }
        if (input.timeout) return new Promise<HTTPResponse>(() => undefined);
        if (input.timeoutWithNavigation) return navigate(url, true, false);
        let response: HTTPResponse | null = null;
        for (const target of input.urls ?? [url]) {
          const next = await navigate(target, true);
          if (!next) throw new Error('synthetic_request_blocked');
          response = next;
        }
        for (const target of input.assets ?? []) await navigate(target, false);
        for (const target of input.frames ?? []) await navigate(target, false, true, true);
        return response;
      },
      url: () => input.documentUrl ?? finalUrl,
      evaluate: () => Promise.resolve(input.contentLarge ? null : html),
      accessibility: { snapshot: (options: unknown) => { axOptions = options; return Promise.resolve({ role: 'RootWebArea', name: input.accessibilityLarge ? '字'.repeat(100_000) : 'Fixture', children: [{ role: 'button', name: 'Buy' }] }); } },
      screenshot: (options: unknown) => {
        screenshotOptions = options;
        if (input.screenshotError) return Promise.reject(new Error('synthetic_screenshot_failure'));
        return Promise.resolve(input.screenshotLarge ? new Uint8Array(1024 * 1024 + 1) : JPEG);
      },
    } as unknown as Page;
    const browser = { newPage: () => Promise.resolve(page), close: () => { closed = true; return input.closeStalls ? new Promise<void>(() => undefined) : Promise.resolve(); } } as unknown as Browser;
    const binding = { fetch: () => Promise.resolve(new Response('', { status: input.quota ? 429 : 200 })) } as unknown as Fetcher;
    const launch = async (metered: Fetcher) => {
      launches++;
      if (input.quota) { await metered.fetch('https://browser.invalid/acquire'); throw new Error('synthetic_quota'); }
      return browser;
    };
    try {
      const result = await puppeteerRenderer(binding, 2 * 1024 * 1024, launch, () => 1000).render({
        url, locale: 'zh-CN', timeoutMs: input.timeout || input.timeoutWithNavigation ? 10 : 1000,
        ...(input.source ? { source: input.source } : {}),
        gate: {
          enter: (target, hop, previous) => {
            gates.push(`enter:${target.href}:${String(hop)}:${previous?.href ?? ''}`);
            if (input.gateError) return Promise.reject(new Error('synthetic_storage_failure'));
            return Promise.resolve(target.href === input.denyUrl ? { kind: 'robots' as const } : null);
          },
          leave: target => { gates.push(`leave:${target.href}`); if (input.gateLeaveError) throw new Error('synthetic_storage_failure'); },
        },
      });
      return Response.json({ result, admitted, denied, gates, closed, launches, screenshotOptions, viewport, axOptions,
        error: result.kind === 'failed' ? result.error?.message : undefined });
    } catch { return Response.json({ error: 'synthetic_storage_failure', closed }); }
  },
};
