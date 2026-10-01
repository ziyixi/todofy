/**
 * The transcoder beyond the shared cases (ts/http-transcoder.ts): the app's hooks (authorize before the body,
 * localize, onUnexpected), streamed bodies over the limit, typed error details, and the bindings refused
 * when the routes are built (descriptors made in the test). And the cold cost of building the routes.
 */
import { describe, expect, test, vi } from 'vitest';
import { create, createFileRegistry, setExtension, type DescService, type MessageInitShape } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema, MethodOptionsSchema, type FileDescriptorProto } from '@bufbuild/protobuf/wkt';
import { CommonReasonSchema } from '../ts/common/errors/v1/errors_pb.ts';
import { file_google_api_annotations, http } from '../ts/google/api/annotations_pb.ts';
import { HttpRuleSchema } from '../ts/google/api/http_pb.ts';

type Rule = MessageInitShape<typeof HttpRuleSchema>;
import { BookSchema, BookService, type ArchiveBookRequest } from '../ts/prototest/v1/prototest_pb.ts';
import { HttpRuleError } from '../ts/http-rule.ts';
import { HttpTranscoder, TRANSCODER_REASONS, type ServiceHandlers, type ShapeOf } from '../ts/http-transcoder.ts';
import { Code, errorDetail, parseStatus, readDetail, RpcError } from '../ts/rpc-status.ts';

type Handlers = ServiceHandlers<ShapeOf<typeof BookService>, { readonly user: string }>;

function handlers(overrides: Partial<Handlers> = {}): Handlers {
  const empty = Object.fromEntries(BookService.methods.map((m) => [m.localName, () => Promise.resolve(create(m.output))])) as unknown as Handlers;
  return { ...empty, ...overrides };
}

const ARCHIVE = 'https://api.example.com/v1/shelves/s1/books/b1:archive';
const UUID = '0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a';

function post(body: BodyInit, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  return new Request(ARCHIVE, { method: 'POST', headers, body });
}

describe('the app hooks', () => {
  test('authorize sees the route before the body is read, and can refuse', async () => {
    let bodyUsed: boolean | undefined;
    const authorize = vi.fn((request: Request, route: { safe: boolean; template: string }) => {
      bodyUsed = request.bodyUsed;
      if (!route.safe) throw new RpcError(Code.PERMISSION_DENIED, 'CSRF_FAILED', 'csrf');
    });
    const api = new HttpTranscoder(BookService, handlers(), { domain: 'a.example.com', maxBodyBytes: 1024, authorize });
    const result = await api.handle(post(JSON.stringify({ request_id: UUID })), { user: 'u' });
    expect(bodyUsed).toBe(false);
    expect(authorize.mock.calls[0]?.[1]).toMatchObject({ httpMethod: 'POST', template: '/v1/{name=shelves/*/books/*}:archive', safe: false });
    expect(result?.response.status).toBe(403);
    expect(result?.error?.reason).toBe('CSRF_FAILED');
    expect((await api.handle(new Request('https://api.example.com/v1/shelves/s1/books/b1'), { user: 'u' }))?.response.status).toBe(200);
  });

  test('a handler gets the context and its RpcError reaches the body with localized text and typed details', async () => {
    const archiveBook = (request: ArchiveBookRequest, context: { user: string }) => {
      expect(context.user).toBe('u');
      expect(request.requestId).toBe(UUID);
      return Promise.reject(new RpcError(Code.ABORTED, 'DECK_CHANGED', 'changed', { details: [errorDetail(BookSchema, create(BookSchema, { title: 'now' }))] }));
    };
    const api = new HttpTranscoder(BookService, handlers({ archiveBook }), {
      domain: 'a.example.com',
      maxBodyBytes: 1024,
      authorize: () => undefined,
      localize: (reason) => (reason === 'DECK_CHANGED' ? { locale: 'zh-CN', message: '已改动' } : undefined),
    });
    const result = await api.handle(post(JSON.stringify({ request_id: UUID.toUpperCase() })), { user: 'u' }, 'r9');
    expect(result?.response.status).toBe(409);
    const status = parseStatus(409, await result?.response.json());
    expect(status).toMatchObject({ reason: 'DECK_CHANGED', requestId: 'r9', localizedMessage: { locale: 'zh-CN', message: '已改动' } });
    expect(status && readDetail(status, BookSchema)?.title).toBe('now');
  });

  test('anything else thrown goes through onUnexpected, without its message', async () => {
    const getBook = () => Promise.reject(new Error('D1 exploded with secret details'));
    const plain = new HttpTranscoder(BookService, handlers({ getBook }), { domain: 'a.example.com', maxBodyBytes: 1024, authorize: () => undefined });
    const first = await plain.handle(new Request('https://api.example.com/v1/shelves/s1/books/b1'), { user: 'u' });
    expect(first?.response.status).toBe(500);
    expect(first?.error?.reason).toBe('INTERNAL');
    expect(first?.error?.code).toBe(Code.INTERNAL);
    expect(await first?.response.text()).not.toContain('secret');
    const mapped = new HttpTranscoder(BookService, handlers({ getBook }), {
      domain: 'a.example.com',
      maxBodyBytes: 1024,
      authorize: () => undefined,
      onUnexpected: () => new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'try again'),
    });
    expect((await mapped.handle(new Request('https://api.example.com/v1/shelves/s1/books/b1'), { user: 'u' }))?.error?.reason).toBe('UNAVAILABLE');
  });
});

