/**
 * The pure rules of the pipeline and the etiquette: diff, robots.txt, scheduling, the URL policy, JSONPath, feeds,
 * structured data, markdown, numbers, charsets, the health gate and snapshots. No workerd (HTMLRewriter is covered by
 * the runtime suite).
 */
import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/diff.ts';
import { backoffMs, confirmAt, earliestFetch, jitterFactor, nextCheckAt, nextUtcMidnight, retryAfterMs, utcDay } from '../src/etiquette.ts';
import { detectCharset, decodeBody, headerCharset, mediaType, sniffCharset } from '../src/extract/charset.ts';
import { decodeEntities } from '../src/extract/entities.ts';
import { parseFeed } from '../src/extract/feed.ts';
import { canonicalJson, evaluatePath, parsePath, valueKey } from '../src/extract/jsonpath.ts';
import { markdownLines } from '../src/extract/markdown.ts';
import { findNumber, parseNumber } from '../src/extract/number.ts';
import { jsonValues, readJsonLd } from '../src/extract/structured.ts';
import { contentTypeFits, isChallenge, isMojibake, isTooShort, statusFailure } from '../src/health.ts';
import { DAY, HOUR, MINUTE } from '../src/limits.ts';
import { parseRobots, robotsAllows, robotsFromAnswer } from '../src/robots.ts';
import { decodeSnapshot, encodeSnapshot, gzip } from '../src/snapshot.ts';
import { checkRedirect, checkUri } from '../src/url-policy.ts';

const T = Date.parse('2026-10-01T10:00:00Z');

describe('diffLines', () => {
  it('finds the edit script around a common prefix and suffix', () => {
    const result = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect(result.removed).toEqual(['b']);
    expect(result.added).toEqual(['x', 'e']);
    expect(result.approximate).toBe(false);
    expect(result.ops.map((op) => `${op.kind[0] ?? ''}${op.text}`)).toEqual(['rb', 'ax', 'ae']);
  });

  it('falls back to the multiset difference beyond the edit limit, with the same counts', () => {
    const before = Array.from({ length: 50 }, (_, i) => `old ${String(i)}`);
    const after = Array.from({ length: 50 }, (_, i) => `new ${String(i)}`);
    const result = diffLines(before, after, 10);
    expect(result.approximate).toBe(true);
    expect([result.added.length, result.removed.length]).toEqual([50, 50]);
  });

  it('counts repeated lines as often as they occur', () => {
    expect(diffLines(['x', 'x'], ['x']).removed).toEqual(['x']);
  });
});

describe('robots.txt', () => {
  const text = 'User-agent: *\nDisallow: /\n\nUser-agent: ziyixi-watch/1.0\nUser-agent: other\nDisallow: /private\nAllow: /private/ok$\nDisallow: /*.pdf$\n';

  it('applies the group naming this agent over `*`; the longest rule wins; allow wins a tie', () => {
    const verdict = parseRobots(text);
    expect(robotsAllows(verdict, '/')).toBe(true);
    expect(robotsAllows(verdict, '/private/x')).toBe(false);
    expect(robotsAllows(verdict, '/private/ok')).toBe(true);
    expect(robotsAllows(verdict, '/private/ok/more')).toBe(false);
    expect(robotsAllows(verdict, '/files/a.pdf')).toBe(false);
    expect(robotsAllows(verdict, '/files/a.pdf?x')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n'), '/a')).toBe(true);
  });

  it('reads the `*` group when no group names this agent, and allows everything without rules', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /x\n'), '/x/y')).toBe(false);
    expect(parseRobots('User-agent: ziyixi-watch\nDisallow:\n')).toEqual({ kind: 'allow_all' });
    expect(parseRobots('')).toEqual({ kind: 'allow_all' });
  });

  it('reads 4xx as allow-all, 5xx and no answer as disallow-all', () => {
    expect(robotsFromAnswer(404, null)).toEqual({ kind: 'allow_all' });
    expect(robotsFromAnswer(503, null)).toEqual({ kind: 'disallow_all' });
    expect(robotsFromAnswer(0, null)).toEqual({ kind: 'disallow_all' });
  });
});

