/**
 * The transport to Newsletter on its own (upstream.ts), with a fake fetch: what is sent (the rewritten path and query,
 * a GET with the owner's assertion only, no redirect followed, a deadline) and how each answer maps to the console's
 * Status, never echoing what Newsletter or anything on the way answered.
 */
import { describe, expect, it, vi } from 'vitest';
import { PreEncoded } from '@ziyixi/proto/http-transcoder';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { forward, MAX_ANSWER_BYTES, UPSTREAM_TIMEOUT_MS, upstreamOrigin, type UpstreamOutcome } from '../src/upstream.ts';

const ORIGIN = 'https://runtime.example.test';
const ASSERTION = 'header.claims.signature';
const SECRET = 'upstream-private-detail';

interface Sent {
  readonly request: Request;
}

function exchange(answer: (request: Request) => Response | Promise<Response>, url = 'https://news.example.test/api/v1/runs?month=2026-10') {
  const sent: Sent[] = [];
  const outcomes: UpstreamOutcome[] = [];
  const result = forward({
    url: new URL(url),
    assertion: ASSERTION,
    origin: ORIGIN,
    report: (outcome) => outcomes.push(outcome),
    fetch: (request) => {
      sent.push({ request });
      return Promise.resolve(answer(request));
    },
  });
  return { result, sent, outcomes };
}

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('expected an RpcError');
}

/** An RpcError carries nothing upstream said: not its body, status text or headers. */
function expectNoEcho(error: RpcError): void {
  expect(JSON.stringify({ message: error.message, headers: error.headers })).not.toContain(SECRET);
}

const json = (body: string, init: { status?: number } = {}) =>
  new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'application/json; charset=utf-8' } });

describe('what is sent', () => {
  it('rewrites the binding prefix, keeps the query, and sends a GET carrying only the owner assertion', async () => {
    const { result, sent, outcomes } = exchange(() => json('{"month":"2026-10"}'));
    const answer = await result;
    expect(answer).toBeInstanceOf(PreEncoded);
    expect(answer.body).toBe('{"month":"2026-10"}');
    expect(answer.headers).toEqual({});
    expect(sent).toHaveLength(1);
    const request = sent[0]?.request;
    expect(request?.url).toBe(`${ORIGIN}/api/newsletter/v1/runs?month=2026-10`);
    expect(request?.method).toBe('GET');
    expect(request?.redirect).toBe('manual');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect([...(request?.headers.entries() ?? [])].sort()).toEqual([['accept', 'application/json'], ['cf-access-token', ASSERTION]]);
    expect(outcomes).toEqual(['2xx']);
  });

  it('keeps resource names and custom methods as the transcoder matched them', async () => {
    for (const [path, target] of [
      ['/api/v1/overview', '/api/newsletter/v1/overview'],
      ['/api/v1/runs/00000000-0000-4000-8000-000000002800/modelCalls?page_size=7', '/api/newsletter/v1/runs/00000000-0000-4000-8000-000000002800/modelCalls?page_size=7'],
      ['/api/v1/runs:summarizeModelUsage?day_count=30', '/api/newsletter/v1/runs:summarizeModelUsage?day_count=30'],
      ['/api/v1/editions/e1/rendering', '/api/newsletter/v1/editions/e1/rendering'],
    ] as const) {
      const { result, sent } = exchange(() => json('{}'), `https://news.example.test${path}`);
      await result;
      expect(sent[0]?.request.url).toBe(`${ORIGIN}${target}`);
    }
  });

  it('abandons a read after the deadline', async () => {
    // AbortSignal.timeout runs on the runtime's own timers; the test stands in for it and fires it.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const outcomes: UpstreamOutcome[] = [];
    const result = forward({
      url: new URL('https://news.example.test/api/v1/overview'), assertion: ASSERTION, origin: ORIGIN,
      report: (outcome) => outcomes.push(outcome),
      fetch: (request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { reject(request.signal.reason as Error); });
      }),
    });
    expect(timeout).toHaveBeenCalledWith(UPSTREAM_TIMEOUT_MS);
    deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    const error = await failure(result);
    expect([error.code, error.reason]).toEqual([Code.UNAVAILABLE, 'UNAVAILABLE']);
    expect(outcomes).toEqual(['timeout']);
  });
});

