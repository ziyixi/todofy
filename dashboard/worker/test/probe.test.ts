import { describe, expect, it } from 'vitest';
import { PROBE_TIMEOUT_MS } from '../src/api-v2-types.ts';
import { nextProbeDoc, probeDue, probeUrl } from '../src/probe.ts';
import type { FetchLike } from '../src/usage.ts';

const URL_ = 'https://www.example.com/build-info.json';
const NOW = Date.parse('2026-09-29T14:30:00Z');

function clock(...times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)] ?? 0;
}

describe('probeUrl', () => {
  it('sends one plain GET without following redirects, and never reads the body', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: FetchLike = (url, init) => {
      seen.push({ url, init });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const result = await probeUrl(URL_, [200], fetcher, clock(1000, 1180));
    expect(result).toEqual({ ok: true, http_status: 200, latency_ms: 180, error: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(URL_);
    expect(seen[0]?.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
    // No credentials, cookies or authorization: only an Accept header.
    expect(Object.keys(seen[0]?.init.headers ?? {})).toEqual(['accept']);
    expect('credentials' in (seen[0]?.init ?? {})).toBe(false);
    expect(cancelled).toBe(true);
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
  });

  it('reports an unexpected status (a redirect included) as http_status', async () => {
    const redirect: FetchLike = () => Promise.resolve(new Response(null, { status: 308, headers: { location: 'https://elsewhere.example.com/' } }));
    expect(await probeUrl(URL_, [200], redirect, clock(0, 40))).toEqual({ ok: false, http_status: 308, latency_ms: 40, error: 'http_status' });
    const down: FetchLike = () => Promise.resolve(new Response('bad gateway', { status: 502 }));
    expect(await probeUrl(URL_, [200], down, clock(0, 5))).toMatchObject({ ok: false, http_status: 502, error: 'http_status' });
  });

  it('turns a timeout and a network error into codes without a status', async () => {
    const timeout: FetchLike = () => Promise.reject(new DOMException('timed out', 'TimeoutError'));
    expect(await probeUrl(URL_, [200], timeout)).toEqual({ ok: false, http_status: null, latency_ms: null, error: 'timeout' });
    const network: FetchLike = () => Promise.reject(new TypeError('connection refused 192.0.2.1'));
    const result = await probeUrl(URL_, [200], network);
    expect(result).toEqual({ ok: false, http_status: null, latency_ms: null, error: 'network_error' });
    expect(JSON.stringify(result)).not.toContain('refused');
  });
});

describe('the probe document', () => {
  it('counts consecutive failures and resets them on success', () => {
    const fail = { ok: false, http_status: 503, latency_ms: 20, error: 'http_status' } as const;
    const first = nextProbeDoc(null, fail, NOW);
    expect(first).toEqual({ checked_at: NOW, ok: false, http_status: 503, latency_ms: 20, error: 'http_status', consecutive_failures: 1 });
    const second = nextProbeDoc(first, fail, NOW + 1_800_000);
    expect(second.consecutive_failures).toBe(2);
    expect(nextProbeDoc(second, { ok: true, http_status: 200, latency_ms: 90, error: null }, NOW + 3_600_000).consecutive_failures).toBe(0);
  });

  it('is due when never run, after 10 minutes, or when it is from a later clock', () => {
    const doc = nextProbeDoc(null, { ok: true, http_status: 200, latency_ms: 1, error: null }, NOW);
    expect(probeDue(null, NOW)).toBe(true);
    expect(probeDue(doc, NOW + 9 * 60_000)).toBe(false);
    expect(probeDue(doc, NOW + 10 * 60_000)).toBe(true);
    expect(probeDue(doc, NOW - 1)).toBe(true);
  });
});