describe('scheduling', () => {
  it('jitter is within ±10 % and deterministic per watch and slot', () => {
    for (const id of ['a', 'kettle', 'w123456789']) {
      const factor = jitterFactor(id, 7);
      expect(factor).toBeGreaterThanOrEqual(0.9);
      expect(factor).toBeLessThanOrEqual(1.1);
      expect(jitterFactor(id, 7)).toBe(factor);
    }
    expect(new Set(['a', 'b', 'c', 'd', 'e'].map((id) => jitterFactor(id, 1))).size).toBe(5);
  });

  it('the next check is the interval moved by the jitter, never sooner than 15 minutes after the last fetch', () => {
    const next = nextCheckAt('w', T, 360, T);
    expect(next - T).toBeGreaterThanOrEqual(0.9 * 360 * MINUTE);
    expect(next - T).toBeLessThanOrEqual(1.1 * 360 * MINUTE);
    expect(nextCheckAt('w', T, 60, T + 50 * MINUTE)).toBe(T + 65 * MINUTE);
    const confirm = confirmAt('w', T, 15);
    expect(confirm - T).toBeGreaterThanOrEqual(15 * MINUTE);
    expect(confirm - T).toBeLessThanOrEqual(16.5 * MINUTE);
  });

  it('the earliest fetch waits for the host spacing, its backoff and the page\'s 15 minutes', () => {
    expect(earliestFetch(T, null, null)).toBe(T);
    expect(earliestFetch(T, { next_at: T + 10_000, backoff_until: null }, null)).toBe(T + 10_000);
    expect(earliestFetch(T, { next_at: 0, backoff_until: T + HOUR }, null)).toBe(T + HOUR);
    expect(earliestFetch(T, null, T - 5 * MINUTE)).toBe(T + 10 * MINUTE);
  });

  it('reads Retry-After as seconds or a date, capped at 7 days; backs off 15 minutes doubling to a day', () => {
    expect(retryAfterMs('120', T)).toBe(120_000);
    expect(retryAfterMs(new Date(T + HOUR).toUTCString(), T)).toBe(HOUR);
    expect(retryAfterMs('99999999', T)).toBe(7 * DAY);
    expect(retryAfterMs('soon', T)).toBeNull();
    expect(retryAfterMs(null, T)).toBeNull();
    expect([0, 1, 2, 10].map(backoffMs)).toEqual([15 * MINUTE, 30 * MINUTE, HOUR, DAY]);
  });

  it('days are UTC', () => {
    expect(nextUtcMidnight(T)).toBe(Date.parse('2026-10-02T00:00:00Z'));
    expect(utcDay(Date.parse('2026-10-01T23:59:59Z'))).toBe('2026-10-01');
  });
});

describe('the URL policy', () => {
  it.each([
    ['https://example.com/a#frag', 'https://example.com/a'],
    ['https://Shop.Example.com/', 'https://shop.example.com/'],
  ])('accepts %s', (input, href) => {
    expect(checkUri(input, { allowHttp: false })?.href).toBe(href);
  });

  it.each([
    'http://example.com/',
    'ftp://example.com/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://localhost/',
    'https://printer.local/',
    'https://router.home.arpa/',
    'https://ziyixi.science/',
    'https://home.ziyixi.science/',
    'https://cloudflare-579.workers.dev/',
    'https://ziyixi-notion-publish.cloudflare-579.workers.dev/health',
    'https://user@example.com/',
    'https://example.com:8443/',
    'https://intranet/',
    'https://example.com/a b',
    'https://example.com/\u0000',
    `https://example.com/${'a'.repeat(2050)}`,
  ])('refuses %s', (input) => {
    expect(checkUri(input, { allowHttp: false })).toBeNull();
  });

  it('allows http only with the watch\'s allowance, and checks every redirect like a saved URI', () => {
    expect(checkUri('http://example.com/', { allowHttp: true })?.href).toBe('http://example.com/');
    const from = new URL('https://example.com/a/b');
    expect(checkRedirect('../c', from, { allowHttp: false })?.href).toBe('https://example.com/c');
    expect(checkRedirect('http://example.com/', from, { allowHttp: false })).toBeNull();
    expect(checkRedirect('https://10.0.0.1/', from, { allowHttp: false })).toBeNull();
    // A hostile page's redirect never reaches the owner's own Workers either.
    expect(checkRedirect('https://ziyixi-notion-publish.cloudflare-579.workers.dev/health', from, { allowHttp: false })).toBeNull();
    // Another account's workers.dev site is an ordinary public site.
    expect(checkRedirect('https://someone.other-account.workers.dev/', from, { allowHttp: false })?.href).toBe('https://someone.other-account.workers.dev/');
  });
});