describe('reasons', () => {
  test("the transcoder's own reasons are values of common.errors.v1.CommonReason", () => {
    const common = new Set(CommonReasonSchema.values.map((value) => value.name.slice('COMMON_REASON_'.length)));
    for (const reason of Object.values(TRANSCODER_REASONS)) expect(common).toContain(reason);
  });

  test('an answer the wire profile refuses to write is INTERNAL, not a retryable reason', async () => {
    const getBook = () => Promise.resolve(create(BookSchema, { pages: 2 ** 31 }));
    const api = new HttpTranscoder(BookService, handlers({ getBook }), { domain: 'a.example.com', maxBodyBytes: 1024, authorize: () => undefined });
    const result = await api.handle(new Request('https://api.example.com/v1/shelves/s1/books/b1'), { user: 'u' });
    expect(result?.response.status).toBe(500);
    expect(result?.error?.reason).toBe('INTERNAL');
  });
});

describe('bodies', () => {
  const api = new HttpTranscoder(BookService, handlers(), { domain: 'a.example.com', maxBodyBytes: 64, authorize: () => undefined });

  test('a streamed body over the limit is refused without a content-length', async () => {
    const chunks = [new TextEncoder().encode('{"request_id": "'), new TextEncoder().encode('x'.repeat(100)), new TextEncoder().encode('"}')];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request(ARCHIVE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const result = await api.handle(request, { user: 'u' });
    expect(result?.response.status).toBe(400);
  });

  test('a declared content-length over the limit is refused before reading', async () => {
    const request = new Request(ARCHIVE, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '100000' }, body: '{}' });
    expect((await api.handle(request, { user: 'u' }))?.response.status).toBe(400);
  });

  test('a HEAD error has no body', async () => {
    const result = await api.handle(new Request('https://api.example.com/v1/shelves/s1/books/b1?nope=1', { method: 'HEAD' }), { user: 'u' });
    expect(result?.response.status).toBe(400);
    expect(await result?.response.text()).toBe('');
  });
});

