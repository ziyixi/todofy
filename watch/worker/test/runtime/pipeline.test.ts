/**
 * The noise pipeline in workerd (../../../docs/design.md §5), stage by stage, against synthetic sites: every fetch tier
 * that v1 has, the short-circuits, the health gate (BROKEN after 3, the digest event once, the auto-pause after 14
 * days), GBK pages that name their charset only in a meta tag, UTF-16 pages, an omitted </head>, the masks (relative
 * times in English and Chinese), ignored lines (and a change pending meanwhile), every typed trigger, the confirmation
 * fetch, flicker, a third version, the confirmation window, a check that throws, the bounds of the changes table, and
 * shadow mode.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Change_State, Change_SuppressionReason, Change_TriggerKind, DiffLine_Kind } from '@ziyixi/proto/watch/ui/v1/change_pb';
import { EmbeddedSource_Kind, FailureReason, Watch_PauseReason, Watch_State, WatchHealth_Outcome, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import type { MessageInitShape } from '@ziyixi/proto/protobuf';
import type { WatchSchema } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { atom, page, productPage, rss } from '../fake-sites.ts';
import { DAY, HOUR, MINUTE, op, resetWatches, startHarness, T0, watchRow, type Harness } from './harness.ts';

let h: Harness;
let clock = T0;

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await resetWatches(h);
});

afterAll(async () => {
  await h.dispose();
});

type WatchInit = MessageInitShape<typeof WatchSchema>;

/** Creates a watch at the current clock and runs its first check (the notified state). */
async function watchOf(id: string, watch: WatchInit): Promise<Watch> {
  clock += DAY;
  await h.clock(clock);
  const created = await h.api.createWatch({ watchId: id, requestId: op(), watch: { displayName: id, ...watch } });
  await h.run(clock);
  return created;
}

/** The next regular check of every watch: well after any interval of these tests (and any confirmation). */
async function later(hours = 8): Promise<void> {
  clock += hours * HOUR;
  await h.clock(clock);
  await h.run(clock);
}

async function changes(id: string, filter = ''): Promise<Awaited<ReturnType<Harness['api']['listChanges']>>['changes']> {
  return (await h.api.listChanges({ parent: `watches/${id}`, filter })).changes;
}

async function health(id: string) {
  const watch = await h.api.getWatch({ name: `watches/${id}` });
  return { state: watch.state, health: watch.health, pause: watch.pauseReason };
}

const item = (n: number) => ({ guid: `urn:item:${String(n)}`, title: `Synthetic headline ${String(n)}`, link: `https://news.example.org/${String(n)}` });

describe('tier 2: HTML text', () => {
  it('sets the notified state on the first check without a change, then a changed line is pending, then confirmed', async () => {
    const url = 'https://html.example.com/page';
    h.sites.html(url, page('Page', '<p>The opening hours are 09:00 to 18:00.</p><p>Closed on public holidays.</p>'));
    await watchOf('html', { uri: url });
    expect(await changes('html')).toEqual([]);
    const first = await health('html');
    expect(first.health?.lastOutcome).toBe(WatchHealth_Outcome.UNCHANGED);
    expect(first.state).toBe(Watch_State.ACTIVE);

    h.sites.html(url, page('Page', '<p>The opening hours are 10:00 to 18:00.</p><p>Closed on public holidays.</p>'));
    await later();
    const [pending] = await changes('html');
    expect(pending?.state).toBe(Change_State.PENDING_CONFIRMATION);
    expect((await health('html')).health?.pendingConfirmation).toBe(true);

    // The confirmation fetch, about 15 minutes later, sees the same text.
    clock += 20 * MINUTE;
    await h.clock(clock);
    await h.run(clock);
    const [confirmed] = await changes('html', 'state = NEW');
    expect(confirmed?.state).toBe(Change_State.CONFIRMED);
    expect(confirmed?.triggerKind).toBe(Change_TriggerKind.ANY_CHANGE);
    expect(confirmed?.diffLines.map((line) => [line.kind, line.text])).toEqual([
      [DiffLine_Kind.REMOVED, 'The opening hours are 09:00 to 18:00.'],
      [DiffLine_Kind.ADDED, 'The opening hours are 10:00 to 18:00.'],
    ]);
    expect(confirmed?.summary).toBe('新增 1 行，删除 1 行');
    expect(confirmed?.watchDisplayName).toBe('html');
    // The notification outbox got the event (W3 delivers it): IDs, kind and policy only.
    const events = await h.sql<{ kind: string; watch_id: string; change_id: string; policy: string }>('SELECT kind, watch_id, change_id, policy FROM notifications');
    expect(events).toEqual([{ kind: 'change_confirmed', watch_id: 'html', change_id: confirmed?.name.split('/').pop(), policy: 'digest' }]);

    // Acknowledged, it leaves the inbox; the same page again is no change.
    await h.api.acknowledgeChange({ name: confirmed?.name ?? '', requestId: op() });
    await later();
    expect(await changes('html', 'state = NEW')).toEqual([]);
    expect(await changes('html')).toHaveLength(1);
  });

  it('strips scripts, styles and landmarks, keeps entities decoded, and reads only the include selectors', async () => {
    const url = 'https://select.example.com/list';
    const body = (price: string, nav: string) =>
      `<!doctype html><html><head><title>t</title></head><body><nav>${nav}</nav><div id="main"><h2>Fish &amp; chips</h2><p>Price ${price}</p><script>document.write("x")</script></div><aside id="ads">Ad ${nav}</aside></body></html>`;
    h.sites.html(url, body('5', 'one'));
    await watchOf('select', { uri: url, source: { html: { includeSelectors: ['div#main'] } }, stability: { skipConfirmation: true } });
    // A change outside the selector (the nav, the aside) is not read at all.
    h.sites.html(url, body('5', 'two'));
    await later();
    expect(await changes('select')).toEqual([]);
    h.sites.html(url, body('6', 'two'));
    await later();
    const [change] = await changes('select');
    expect(change?.state).toBe(Change_State.CONFIRMED);
    expect(change?.diffLines.map((line) => line.text)).toEqual(['Price 5', 'Price 6']);
  });

  it('reads a markdown answer (Accept: text/markdown) as text lines', async () => {
    const url = 'https://markdown.example.com/doc';
    h.sites.set(url, (request) => {
      expect(request.headers.get('accept')).toMatch(/^text\/markdown/);
      return { headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: '# Release notes\n\n- Version **1.2.0** is out\n- See [the changelog](/changes)\n' };
    });
    await watchOf('md', { uri: url, stability: { skipConfirmation: true } });
    h.sites.set(url, { headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: '# Release notes\n\n- Version **1.3.0** is out\n- See [the changelog](/changes)\n' });
    await later();
    const [change] = await changes('md');
    expect(change?.diffLines.map((line) => line.text)).toEqual(['Version 1.2.0 is out', 'Version 1.3.0 is out']);
  });
});