describe('JSONPath and structured data', () => {
  it('parses the subset and refuses the rest', () => {
    expect(parsePath('$.a[0].b')).toEqual([{ kind: 'name', name: 'a' }, { kind: 'index', index: 0 }, { kind: 'name', name: 'b' }]);
    expect(parsePath("$['a b'][*]")).toEqual([{ kind: 'name', name: 'a b' }, { kind: 'all' }]);
    for (const path of ['$..a', '$.a[?(@.b)]', '$.a[0:2]', 'a.b', '$.a[-1]']) expect(parsePath(path), path).toBeNull();
  });

  it('evaluates paths, spreads a single array, keys objects by id or url, and writes canonical JSON', () => {
    const document = { items: [{ id: 2, name: 'b' }, { url: 'https://x.example/1', name: 'a' }] };
    expect(evaluatePath(document, parsePath('$.items[*].name') ?? [])).toEqual(['b', 'a']);
    const values = jsonValues(document, '$.items');
    expect(values?.items.map((item) => item.key)).toEqual(['id:2', 'url:https://x.example/1']);
    expect(canonicalJson({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
    expect(valueKey('plain')).toBe('plain');
  });

  it('reads JSON-LD products and offers with their availability, @graph and arrays included', () => {
    const blocks = [
      JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'Product', name: 'Kettle', offers: { '@type': 'Offer', price: 199, priceCurrency: 'CNY', availability: 'https://schema.org/OutOfStock' } }] }),
      '<!-- not json -->',
    ];
    const result = readJsonLd(blocks, '');
    expect(result?.lines).toEqual(['Kettle — 199 CNY — OutOfStock']);
    expect(result?.availability).toBe('OutOfStock');
    expect(readJsonLd(blocks, '$..x')).toBeNull();
    expect(readJsonLd(['{"@type":"Product","name":"A","offers":[{"price":"1","availability":"InStock"},{"price":"2"}]}'], '')?.lines).toEqual(['A — 1 — InStock', 'A — 2']);
  });
});

describe('feeds', () => {
  it('reads RSS (CDATA, entities, escaped HTML summaries), Atom and JSON Feed, keyed by guid, id or link', () => {
    const rss = parseFeed('<rss><channel><item><title><![CDATA[A &amp; B]]></title><link>https://n.example/1</link><guid>g1</guid><description>&lt;p&gt;Hi&lt;/p&gt;</description></item></channel></rss>', true);
    expect(rss).toEqual({ ok: true, items: [{ key: 'g1', text: 'A & B — https://n.example/1 — Hi' }] });
    const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:1</id><title>T</title><link rel="alternate" href="https://a.example/1"/></entry></feed>', false);
    expect(atom).toEqual({ ok: true, items: [{ key: 'tag:1', text: 'T — https://a.example/1' }] });
    const json = parseFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ url: 'https://j.example/1', title: 'J' }] }), false);
    expect(json).toEqual({ ok: true, items: [{ key: 'https://j.example/1', text: 'J — https://j.example/1' }] });
    expect(parseFeed('<html><body>no</body></html>', false)).toEqual({ ok: false });
  });
});

describe('markdown, numbers and entities', () => {
  it('reads markdown as text lines, links as text (or text <url>)', () => {
    const { lines } = markdownLines('---\ntitle: x\n---\n# Title\n\n- **Bold** item with [a link](/x)\n| a | b |\n|---|---|\n| 1 | 2 |\n![img](/i.png)\n', true, 'https://m.example.com/doc');
    expect(lines).toEqual(['Title', 'Bold item with a link <https://m.example.com/x>', 'a | b', '1 | 2']);
  });

  it('reads numbers with separators, signs and a decimal comma; after a label', () => {
    expect(parseNumber('1,299.00')).toBe(1299);
    expect(parseNumber('−3.5')).toBe(-3.5);
    expect(parseNumber('12,50')).toBe(12.5);
    expect(findNumber(['Shipping 15 days', 'Price: ¥1,299.00'], 'Price:')).toEqual({ text: '1,299.00', value: 1299 });
    expect(findNumber(['no digits'], '')).toBeNull();
    expect(findNumber(['3 items 500 left'], '')?.value).toBe(3);
  });

  it('decodes character references, numeric and named', () => {
    expect(decodeEntities('A &amp; B &#38; &#x26; &copy; &unknown; &#0;')).toBe('A & B & & © &unknown; �');
  });
});

