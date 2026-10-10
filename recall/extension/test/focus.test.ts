// The focus state machine (src/focus.ts): window and tab changes, idle backdating, the lock, worker and browser
// restarts, sleep gaps, and what never leaves a visit. Synthetic pages on example.com and example.org.
import { describe, expect, it } from 'vitest';
import { normalizeUrl, pageIdOf } from '../../shared/url.ts';
import { beat, browserStarted, idleChanged, reconcile, tabChanged, tabRemoved } from '../src/focus.ts';
import { harness, MINUTE, SECOND, T0, WINDOW_ID_NONE } from './fake-chrome.ts';
import { openSpan, openVisits, queuedVisits, spansOf } from './helpers.ts';

const GUIDE = 'https://docs.example.com/guide/durable-objects';
const NEWS = 'https://news.example.org/2026/10/sqlite-fts5-chinese';

describe('the open span', () => {
  it('follows the active tab, and the tab that loses the focus queues its visit', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE, { title: 'Durable Objects' });
    await reconcile(ctx, T0);
    expect(await openSpan(ctx, T0)).toMatchObject({ start: T0 });

    browser.open(NEWS, { title: 'FTS5 与中文' });
    await reconcile(ctx, T0 + 30 * SECOND);

    const [visit, ...others] = await queuedVisits(ctx);
    expect(others).toEqual([]);
    expect(visit).toMatchObject({ revision: 1, url: GUIDE, title: 'Durable Objects', page_id: await pageIdOf(GUIDE) });
    expect(visit && spansOf(visit)).toEqual([[T0, T0 + 30 * SECOND]]);
    // The new tab's visit is open: nothing to upload yet.
    expect((await openVisits(ctx)).map((open) => open.page.url).sort()).toEqual([NEWS, GUIDE].sort());
  });

  it('closes while another app is in front, and the same visit takes the next span', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    await reconcile(ctx, T0);
    browser.focusedWindow = WINDOW_ID_NONE;
    await reconcile(ctx, T0 + 20 * SECOND, { windowId: WINDOW_ID_NONE });
    expect(await openSpan(ctx, T0 + 20 * SECOND)).toBeNull();

    browser.focusedWindow = 1;
    await reconcile(ctx, T0 + MINUTE, { windowId: 1 });
    await reconcile(ctx, T0 + 90 * SECOND, { windowId: WINDOW_ID_NONE });

    // One item for the visit: its newest revision, with both spans.
    const visits = await queuedVisits(ctx);
    expect(visits).toHaveLength(1);
    expect(visits[0]?.revision).toBe(2);
    expect(visits[0] && spansOf(visits[0])).toEqual([
      [T0, T0 + 20 * SECOND],
      [T0 + MINUTE, T0 + 90 * SECOND],
    ]);
  });

  it('backdates the end by the idle threshold when the owner goes idle, and ends at once on a lock', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    await reconcile(ctx, T0);
    await beat(ctx, T0 + MINUTE);
    browser.idle = 'idle';
    await idleChanged(ctx, 'idle', T0 + 2 * MINUTE);
    browser.idle = 'active';
    await idleChanged(ctx, 'active', T0 + 5 * MINUTE);
    browser.idle = 'locked';
    await idleChanged(ctx, 'locked', T0 + 6 * MINUTE);

    // Two minutes of focus whose last three were without input leave nothing; the lock ends the second span at once.
    const [visit] = await queuedVisits(ctx);
    expect(visit && spansOf(visit)).toEqual([[T0 + 5 * MINUTE, T0 + 6 * MINUTE]]);
    expect(await openSpan(ctx, T0 + 6 * MINUTE)).toBeNull();
  });

  it('keeps a long idle stretch out of the focus', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    await reconcile(ctx, T0);
    await beat(ctx, T0 + MINUTE);
    await beat(ctx, T0 + 2 * MINUTE);
    await beat(ctx, T0 + 3 * MINUTE);
    await beat(ctx, T0 + 4 * MINUTE);
    browser.idle = 'idle';
    await idleChanged(ctx, 'idle', T0 + 5 * MINUTE);
    const [visit] = await queuedVisits(ctx);
    expect(visit && spansOf(visit)).toEqual([[T0, T0 + 2 * MINUTE]]);
  });

  it('survives the worker being restarted: the span lives in storage', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    await reconcile(ctx, T0);
    // A new worker: the same storage and database, no globals.
    const restarted = { ...ctx };
    await reconcile(restarted, T0 + 20 * SECOND);
    expect(await openSpan(restarted, T0 + 20 * SECOND)).toMatchObject({ start: T0 });
    expect(await queuedVisits(ctx)).toEqual([]);
  });

  it('closes a span at the last beat after a silence (the Mac asleep), never at the next event', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    await reconcile(ctx, T0);
    await beat(ctx, T0 + MINUTE);
    // Asleep for ten minutes, the same tab in front on waking.
    await beat(ctx, T0 + 11 * MINUTE);

    const [visit] = await queuedVisits(ctx);
    expect(visit && spansOf(visit)).toEqual([[T0, T0 + MINUTE]]);
    // The same visit goes on (ten minutes without focus is not thirty).
    expect(await openSpan(ctx, T0 + 11 * MINUTE)).toMatchObject({ visitId: visit?.id, start: T0 + 11 * MINUTE });
  });

  it('starts a new visit after a silence longer than thirty minutes', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    await reconcile(ctx, T0);
    await beat(ctx, T0 + MINUTE);
    await beat(ctx, T0 + 2 * 60 * MINUTE);
    const [visit] = await queuedVisits(ctx);
    expect(visit && spansOf(visit)).toEqual([[T0, T0 + MINUTE]]);
    expect((await openSpan(ctx, T0 + 2 * 60 * MINUTE))?.visitId).not.toBe(visit?.id);
  });

  it('after a browser restart closes the mirrored span at its last beat and ends the last session\'s visits', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    browser.open(NEWS, { active: false });
    await reconcile(ctx, T0);
    await beat(ctx, T0 + MINUTE);
    browser.restart();
    browser.open(NEWS);
    await browserStarted(ctx, T0 + 3 * 60 * MINUTE);

    const [visit] = await queuedVisits(ctx);
    expect(visit && spansOf(visit)).toEqual([[T0, T0 + MINUTE]]);
    const open = await openVisits(ctx);
    expect(open.map((v) => v.page.url)).toEqual([NEWS]);
    expect(open[0]?.spans).toEqual([]);
  });
});

