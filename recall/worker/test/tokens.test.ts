// The machine tokens (src/tokens.ts, src/machine.ts) in Node: a new token's shape (the extension's parser and the
// scrubber know it), only its digest kept, the grace of a replaced token and its revocation, and the Worker's check:
// Worker-secret digests first, RecallState's kept for a minute, a refused bearer asking again at most every 10 s.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { DAY, HOUR, MINUTE, SECOND } from '../src/limits.ts';
import { checkBearer, forgetHeldDigests } from '../src/machine.ts';
import { deleteToken, heldDigests, newToken, pruneTokens, secretDigests, storeToken, tokenDigest, tokenMessage, tokenRoute, type RouteDigests } from '../src/tokens.ts';
import { memoryStore } from './sqlite.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const T0 = Date.parse('2026-10-10T02:10:00Z');

describe('tokens', () => {
  it("makes tokens in the extension's shape, and digests them as the Worker compares them", async () => {
    const token = newToken('ingest');
    expect(token).toMatch(/^recall_ingest_[A-Za-z0-9_-]{43}$/);
    expect(newToken('export')).toMatch(/^recall_export_[A-Za-z0-9_-]{43}$/);
    expect(newToken('ingest')).not.toBe(token);
    expect(await tokenDigest(token)).toBe(digest(token));
    expect(tokenRoute('machineTokens/ingest')).toBe('ingest');
    expect(tokenRoute('machineTokens/other')).toBeNull();
  });

  it('keeps only the digest; a regeneration keeps the old one 24 hours, a revocation not at all', () => {
    const store = memoryStore();
    storeToken(store, 'ingest', 'a'.repeat(64), T0, false);
    expect(store.getMeta('token_ingest')).toBe(JSON.stringify({ digest: 'a'.repeat(64), created_ms: T0, previous: null, previous_until_ms: null }));
    storeToken(store, 'ingest', 'b'.repeat(64), T0 + HOUR, false);
    expect(heldDigests(store, T0 + HOUR)).toEqual({ ingest: ['b'.repeat(64), 'a'.repeat(64)], export: [] });
    expect(tokenMessage(store, 'ingest', T0 + HOUR, false)).toMatchObject({ name: 'machineTokens/ingest', token: '', previousExpireTime: { seconds: BigInt((T0 + HOUR + DAY) / 1000) } });
    expect(heldDigests(store, T0 + HOUR + DAY)).toEqual({ ingest: ['b'.repeat(64)], export: [] });
    pruneTokens(store, T0 + HOUR + DAY);
    expect(store.getMeta('token_ingest')).not.toContain('a'.repeat(64));
    storeToken(store, 'ingest', 'c'.repeat(64), T0 + 2 * HOUR, false);
    storeToken(store, 'ingest', 'd'.repeat(64), T0 + 3 * HOUR, true);
    expect(heldDigests(store, T0 + 3 * HOUR)).toEqual({ ingest: ['d'.repeat(64)], export: [] });
    expect(deleteToken(store, 'ingest')).toBe(true);
    expect(deleteToken(store, 'ingest')).toBe(false);
    expect(heldDigests(store, T0)).toEqual({ ingest: [], export: [] });
  });

  it('reads the Worker-secret digests of a route, lower-case hex only', () => {
    expect(secretDigests({ INGEST_TOKEN_SHA256: ` ${'A'.repeat(64)} `, INGEST_TOKEN_SHA256_PREVIOUS: 'not-a-digest', EXPORT_TOKEN_SHA256: 'e'.repeat(64) }, 'ingest')).toEqual(['a'.repeat(64)]);
    expect(secretDigests({}, 'export')).toEqual([]);
  });
});

describe("the Worker's check", () => {
  afterEach(() => {
    vi.useRealTimers();
    forgetHeldDigests();
  });

  function worker(held: () => RouteDigests, secrets: Partial<Env> = {}): { env: Env; calls: () => number } {
    let calls = 0;
    const stub = {
      machineDigests: () => {
        calls += 1;
        return Promise.resolve(held());
      },
    };
    const env = { RECALL: { idFromName: () => 'id', get: () => stub }, ...secrets } as unknown as Env;
    return { env, calls: () => calls };
  }
  const request = (token: string | null) => new Request('https://recall.example.com/api/machine/v1/changes', { headers: token === null ? {} : { authorization: `Bearer ${token}` } });

  it("accepts a Worker secret's token without asking RecallState", async () => {
    const { env, calls } = worker(() => ({ ingest: [], export: [] }), { EXPORT_TOKEN_SHA256: digest('recall_export_secret') });
    expect(await checkBearer(request('recall_export_secret'), env, 'export')).toBe('ok');
    expect(calls()).toBe(0);
    expect(await checkBearer(request('recall_export_other'), env, 'export')).toBe('refused');
  });

  it("keeps RecallState's digests a minute, and asks again for a refused bearer once they are 10 seconds old", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let digests: RouteDigests = { ingest: [digest('recall_ingest_old')], export: [] };
    const { env, calls } = worker(() => digests);
    expect(await checkBearer(request('recall_ingest_old'), env, 'ingest')).toBe('ok');
    expect(await checkBearer(request('recall_ingest_old'), env, 'ingest')).toBe('ok');
    expect(calls()).toBe(1);
    // A new token (the old one revoked): refused at once from memory, accepted once the kept digests are 10 s old.
    digests = { ingest: [digest('recall_ingest_new')], export: [] };
    expect(await checkBearer(request('recall_ingest_new'), env, 'ingest')).toBe('refused');
    expect(calls()).toBe(1);
    vi.setSystemTime(T0 + 10 * SECOND);
    expect(await checkBearer(request('recall_ingest_new'), env, 'ingest')).toBe('ok');
    expect(calls()).toBe(2);
    // A flood of wrong tokens asks RecallState at most once per 10 seconds.
    for (let i = 0; i < 50; i++) expect(await checkBearer(request(`recall_ingest_wrong${String(i)}`), env, 'ingest')).toBe('refused');
    expect(calls()).toBe(2);
    // The revoked token works at most a minute in an isolate that kept it.
    vi.setSystemTime(T0 + 10 * SECOND + MINUTE);
    expect(await checkBearer(request('recall_ingest_old'), env, 'ingest')).toBe('refused');
  });

  it('answers none (503) when no digest exists anywhere, also without a bearer', async () => {
    const { env } = worker(() => ({ ingest: [], export: [] }));
    expect(await checkBearer(request(null), env, 'export')).toBe('none');
    expect(await checkBearer(request('recall_export_x'), env, 'export')).toBe('none');
  });
});