describe('charsets', () => {
  // 你好 in GBK.
  const gbk = new Uint8Array([...new TextEncoder().encode('<html><head><meta charset="gbk"></head><body>'), 0xc4, 0xe3, 0xba, 0xc3, ...new TextEncoder().encode('</body></html>')]);

  it('sniffs <meta charset> and http-equiv when the header names none; the header wins otherwise', () => {
    expect(sniffCharset(gbk)?.label).toBe('gbk');
    expect(detectCharset('text/html', gbk)).toEqual({ label: 'gbk', source: 'meta' });
    expect(detectCharset('text/html; charset=utf-8', gbk)).toEqual({ label: 'utf-8', source: 'header' });
    expect(sniffCharset(new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'))?.label).toBe('shift_jis');
    expect(detectCharset(null, new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ label: 'utf-8', source: 'bom' });
    expect(detectCharset('text/html; charset=x-unknown', new Uint8Array())).toEqual({ label: 'utf-8', source: 'default' });
    expect(decodeBody(gbk, 'gbk')).toContain('你好');
    expect(headerCharset('text/html; Charset="GB2312"')).toBe('gb2312');
    expect(mediaType('Application/JSON; charset=utf-8')).toBe('application/json');
  });
});

describe('the health gate', () => {
  it('recognizes challenge pages by header or markers, and lets an ordinary large page through', () => {
    expect(isChallenge(403, new Headers(), new TextEncoder().encode('<title>Just a moment...</title>'))).toBe(true);
    expect(isChallenge(200, new Headers({ 'cf-mitigated': 'challenge' }), new Uint8Array())).toBe(true);
    expect(isChallenge(200, new Headers(), new TextEncoder().encode('<title>请完成安全验证</title>'))).toBe(true);
    expect(isChallenge(200, new Headers(), new TextEncoder().encode('<title>Kettles</title><p>captcha-free page</p>'))).toBe(false);
  });

  it('checks the content type per source, mojibake, too short and the status', () => {
    const html = { kind: 'html', include: [], exclude: [], keepLinks: false, keepLandmarks: false } as const;
    expect(contentTypeFits(html, 'text/html', true)).toBe(true);
    expect(contentTypeFits(html, 'text/markdown', false)).toBe(false);
    expect(contentTypeFits({ kind: 'feed', includeSummaries: false }, 'application/rss+xml', false)).toBe(true);
    expect(contentTypeFits({ kind: 'feed', includeSummaries: false }, 'text/html', false)).toBe(false);
    expect(contentTypeFits({ kind: 'json', path: '' }, 'application/vnd.api+json', false)).toBe(true);
    expect(isMojibake(`ok ${'�'.repeat(3)}`)).toBe(true);
    expect(isMojibake(`${'a'.repeat(1000)}���`)).toBe(false);
    expect(isTooShort(['tiny'])).toBe(true);
    expect(isTooShort(['long enough text for a page'])).toBe(false);
    expect([200, 304, 404, 429, 503].map(statusFailure)).toEqual([null, null, 'HTTP_ERROR', 'RATE_LIMITED', 'RATE_LIMITED']);
  });
});

describe('snapshots', () => {
  it('marks completeness of snapshots recorded before the marker as unknown', async () => {
    const legacy = { l: ['Retained text'], k: null, n: null, a: null };
    const bytes = await gzip(new TextEncoder().encode(JSON.stringify(legacy)));
    expect((await decodeSnapshot(bytes)).truncated).toBe(true);
  });

  it('round-trip, and keep only the first lines of a text over 64 KiB compressed', async () => {
    const content = { lines: ['a', 'b'], keys: ['k1'], number: '12', availability: 'InStock' };
    const { bytes, lines } = await encodeSnapshot(content);
    expect(lines).toBe(2);
    expect(await decodeSnapshot(bytes)).toEqual({ ...content, truncated: false });
    const random = Array.from({ length: 3000 }, (_, i) => `${String(i)} ${crypto.randomUUID()} ${crypto.randomUUID()}`);
    const big = await encodeSnapshot({ lines: random, keys: random, number: null, availability: null });
    expect(big.bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(big.lines).toBeLessThan(3000);
    expect((await decodeSnapshot(big.bytes)).lines).toEqual(random.slice(0, big.lines));
    expect((await decodeSnapshot(big.bytes)).truncated).toBe(true);
  });
});

// ---- HTML selector helpers, JPEG dimensions, scheduler, pipeline & backup cell helpers ----

import { decodeCell, encodeCell } from '../src/backup.ts';
import { jpegDimensions } from '../src/browser.ts';
import { selectorOf, supportedSelector, type Frame } from '../src/extract/html.ts';
import { confirmWindowMs, decideAsSeen, storedConfig, type CheckDeps } from '../src/pipeline.ts';
import { errorCode, laneOf } from '../src/scheduler.ts';
import type { ChangeRow, WatchRow } from '../src/store.ts';

function frameOf(tag: string, id = '', parent: Frame | null = null, nthOfType = 1): Frame {
  return {
    tag,
    id,
    parent,
    nthOfType,
    typeCounts: new Map(),
    block: true,
    serial: 1,
    skip: false,
    landmark: false,
    include: false,
    optIn: false,
    exclude: false,
    closed: false,
    href: null,
    selector: null,
  };
}

describe('extract/html selector helpers', () => {
  it('builds selectors anchored at a stable id or body, skips generated ids, and truncates deep trees', () => {
    const body = frameOf('body');
    const stableSection = frameOf('section', 'reviews', body, 2);
    const para = frameOf('p', '', stableSection, 3);
    expect(selectorOf(para)).toBe('section#reviews > p:nth-of-type(3)');

    // Generated/unstable ids (3+ digits, hashes, CSS modules, BEM) are ignored in favor of :nth-of-type up to body.
    for (const unstable of ['item123', 'a1b2c3d4', 'css-1a2b3', 'card__title', 'btn--primary']) {
      const div = frameOf('div', unstable, body, 1);
      const child = frameOf('p', '', div, 2);
      expect(selectorOf(child), unstable).toBe('body > div:nth-of-type(1) > p:nth-of-type(2)');
    }

    // Over 200 chars falls back to "<anchor> <leaf>".
    let deep: Frame = body;
    for (let i = 0; i < 15; i++) deep = frameOf('section', '', deep, i + 1);
    const leaf = frameOf('article', '', deep, 4);
    expect(selectorOf(leaf)).toBe('body article:nth-of-type(4)');
  });

  it('supportedSelector rejects blank or >200-char selectors and delegates to HTMLRewriter', () => {
    expect(supportedSelector('')).toBe(false);
    expect(supportedSelector('   ')).toBe(false);
    expect(supportedSelector('div > '.repeat(40))).toBe(false);

    const prev = (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
    try {
      (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = class {
        on(sel: string) {
          if (sel.includes(':has(')) throw new Error('unsupported selector');
          return this;
        }
      };
      expect(supportedSelector('main > article:nth-of-type(2)')).toBe(true);
      expect(supportedSelector('div:has(p)')).toBe(false);
    } finally {
      (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = prev;
    }
  });
});

describe('jpegDimensions', () => {
  it('parses baseline (0xc0) and progressive (0xc2) JPEGs and rejects truncated, missing-EOI, or oversize frames', () => {
    // Baseline 0xc0 (3x2)
    const baseline = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9]);
    expect(jpegDimensions(baseline)).toEqual({ width: 3, height: 2 });

    // Progressive 0xc2 with 0xff fill bytes and an APP0 (0xe0) segment before SOF2 (640x480)
    const progressive = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xff, 0xe0, 0, 4, 0, 0,
      0xff, 0xc2, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0,
      0xff, 0xd9,
    ]);
    expect(jpegDimensions(progressive)).toEqual({ width: 640, height: 480 });

    // Missing EOI (0xff 0xd9)
    expect(jpegDimensions(baseline.slice(0, -1))).toBeNull();
    // Too short (< 12 bytes)
    expect(jpegDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    // Truncated segment length extending beyond buffer
    const truncated = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 50, 0, 0, 0, 0, 0xff, 0xd9]);
    expect(jpegDimensions(truncated)).toBeNull();
    // SOF segment with size < 8
    const shortSof = Uint8Array.from([0xff, 0xd8, 0xff, 0xc2, 0, 6, 8, 0, 2, 0, 0xff, 0xd9]);
    expect(jpegDimensions(shortSof)).toBeNull();
    // Exceeds 1280x960 viewport
    const oversize = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0x03, 0xc0, 0x05, 0x01, 1, 1, 0x11, 0, 0xff, 0xd9]);
    expect(jpegDimensions(oversize)).toBeNull();
  });
});

