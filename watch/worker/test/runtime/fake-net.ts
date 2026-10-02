/**
 * The network between a Worker under test and Node-side fakes (the synthetic sites of ../fake-sites.ts, the fake
 * browser), for the workerd suite (./harness.ts): a proxy Worker inside workerd that the Worker's outbound fetches (or
 * a service binding) go to, and a Node service (FakeNet) that the proxy asks for each answer. Nothing leaves the
 * process tree; the proxy's requests to Node travel over Miniflare's loopback connection, like any Node service's.
 *
 * Why not hand a Node function to Miniflare's `outboundService` directly: Miniflare then writes each answer's whole
 * body into its loopback TCP connection at once, ahead of the reader. workerd runs every isolate and its own I/O on one
 * thread and does not read its sockets while JavaScript work is queued, so while WatchState parses one lane's page
 * (seconds on a slow runner) the answers of the other lanes sit in their connections with nobody reading. On Linux
 * kernels with "tcp: stronger sk_rcvbuf checks" (1d2fbaad7cd8, from 6.17; reverted by 026dfef287c0 for 7.0) such a
 * loopback connection, with its receive buffer still at the default 128 KiB, drops arriving 64 KiB segments
 * (TcpExtTCPRcvQDrop), shrinks that buffer and retransmits on exponential timeouts: the rest of a 2 MiB page then
 * crawled in at 25-40 KB/s and its check failed TIMEOUT even with a 60 s timer (GitHub's ubuntu-24.04 runners, kernel
 * 6.17.0-azure; the CPU test's worst alarm pass, ./cpu.test.ts). macOS and newer kernels never showed it.
 *
 * So here a body is pulled, never pushed: the proxy answers with a stream that asks Node for the next BODY_SLICE_BYTES
 * only when the reader wants more. A connection then carries at most one small slice that nobody reads, which no kernel
 * drops, and a reader that stalls stalls nothing else. Each answer's request (method, URL, headers, body) goes to Node
 * whole. Node keeps an answer's body until its last slice is read; a body the reader abandoned (a cancelled read:
 * workerd does not tell the proxy) is forgotten after BODY_IDLE_MS without a read.
 */

/** A Node-side fake: the answer to one request. */
export type FakeHandler = (request: Request) => Promise<Response>;

/** The most body bytes one slice carries: far below the 64 KiB segment and 128 KiB buffer of the kernel fault above. */
export const BODY_SLICE_BYTES = 32 * 1024;
/** A body nobody read for this long was abandoned (far above any request timer of the suite). */
const BODY_IDLE_MS = 5 * 60_000;

/** What the proxy sends Node for each request (the request itself, its body in base64). */
interface AnswerRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: string | null;
}

/** What Node answers: the status and headers, and the body's id and length (id null: no body; length 0: empty). */
interface AnswerHead {
  readonly status: number;
  readonly headers: [string, string][];
  readonly id: string | null;
  readonly length: number;
}

/**
 * The proxy Worker (modules syntax, no imports): every request becomes an answer request to Node (binding NODE); the
 * body comes back as a stream with a high-water mark of zero, so each slice is asked for only on a read. A body Node
 * no longer has errors the stream (never a silently short body).
 */
const PROXY_SCRIPT = `
function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export default {
  async fetch(request, env) {
    const body = request.body === null ? null : base64(new Uint8Array(await request.arrayBuffer()));
    const answer = await env.NODE.fetch('http://fake-net/answer', {
      method: 'POST',
      body: JSON.stringify({ url: request.url, method: request.method, headers: [...request.headers], body }),
    });
    const { status, headers, id, length } = await answer.json();
    if (id === null || length === 0) return new Response(id === null ? null : '', { status, headers });
    let offset = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        const slice = await env.NODE.fetch('http://fake-net/slice?id=' + id + '&offset=' + offset);
        if (!slice.ok) {
          controller.error(new Error('fake-net: body ' + id + ' is gone'));
          return;
        }
        const bytes = new Uint8Array(await slice.arrayBuffer());
        offset += bytes.byteLength;
        if (bytes.byteLength > 0) controller.enqueue(bytes);
        if (bytes.byteLength === 0 || offset >= length) controller.close();
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status, headers });
  },
};
`;

/** One answer's body while the proxy reads it. */
interface Body {
  readonly url: string;
  readonly bytes: Uint8Array;
  /** When a slice of it was last asked for (or it was answered). */
  touched: number;
}

/**
 * The Node side of the fake network: answers the proxy's requests with `handler`, and hands each body out in slices.
 * `served` counts, per URL, the body bytes of its latest answer handed to the proxy so far (./fake-net.test.ts).
 */
export class FakeNet {
  readonly served = new Map<string, number>();
  private readonly handler: FakeHandler;
  private readonly bodies = new Map<string, Body>();
  private next = 0;

  constructor(handler: FakeHandler) {
    this.handler = handler;
  }

  /** The Node service the proxy Worker calls (its NODE binding). */
  readonly service = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? '';
    if (url.pathname === '/answer') return Response.json(await this.answer(await request.json<AnswerRequest>()));
    if (url.pathname === '/slice') return this.slice(id, Number(url.searchParams.get('offset')));
    return new Response('unknown fake-net path', { status: 404 });
  };

  /** A Miniflare worker definition of the proxy named `name`, whose answers come from this FakeNet. */
  worker(name: string): { name: string; modules: true; script: string; compatibilityDate: string; serviceBindings: Record<string, (request: Request) => Promise<Response>> } {
    return { name, modules: true, script: PROXY_SCRIPT, compatibilityDate: '2026-09-08', serviceBindings: { NODE: (request: Request) => this.service(request) } };
  }

  private async answer({ url, method, headers, body }: AnswerRequest): Promise<AnswerHead> {
    let response: Response;
    try {
      response = await this.handler(new Request(url, { method, headers, ...(body === null ? {} : { body: Uint8Array.from(atob(body), (char) => char.charCodeAt(0)) }) }));
    } catch (error) {
      // As Miniflare answers a Node service that throws.
      response = new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
    const answerHeaders: [string, string][] = [];
    response.headers.forEach((value, name) => {
      answerHeaders.push([name, value]);
    });
    this.served.set(url, 0);
    if (response.body === null) return { status: response.status, headers: answerHeaders, id: null, length: 0 };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { status: response.status, headers: answerHeaders, id: '', length: 0 };
    const now = Date.now();
    for (const [stale, { touched }] of this.bodies) if (now - touched > BODY_IDLE_MS) this.bodies.delete(stale);
    this.next += 1;
    const id = String(this.next);
    this.bodies.set(id, { url, bytes, touched: now });
    return { status: response.status, headers: answerHeaders, id, length: bytes.byteLength };
  }

  /** BODY_SLICE_BYTES of body `id` from `offset` (fewer at its end); the body is forgotten after its last slice. */
  private slice(id: string, offset: number): Response {
    const body = this.bodies.get(id);
    if (body === undefined) return new Response('fake-net: no such body', { status: 410 });
    body.touched = Date.now();
    const end = Math.min(offset + BODY_SLICE_BYTES, body.bytes.byteLength);
    const bytes = body.bytes.slice(offset, end);
    this.served.set(body.url, end);
    if (end >= body.bytes.byteLength) this.bodies.delete(id);
    return new Response(bytes);
  }
}
