import { describe, expect, it, vi } from 'vitest';
import { continuationPath, parseShortPath } from '../src/keys.ts';
import { isLive, readResolvable, resolve, resolveForOwner, type Resolvable } from '../src/resolve.ts';

const NOW = Date.parse('2026-10-01T08:00:00Z');

function link(overrides: Partial<Resolvable> = {}): Resolvable {
  return { target: 'https://example.com/', description: '', path_mode: 'append', visibility: 'private', expire_time: null, delete_time: null, ...overrides };
}

/** A D1 stand-in that records every statement and the method that ran it. */
function recordingDb(answer: Resolvable | null) {
  const calls: string[] = [];
  const statement = (sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: () => {
        calls.push(`first ${sql} ${JSON.stringify(values)}`);
        return Promise.resolve(answer);
      },
      run: () => calls.push(`run ${sql}`),
      all: () => calls.push(`all ${sql}`),
    }),
  });
  const db = { prepare: (sql: string) => statement(sql), batch: () => calls.push('batch'), exec: () => calls.push('exec') };
  return { db: db as unknown as D1Database, calls };
}

describe('the redirect read', () => {
  it('is one SELECT by primary key, read with first(): no write of any kind', async () => {
    const { db, calls } = recordingDb(link());
    await readResolvable(db, 'gh');
    expect(calls).toEqual(['first SELECT target, path_mode, visibility, description, expire_time, delete_time FROM links WHERE key = ? ["gh"]']);
  });
});

describe('resolve', () => {
  const path = (text: string) => {
    const parsed = parseShortPath(text);
    if (parsed === null) throw new Error(text);
    return parsed;
  };

  it('redirects anyone to a live public link without asking who they are', async () => {
    const owner = vi.fn(() => Promise.resolve(false));
    expect(await resolve(path('/gh/a'), link({ visibility: 'public' }), NOW, owner)).toEqual({ kind: 'redirect', location: 'https://example.com/a' });
    expect(owner).not.toHaveBeenCalled();
  });

  it('gives an anonymous request the same answer for a private, unknown, deleted or expired key', async () => {
    const anonymous = () => Promise.resolve(false);
    const expected = { kind: 'redirect', location: '/_/k/gh+/a%20b' };
    for (const row of [link(), null, link({ delete_time: NOW - 1 }), link({ visibility: 'public', expire_time: NOW }), link({ visibility: 'public', delete_time: NOW - 1 })]) {
      expect(await resolve(path('/gh+/a%20b'), row, NOW, anonymous)).toEqual(expected);
    }
    expect(continuationPath(path('/GH+/a%20b'))).toBe(expected.location);
  });

  it('redirects the owner to a live private link, and to the continuation for anything else', async () => {
    const owner = () => Promise.resolve(true);
    expect(await resolve(path('/gh'), link(), NOW, owner)).toEqual({ kind: 'redirect', location: 'https://example.com/' });
    expect(await resolve(path('/gh'), null, NOW, owner)).toEqual({ kind: 'redirect', location: '/_/k/gh' });
    expect(await resolve(path('/gh'), link({ expire_time: NOW - 1 }), NOW, owner)).toEqual({ kind: 'redirect', location: '/_/k/gh' });
  });

  it('previews instead of redirecting, and refuses a path the link cannot take', async () => {
    const owner = () => Promise.resolve(true);
    const row = link({ path_mode: 'exact' });
    expect(await resolve(path('/gh+'), row, NOW, owner)).toEqual({ kind: 'preview', key: 'gh', row, url: 'https://example.com/' });
    expect(await resolve(path('/gh+/x'), row, NOW, owner)).toEqual({ kind: 'preview', key: 'gh', row, url: null });
    expect(await resolve(path('/gh/x'), row, NOW, owner)).toEqual({ kind: 'refused', problem: 'NO_PATH' });
    expect(await resolve(path('/gh/a%2Fb'), link(), NOW, owner)).toEqual({ kind: 'refused', problem: 'BAD_PATH' });
  });

  it('the owner continuation answers only a live link', () => {
    expect(resolveForOwner(path('/gh/x'), link(), NOW)).toEqual({ kind: 'redirect', location: 'https://example.com/x' });
    expect(resolveForOwner(path('/gh'), null, NOW)).toBeNull();
    expect(resolveForOwner(path('/gh'), link({ delete_time: 1 }), NOW)).toBeNull();
    expect(isLive(link({ expire_time: NOW + 1 }), NOW)).toBe(true);
    expect(isLive(link({ expire_time: NOW }), NOW)).toBe(false);
  });
});
