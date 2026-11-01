import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, namespace, objectKey, providerPath, writeMode } from '../src/keys.ts';

describe('namespace authority', () => {
  it('keeps namespace selection on the server and rejects alternate Dropbox path syntaxes', () => {
    expect(providerPath('quant', 'datasets/test/part-01.parquet')).toBe('/namespaces/quant/datasets/test/part-01.parquet');
    for (const key of ['/other/file', '../file', 'a/../file', 'a//file', 'a/./file', 'a\\file', 'id:other', 'ns:other', 'rev:other', 'a/%2e%2e/file', '']) {
      expect(() => objectKey(key), key).toThrow();
    }
    for (const value of ['../quant', 'Quant', '/quant', 'quant/other', '']) expect(() => namespace(value)).toThrow();
  });

  it('permits directory and filename prefixes without admitting traversal', () => {
    expect(objectKey('', true)).toBe('');
    expect(objectKey('datasets/', true)).toBe('datasets/');
    expect(objectKey('datasets/part-', true)).toBe('datasets/part-');
    expect(() => objectKey('../', true)).toThrow();
  });
});

describe('conditional writes', () => {
  const request = (headers: Record<string, string>) => new Request('https://storage.example.test/api/storage/v1/content?key=a', { method: 'PUT', headers });
  it('requires create-only or one exact revision and always rejects blind replacement', () => {
    expect(writeMode(request({ 'if-none-match': '*' }))).toEqual({ '.tag': 'add' });
    expect(writeMode(request({ 'if-match': '"abc123"' }))).toEqual({ '.tag': 'update', update: 'abc123' });
    expect(writeMode(request({ 'if-match': 'abc123' }))).toEqual({ '.tag': 'update', update: 'abc123' });
    for (const headers of [{}, { 'if-match': '*' }, { 'if-match': 'W/"abc"' }, { 'if-match': '"abc", "def"' }, { 'if-none-match': 'abc' }, { 'if-match': 'abc', 'if-none-match': '*' }]) {
      expect(() => writeMode(request(headers))).toThrow();
    }
  });
});

describe('provider cursors', () => {
  it('authenticates the namespace and prefix instead of trusting a caller-supplied provider cursor', async () => {
    const secret = 'a'.repeat(64);
    const claims = { provider: 'synthetic-provider-cursor', namespace: 'quant', prefix: 'datasets/', expires: Date.now() + 60000 };
    const cursor = await encodeCursor(secret, claims);
    expect(await decodeCursor(secret, cursor, 'quant', 'datasets/')).toEqual(claims);
    await expect(decodeCursor(secret, cursor, 'other', 'datasets/')).rejects.toThrow();
    await expect(decodeCursor(secret, cursor, 'quant', 'control/')).rejects.toThrow();
    await expect(decodeCursor('b'.repeat(64), cursor, 'quant', 'datasets/')).rejects.toThrow();
    await expect(decodeCursor(secret, cursor.slice(0, -2) + 'xx', 'quant', 'datasets/')).rejects.toThrow();
  });

  it('accepts only a valid signed page reference, nonnegative offset and unexpired scope', async () => {
    const secret = 'a'.repeat(64);
    const claims = { page: crypto.randomUUID(), offset: 100, namespace: 'quant', prefix: 'datasets/', expires: Date.now() + 60000 };
    const cursor = await encodeCursor(secret, claims);
    expect(await decodeCursor(secret, cursor, 'quant', 'datasets/')).toEqual(claims);
    for (const changed of [{ ...claims, offset: -1 }, { ...claims, offset: 1.5 }, { ...claims, page: 'unknown' }, { ...claims, expires: Date.now() - 1 }]) {
      await expect(decodeCursor(secret, await encodeCursor(secret, changed), 'quant', 'datasets/')).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    }
    await expect(decodeCursor(secret, cursor, 'other', 'datasets/')).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    await expect(decodeCursor(secret, cursor, 'quant', 'control/')).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
  });
});