/** A one-rpc service whose only binding is `rule`, built in memory. */
function serviceWith(rule: Rule, field: { name: string; type: 'string' | 'message' } = { name: 'name', type: 'string' }): DescService {
  const options = create(MethodOptionsSchema);
  setExtension(options, http, create(HttpRuleSchema, rule));
  const file: FileDescriptorProto = create(FileDescriptorProtoSchema, {
    name: 'fixture/v1/fixture.proto',
    package: 'fixture.v1',
    syntax: 'proto3',
    dependency: ['google/api/annotations.proto'],
    messageType: [
      { name: 'Inner', field: [{ name: 'name', number: 1, type: 9, label: 1, jsonName: 'name' }] },
      {
        name: 'Request',
        field: [
          field.type === 'string'
            ? { name: field.name, number: 1, type: 9, label: 1, jsonName: field.name }
            : { name: field.name, number: 1, type: 11, label: 1, typeName: '.fixture.v1.Inner', jsonName: field.name },
          { name: 'count', number: 2, type: 5, label: 1, jsonName: 'count' },
        ],
      },
    ],
    service: [{ name: 'FixtureService', method: [{ name: 'Call', inputType: '.fixture.v1.Request', outputType: '.fixture.v1.Request', options }] }],
  });
  const registry = createFileRegistry(file, (name) => (name === 'google/api/annotations.proto' ? file_google_api_annotations : undefined));
  const service = registry.getService('fixture.v1.FixtureService');
  if (service === undefined) throw new Error('no service');
  return service;
}

function build(service: DescService): () => unknown {
  return () => new HttpTranscoder(service as never, { call: () => Promise.resolve(undefined as never) } as never, { domain: 'a.example.com', maxBodyBytes: 64, authorize: () => undefined }).routes();
}

describe('bindings refused when the routes are built', () => {
  test('a supported binding builds', () => {
    expect(build(serviceWith({ pattern: { case: 'post', value: '/v1/{name=things/*}:call' }, body: '*' }))()).toHaveLength(1);
  });

  test.each<[string, Rule, { name: string; type: 'string' | 'message' }?]>([
    ['a custom pattern', { pattern: { case: 'custom', value: { kind: 'HEAD', path: '/v1/x' } } }],
    ['a response_body', { pattern: { case: 'get', value: '/v1/{name=x/*}' }, responseBody: 'name' }],
    ['a body on GET', { pattern: { case: 'get', value: '/v1/{name=x/*}' }, body: '*' }],
    ['a body on DELETE', { pattern: { case: 'delete', value: '/v1/{name=x/*}' }, body: '*' }],
    ['a scalar body field', { pattern: { case: 'post', value: '/v1/x' }, body: 'count' }],
    ['an unknown body field', { pattern: { case: 'post', value: '/v1/x' }, body: 'nope' }],
    ['a path variable naming no field', { pattern: { case: 'get', value: '/v1/{nope}' } }],
    ['a path variable on a message field', { pattern: { case: 'get', value: '/v1/{inner}' } }, { name: 'inner', type: 'message' }],
    ['a bad template', { pattern: { case: 'get', value: 'v1/x' } }],
    [
      'nested additional bindings',
      { pattern: { case: 'get', value: '/v1/a' }, additionalBindings: [create(HttpRuleSchema, { pattern: { case: 'get', value: '/v1/b' }, additionalBindings: [create(HttpRuleSchema, { pattern: { case: 'get', value: '/v1/c' } })] })] },
    ],
  ])('refuses %s', (_name, rule, field) => {
    expect(build(serviceWith(rule, field))).toThrow(HttpRuleError);
  });

  test('refuses two bindings of one method that match the same paths, and a missing handler', () => {
    const twice = serviceWith({ pattern: { case: 'get', value: '/v1/{name=x/*}' }, additionalBindings: [create(HttpRuleSchema, { pattern: { case: 'get', value: '/v1/x/{count}' } })] });
    expect(build(twice)).toThrow(TypeError);
    expect(() => new HttpTranscoder(BookService, {} as never, { domain: 'a.example.com', maxBodyBytes: 64, authorize: () => undefined })).toThrow(TypeError);
  });
});

describe('cold cost', () => {
  test('the constructor reads the descriptors once; requests reuse the table', () => {
    const start = performance.now();
    const api = new HttpTranscoder(BookService, handlers(), { domain: 'a.example.com', maxBodyBytes: 64, authorize: () => undefined });
    const built = performance.now() - start;
    const routes = api.routes();
    expect(api.routes()).toBe(routes);
    // Printed for proto/README.md; the bound only catches a pathological regression on a slow runner.
    console.log(`routes of ${BookService.typeName} (${String(routes.length)} bindings): ${built.toFixed(2)} ms`);
    expect(built).toBeLessThan(50);
  });
});
