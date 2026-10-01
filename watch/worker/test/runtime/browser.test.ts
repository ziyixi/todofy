/**
 * Fetch tier 3 in workerd (../../../docs/design.md §4), behind its feature flag: with a (fake) browser binding, a
 * FETCHER_BROWSER watch is rendered through the `content` quick action; the app's own ledger stops renders at 480
 * seconds a day and a 429 from Browser Run marks the day exhausted, which shows as JS_QUOTA_EXHAUSTED until 00:00 UTC,
 * never as "no change". A failed render is charged too, and where the browser ended up obeys the redirect rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FailureReason, Watch_Fetcher } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { page } from '../fake-sites.ts';
import { DAY, HOUR, op, startHarness, T0, type Harness } from './harness.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ browser: true });
});

afterAll(async () => {
  await h.dispose();
});

describe('the browser tier', () => {
  it('renders, counts its seconds, and stops at the daily ledger', async () => {
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.browserEnabled).toBe(true);
    expect(status.browserLimitMs).toBe(480_000);
    const url = 'https://spa.example.com/app';
    h.browser.pages.set(url, page('App', '<p>Rendered by JavaScript: 42 items in stock.</p>'));
    h.browser.msUsed = 200_000;
    const created = await h.api.createWatch({ watchId: 'spa', requestId: op(), watch: { displayName: 'spa', uri: url, fetcher: Watch_Fetcher.BROWSER } });
    expect(created.checkIntervalMinutes).toBe(0);
    await h.run(T0);
    expect(h.browser.calls).toEqual([url]);
    // The page itself was never fetched by HTTP (only robots.txt).
    expect(h.sites.requestsTo(url)).toEqual([]);
    expect((await h.api.getWatch({ name: 'watches/spa' })).health?.lastFailure).toBe(FailureReason.UNSPECIFIED);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).browserUsedMs).toBe(200_000);

    // 400 s used after the second render; a third would pass 480 s with its reserve.
    await h.api.checkWatch({ name: 'watches/spa', requestId: op() });
    await h.run(T0 + HOUR);
    await h.api.checkWatch({ name: 'watches/spa', requestId: op() });
    await h.clock(T0 + 2 * HOUR);
    await h.run(T0 + 2 * HOUR);
    expect(h.browser.calls).toHaveLength(3);
    await h.clock(T0 + 3 * HOUR);
    await h.api.checkWatch({ name: 'watches/spa', requestId: op() });
    await h.run(T0 + 3 * HOUR);
    expect(h.browser.calls).toHaveLength(3);
    const watch = await h.api.getWatch({ name: 'watches/spa' });
    expect(watch.health?.lastFailure).toBe(FailureReason.JS_QUOTA_EXHAUSTED);
    // The next try is after 00:00 UTC.
    expect(Number(watch.health?.nextCheckTime?.seconds) * 1000).toBeGreaterThanOrEqual(T0 + DAY);
    const exhausted = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(exhausted.browserQuotaExhausted).toBe(true);
    expect(Number(exhausted.browserQuotaResetTime?.seconds) * 1000).toBe(T0 + DAY);
  });

  it('a 429 from Browser Run exhausts the day; the next day renders again', async () => {
    const day = T0 + DAY;
    await h.clock(day);
    h.browser.quota = true;
    h.browser.msUsed = 10_000;
    const url = 'https://spa2.example.com/app';
    h.browser.pages.set(url, page('App', '<p>Another page that needs JavaScript to show its text.</p>'));
    await h.api.createWatch({ watchId: 'spa2', requestId: op(), watch: { displayName: 'spa2', uri: url, fetcher: Watch_Fetcher.BROWSER } });
    await h.run(day);
    expect((await h.api.getWatch({ name: 'watches/spa2' })).health?.lastFailure).toBe(FailureReason.JS_QUOTA_EXHAUSTED);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).browserQuotaExhausted).toBe(true);
    h.browser.quota = false;
    const calls = h.browser.calls.length;
    // Its next try is the regular one (a day, moved by up to 10 %), never before 00:00 UTC.
    await h.clock(day + DAY + 3 * HOUR);
    await h.run(day + DAY + 3 * HOUR);
    expect(h.browser.calls.length).toBeGreaterThan(calls);
    expect((await h.api.getWatch({ name: 'watches/spa2' })).health?.lastFailure).toBe(FailureReason.UNSPECIFIED);
  });

  it('charges a render that failed (too large): failing JS watches cannot pass the daily ledger', async () => {
    const day = T0 + 3 * DAY;
    const url = 'https://big-spa.example.com/app';
    h.browser.quota = false;
    h.browser.pages.set(url, `<p>${'x'.repeat(2 * 1024 * 1024 + 10)}</p>`);
    h.browser.msUsed = 30_000;
    await h.clock(day);
    await h.api.createWatch({ watchId: 'bigspa', requestId: op(), watch: { displayName: 'b', uri: url, fetcher: Watch_Fetcher.BROWSER } });
    const before = h.browser.calls.length;
    for (let i = 0; i < 20; i++) {
      await h.clock(day + i * HOUR);
      await h.api.checkWatch({ name: 'watches/bigspa', requestId: op() });
      await h.run(day + i * HOUR);
    }
    const renders = h.browser.calls.length - before;
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    // 30 s reported per render: a render starts only with its 15 s reserve left, so 16 renders use exactly 480 s.
    expect(renders).toBe(16);
    expect(status.browserUsedMs).toBe(renders * 30_000);
    expect(status.browserQuotaExhausted).toBe(true);
    expect((await h.api.getWatch({ name: 'watches/bigspa' })).health?.lastFailure).toBe(FailureReason.JS_QUOTA_EXHAUSTED);
  });

  it('refuses a render that ended on a URL a watch may not fetch (an IP literal, the own zone)', async () => {
    const day = T0 + 5 * DAY;
    const url = 'https://moving-spa.example.com/app';
    h.browser.pages.set(url, page('App', '<p>Rendered after a script moved the page somewhere else.</p>'));
    h.browser.finalUrls.set(url, 'https://10.0.0.1/admin');
    h.browser.msUsed = 10_000;
    await h.clock(day);
    await h.api.createWatch({ watchId: 'moving', requestId: op(), watch: { displayName: 'm', uri: url, fetcher: Watch_Fetcher.BROWSER } });
    await h.run(day);
    expect((await h.api.getWatch({ name: 'watches/moving' })).health?.lastFailure).toBe(FailureReason.REDIRECT_REFUSED);
  });

  it('refuses a browser interval under 6 hours', async () => {
    const error = await h.api.createWatch({ requestId: op(), watch: { displayName: 'x', uri: 'https://spa3.example.com/', fetcher: Watch_Fetcher.BROWSER, checkIntervalMinutes: 60 } }).catch((reason: unknown) => reason);
    expect((error as { status?: { reason?: string } }).status?.reason).toBe('INVALID_INTERVAL');
  });
});
