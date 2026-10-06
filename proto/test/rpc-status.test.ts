/**
 * google.rpc.Status errors (ts/rpc-status.ts): the hand-written tables against googleapis itself (the
 * version buf.lock pins, built with the pinned buf), the body's shape, and reading bodies a client may get.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { BookSchema, Genre } from '../ts/prototest/v1/prototest_pb.ts';
import { Code, errorDetail, HTTP_STATUS, parseStatus, readDetail, RpcError, statusBody } from '../ts/rpc-status.ts';

const PROTO = join(import.meta.dirname, '..');

interface ImageField {
  name: string;
}
interface ImageFile {
  name: string;
  enumType?: { name: string; value: { name: string; number: number }[] }[];
  messageType?: { name: string; field?: ImageField[] }[];
  sourceCodeInfo?: { location: { path?: number[]; leadingComments?: string }[] };
}

let work: string;
let files: ImageFile[];

beforeAll(() => {
  // A throwaway module that imports the google.rpc files, with this module's buf.lock: the same googleapis.
  work = mkdtempSync(join(tmpdir(), 'rpc-status-'));
  writeFileSync(join(work, 'buf.yaml'), 'version: v2\ndeps:\n  - buf.build/googleapis/googleapis\n');
  copyFileSync(join(PROTO, 'buf.lock'), join(work, 'buf.lock'));
  mkdirSync(join(work, 'fixture', 'v1'), { recursive: true });
  writeFileSync(
    join(work, 'fixture', 'v1', 'fixture.proto'),
    'syntax = "proto3";\npackage fixture.v1;\nimport "google/rpc/code.proto";\nimport "google/rpc/error_details.proto";\nmessage F {\n  google.rpc.Code c = 1;\n  google.rpc.ErrorInfo e = 2;\n}\n',
  );
  const run = spawnSync(process.execPath, [join(PROTO, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf'), 'build', '-o', 'image.json#format=json'], { cwd: work, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`buf build failed: ${run.stderr}`);
  files = (JSON.parse(readFileSync(join(work, 'image.json'), 'utf8')) as { file: ImageFile[] }).file;
}, 120_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('the tables match googleapis', () => {
  test('google.rpc.Code: names, numbers and HTTP mappings', () => {
    const file = files.find((f) => f.name === 'google/rpc/code.proto');
    const values = file?.enumType?.[0]?.value ?? [];
    expect(Object.fromEntries(values.map((v) => [v.name, v.number]))).toEqual(Code);
    const mapping: Record<string, number> = {};
    values.forEach((value, i) => {
      const comment = file?.sourceCodeInfo?.location.find((l) => l.path?.join(',') === `5,0,2,${String(i)}`)?.leadingComments ?? '';
      const match = /HTTP Mapping: (\d{3})/.exec(comment);
      if (match) mapping[value.name] = Number(match[1]);
    });
    expect(mapping).toEqual(HTTP_STATUS);
  });

  test('ErrorInfo, RequestInfo and LocalizedMessage have the field names the bodies use', () => {
    const details = files.find((f) => f.name === 'google/rpc/error_details.proto');
    const fields = (name: string) => details?.messageType?.find((m) => m.name === name)?.field?.map((f) => f.name);
    expect(fields('ErrorInfo')).toEqual(['reason', 'domain', 'metadata']);
    expect(fields('RequestInfo')).toEqual(['request_id', 'serving_data']);
    expect(fields('LocalizedMessage')).toEqual(['locale', 'message']);
  });
});

describe('statusBody', () => {
  test('writes the HTTP status, the code name, ErrorInfo, LocalizedMessage, RequestInfo and typed details', () => {
    const book = create(BookSchema, { title: 'T', genre: Genre.POETRY, copies: { b: 1, a: 2 } });
    const error = new RpcError(Code.ABORTED, 'WATCH_CHANGED', 'the watch changed', { metadata: { z: '1', a: '2' }, details: [errorDetail(BookSchema, book)] });
    const body = statusBody(error, { domain: 'watch.ziyixi.science', requestId: 'r1', localized: { locale: 'zh-CN', message: '已改动' } });
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        error: {
          code: 409,
          message: 'the watch changed',
          status: 'ABORTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'WATCH_CHANGED', domain: 'watch.ziyixi.science', metadata: { a: '2', z: '1' } },
            { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'zh-CN', message: '已改动' },
            { '@type': 'type.googleapis.com/google.rpc.RequestInfo', request_id: 'r1' },
            { '@type': 'type.googleapis.com/prototest.v1.Book', title: 'T', genre: 'poetry', copies: { a: 2, b: 1 } },
          ],
        },
      }),
    );
  });

  test('an explicit HTTP status wins over the mapping (405 for UNIMPLEMENTED)', () => {
    const body = statusBody(new RpcError(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 'no', { httpStatus: 405 }), { domain: 'a.example.com' });
    expect(body['error']).toMatchObject({ code: 405, status: 'UNIMPLEMENTED' });
  });

  test.each(['watch_changed', 'WATCH-CHANGED', '_X', 'X_', 'A'.repeat(64)])('refuses the reason %s (AIP-193)', (reason) => {
    expect(() => new RpcError(Code.ABORTED, reason, 'm')).toThrow(TypeError);
  });

  test('refuses OK and a domain that is not a service name', () => {
    expect(() => new RpcError(Code.OK, 'FINE', 'm')).toThrow(TypeError);
    expect(() => statusBody(new RpcError(Code.ABORTED, 'X1', 'm'), { domain: 'not a domain' })).toThrow(TypeError);
  });
});

describe('parseStatus and readDetail', () => {
  test('read back what statusBody wrote', () => {
    const book = create(BookSchema, { title: 'T' });
    const body = statusBody(new RpcError(Code.NOT_FOUND, 'WATCH_NOT_FOUND', 'gone', { details: [errorDetail(BookSchema, book)] }), {
      domain: 'watch.ziyixi.science',
      requestId: 'r2',
      localized: { locale: 'zh-CN', message: '找不到' },
    });
    const status = parseStatus(404, JSON.parse(JSON.stringify(body)));
    expect(status).toMatchObject({ httpStatus: 404, status: 'NOT_FOUND', message: 'gone', reason: 'WATCH_NOT_FOUND', domain: 'watch.ziyixi.science', requestId: 'r2' });
    expect(status?.localizedMessage).toEqual({ locale: 'zh-CN', message: '找不到' });
    expect(status && readDetail(status, BookSchema)?.title).toBe('T');
  });

  test.each([null, 'text', [], { error: 'x' }, { message: 'no error object' }])('is null for a body that is not a Status: %j', (json) => {
    expect(parseStatus(500, json)).toBeNull();
  });

  test('tolerates odd details: unknown codes, missing fields, wrong types', () => {
    const status = parseStatus(418, { error: { code: 418, status: 'TEAPOT', details: [1, { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 7 }] } });
    expect(status).toMatchObject({ status: undefined, message: '', reason: undefined, metadata: {} });
  });

  test('an unreadable typed detail reads as absent', () => {
    const status = parseStatus(409, { error: { details: [{ '@type': 'type.googleapis.com/prototest.v1.Book', pages: 'many' }] } });
    expect(status && readDetail(status, BookSchema)).toBeUndefined();
  });
});