describe('tier 0: structured sources', () => {
  it('RSS: a new item is confirmed at once (no confirmation fetch) with NewItemTrigger', async () => {
    const url = 'https://news.example.org/feed.xml';
    h.sites.set(url, { headers: { 'content-type': 'application/rss+xml' }, body: rss([item(1), item(2)]) });
    await watchOf('rss', { uri: url, source: { feed: {} }, trigger: { newItem: {} } });
    // An edited title of a known item is no new item.
    h.sites.set(url, { headers: { 'content-type': 'application/rss+xml' }, body: rss([{ ...item(1), title: 'Edited headline 1' }, item(2)]) });
    await later();
    const [edited] = await changes('rss');
    expect(edited?.state).toBe(Change_State.SUPPRESSED);
    expect(edited?.suppressionReason).toBe(Change_SuppressionReason.TRIGGER_NOT_MET);
    h.sites.set(url, { headers: { 'content-type': 'application/rss+xml' }, body: rss([item(3), item(1), item(2)]) });
    await later();
    const [fresh] = await changes('rss', 'state = NEW');
    expect(fresh?.summary).toBe('新增 1 项');
    expect(fresh?.diffLines.filter((line) => line.kind === DiffLine_Kind.ADDED).map((line) => line.text)).toContain('Synthetic headline 3 — https://news.example.org/3');
  });

  it('Atom and JSON Feed parse; an HTML page where a feed belongs is WRONG_CONTENT_TYPE', async () => {
    const atomUrl = 'https://atom.example.org/feed';
    h.sites.set(atomUrl, { headers: { 'content-type': 'application/atom+xml' }, body: atom([{ id: 'tag:x,1', title: 'First', link: 'https://atom.example.org/1' }]) });
    await watchOf('atom', { uri: atomUrl, source: { feed: {} } });
    expect((await health('atom')).health?.lastOutcome).toBe(WatchHealth_Outcome.UNCHANGED);
    const jsonUrl = 'https://jsonfeed.example.org/feed.json';
    h.sites.set(jsonUrl, { headers: { 'content-type': 'application/feed+json' }, body: JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: '1', title: 'One', url: 'https://jsonfeed.example.org/1' }] }) });
    await watchOf('jsonfeed', { uri: jsonUrl, source: { feed: {} } });
    expect((await health('jsonfeed')).health?.lastFailure).toBe(FailureReason.UNSPECIFIED);
    const wrong = 'https://wrongtype.example.org/feed';
    h.sites.html(wrong, page('Not a feed', '<p>This is a web page and not a feed at all.</p>'));
    await watchOf('wrongtype', { uri: wrong, source: { feed: {} } });
    expect((await health('wrongtype')).health?.lastFailure).toBe(FailureReason.WRONG_CONTENT_TYPE);
  });

  it('JSON API with a JSONPath: a NumberTrigger fires when the value falls to its lower threshold', async () => {
    const url = 'https://api.example.net/v1/price';
    const answer = (price: number) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: { name: 'Synthetic widget', price, updated: '2026-10-01T00:00:00Z' } }) });
    h.sites.set(url, answer(120));
    await watchOf('api', { uri: url, source: { json: { path: '$.product.price' } }, trigger: { number: { lowerThreshold: 100 } } });
    h.sites.set(url, answer(110));
    await later();
    const [above] = await changes('api');
    expect(above?.state).toBe(Change_State.SUPPRESSED);
    expect([above?.previousValue, above?.currentValue]).toEqual(['120', '110']);
    h.sites.set(url, answer(99));
    await later();
    const [crossed] = await changes('api', 'state = NEW');
    expect(crossed?.summary).toBe('数值降到下限以下');
    expect([crossed?.previousValue, crossed?.currentValue]).toEqual(['110', '99']);
    // An edge: still below the threshold is no new change.
    h.sites.set(url, answer(95));
    await later();
    expect(await changes('api', 'state = NEW')).toHaveLength(1);
  });

  it('JSON-LD: AvailabilityTrigger with only_when_available fires on the restock only', async () => {
    const url = 'https://shop.example.net/kettle';
    h.sites.html(url, productPage('Synthetic kettle', '199.00', 'InStock'));
    await watchOf('ld', { uri: url, source: { embedded: { kind: EmbeddedSource_Kind.JSON_LD } }, trigger: { availability: { onlyWhenAvailable: true } } });
    h.sites.html(url, productPage('Synthetic kettle', '199.00', 'OutOfStock'));
    await later();
    expect((await changes('ld'))[0]?.state).toBe(Change_State.SUPPRESSED);
    h.sites.html(url, productPage('Synthetic kettle', '189.00', 'InStock'));
    await later();
    const [restock] = await changes('ld', 'state = NEW');
    expect(restock?.triggerKind).toBe(Change_TriggerKind.AVAILABILITY);
    // Structured sources are never confirmed by a second fetch; the edge is from the previous check's availability.
    expect([restock?.previousValue, restock?.currentValue]).toEqual(['OutOfStock', 'InStock']);
    expect(restock?.summary).toBe('可以购买了');
  });

  it('__NEXT_DATA__ with a path, and a missing value is VALUE_MISSING', async () => {
    const url = 'https://next.example.com/release';
    const body = (version: string) => page('Release', '<p>Loading the latest release information now…</p>', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { release: { version } } } })}</script>`);
    h.sites.html(url, body('1.0.0'));
    await watchOf('next', { uri: url, source: { embedded: { kind: EmbeddedSource_Kind.NEXT_DATA, path: '$.props.pageProps.release.version' } } });
    h.sites.html(url, body('1.1.0'));
    await later();
    expect((await changes('next', 'state = NEW'))[0]?.diffLines.map((line) => line.text)).toEqual(['1.0.0', '1.1.0']);
    const missing = 'https://nolabel.example.com/p';
    h.sites.html(missing, page('No number', '<p>There is no figure on this page whatsoever.</p>'));
    await watchOf('nonumber', { uri: missing, trigger: { number: { upperThreshold: 10 } } });
    expect((await health('nonumber')).health?.lastFailure).toBe(FailureReason.VALUE_MISSING);
  });
});

describe('stage 1: short-circuits', () => {
  it('a 304 skips the parse and the snapshot; the same bytes skip them too; validators are sent', async () => {
    const url = 'https://etag.example.com/doc';
    h.sites.set(url, (request) =>
      request.headers.get('if-none-match') === '"v1"' ? { status: 304 } : { headers: { 'content-type': 'text/html', etag: '"v1"' }, body: page('Doc', '<p>A stable document with enough text.</p>') },
    );
    await watchOf('etag', { uri: url });
    const snapshots = async () => (await h.sql<{ n: number }>('SELECT count(*) AS n FROM snapshots WHERE watch_id = ?', 'etag'))[0]?.n;
    expect(await snapshots()).toBe(1);
    await later();
    expect(h.sites.requestsTo(url).at(-1)?.headers['if-none-match']).toBe('"v1"');
    expect((await health('etag')).health?.lastOutcome).toBe(WatchHealth_Outcome.NOT_MODIFIED);
    expect(await snapshots()).toBe(1);

    const same = 'https://samebytes.example.com/doc';
    h.sites.html(same, page('Doc', '<p>Unchanging text of a page without validators.</p>'));
    await watchOf('same', { uri: same });
    const before = await watchRow(h, 'same');
    await later();
    const after = await watchRow(h, 'same');
    expect(after['raw_sha']).toBe(before['raw_sha']);
    expect((await health('same')).health?.lastOutcome).toBe(WatchHealth_Outcome.UNCHANGED);
  });
});

describe('stage 3: masks', () => {
  it('relative times (Chinese and English), timestamps, tokens and copyright years make no change; masked_change_count counts them', async () => {
    const url = 'https://masks.example.com/news';
    const body = (n: number) =>
      page(
        'News',
        `<p>发布于 ${String(n)}小时前</p><p>Updated ${String(n)} minutes ago</p><p>Server time 2026-10-01T12:3${String(n)}:0${String(n)}Z build 9f${'a'.repeat(15)}${String(n)}</p><p>刚刚 有人购买了这件商品</p><p>Price ¥1,299 on 2026-10-01</p>`,
        `<p>© 2019-202${String(n)} Example</p>`,
      );
    h.sites.html(url, body(1));
    await watchOf('masks', { uri: url });
    h.sites.html(url, body(3));
    await later();
    expect(await changes('masks')).toEqual([]);
    const watch = await h.api.getWatch({ name: 'watches/masks' });
    expect(watch.health?.maskedChangeCount).toBe(1);
    // An absolute date or a number is kept: the price matters.
    h.sites.html(url, body(3).replace('¥1,299', '¥1,199'));
    await later();
    expect((await changes('masks'))[0]?.diffLines.map((line) => line.text)).toEqual(['Price ¥1,299 on 2026-10-01', 'Price ¥1,199 on 2026-10-01']);
  });

  it('ignored lines are dropped from both sides of every comparison (the drawer\'s "ignore this line"); the undo brings them back', async () => {
    const url = 'https://ignore.example.com/p';
    h.sites.html(url, page('P', '<p>Visitors today: 120</p><p>The article text stays the same.</p>'));
    await watchOf('ignore', { uri: url, stability: { skipConfirmation: true } });
    h.sites.html(url, page('P', '<p>Visitors today: 121</p><p>The article text stays the same.</p>'));
    await later();
    const [first] = await changes('ignore');
    expect(first?.state).toBe(Change_State.CONFIRMED);
    const notified = (await watchRow(h, 'ignore'))['baseline_id'];
    const watch = await h.api.getWatch({ name: 'watches/ignore' });
    const ignoredLines = ['Visitors today: 121', 'Visitors today: 122'];
    await h.api.updateWatch({ watch: { name: watch.name, etag: watch.etag, normalize: { ignoredLines } }, updateMask: { paths: ['normalize.ignored_lines'] }, requestId: op() });
    h.sites.html(url, page('P', '<p>Visitors today: 122</p><p>The article text stays the same.</p>'));
    await later();
    // Ignoring is not a change of what is read: the notified state stays, and 121 -> 122 is no change.
    expect(await changes('ignore')).toHaveLength(1);
    expect((await watchRow(h, 'ignore'))['baseline_id']).toBe(notified);
    await h.clock(clock + 15 * MINUTE);
    const preview = await h.api.previewWatch({ watch: { ...(await h.api.getWatch({ name: 'watches/ignore' })) } });
    expect(preview.ignoredLineCount).toBe(1);
    expect(preview.normalizedLines).not.toContain('Visitors today: 122');
    // The undo: the line counts again, against the same notified state (121), and never as a change of its own.
    const ignoring = await h.api.getWatch({ name: 'watches/ignore' });
    await h.api.updateWatch({ watch: { name: ignoring.name, etag: ignoring.etag, normalize: { ignoredLines: [] } }, updateMask: { paths: ['normalize.ignored_lines'] }, requestId: op() });
    await later();
    const [undone] = await changes('ignore');
    expect(undone?.diffLines.map((line) => line.text)).toEqual(['Visitors today: 121', 'Visitors today: 122']);
  });
});

describe('ignoring a line while a real change is pending', () => {
  const body = (price: string, visitors: string) =>
    page('P', `<p>The price of the synthetic item is ${price} yuan.</p><p>Visitors ${visitors}</p><p>Another stable line of synthetic text.</p>`);

  /** A watch whose visitor counter changed alone (suppressed), then whose price changed too (pending). */
  async function pendingWithNoise(id: string, url: string): Promise<void> {
    h.sites.html(url, body('100', '1'));
    await watchOf(id, { uri: url, trigger: { anyChange: { minChangedLines: 3 } } });
    h.sites.html(url, body('100', '2'));
    await later();
    h.sites.html(url, body('80', '3'));
    await later();
    expect(await changes(id, 'state = PENDING_CONFIRMATION')).toHaveLength(1);
  }

  async function setIgnored(id: string, lines: string[]): Promise<void> {
    const watch = await h.api.getWatch({ name: `watches/${id}` });
    await h.api.updateWatch({ watch: { name: watch.name, etag: watch.etag, normalize: { ignoredLines: lines } }, updateMask: { paths: ['normalize.ignored_lines', 'etag'] }, requestId: op() });
  }

  it('keeps the pending change and confirms it at the confirmation fetch', async () => {
    const url = 'https://ignore2.example.com/p';
    await pendingWithNoise('ign', url);
    // Before the confirmation fetch, the owner ignores the counter line from the drawer (the UI's own call).
    await setIgnored('ign', ['Visitors 2']);
    expect(await changes('ign', 'state = PENDING_CONFIRMATION')).toHaveLength(1);
    clock += 20 * MINUTE;
    await h.clock(clock);
    await h.run(clock);
    const [confirmed] = await changes('ign', 'state = NEW');
    expect(confirmed?.diffLines.map((line) => line.text)).toEqual(expect.arrayContaining(['The price of the synthetic item is 100 yuan.', 'The price of the synthetic item is 80 yuan.']));
  });

  it('taking the ignore back keeps it too', async () => {
    const url = 'https://ignore3.example.com/p';
    h.sites.html(url, body('100', '1'));
    await watchOf('undo', { uri: url, trigger: { anyChange: { minChangedLines: 3 } }, normalize: { ignoredLines: ['Visitors 9'] } });
    h.sites.html(url, body('80', '3'));
    await later();
    expect(await changes('undo', 'state = PENDING_CONFIRMATION')).toHaveLength(1);
    await setIgnored('undo', []);
    clock += 20 * MINUTE;
    await h.clock(clock);
    await h.run(clock);
    expect(await changes('undo', 'state = NEW')).toHaveLength(1);
  });

  it('ignoring the very line that made the change re-evaluates it: what no longer fires is suppressed with its reason, never lost silently', async () => {
    const url = 'https://ignore4.example.com/p';
    h.sites.html(url, page('P', '<p>Visitors 1</p><p>The article text stays the same, a long synthetic line.</p>'));
    await watchOf('only', { uri: url });
    h.sites.html(url, page('P', '<p>Visitors 2</p><p>The article text stays the same, a long synthetic line.</p>'));
    await later();
    expect(await changes('only', 'state = PENDING_CONFIRMATION')).toHaveLength(1);
    await setIgnored('only', ['Visitors 1', 'Visitors 2']);
    clock += 20 * MINUTE;
    await h.clock(clock);
    await h.run(clock);
    const [resolved] = await changes('only');
    expect(resolved?.state).toBe(Change_State.SUPPRESSED);
    expect(resolved?.suppressionReason).toBe(Change_SuppressionReason.BELOW_THRESHOLD);
  });

  it('a change of what is read confirms the pending change as it was seen, with a note, before the new notified state', async () => {
    const url = 'https://ignore5.example.com/p';
    await pendingWithNoise('reread', url);
    const watch = await h.api.getWatch({ name: 'watches/reread' });
    await h.api.updateWatch({ watch: { name: watch.name, etag: watch.etag, normalize: { maskNumbers: true } }, updateMask: { paths: ['normalize.mask_numbers', 'etag'] }, requestId: op() });
    clock += 20 * MINUTE;
    await h.clock(clock);
    await h.run(clock);
    const [confirmed] = await changes('reread', 'state = NEW');
    expect(confirmed?.summary).toContain('设置已更改');
    expect((await watchRow(h, 'reread'))['pending_change']).toBeNull();
  });
});

describe('pages that are hard to read', () => {
  it('a UTF-16 page (with a BOM, or named by the header) decodes; a meta that says utf-16 is read as UTF-8', async () => {
    const utf16 = (text: string, bom: boolean) => {
      const units = Array.from(`${bom ? '﻿' : ''}${text}`, (char) => char.charCodeAt(0));
      return new Uint8Array(units.flatMap((unit) => [unit & 0xff, unit >> 8]));
    };
    const html = '<!doctype html><html><body><p>公告：本店营业时间为每天上午九点到下午六点，周末与节假日休息。</p></body></html>';
    h.sites.set('https://utf16.example.com/bom', { headers: { 'content-type': 'text/html' }, body: utf16(html, true) });
    h.sites.set('https://utf16.example.com/header', { headers: { 'content-type': 'text/html; charset=utf-16le' }, body: utf16(html, false) });
    h.sites.html('https://utf16.example.com/meta', '<!doctype html><html><head><meta charset="utf-16"></head><body><p>公告：本店营业时间为每天上午九点到下午六点，周末与节假日休息。</p></body></html>');
    clock += DAY;
    await h.clock(clock);
    for (const path of ['bom', 'header', 'meta']) await h.api.createWatch({ watchId: `u16-${path}`, requestId: op(), watch: { displayName: path, uri: `https://utf16.example.com/${path}` } });
    await h.run(clock);
    for (const path of ['bom', 'header', 'meta']) {
      expect((await health(`u16-${path}`)).health?.lastFailure, path).toBe(FailureReason.UNSPECIFIED);
    }
    await h.clock(clock + 15 * MINUTE);
    const preview = await h.api.previewWatch({ watch: { displayName: 'p', uri: 'https://utf16.example.com/bom' } });
    expect(preview.normalizedLines).toEqual(['公告:本店营业时间为每天上午九点到下午六点,周末与节假日休息。']);
  });

  it('an omitted </head> (valid HTML; minifiers drop it) still reads the body, with or without <body>', async () => {
    h.sites.html('https://nohead.example.com/a', '<!doctype html><html><head><meta charset="utf-8"><title>T</title><body><p>The opening hours are nine to six on weekdays.</p></body></html>');
    h.sites.html('https://nohead.example.com/b', '<!doctype html><html><head><meta charset="utf-8"><title>T</title><script>var x = 1;</script><p>The opening hours are nine to six on weekdays.</p></html>');
    clock += DAY;
    await h.clock(clock);
    for (const path of ['a', 'b']) await h.api.createWatch({ watchId: `nohead-${path}`, requestId: op(), watch: { displayName: path, uri: `https://nohead.example.com/${path}` } });
    await h.run(clock);
    // The second page was checked 30 s after the first (one host): previews wait for both URLs' 15 minutes.
    await h.clock(clock + 16 * MINUTE);
    for (const path of ['a', 'b']) {
      expect((await health(`nohead-${path}`)).health?.lastFailure, path).toBe(FailureReason.UNSPECIFIED);
      const preview = await h.api.previewWatch({ watch: { displayName: 'p', uri: `https://nohead.example.com/${path}` } });
      expect(preview.normalizedLines, path).toEqual(['The opening hours are nine to six on weekdays.']);
    }
  });
});