describe('scheduler, pipeline, and backup cell helpers', () => {
  it('formats safe error codes and assigns browser vs host lanes in scheduler.ts', () => {
    expect(errorCode(new Error('storage_error'))).toBe('storage_error');
    expect(errorCode(new TypeError('Failed to fetch https://private.example.com/secret'))).toBe('TypeError');
    expect(errorCode('raw string')).toBe('error');

    const baseRow = { id: 'w1', host: 'news.example.com' } as WatchRow;
    expect(laneOf({ ...baseRow, settings: JSON.stringify({ display_name: 'News', uri: 'https://news.example.com/' }) })).toBe('news.example.com');
    expect(laneOf({ ...baseRow, settings: JSON.stringify({ display_name: 'SPA', uri: 'https://news.example.com/', fetcher: 'BROWSER' }) })).toBe(':browser');
    expect(laneOf({ ...baseRow, settings: '{invalid-json' })).toBe('news.example.com');
  });

  it('computes confirmWindowMs and settles pending changes with decideAsSeen in pipeline.ts', () => {
    const cfg = storedConfig({ settings: JSON.stringify({ display_name: 'Shop', uri: 'https://shop.example.com/', stability: { confirm_delay_minutes: 20 } }) });
    expect(confirmWindowMs(cfg)).toBe(4 * 20 * MINUTE + 15 * MINUTE);

    const defaultCfg = storedConfig({ settings: JSON.stringify({ display_name: 'Shop', uri: 'https://shop.example.com/', stability: { skip_confirmation: true } }) });
    expect(confirmWindowMs(defaultCfg)).toBe(4 * 15 * MINUTE + 15 * MINUTE);

    const calls: { change?: unknown; watch?: unknown; enqueue?: unknown } = {};
    const deps = {
      store: {
        updateChange: (id: string, fields: unknown) => {
          calls.change = { id, fields };
        },
        updateWatch: (id: string, fields: unknown) => {
          calls.watch = { id, fields };
        },
        enqueue: (...args: unknown[]) => {
          calls.enqueue = args;
        },
      },
    } as unknown as CheckDeps;
    const row = { id: 'w1' } as WatchRow;
    const pending = { id: 'c1', summary: '新增 1 行', snapshot_id: 42 } as ChangeRow;
    decideAsSeen(deps, row, cfg, pending, T, '（未完成二次确认）');
    expect(calls.change).toEqual({
      id: 'c1',
      fields: { state: 'confirmed', resolve_time: T, summary: '新增 1 行（未完成二次确认）', before_snapshot_id: null },
    });
    expect(calls.watch).toEqual({
      id: 'w1',
      fields: { pending_change: null, baseline_id: 42 },
    });
    expect(calls.enqueue).toEqual(['change_confirmed', 'w1', 'c1', cfg.notify, T]);
  });

  it('encodes and decodes SQLite cells (strings, numbers, nulls, large ArrayBuffers) and rejects malformed cells', () => {
    expect(encodeCell('text')).toBe('text');
    expect(encodeCell(42)).toBe(42);
    expect(encodeCell(null)).toBeNull();
    expect(decodeCell('text')).toBe('text');
    expect(decodeCell(42)).toBe(42);
    expect(decodeCell(null)).toBeNull();

    const raw = new Uint8Array(9000);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 17) & 0xff;
    const encoded = encodeCell(raw.buffer);
    expect(encoded).toEqual({ base64: expect.any(String) });
    const decoded = decodeCell(encoded);
    expect(decoded).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(decoded as ArrayBuffer)).toEqual(raw);

    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, [1], {}, { base64: 123 }, { base64: 'AA==', extra: true }]) {
      expect(() => decodeCell(bad)).toThrow('part_invalid');
    }
  });
});

