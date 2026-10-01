/**
 * The shared HTTP cases (testdata/http-cases.json) against the TypeScript transcoder and client, on the
 * fixture service prototest.v1.BookService. A Python transcoder will run the same file. Each encode case
 * also goes back through the transcoder: what the client sends decodes to the message it was given.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { create, type DescMessage, type JsonObject } from '@bufbuild/protobuf';
import { BookService } from '../ts/prototest/v1/prototest_pb.ts';
import { encodeHttpRequest, HttpEncodeError, urlOf } from '../ts/http-client.ts';
import { httpBindings } from '../ts/http-rule.ts';
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '../ts/http-transcoder.ts';
import { parseStatus } from '../ts/rpc-status.ts';
import { fromWire, toWire } from '../ts/wire-json.ts';

interface TranscodeCase {
  readonly name: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query?: string;
    readonly headers?: Record<string, string>;
    readonly json?: unknown;
    readonly body?: string;
    readonly body_base64?: string;
  };
  readonly expect: {
    readonly status: number | null;
    readonly rpc?: string;
    readonly input?: unknown;
    readonly reason?: string;
    readonly allow?: string;
    readonly empty_body?: true;
  };
}

interface EncodeCase {
  readonly name: string;
  readonly rpc: string;
  readonly input: unknown;
  readonly expect: { readonly method?: string; readonly url?: string; readonly body?: unknown; readonly error?: true };
}

const FILE = join(import.meta.dirname, '..', 'testdata', 'http-cases.json');
const cases = JSON.parse(readFileSync(FILE, 'utf8')) as { max_body_bytes: number; transcode: TranscodeCase[]; encode: EncodeCase[] };

/** A transcoder whose handlers record the decoded request and answer an empty response. */
function recorder() {
  const calls: { rpc: string; input: JsonObject }[] = [];
  const handlers = Object.fromEntries(
    BookService.methods.map((method) => [
      method.localName,
      (request: never) => {
        calls.push({ rpc: method.name, input: toWire(method.input, request) });
        return Promise.resolve(create(method.output as DescMessage));
      },
    ]),
  ) as unknown as ServiceHandlers<ShapeOf<typeof BookService>, undefined>;
  const transcoder = new HttpTranscoder(BookService, handlers, { domain: 'prototest.example.com', maxBodyBytes: cases.max_body_bytes, authorize: () => undefined });
  return { transcoder, calls };
}

function requestOf(c: TranscodeCase['request']): Request {
  let body: BodyInit | undefined;
  if (c.json !== undefined) body = JSON.stringify(c.json);
  else if (c.body !== undefined) body = c.body;
  else if (c.body_base64 !== undefined) body = Uint8Array.from(atob(c.body_base64), (char) => char.charCodeAt(0));
  const query = c.query === undefined ? '' : `?${c.query}`;
  return new Request(`https://api.example.com${c.path}${query}`, { method: c.method, ...(c.headers === undefined ? {} : { headers: c.headers }), ...(body === undefined ? {} : { body }) });
}

describe('transcode cases shared with Python', () => {
  test('every case has its own name', () => {
    expect(new Set(cases.transcode.map((c) => c.name)).size).toBe(cases.transcode.length);
    expect(cases.transcode.length).toBeGreaterThanOrEqual(46);
  });

  test.each(cases.transcode.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { transcoder, calls } = recorder();
    const result = await transcoder.handle(requestOf(c.request), undefined, 'req-1');
    if (c.expect.status === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result).not.toBeNull();
    const response = result?.response as Response;
    expect(response.status).toBe(c.expect.status);
    const text = await response.text();
    if (c.expect.empty_body === true) expect(text).toBe('');
    if (c.expect.allow !== undefined) expect(response.headers.get('allow')).toBe(c.expect.allow);
    if (c.expect.rpc !== undefined) {
      expect(calls).toEqual([{ rpc: c.expect.rpc, input: c.expect.input }]);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
    } else {
      expect(calls).toEqual([]);
    }
    if (c.expect.reason !== undefined) {
      const status = parseStatus(response.status, JSON.parse(text));
      expect(status?.reason).toBe(c.expect.reason);
      expect(status?.domain).toBe('prototest.example.com');
      expect(status?.requestId).toBe('req-1');
      // Nothing from the request is echoed: no path, query or body text in the error.
      for (const echoed of [c.request.path.split('/').pop(), c.request.query, c.request.body].filter((v): v is string => v !== undefined && v.length > 3)) {
        expect(text).not.toContain(echoed);
      }
    }
  });
});

describe('encode cases shared with Python', () => {
  const bindings = new Map(httpBindings(BookService).filter((b) => b.primary).map((b) => [b.method.name, b]));

  test('every case has its own name', () => {
    expect(new Set(cases.encode.map((c) => c.name)).size).toBe(cases.encode.length);
  });

  test.each(cases.encode.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const binding = bindings.get(c.rpc);
    if (binding === undefined) throw new Error(`no binding for ${c.rpc}`);
    const message = fromWire(binding.method.input, c.input, { strict: true }).message;
    if (c.expect.error === true) {
      expect(() => encodeHttpRequest(binding, message)).toThrow(HttpEncodeError);
      return;
    }
    const parts = encodeHttpRequest(binding, message);
    expect(parts.httpMethod).toBe(c.expect.method);
    expect(urlOf(parts)).toBe(c.expect.url);
    expect(parts.body ?? null).toEqual(c.expect.body);
    // And back: the transcoder decodes exactly the message the client was given.
    const { transcoder, calls } = recorder();
    const body = parts.body === undefined ? undefined : JSON.stringify(parts.body);
    const result = await transcoder.handle(
      new Request(`https://api.example.com${urlOf(parts)}`, { method: parts.httpMethod, ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }) }),
      undefined,
    );
    expect(result?.response.status).toBe(200);
    expect(calls).toEqual([{ rpc: c.rpc, input: toWire(binding.method.input, message) }]);
  });
});
