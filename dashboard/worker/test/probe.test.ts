import { describe, expect, it } from 'vitest';
import { PROBE_TIMEOUT_MS } from '../src/api-types.ts';
import { mediaType, nextProbeDoc, probeDue, probeUrl, type ProbeTarget } from '../src/probe.ts';
import type { FetchLike } from '../src/usage.ts';

const URL_ = 'https://www.example.com/build-info.json';
const TARGET: ProbeTarget = { url: URL_, expect: [200] };
/** A probe that also asks for the Worker's own media type (FlowDay's manifest, the links app's robots.txt). */
const TYPED: ProbeTarget = { url: 'https://app.example.com/robots.txt', expect: [200], content_type: 'text/plain' };
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
    const result = await probeUrl(TARGET, fetcher, clock(1000, 1180));
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
    expect(await probeUrl(TARGET, redirect, clock(0, 40))).toEqual({ ok: false, http_status: 308, latency_ms: 40, error: 'http_status' });
    const down: FetchLike = () => Promise.resolve(new Response('bad gateway', { status: 502 }));
    expect(await probeUrl(TARGET, down, clock(0, 5))).toMatchObject({ ok: false, http_status: 502, error: 'http_status' });
  });

  it('turns a timeout and a network error into codes without a status', async () => {
    const timeout: FetchLike = () => Promise.reject(new DOMException('timed out', 'TimeoutError'));
    expect(await probeUrl(TARGET, timeout)).toEqual({ ok: false, http_status: null, latency_ms: null, error: 'timeout' });
    const network: FetchLike = () => Promise.reject(new TypeError('connection refused 192.0.2.1'));
    const result = await probeUrl(TARGET, network);
    expect(result).toEqual({ ok: false, http_status: null, latency_ms: null, error: 'network_error' });
    expect(JSON.stringify(result)).not.toContain('refused');
  });

  it('asks for the expected media type and compares the header without parameters or case', async () => {
    const seen: RequestInit[] = [];
    const answer =
      (type: string | null, status = 200): FetchLike =>
      (_url, init) => {
        seen.push(init);
        // Bytes, not a string: a string body would get a text/plain Content-Type of its own.
        const body = new TextEncoder().encode('User-agent: *\nDisallow: /\n');
        return Promise.resolve(new Response(body, { status, headers: type === null ? {} : { 'content-type': type } }));
      };
    expect(await probeUrl(TYPED, answer('Text/Plain; charset=utf-8'), clock(0, 30))).toEqual({ ok: true, http_status: 200, latency_ms: 30, error: null });
    expect(seen[0]?.headers).toEqual({ accept: 'text/plain' });
    // Another app (or an edge error page) answered: right status, wrong type.
    expect(await probeUrl(TYPED, answer('text/html; charset=utf-8'), clock(0, 30))).toEqual({ ok: false, http_status: 200, latency_ms: 30, error: 'content_type' });
    expect(await probeUrl(TYPED, answer(null), clock(0, 30))).toMatchObject({ ok: false, error: 'content_type' });
    // The status is judged first: Access's login redirect is an http_status failure whatever its type.
    expect(await probeUrl(TYPED, answer('text/plain', 302), clock(0, 30))).toMatchObject({ ok: false, http_status: 302, error: 'http_status' });
    // Without content_type any type passes, and the Accept header stays the JSON default.
    expect(await probeUrl(TARGET, answer('text/html'), clock(0, 30))).toMatchObject({ ok: true, error: null });
    expect(seen.at(-1)?.headers).toEqual({ accept: 'application/json' });
  });

  it('reduces a Content-Type header to its media type', () => {
    expect(mediaType('application/manifest+json')).toBe('application/manifest+json');
    expect(mediaType(' TEXT/plain ;charset=UTF-8')).toBe('text/plain');
    expect(mediaType(null)).toBeNull();
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