describe('a check that throws after its fetch', () => {
  it('is a failure of its own (INTERNAL_ERROR): it counts toward BROKEN and waits at least 15 minutes, with a growing delay', async () => {
    const url = 'https://throws.example.com/p';
    h.sites.html(url, page('P', '<p>The first synthetic text of a page that will break.</p>'));
    await watchOf('throws', { uri: url });
    // A state the code never leaves (its notified snapshot gone) makes every check throw after the fetch.
    await h.sql('DELETE FROM snapshots WHERE watch_id = ?', 'throws');
    h.sites.html(url, page('P', '<p>The second synthetic text of a page that will break.</p>'));
    h.sites.clearRequests();
    const start = clock + 8 * HOUR;
    for (let t = start; t <= start + HOUR; t += MINUTE) await h.step(t);
    expect(h.sites.requestsTo(url).length).toBeLessThanOrEqual(4);
    const row = await watchRow(h, 'throws');
    expect(row['last_failure']).toBe('INTERNAL_ERROR');
    expect(Number(row['failures'])).toBeGreaterThanOrEqual(3);
    expect(row['state']).toBe('broken');
    expect(h.logs.some((line) => line.includes('"check_failed"') && line.includes('"baseline_missing"'))).toBe(true);
    // The delay grows: the next day sees far fewer requests than one every 15 minutes.
    h.sites.clearRequests();
    for (let t = start + HOUR; t <= start + DAY; t += 10 * MINUTE) await h.step(t);
    expect(h.sites.requestsTo(url).length).toBeLessThanOrEqual(8);
    expect((await health('throws')).health?.lastFailure).toBe(FailureReason.INTERNAL_ERROR);
    clock = start + DAY;
  });
});