describe('what leaves no visit', () => {
  it('a page with less than a second of focus', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(GUIDE);
    await reconcile(ctx, T0);
    browser.open(NEWS);
    await reconcile(ctx, T0 + 600);
    browser.close(tab.id);
    await tabRemoved(ctx, tab.id, T0 + SECOND);
    expect(await queuedVisits(ctx)).toEqual([]);
  });

  it('a background tab, its navigations and its closing', async () => {
    const { browser, ctx } = await harness();
    browser.open(GUIDE);
    await reconcile(ctx, T0);
    const background = browser.open(NEWS, { active: false });
    await tabChanged(ctx, background.id, T0 + SECOND);
    browser.navigate(background.id, 'https://news.example.org/redirected');
    await tabChanged(ctx, background.id, T0 + 2 * SECOND);
    browser.close(background.id);
    await tabRemoved(ctx, background.id, T0 + 3 * SECOND);
    expect((await openVisits(ctx)).map((visit) => visit.page.url)).toEqual([GUIDE]);
    expect(await queuedVisits(ctx)).toEqual([]);
  });

  it('recall\'s own pages, pages that are not http(s), and incognito tabs', async () => {
    for (const url of ['https://recall.ziyixi.science/search?q=durable', 'chrome://settings/', 'file:///Users/example/notes.txt', 'chrome-extension://abc/page.html']) {
      const { browser, ctx } = await harness();
      browser.open(url, { title: 'x' });
      await reconcile(ctx, T0);
      await reconcile(ctx, T0 + MINUTE, { windowId: WINDOW_ID_NONE });
      expect(await openVisits(ctx), url).toEqual([]);
    }
    const { browser, ctx } = await harness();
    browser.open(GUIDE, { incognito: true });
    await reconcile(ctx, T0);
    expect(await openVisits(ctx)).toEqual([]);
  });

  it('a page from the back/forward cache or a prerender is not the tab\'s document', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(GUIDE);
    tab.lifecycle = 'prerender';
    await reconcile(ctx, T0);
    expect(await openVisits(ctx)).toEqual([]);
  });
});

describe('events deduplicated on the document', () => {
  it('a second commit, title or update of the same document and page changes nothing', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(GUIDE, { title: 'Guide' });
    await reconcile(ctx, T0);
    const before = await openSpan(ctx, T0);
    await tabChanged(ctx, tab.id, T0 + SECOND);
    await tabChanged(ctx, tab.id, T0 + 2 * SECOND);
    expect(await openSpan(ctx, T0 + 2 * SECOND)).toEqual(before);
    expect(await queuedVisits(ctx)).toEqual([]);
  });

  it('a new title is the visit\'s title, scrubbed', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(GUIDE, { title: 'Guide' });
    await reconcile(ctx, T0);
    tab.title = 'Guide · api_key=sk_example_000000';
    await tabChanged(ctx, tab.id, T0 + 5 * SECOND);
    await reconcile(ctx, T0 + 10 * SECOND, { windowId: WINDOW_ID_NONE });
    const [visit] = await queuedVisits(ctx);
    expect(visit?.title).toBe('Guide · api_key=[redacted]');
  });

  it('uses the normalized URL: tracking parameters and plain fragments are the same page', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(`${GUIDE}?utm_source=feed`);
    await reconcile(ctx, T0);
    browser.pushState(tab.id, `${GUIDE}#alarms`);
    await tabChanged(ctx, tab.id, T0 + 5 * SECOND);
    await reconcile(ctx, T0 + 10 * SECOND, { windowId: WINDOW_ID_NONE });
    const visits = await queuedVisits(ctx);
    expect(visits).toHaveLength(1);
    expect(visits[0]?.url).toBe(normalizeUrl(GUIDE)?.url);
    expect(visits[0] && spansOf(visits[0])).toEqual([[T0, T0 + 10 * SECOND]]);
  });
});
