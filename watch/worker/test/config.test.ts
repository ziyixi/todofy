import { describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { EmbeddedSource_Kind, Watch_Fetcher, WatchSchema, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { acceptFor, checkHash, readConfig, readHash, settingsWatch, settingsWire, type ConfigEnv } from '../src/config.ts';
import { devFetch } from '../src/env.ts';
import { fetchPage, type FetchFn } from '../src/fetcher.ts';

const env: ConfigEnv = { selectorOk: (selector) => !selector.includes(':has('), browserEnabled: false };
const watch = (init: Parameters<typeof create<typeof WatchSchema>>[1]): Watch => create(WatchSchema, { displayName: 'x', uri: 'https://example.com/a', ...init });

describe('readConfig', () => {
  it('fills the defaults', () => {
    const config = readConfig(watch({}), env);
    expect(config).toMatchObject({
      uri: 'https://example.com/a',
      host: 'example.com',
      source: { kind: 'html', include: [], exclude: [] },
      trigger: { kind: 'any_change', minLines: 1, minPercent: 0 },
      confirmDelayMinutes: 15,
      intervalMinutes: 360,
      fetcher: 'http',
      notify: 'digest',
      locale: 'zh-CN,zh;q=0.9,en;q=0.8',
    });
  });

  it('confirms only HTML sources, and not with skip_confirmation', () => {
    expect(readConfig(watch({ source: { feed: {} } }), env)).toMatchObject({ confirmDelayMinutes: null });
    expect(readConfig(watch({ source: { embedded: { kind: EmbeddedSource_Kind.JSON_LD } } }), env)).toMatchObject({ confirmDelayMinutes: null });
    expect(readConfig(watch({ stability: { skipConfirmation: true } }), env)).toMatchObject({ confirmDelayMinutes: null });
    expect(readConfig(watch({ stability: { confirmDelayMinutes: 30 } }), env)).toMatchObject({ confirmDelayMinutes: 30 });
  });

  it('names the rule a watch breaks', () => {
    expect(readConfig(watch({ source: { html: { includeSelectors: ['div:has(p)'] } } }), env)).toBe('INVALID_SELECTOR');
    expect(readConfig(watch({ source: { embedded: { kind: EmbeddedSource_Kind.NEXT_DATA } } }), env)).toBe('INVALID_SOURCE');
    expect(readConfig(watch({ trigger: { number: { label: 'x' } } }), env)).toBe('INVALID_TRIGGER');
    expect(readConfig(watch({ trigger: { number: { upperThreshold: Number.NaN } } }), env)).toBe('INVALID_TRIGGER');
    expect(readConfig(watch({ fetcher: Watch_Fetcher.BROWSER }), env)).toBe('BROWSER_NOT_AVAILABLE');
    expect(readConfig(watch({ fetcher: Watch_Fetcher.BROWSER, checkIntervalMinutes: 360 }), { ...env, browserEnabled: true })).toMatchObject({ fetcher: 'browser' });
    expect(readConfig(watch({ fetcher: Watch_Fetcher.BROWSER }), { ...env, browserEnabled: true })).toMatchObject({ intervalMinutes: 1440 });
    expect(readConfig(watch({ normalize: { ignoredLines: [''] } }), env)).toBe('BAD_REQUEST');
  });

  it('stores only the owner\'s fields, and the hashes tell what is read from what is decided', async () => {
    const full = watch({ name: 'watches/x', etag: 'e', shadowMode: true, trigger: { textAppears: { text: 'sale' } } });
    expect(Object.keys(settingsWire(full)).sort()).toEqual(['display_name', 'trigger', 'uri']);
    expect(settingsWatch(JSON.stringify(settingsWire(full))).trigger?.textAppears?.text).toBe('sale');
    const a = readConfig(watch({}), env);
    const b = readConfig(watch({ trigger: { textAppears: { text: 'sale' } } }), env);
    const c = readConfig(watch({ requestLocale: 'en' }), env);
    if (typeof a === 'string' || typeof b === 'string' || typeof c === 'string') throw new Error('invalid');
    expect(await readHash(a)).toBe(await readHash(b));
    expect(await checkHash(a)).not.toBe(await checkHash(b));
    expect(await readHash(a)).not.toBe(await readHash(c));
  });

  it('asks for markdown only when no selector needs HTML', () => {
    expect(acceptFor({ kind: 'html', include: [], exclude: [], keepLinks: false, keepLandmarks: false })).toMatch(/^text\/markdown/);
    expect(acceptFor({ kind: 'html', include: ['main'], exclude: [], keepLinks: false, keepLandmarks: false })).toMatch(/^text\/html/);
  });
});

describe('fetchPage', () => {
  const fake = (routes: Record<string, () => Response | Promise<Response>>, seen: Request[] = []): FetchFn => (request) => {
    seen.push(request);
    const route = routes[request.url];
    return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route());
  };
  const page = { accept: 'text/html', locale: 'en', allowHttp: false, conditional: null };

  it('follows redirects by hand, sends validators only on the first request, and caps the body', async () => {
    const seen: Request[] = [];
    const fetchFn = fake({
      'https://a.example.com/': () => new Response(null, { status: 302, headers: { location: '/b' } }),
      'https://a.example.com/b': () => new Response('hello'),
    }, seen);
    const answer = await fetchPage(fetchFn, { ...page, url: 'https://a.example.com/', conditional: { etag: '"x"', lastModified: null } });
    expect(answer).toMatchObject({ kind: 'answer', status: 200, finalUrl: 'https://a.example.com/b', redirects: 1, requests: 2 });
    expect(seen.map((request) => request.headers.get('if-none-match'))).toEqual(['"x"', null]);
    expect(seen.every((request) => request.redirect === 'manual')).toBe(true);
    const large = await fetchPage(fake({ 'https://a.example.com/': () => new Response('x'.repeat(100)) }), { ...page, url: 'https://a.example.com/', maxBytes: 10 });
    expect(large).toMatchObject({ kind: 'failed', failure: 'TOO_LARGE' });
  });

  it('times out with its timer cleared, and reports a network failure', async () => {
    const slow: FetchFn = (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    expect(await fetchPage(slow, { ...page, url: 'https://a.example.com/', timeoutMs: 20 })).toMatchObject({ kind: 'failed', failure: 'TIMEOUT' });
    expect(await fetchPage(() => Promise.reject(new Error('down')), { ...page, url: 'https://a.example.com/' })).toMatchObject({ kind: 'failed', failure: 'NETWORK_ERROR' });
  });
});

describe('devFetch', () => {
  it('only with the dev bypass and a plain-http loopback origin', () => {
    expect(devFetch({ DEV_AUTH_BYPASS: 'true', DEV_FAKE_UPSTREAM: 'http://127.0.0.1:8792' })).not.toBeNull();
    expect(devFetch({ DEV_AUTH_BYPASS: 'false', DEV_FAKE_UPSTREAM: 'http://127.0.0.1:8792' })).toBeNull();
    expect(devFetch({ DEV_AUTH_BYPASS: 'true', DEV_FAKE_UPSTREAM: 'https://127.0.0.1:8792' })).toBeNull();
    expect(devFetch({ DEV_AUTH_BYPASS: 'true', DEV_FAKE_UPSTREAM: 'http://fake.example.com' })).toBeNull();
    expect(devFetch({ DEV_AUTH_BYPASS: 'true' })).toBeNull();
  });
});