describe('stage 0: the health gate', () => {
  it('non-2xx three times makes the watch BROKEN with one digest event; a success makes it ACTIVE again', async () => {
    const url = 'https://flaky.example.com/p';
    h.sites.html(url, page('P', '<p>A page that will start failing soon enough.</p>'));
    await watchOf('flaky', { uri: url });
    h.sites.set(url, { status: 500, body: 'oops' });
    await later();
    await later();
    expect((await health('flaky')).state).toBe(Watch_State.ACTIVE);
    await later();
    const broken = await health('flaky');
    expect(broken.state).toBe(Watch_State.BROKEN);
    expect(broken.health?.lastFailure).toBe(FailureReason.HTTP_ERROR);
    expect(broken.health?.lastHttpStatus).toBe(500);
    expect(broken.health?.consecutiveFailureCount).toBe(3);
    await later();
    // One digest event per run of failures, never urgent.
    expect(await h.sql('SELECT kind, policy FROM notifications WHERE watch_id = ?', 'flaky')).toEqual([{ kind: 'watch_broken', policy: 'digest' }]);
    // No change was ever recorded: a failure is never "no change" nor a change.
    expect(await changes('flaky')).toEqual([]);
    h.sites.html(url, page('P', '<p>A page that will start failing soon enough.</p>'));
    await later();
    expect((await health('flaky')).state).toBe(Watch_State.ACTIVE);
    expect(await changes('flaky')).toEqual([]);
  });

  it('a watch broken for 14 days is paused with BROKEN_TOO_LONG; resume starts it afresh', async () => {
    const url = 'https://gone.example.com/p';
    h.sites.html(url, page('P', '<p>Here today and gone tomorrow, as they say.</p>'));
    await watchOf('gone', { uri: url, checkIntervalMinutes: 1440 });
    h.sites.set(url, { status: 404, body: 'gone' });
    // Every 27 hours: always past the next check (24 hours, moved by up to 10 %).
    for (let day = 0; day < 15; day++) await later(27);
    const paused = await health('gone');
    expect(paused.state).toBe(Watch_State.PAUSED);
    expect(paused.pause).toBe(Watch_PauseReason.BROKEN_TOO_LONG);
    expect(paused.health?.nextCheckTime).toBeUndefined();
    expect((await h.sql<{ kind: string }>('SELECT kind FROM notifications WHERE watch_id = ? ORDER BY id', 'gone')).map((row) => row.kind)).toEqual(['watch_broken', 'watch_paused']);
    const requests = h.sites.requestsTo(url).length;
    await later(48);
    expect(h.sites.requestsTo(url)).toHaveLength(requests);
    const resumed = await h.api.resumeWatch({ name: 'watches/gone', requestId: op() });
    expect(resumed.state).toBe(Watch_State.ACTIVE);
    expect(resumed.health?.consecutiveFailureCount).toBe(0);
  });

  it('a challenge page, a page too short, a missing selector and mojibake each fail with their code', async () => {
    const cases: [string, Parameters<Harness['sites']['set']>[1], WatchInit, FailureReason][] = [
      ['challenge', { status: 403, headers: { 'content-type': 'text/html' }, body: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>' }, {}, FailureReason.CHALLENGE_PAGE],
      ['mitigated', { status: 200, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }, body: '<html><body>x</body></html>' }, {}, FailureReason.CHALLENGE_PAGE],
      ['short', { headers: { 'content-type': 'text/html' }, body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>' }, {}, FailureReason.TOO_SHORT],
      ['miss', { headers: { 'content-type': 'text/html' }, body: page('P', '<p>No element with that id exists on this page.</p>') }, { source: { html: { includeSelectors: ['div#price'] } } }, FailureReason.SELECTOR_MISS],
      ['mojibake', { headers: { 'content-type': 'text/html; charset=utf-8' }, body: new Uint8Array([...new TextEncoder().encode('<html><body><p>'), ...Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0xc4 : 0xe3)), ...new TextEncoder().encode('</p></body></html>')]) }, {}, FailureReason.MOJIBAKE],
    ];
    for (const [id, route, extra, failure] of cases) {
      const url = `https://${id}.example.com/p`;
      h.sites.set(url, route);
      await watchOf(id, { uri: url, ...extra });
      expect((await health(id)).health?.lastFailure, id).toBe(failure);
    }
  });

  it('a GBK page that names its charset only in <meta charset> decodes, and its change reads as Chinese', async () => {
    const url = 'https://gbk.example.com/notice';
    // 公告：本店营业时间为九点到六点 / 公告：本店营业时间为十点到六点, encoded in GBK by hand (no encoder in workerd's TextEncoder).
    const gbk = (hour: number[]) =>
      new Uint8Array([
        ...new TextEncoder().encode('<html><head><meta charset="gbk"><title>t</title></head><body><p>'),
        0xb9, 0xab, 0xb8, 0xe6, 0xa3, 0xba, 0xb1, 0xbe, 0xb5, 0xea, 0xd3, 0xaa, 0xd2, 0xb5, 0xca, 0xb1, 0xbc, 0xe4, 0xce, 0xaa,
        ...hour,
        0xb5, 0xe3, 0xb5, 0xbd, 0xc1, 0xf9, 0xb5, 0xe3,
        ...new TextEncoder().encode('</p><p>'),
        0xbb, 0xb6, 0xd3, 0xad, 0xb9, 0xe2, 0xc1, 0xd9, 0xa3, 0xac, 0xd0, 0xbb, 0xd0, 0xbb, 0xa1, 0xa3,
        ...new TextEncoder().encode('</p></body></html>'),
      ]);
    h.sites.set(url, { headers: { 'content-type': 'text/html' }, body: gbk([0xbe, 0xc5]) });
    await watchOf('gbk', { uri: url, stability: { skipConfirmation: true } });
    expect((await health('gbk')).health?.lastFailure).toBe(FailureReason.UNSPECIFIED);
    h.sites.set(url, { headers: { 'content-type': 'text/html' }, body: gbk([0xca, 0xae]) });
    await later();
    // NFKC (stage 3) turns the full-width colon into ':'.
    expect((await changes('gbk'))[0]?.diffLines.map((line) => line.text)).toEqual(['公告:本店营业时间为九点到六点', '公告:本店营业时间为十点到六点']);
    // The check fetched the page just now: the preview may fetch it again only 15 minutes later.
    await h.clock(clock + 15 * MINUTE);
    const preview = await h.api.previewWatch({ watch: { displayName: 'gbk', uri: url } });
    expect(preview.fetch?.charset).toBe('gbk');
    expect(preview.fetch?.metaCharset).toBe(true);
  });
});

describe('stage 5: triggers', () => {
  it('AnyChangeTrigger below its floor is suppressed BELOW_THRESHOLD; differences add up against the notified state', async () => {
    const url = 'https://floor.example.com/list';
    const lines = (changed: number) => Array.from({ length: 10 }, (_, i) => `<li>Entry number ${String(i)}${i < changed ? ' (revised)' : ''}</li>`).join('');
    h.sites.html(url, page('L', `<ul>${lines(0)}</ul>`));
    await watchOf('floor', { uri: url, trigger: { anyChange: { minChangedLines: 3 } }, stability: { skipConfirmation: true } });
    h.sites.html(url, page('L', `<ul>${lines(1)}</ul>`));
    await later();
    const [small] = await changes('floor');
    expect(small?.state).toBe(Change_State.SUPPRESSED);
    expect(small?.suppressionReason).toBe(Change_SuppressionReason.BELOW_THRESHOLD);
    // The same text again records nothing new.
    await later();
    expect(await changes('floor')).toHaveLength(1);
    h.sites.html(url, page('L', `<ul>${lines(2)}</ul>`));
    await later();
    expect((await changes('floor', 'state = NEW')).map((change) => change.addedLineCount + change.removedLineCount)).toEqual([4]);
  });

  it('TextTrigger appears and disappears are edges', async () => {
    const url = 'https://text.example.com/p';
    const body = (status: string) => page('P', `<p>Status of the synthetic order: ${status}</p><p>Thank you for waiting.</p>`);
    h.sites.html(url, body('processing'));
    await watchOf('appears', { uri: url, trigger: { textAppears: { text: 'SHIPPED' } }, stability: { skipConfirmation: true } });
    h.sites.html(url, body('shipped'));
    await later();
    expect((await changes('appears', 'state = NEW'))[0]?.summary).toBe('关注的文字出现了');
    h.sites.html(url, body('shipped, arriving soon'));
    await later();
    expect(await changes('appears', 'state = NEW')).toHaveLength(1);
    expect((await changes('appears', 'state = SUPPRESSED'))[0]?.suppressionReason).toBe(Change_SuppressionReason.TRIGGER_NOT_MET);
  });

  it('NumberTrigger with a label and change_percent', async () => {
    const url = 'https://number.example.com/p';
    const body = (stock: string) => page('P', `<p>Shipping 15 days. Stock left: ${stock} units.</p>`);
    h.sites.html(url, body('200'));
    await watchOf('number', { uri: url, trigger: { number: { label: 'Stock left:', changePercent: 50 } }, stability: { skipConfirmation: true } });
    h.sites.html(url, body('150'));
    await later();
    expect((await changes('number'))[0]?.state).toBe(Change_State.SUPPRESSED);
    h.sites.html(url, body('90'));
    await later();
    const [moved] = await changes('number', 'state = NEW');
    expect([moved?.previousValue, moved?.currentValue, moved?.summary]).toEqual(['200', '90', '数值变动超过 50%']);
  });
});

describe('stage 6: the confirmation fetch', () => {
  it('A -> B -> A within the window is a flicker: suppressed for AnyChangeTrigger', async () => {
    const url = 'https://flicker.example.com/p';
    const a = page('P', '<p>Banner: welcome to the synthetic store front page.</p>');
    const b = page('P', '<p>Banner: flash sale for the next ten minutes only.</p>');
    h.sites.html(url, a);
    await watchOf('flicker', { uri: url });
    h.sites.html(url, b);
    await later();
    expect((await changes('flicker'))[0]?.state).toBe(Change_State.PENDING_CONFIRMATION);
    h.sites.html(url, a);
    clock += 20 * MINUTE;
    await h.clock(clock);
    await h.run(clock);
    const [flicker] = await changes('flicker');
    expect(flicker?.state).toBe(Change_State.SUPPRESSED);
    expect(flicker?.suppressionReason).toBe(Change_SuppressionReason.FLICKER);
    expect(await changes('flicker', 'state = NEW')).toEqual([]);
  });

  it('a typed trigger that goes back within the window is confirmed as reverted', async () => {
    const url = 'https://revert.example.com/p';
    h.sites.html(url, page('P', '<p>Availability: sold out for the season.</p>'));
    await watchOf('revert', { uri: url, trigger: { textAppears: { text: 'in stock' } } });
    h.sites.html(url, page('P', '<p>Availability: in stock, ships today.</p>'));
    await later();
    h.sites.html(url, page('P', '<p>Availability: sold out for the season.</p>'));
    clock += 20 * MINUTE;
    await h.clock(clock);
    await h.run(clock);
    const [reverted] = await changes('revert', 'state = NEW');
    expect(reverted?.reverted).toBe(true);
    // The notified state stays: the next restock is news again.
    h.sites.html(url, page('P', '<p>Availability: in stock, ships today.</p>'));
    await later();
    expect((await changes('revert'))[0]?.state).toBe(Change_State.PENDING_CONFIRMATION);
  });

  it('a third version within the window is evaluated again; the third new version in a row is confirmed as it stands', async () => {
    const url = 'https://third.example.com/p';
    const version = (n: number) => page('P', `<p>Draft revision number ${String(n)} of the synthetic notice.</p>`);
    h.sites.html(url, version(1));
    await watchOf('third', { uri: url });
    for (let n = 2; n <= 5; n++) {
      h.sites.html(url, version(n));
      clock += n === 2 ? 8 * HOUR : 20 * MINUTE;
      await h.clock(clock);
      await h.run(clock);
    }
    const [confirmed] = await changes('third', 'state = NEW');
    expect(confirmed?.diffLines.map((line) => line.text)).toEqual(['Draft revision number 1 of the synthetic notice.', 'Draft revision number 5 of the synthetic notice.']);
  });
});

describe('the confirmation window', () => {
  const A = page('P', '<p>The price of the synthetic item is 100 yuan today.</p>');
  const B = page('P', '<p>The price of the synthetic item is 80 yuan today.</p>');

  it('a confirmation that keeps failing returns to the regular pace after the window and confirms the change as it was seen', async () => {
    const url = 'https://pend.example.com/p';
    h.sites.html(url, A);
    await watchOf('pend', { uri: url });
    h.sites.html(url, B);
    await later();
    expect((await changes('pend'))[0]?.state).toBe(Change_State.PENDING_CONFIRMATION);
    // The site errors for two days.
    h.sites.set(url, { status: 500, body: 'oops' });
    h.sites.clearRequests();
    const start = clock;
    for (let t = start + 10 * MINUTE; t <= start + 2 * DAY; t += 10 * MINUTE) {
      clock = t;
      await h.clock(t);
      await h.run(t);
    }
    // A few confirmation tries within the window, then the 6-hour pace: about 8 a day, never one every 15 minutes.
    expect(h.sites.requestsTo(url).length).toBeLessThanOrEqual(4 + 2 * 5);
    const [decided] = await changes('pend');
    expect(decided?.state).toBe(Change_State.CONFIRMED);
    expect(decided?.summary).toContain('按所见确认');
    // The page back at A days later is a change of its own against B (now the notified state), never a flicker.
    h.sites.html(url, A);
    await later(24);
    const all = await changes('pend');
    expect(all.some((change) => change.suppressionReason === Change_SuppressionReason.FLICKER)).toBe(false);
  });

  it('A -> B -> A after the window (the confirmation was held back) is a confirmed, reverted change, never a flicker', async () => {
    const url = 'https://late.example.com/p';
    h.sites.html(url, A);
    await watchOf('late', { uri: url });
    h.sites.html(url, B);
    await later();
    // The host backs off for a day (a 429 elsewhere on it): the confirmation fetch waits, the check does not fail.
    const [host] = await h.sql<{ host: string }>('SELECT host FROM hosts WHERE host = ?', 'late.example.com');
    expect(host).toBeDefined();
    await h.sql('UPDATE hosts SET backoff_until = ? WHERE host = ?', clock + DAY, 'late.example.com');
    h.sites.html(url, A);
    await later(25);
    const [change] = await changes('late');
    expect(change?.state).toBe(Change_State.CONFIRMED);
    expect(change?.reverted).toBe(true);
    expect(change?.suppressionReason).not.toBe(Change_SuppressionReason.FLICKER);
  });
});

describe('the bounds of the changes table', () => {
  it('confirmed changes that are never acknowledged stay bounded (the oldest go, the newest 50 stay)', async () => {
    const url = 'https://bound.example.org/feed.xml';
    const items = (n: number) => Array.from({ length: 3 }, (_, i) => ({ guid: `urn:x:${String(n - i)}`, title: `Synthetic headline ${String(n - i)}`, link: `https://bound.example.org/${String(n - i)}` }));
    h.sites.set(url, { headers: { 'content-type': 'application/rss+xml' }, body: rss(items(3)) });
    await watchOf('bound', { uri: url, source: { feed: {} }, trigger: { newItem: {} }, checkIntervalMinutes: 60 });
    for (let n = 4; n < 4 + 215; n++) {
      h.sites.set(url, { headers: { 'content-type': 'application/rss+xml' }, body: rss(items(n)) });
      await later(2);
    }
    const [count] = await h.sql<{ n: number }>('SELECT count(*) AS n FROM changes WHERE watch_id = ?', 'bound');
    expect(count?.n).toBe(200);
    const [newest] = await changes('bound');
    expect(newest?.diffLines.some((line) => line.text.includes('Synthetic headline 218'))).toBe(true);
  });
});

describe('shadow mode', () => {
  it('records what the rules would drop as CONFIRMED with its reason, for 7 days', async () => {
    const url = 'https://shadow.example.com/p';
    h.sites.html(url, page('P', '<p>Stock count 10 and the rest of the text.</p>'));
    const created = await watchOf('shadow', { uri: url, shadowMode: true, trigger: { anyChange: { minChangedLines: 5 } }, stability: { skipConfirmation: true } });
    expect(created.shadowMode).toBe(true);
    expect(created.shadowEndTime).toBeDefined();
    h.sites.html(url, page('P', '<p>Stock count 9 and the rest of the text.</p>'));
    await later();
    const [shadowed] = await changes('shadow');
    expect(shadowed?.state).toBe(Change_State.CONFIRMED);
    expect(shadowed?.shadow).toBe(true);
    expect(shadowed?.suppressionReason).toBe(Change_SuppressionReason.BELOW_THRESHOLD);
    // After 7 days the same kind of difference is dropped again.
    clock += 8 * DAY;
    await h.clock(clock);
    expect((await h.api.getWatch({ name: 'watches/shadow' })).shadowMode).toBe(false);
    h.sites.html(url, page('P', '<p>Stock count 8 and the rest of the text.</p>'));
    await h.run(clock);
    const [dropped] = await changes('shadow');
    expect(dropped?.state).toBe(Change_State.SUPPRESSED);
    expect(dropped?.shadow).toBe(false);
  });
});