describe('what is answered', () => {
  it('passes a 200 JSON answer through byte for byte, up to the cap', async () => {
    const body = `{"title":"合成 ${'x'.repeat(MAX_ANSWER_BYTES - 40)}"}`;
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const answer = await exchange(() => json(body)).result;
    expect(answer.body).toBe(body);
  });

  it('maps 404 to NOT_FOUND and 400 to BAD_REQUEST, without the body', async () => {
    for (const [status, code, reason] of [[404, Code.NOT_FOUND, 'NOT_FOUND'], [400, Code.INVALID_ARGUMENT, 'BAD_REQUEST']] as const) {
      const { result, outcomes } = exchange(() => new Response(`{"error":"${SECRET}"}`, { status, statusText: SECRET, headers: { 'x-detail': SECRET } }));
      const error = await failure(result);
      expect([error.code, error.reason], String(status)).toEqual([code, reason]);
      expectNoEcho(error);
      expect(outcomes).toEqual(['4xx']);
    }
  });

  it('answers UNAVAILABLE for a redirect, Access refusing, a server error, another type, an oversized or unreadable body', async () => {
    const cases: [string, () => Response, UpstreamOutcome][] = [
      ['redirect to the Access login', () => new Response(null, { status: 302, headers: { location: `https://login.example.test/${SECRET}` } }), '3xx'],
      ['Access refusing', () => new Response(SECRET, { status: 403 }), '4xx'],
      ['unauthorized', () => new Response(SECRET, { status: 401 }), '4xx'],
      ['server error', () => new Response(SECRET, { status: 502 }), '5xx'],
      ['service unavailable', () => json(`{"error":{"message":"${SECRET}"}}`, { status: 503 }), '5xx'],
      ['another 2xx', () => json('{}', { status: 201 }), '2xx'],
      ['an HTML page', () => new Response(`<html>${SECRET}</html>`, { headers: { 'content-type': 'text/html' } }), 'not_json'],
      ['no type', () => new Response('{}'), 'not_json'],
      ['one byte over the cap', () => json('x'.repeat(MAX_ANSWER_BYTES + 1)), 'too_large'],
      ['not UTF-8', () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: { 'content-type': 'application/json' } }), 'not_json'],
    ];
    for (const [name, answer, outcome] of cases) {
      const { result, outcomes } = exchange(answer);
      const error = await failure(result);
      expect([error.code, error.reason], name).toEqual([Code.UNAVAILABLE, 'UNAVAILABLE']);
      expectNoEcho(error);
      expect(outcomes, name).toEqual([outcome]);
    }
  });

  it('stops reading a body that runs past the cap, whatever its Content-Length says', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { result, outcomes } = exchange(() => new Response(endless, { headers: { 'content-type': 'application/json', 'content-length': '2' } }));
    expect((await failure(result)).reason).toBe('UNAVAILABLE');
    expect(outcomes).toEqual(['too_large']);
    expect(pulled).toBeLessThanOrEqual(MAX_ANSWER_BYTES / chunk.byteLength + 2);
  });

  it('answers UNAVAILABLE when the network fails', async () => {
    const outcomes: UpstreamOutcome[] = [];
    const error = await failure(forward({
      url: new URL('https://news.example.test/api/v1/overview'), assertion: ASSERTION, origin: ORIGIN,
      report: (outcome) => outcomes.push(outcome),
      fetch: () => Promise.reject(new TypeError(`connect failed ${SECRET}`)),
    }));
    expect([error.code, error.reason]).toEqual([Code.UNAVAILABLE, 'UNAVAILABLE']);
    expectNoEcho(error);
    expect(outcomes).toEqual(['network']);
  });
});

describe('configuration', () => {
  it('is NOT_CONFIGURED, sending nothing, without an exact https origin or an assertion to forward', async () => {
    for (const [origin, assertion] of [
      [undefined, ASSERTION], ['', ASSERTION], ['http://runtime.example.test', ASSERTION], ['https://runtime.example.test/', ASSERTION],
      ['https://runtime.example.test/api', ASSERTION], ['https://runtime.example.test:8443', ASSERTION],
      ['https://user:pass@runtime.example.test', ASSERTION], ['https://runtime.example.test?x=1', ASSERTION], [ORIGIN, null],
    ] as const) {
      const sent: Request[] = [];
      const outcomes: UpstreamOutcome[] = [];
      const error = await failure(forward({
        url: new URL('https://news.example.test/api/v1/overview'), assertion, origin,
        report: (outcome) => outcomes.push(outcome),
        fetch: (request) => { sent.push(request); return Promise.resolve(json('{}')); },
      }));
      expect([error.code, error.reason], String(origin)).toEqual([Code.UNAVAILABLE, 'NOT_CONFIGURED']);
      expect(sent).toEqual([]);
      expect(outcomes).toEqual(['not_configured']);
    }
    expect(upstreamOrigin(ORIGIN)).toBe(ORIGIN);
  });
});
