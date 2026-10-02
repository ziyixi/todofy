/**
 * The workerd suite's fake network (./fake-net.ts), in a Miniflare of its own: a reader Worker whose outbound fetches
 * go to the fake-net proxy, and a Node control service the reader calls while it stops reading.
 *
 * The regression this guards: Miniflare's own Node-function outbound service wrote each 2 MiB page into its loopback
 * TCP connection at once, ahead of a WatchState that was busy parsing another lane's page, and on Linux 6.17 such a
 * connection lost segments and crawled (./fake-net.ts). The kernel fault cannot be reproduced off those kernels, so the
 * test pins what makes it impossible: while a reader stops reading, at most two slices of its body have left Node (the
 * one it holds and the one workerd's stream pump may ask for ahead), never the rest of the page.
 */
import { describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { BODY_SLICE_BYTES, FakeNet, type FakeHandler } from './fake-net.ts';

const PAGE = 'https://big.example.com/p';
/** Just under FETCH_MAX_BYTES, like the CPU test's pages. */
const PAGE_BYTES = 2 * 1024 * 1024 - 200;
/** How long the reader stays stalled (any push-ahead transport has long written the page by then). */
const STALL_MS = 300;
/**
 * The most body bytes that may have left Node while the reader stalls: two slices of 32 KiB. Half the default 128 KiB
 * receive buffer, and no 64 KiB segment behind data nobody reads: the kernel fault needs both.
 */
const MAX_AHEAD_BYTES = 2 * 32 * 1024;

/** A deterministic body of `size` bytes and its checksum (the sum of its bytes modulo 65521). */
function synthetic(size: number): { bytes: Uint8Array; sum: number } {
  const bytes = new Uint8Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 31 + 7) % 251;
    sum = (sum + (bytes[i] ?? 0)) % 65521;
  }
  return { bytes, sum };
}

/**
 * The reader: GET /stall reads the page's first chunk, asks the control service to look (and waits for its answer:
 * WatchState reads nothing while another lane parses), then reads the rest; GET /echo makes a POST and returns what
 * came back; GET /empty fetches an answer without a body and one with an empty body.
 */
const READER = `
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/echo') {
      const response = await fetch('https://echo.example.com/x?q=1', { method: 'POST', headers: { 'x-sent': 'yes' }, body: 'hello' });
      return Response.json({ status: response.status, header: response.headers.get('x-answered'), body: await response.text() });
    }
    if (path === '/empty') {
      const answers = [];
      for (const url of ['https://echo.example.com/not-modified', 'https://echo.example.com/blank']) {
        const response = await fetch(url);
        answers.push({ status: response.status, body: response.body === null ? null : await response.text() });
      }
      return Response.json(answers);
    }
    const response = await fetch('${PAGE}');
    const reader = response.body.getReader();
    let read = 0;
    let sum = 0;
    const take = (value) => {
      read += value.byteLength;
      for (const byte of value) sum = (sum + byte) % 65521;
    };
    take((await reader.read()).value);
    await env.CONTROL.fetch('http://control/stalled?read=' + read);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      take(value);
    }
    return Response.json({ read, sum });
  },
};
`;

/** A Miniflare with the reader, the proxy over `handler`, and the control service; disposed after `run`. */
async function withReader<T>(handler: FakeHandler, onStall: (read: number, net: FakeNet) => Promise<void>, run: (mf: Miniflare, net: FakeNet) => Promise<T>): Promise<T> {
  const net = new FakeNet(handler);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      workers: [
        {
          name: 'reader',
          modules: true,
          script: READER,
          compatibilityDate: '2026-09-08',
          outboundService: 'fake-net',
          serviceBindings: {
            CONTROL: async (request: Request) => {
              await onStall(Number(new URL(request.url).searchParams.get('read')), net);
              return new Response(null, { status: 204 });
            },
          },
        },
        net.worker('fake-net'),
      ],
    }),
  );
  try {
    await mf.ready;
    return await run(mf, net);
  } finally {
    await mf.dispose();
  }
}

describe('the fake network', () => {
  it('hands a body out only as the reader reads: a stalled reader holds at most two slices of a 2 MiB page', async () => {
    const page = synthetic(PAGE_BYTES);
    let stalled: { read: number; served: number } | undefined;
    const result = await withReader(
      (request) => Promise.resolve(request.url === PAGE ? new Response(page.bytes, { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 })),
      async (read, net) => {
        await new Promise((resolve) => setTimeout(resolve, STALL_MS));
        stalled = { read, served: net.served.get(PAGE) ?? 0 };
      },
      async (mf) => (await mf.dispatchFetch('http://reader/stall')).json(),
    );
    expect(result, 'the whole page, intact').toEqual({ read: PAGE_BYTES, sum: page.sum });
    expect(stalled?.read).toBeGreaterThan(0);
    expect((stalled?.served ?? Infinity) - (stalled?.read ?? 0), `bytes sent ahead of the stalled reader (a slice is ${String(BODY_SLICE_BYTES)})`).toBeLessThanOrEqual(MAX_AHEAD_BYTES);
  });

  it('passes the request (method, URL, headers, body) and the answer (status, headers, body, none, empty) through', async () => {
    const seen: { url: string; method: string; sent: string | null; body: string }[] = [];
    const answers = await withReader(
      async (request) => {
        seen.push({ url: request.url, method: request.method, sent: request.headers.get('x-sent'), body: await request.text() });
        if (request.url.endsWith('/not-modified')) return new Response(null, { status: 304 });
        if (request.url.endsWith('/blank')) return new Response('');
        return new Response('answered', { status: 201, headers: { 'x-answered': 'yes' } });
      },
      () => Promise.resolve(),
      async (mf) => [await (await mf.dispatchFetch('http://reader/echo')).json(), await (await mf.dispatchFetch('http://reader/empty')).json()],
    );
    expect(answers).toEqual([
      { status: 201, header: 'yes', body: 'answered' },
      [
        { status: 304, body: null },
        { status: 200, body: '' },
      ],
    ]);
    expect(seen).toEqual([
      { url: 'https://echo.example.com/x?q=1', method: 'POST', sent: 'yes', body: 'hello' },
      { url: 'https://echo.example.com/not-modified', method: 'GET', sent: null, body: '' },
      { url: 'https://echo.example.com/blank', method: 'GET', sent: null, body: '' },
    ]);
  });
});
