// Visits (src/visits.ts, src/focus.ts): splitting on a new document or page, revisions coalesced in the outbox, the
// 30-minute queueing of a visit that lasts, its ends (30 minutes without focus, six hours, 200 spans), and what the
// denylist and the scrubber leave of a URL and a title. Synthetic pages and tokens only.
import { describe, expect, it } from 'vitest';
import { scrubUrl } from '../../shared/scrub.ts';
import { normalizeUrl, pageIdOf, URL_MAX_CHARS } from '../../shared/url.ts';
import { beat, reconcile, tabChanged } from '../src/focus.ts';
import { ownerDenylist } from '../src/store.ts';
import { harness, MINUTE, SECOND, T0, WINDOW_ID_NONE } from './fake-chrome.ts';
import { openSpan, openVisits, queuedVisits, spansOf } from './helpers.ts';

const APP = 'https://app.example.com';
const HOUR = 60 * MINUTE;

describe('splitting', () => {
  it('a pushState to another URL starts a new visit, a plain fragment change does not', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(`${APP}/inbox`);
    await reconcile(ctx, T0);
    browser.pushState(tab.id, `${APP}/inbox#message-3`);
    await tabChanged(ctx, tab.id, T0 + 20 * SECOND);
    expect(await queuedVisits(ctx)).toEqual([]);

    browser.pushState(tab.id, `${APP}/settings`);
    await tabChanged(ctx, tab.id, T0 + 40 * SECOND);
    const [first] = await queuedVisits(ctx);
    expect(first).toMatchObject({ url: `${APP}/inbox`, revision: 1 });
    expect(first && spansOf(first)).toEqual([[T0, T0 + 40 * SECOND]]);
    const visits = await openVisits(ctx);
    expect(visits.map((visit) => visit.page.url)).toEqual([`${APP}/settings`]);
    expect((await openSpan(ctx, T0 + 40 * SECOND))?.visitId).toBe(visits[0]?.id);
  });

  it('a hash router\'s routes are pages of their own', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(`${APP}/#/projects/7`);
    await reconcile(ctx, T0);
    browser.pushState(tab.id, `${APP}/#/projects/8`);
    await tabChanged(ctx, tab.id, T0 + 5 * SECOND);
    expect((await queuedVisits(ctx)).map((visit) => visit.url)).toEqual([`${APP}/#/projects/7`]);
  });

  it('a new document in the same tab is a new visit, even on the same URL (a reload)', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(`${APP}/inbox`);
    await reconcile(ctx, T0);
    browser.navigate(tab.id, `${APP}/inbox`);
    await tabChanged(ctx, tab.id, T0 + 5 * SECOND);
    const [first] = await queuedVisits(ctx);
    expect(first && spansOf(first)).toEqual([[T0, T0 + 5 * SECOND]]);
    expect((await openVisits(ctx))[0]?.documentId).toBe(tab.documentId);
  });

  it('a background tab that leaves its page ends its visit', async () => {
    const { browser, ctx } = await harness();
    const first = browser.open(`${APP}/a`);
    await reconcile(ctx, T0);
    browser.open(`${APP}/b`);
    await reconcile(ctx, T0 + 30 * SECOND);
    browser.navigate(first.id, `${APP}/c`);
    await tabChanged(ctx, first.id, T0 + MINUTE);
    expect((await openVisits(ctx)).map((visit) => visit.page.url)).toEqual([`${APP}/b`]);
    // Ending queued nothing new: its last revision went when it lost the focus.
    expect((await queuedVisits(ctx)).map((visit) => [visit.url, visit.revision])).toEqual([[`${APP}/a`, 1]]);
  });
});

describe('revisions', () => {
  it('a visit that lasts is queued every 30 minutes, and the outbox keeps its newest revision only', async () => {
    const { browser, ctx } = await harness();
    browser.open(`${APP}/long-read`);
    await reconcile(ctx, T0);
    for (let minute = 1; minute <= 45; minute++) await beat(ctx, T0 + minute * MINUTE);
    const [atHalfHour] = await queuedVisits(ctx);
    expect(atHalfHour).toMatchObject({ revision: 1 });
    expect(atHalfHour && spansOf(atHalfHour)).toEqual([[T0, T0 + 30 * MINUTE]]);

    await reconcile(ctx, T0 + 45 * MINUTE, { windowId: WINDOW_ID_NONE });
    const visits = await queuedVisits(ctx);
    expect(visits).toHaveLength(1);
    expect(visits[0]?.revision).toBe(2);
    expect(visits[0] && spansOf(visits[0])).toEqual([
      [T0, T0 + 30 * MINUTE],
      [T0 + 30 * MINUTE, T0 + 45 * MINUTE],
    ]);
  });

  it('a visit without news is not queued again', async () => {
    const { browser, ctx } = await harness();
    browser.open(`${APP}/a`);
    await reconcile(ctx, T0);
    await reconcile(ctx, T0 + 10 * SECOND, { windowId: WINDOW_ID_NONE });
    for (let minute = 1; minute <= 20; minute++) await beat(ctx, T0 + minute * MINUTE);
    expect((await queuedVisits(ctx)).map((visit) => visit.revision)).toEqual([1]);
  });
});

