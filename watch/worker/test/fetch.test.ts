/**
 * The transport (src/fetcher.ts) and the browser renderer (src/browser.ts) with stubs: bodies are read through a cap
 * and never buffered whole, robots.txt keeps its first bytes, every hop passes the gate and reports back to it, and a
 * render that failed still says what it cost. Synthetic inputs only; nothing leaves the process.
 */
import { describe, expect, it } from 'vitest';
import { browserAllowed, quickActionRenderer } from '../src/browser.ts';
import { fetchPage, readCapped, type HopGate } from '../src/fetcher.ts';
import { BROWSER_DAILY_MS, BROWSER_RESERVE_MS } from '../src/limits.ts';

/** A stream of `chunk` repeated up to `total` bytes, counting what was pulled. */
function counted(total: number, chunkBytes = 16 * 1024): { readonly stream: ReadableStream<Uint8Array>; readonly pulled: () => number } {
  let pulled = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, pulled: () => pulled };
}

describe('readCapped', () => {
  it('stops reading once the body is over the cap; with truncate it keeps the first bytes', async () => {
    const cap = 64 * 1024;
    const over = counted(64 * cap);
    expect(await readCapped(new Response(over.stream), cap)).toBeNull();
    expect(over.pulled()).toBeLessThanOrEqual(cap + 2 * 16 * 1024);
    const kept = await readCapped(new Response(counted(4 * cap).stream), cap, true);
    expect(kept?.byteLength).toBe(cap);
  });
});

describe('fetchPage and its gate', () => {
  it('asks the gate before every hop and reports every answer; a refusal stops the fetch before its request', async () => {
    const seen: string[] = [];
    const requested: string[] = [];
    const gate: HopGate = {
      enter(url, hop, previous) {
        seen.push(`enter ${String(hop)} ${url.href} from ${previous?.href ?? '-'}`);
        return Promise.resolve(url.hostname === 'blocked.example.net' ? { kind: 'robots' } : null);
      },
      leave(url, status) {
        seen.push(`leave ${url.href} ${String(status)}`);
      },
    };
    const fetchFn = (request: Request) => {
      requested.push(request.url);
      if (request.url === 'https://start.example.com/') return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://blocked.example.net/x' } }));
      return Promise.resolve(new Response('page'));
    };
    const answer = await fetchPage(fetchFn, { url: 'https://start.example.com/', accept: 'text/html', locale: 'en', allowHttp: false, conditional: null, gate });
    expect(answer).toMatchObject({ kind: 'refused', refusal: { kind: 'robots' }, redirects: 1, requests: 1 });
    expect(requested).toEqual(['https://start.example.com/']);
    expect(seen).toEqual(['enter 0 https://start.example.com/ from -', 'leave https://start.example.com/ 302', 'enter 1 https://blocked.example.net/x from https://start.example.com/']);
  });

  it('gives every request its own timer, always cleared, and reports a timeout to the gate as no answer', async () => {
    const statuses: number[] = [];
    const gate: HopGate = { enter: () => Promise.resolve(null), leave: (_url, status) => statuses.push(status) };
    const never = (request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const answer = await fetchPage(never, { url: 'https://slow.example.com/', accept: 'text/html', locale: 'en', allowHttp: false, conditional: null, timeoutMs: 20, gate });
    expect(answer).toMatchObject({ kind: 'failed', failure: 'TIMEOUT' });
    expect(statuses).toEqual([0]);
  });
});

describe('the browser renderer', () => {
  const binding = (response: () => Response) => ({ fetch: () => Promise.resolve(response()) }) as unknown as Fetcher;

  it('stops reading a rendered page once it is over the cap (never buffers the whole answer), and says what it cost', async () => {
    const cap = 64 * 1024;
    const body = counted(64 * cap);
    const result = await quickActionRenderer(binding(() => new Response(body.stream, { headers: { 'x-browser-ms-used': '30000' } })), cap).render({ url: 'https://render.example.com/p', locale: 'en', timeoutMs: 5000 });
    expect(result).toEqual({ kind: 'failed', failure: 'TOO_LARGE', browserMs: 30_000 });
    expect(body.pulled()).toBeLessThanOrEqual(cap + 2 * 16 * 1024);
  });

  it('charges the reserve for a failed render that reported nothing, and reads where the render ended', async () => {
    const failing = { fetch: () => Promise.reject(new Error('connection reset')) } as unknown as Fetcher;
    expect(await quickActionRenderer(failing, 1024).render({ url: 'https://render.example.com/p', locale: 'en', timeoutMs: 5000 })).toEqual({ kind: 'failed', failure: 'NETWORK_ERROR', browserMs: BROWSER_RESERVE_MS });
    const moved = await quickActionRenderer(binding(() => new Response('<p>x</p>', { headers: { 'x-final-url': 'https://elsewhere.example.com/' } })), 1024).render({ url: 'https://render.example.com/p', locale: 'en', timeoutMs: 5000 });
    expect(moved).toMatchObject({ kind: 'rendered', finalUrl: 'https://elsewhere.example.com/', browserMs: BROWSER_RESERVE_MS });
  });

  it('allows a render only with its reserve left in the day', () => {
    expect(browserAllowed({ browser_ms: BROWSER_DAILY_MS - BROWSER_RESERVE_MS, browser_exhausted: 0 })).toBe(true);
    expect(browserAllowed({ browser_ms: BROWSER_DAILY_MS - BROWSER_RESERVE_MS + 1, browser_exhausted: 0 })).toBe(false);
    expect(browserAllowed({ browser_ms: 0, browser_exhausted: 1 })).toBe(false);
  });
});