describe('the ends of a visit', () => {
  it('thirty minutes without focus: the next focus starts a new visit', async () => {
    const { browser, ctx } = await harness();
    const tab = browser.open(`${APP}/a`);
    await reconcile(ctx, T0);
    browser.open(`${APP}/b`);
    await reconcile(ctx, T0 + 20 * SECOND);
    const firstId = (await queuedVisits(ctx))[0]?.id;
    for (let minute = 1; minute <= 31; minute++) await beat(ctx, T0 + minute * MINUTE);
    expect((await openVisits(ctx)).map((visit) => visit.page.url)).toEqual([`${APP}/b`]);

    browser.activate(tab.id);
    await reconcile(ctx, T0 + 32 * MINUTE);
    const span = await openSpan(ctx, T0 + 32 * MINUTE);
    expect(span?.tabId).toBe(tab.id);
    expect(span?.visitId).not.toBe(firstId);
  });

  it('six hours after the first focus, exactly', async () => {
    const { browser, ctx } = await harness();
    browser.open(`${APP}/dashboard`);
    await reconcile(ctx, T0);
    for (let minute = 1; minute <= 6 * 60 + 1; minute++) await beat(ctx, T0 + minute * MINUTE);
    const visits = await queuedVisits(ctx);
    const first = visits.find((visit) => spansOf(visit)[0]?.[0] === T0);
    const spans = first === undefined ? [] : spansOf(first);
    expect(spans.at(-1)?.[1]).toBe(T0 + 6 * HOUR);
    expect(spans).toHaveLength(12);
    // The next visit of the same tab began at the six-hour beat.
    const span = await openSpan(ctx, T0 + 6 * HOUR + MINUTE);
    expect(span?.visitId).not.toBe(first?.id);
    expect(span?.start).toBe(T0 + 6 * HOUR);
  });

  it('six hours even when the beat that ends it comes late', async () => {
    const { browser, ctx } = await harness();
    browser.open(`${APP}/dashboard`);
    await reconcile(ctx, T0);
    for (let minute = 1; minute < 6 * 60; minute++) await beat(ctx, T0 + minute * MINUTE);
    await beat(ctx, T0 + 6 * HOUR + 30 * SECOND);
    const first = (await queuedVisits(ctx)).find((visit) => spansOf(visit)[0]?.[0] === T0);
    expect(first && spansOf(first).at(-1)?.[1]).toBe(T0 + 6 * HOUR);
    expect((await openSpan(ctx, T0 + 6 * HOUR + 30 * SECOND))?.start).toBe(T0 + 6 * HOUR + 30 * SECOND);
  });

  it('two hundred spans', async () => {
    const { browser, ctx } = await harness();
    browser.open(`${APP}/chat-like`);
    let at = T0;
    for (let i = 0; i < 201; i++) {
      await reconcile(ctx, at, { windowId: 1 });
      await reconcile(ctx, at + 2 * SECOND, { windowId: WINDOW_ID_NONE });
      at += 4 * SECOND;
    }
    const visits = await queuedVisits(ctx);
    expect(visits.map((visit) => visit.focus_spans.length).sort((a, b) => b - a)).toEqual([200, 1]);
  });
});

describe('what a visit records of its page', () => {
  it('the normalized URL, scrubbed and cut, with the page ID of the whole URL before scrubbing', async () => {
    const { browser, ctx } = await harness();
    const raw = `${APP}/reset/AbCdEfGhIjKlMnOpQrStUv12?token=abc123&utm_source=mail&page=2`;
    browser.open(raw, { title: 'Reset · password: hunter2-example' });
    await reconcile(ctx, T0);
    await reconcile(ctx, T0 + 5 * SECOND, { windowId: WINDOW_ID_NONE });
    const normalized = normalizeUrl(raw)?.url ?? '';
    const [visit] = await queuedVisits(ctx);
    expect(visit).toMatchObject({
      url: `${APP}/reset/[redacted]?token=[redacted]&page=2`,
      title: 'Reset · password: [redacted]',
      page_id: await pageIdOf(normalized),
    });
    expect(visit?.url).toBe(scrubUrl(normalized));
    expect(visit?.url_truncated).toBeUndefined();
  });

  it('a URL longer than 8192 characters is cut and flagged, its page ID from the whole', async () => {
    const { browser, ctx } = await harness();
    const raw = `https://maps.example.com/?view=${'x'.repeat(9000)}`;
    browser.open(raw);
    await reconcile(ctx, T0);
    await reconcile(ctx, T0 + 5 * SECOND, { windowId: WINDOW_ID_NONE });
    const [visit] = await queuedVisits(ctx);
    expect(visit?.url).toHaveLength(URL_MAX_CHARS);
    expect(visit?.url_truncated).toBe(true);
    expect(visit?.page_id).toBe(await pageIdOf(raw));
  });

  it('a sensitive site by its site alone: its root URL, no title', async () => {
    const { browser, ctx } = await harness();
    browser.open('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWDsKmXbCdEfGh', { title: 'Inbox (3) - someone@example.com' });
    await reconcile(ctx, T0);
    await reconcile(ctx, T0 + 5 * SECOND, { windowId: WINDOW_ID_NONE });
    const [visit] = await queuedVisits(ctx);
    expect(visit).toMatchObject({ url: 'https://mail.google.com/', title: '', page_id: await pageIdOf('https://mail.google.com/') });
  });

  it('the owner\'s patterns from recall\'s answer keep the URL and title (they only stop the text)', async () => {
    const { browser, ctx } = await harness();
    await ownerDenylist.set(ctx.chrome, { patterns: ['bank.example.com'], siteOnly: [], etag: 'e1' });
    browser.open('https://bank.example.com/accounts', { title: 'Accounts' });
    await reconcile(ctx, T0);
    expect((await openVisits(ctx))[0]?.page).toMatchObject({ level: 'no_text', url: 'https://bank.example.com/accounts' });
  });
});
