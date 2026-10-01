/**
 * The fetch etiquette in workerd (../../../docs/design.md §4), observed from the synthetic sites' side: what each request
 * says about itself, robots.txt and its cache, the host's spacing and backoff, the page's own 15 minutes, redirects
 * checked hop by hop, the size and time limits, and an alarm's request budget.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FailureReason, Watch_State } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import type { MessageInitShape } from '@ziyixi/proto/protobuf';
import type { WatchSchema } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { page } from '../fake-sites.ts';
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

const body = page('P', '<p>A synthetic page with enough text to pass the gate.</p>');

async function create(id: string, watch: MessageInitShape<typeof WatchSchema>): Promise<void> {
  await h.api.createWatch({ watchId: id, requestId: op(), watch: { displayName: id, ...watch } });
}

async function at(time: number): Promise<void> {
  clock = time;
  await h.clock(clock);
}

async function failureOf(id: string): Promise<FailureReason | undefined> {
  return (await h.api.getWatch({ name: `watches/${id}` })).health?.lastFailure;
}

describe('every request', () => {
  it('names this agent, what the source reads and the watch\'s Accept-Language, and sends no credential', async () => {
    await at(clock + DAY);
    h.sites.html('https://agent.example.com/p', body);
    await create('agent', { uri: 'https://agent.example.com/p', requestLocale: 'en-GB,en;q=0.9' });
    await h.run(clock);
    const [robots, pageRequest] = h.sites.requestsTo('https://agent.example.com/', true);
    expect(robots?.url).toBe('https://agent.example.com/robots.txt');
    expect(pageRequest?.url).toBe('https://agent.example.com/p');
    expect(pageRequest?.headers['user-agent']).toMatch(/ziyixi-watch\/1\.0/);
    expect(pageRequest?.headers['accept']).toMatch(/^text\/markdown, text\/html;q=0\.9/);
    expect(pageRequest?.headers['accept-language']).toBe('en-GB,en;q=0.9');
    expect(pageRequest?.headers['cookie']).toBeUndefined();
    expect(pageRequest?.headers['authorization']).toBeUndefined();
  });

  it('the default Accept-Language is Chinese first', async () => {
    await at(clock + DAY);
    h.sites.html('https://locale.example.com/p', body);
    await create('locale', { uri: 'https://locale.example.com/p' });
    await h.run(clock);
    expect(h.sites.requestsTo('https://locale.example.com/p')[0]?.headers['accept-language']).toBe('zh-CN,zh;q=0.9,en;q=0.8');
  });
});

describe('robots.txt', () => {
  it('a disallowed page is never fetched (ROBOTS_DISALLOWED); the verdict is cached for a day; the owner may override', async () => {
    await at(clock + DAY);
    let robotsFetches = 0;
    h.sites.robots('https://robots.example.com', () => {
      robotsFetches += 1;
      return { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n\nUser-agent: ziyixi-watch\nDisallow: /secret\nAllow: /secret/ok\n' };
    });
    h.sites.html('https://robots.example.com/secret/page', body);
    h.sites.html('https://robots.example.com/private/page', body);
    await create('denied', { uri: 'https://robots.example.com/secret/page' });
    // The group naming this agent applies, not the `*` group.
    await create('allowed', { uri: 'https://robots.example.com/private/page' });
    await h.run(clock);
    expect(await failureOf('denied')).toBe(FailureReason.ROBOTS_DISALLOWED);
    expect(h.sites.requestsTo('https://robots.example.com/secret/page')).toEqual([]);
    expect(await failureOf('allowed')).toBe(FailureReason.UNSPECIFIED);
    expect(robotsFetches).toBe(1);
    // Within a day the cached verdict is used; after a day robots.txt is read again.
    await at(clock + 7 * HOUR);
    await h.run(clock);
    expect(robotsFetches).toBe(1);
    await at(clock + 20 * HOUR);
    await h.run(clock);
    expect(robotsFetches).toBe(2);
    // The owner's override (FetchPolicy.ignore_robots).
    const watch = await h.api.getWatch({ name: 'watches/denied' });
    await h.api.updateWatch({ watch: { name: watch.name, fetchPolicy: { ignoreRobots: true } }, updateMask: { paths: ['fetch_policy.ignore_robots'] }, requestId: op() });
    await at(clock + 7 * HOUR);
    await h.run(clock);
    expect(h.sites.requestsTo('https://robots.example.com/secret/page')).toHaveLength(1);
  });

  it('a robots.txt that answers 5xx disallows everything; a 404 allows everything', async () => {
    await at(clock + DAY);
    h.sites.robots('https://robots5xx.example.com', { status: 503, body: 'down' });
    h.sites.html('https://robots5xx.example.com/p', body);
    h.sites.html('https://robots404.example.com/p', body);
    await create('r5xx', { uri: 'https://robots5xx.example.com/p' });
    await create('r404', { uri: 'https://robots404.example.com/p' });
    await h.run(clock);
    expect(await failureOf('r5xx')).toBe(FailureReason.ROBOTS_DISALLOWED);
    expect(h.sites.requestsTo('https://robots5xx.example.com/p')).toEqual([]);
    expect(await failureOf('r404')).toBe(FailureReason.UNSPECIFIED);
  });
});

describe('spacing and backoff', () => {
  it('one host: the second page waits 30 seconds after the first started', async () => {
    await at(clock + DAY);
    h.sites.html('https://busy.example.com/a', body);
    h.sites.html('https://busy.example.com/b', body);
    await create('busy-a', { uri: 'https://busy.example.com/a' });
    await create('busy-b', { uri: 'https://busy.example.com/b' });
    await h.step(clock);
    const pages = () => h.sites.requests.filter((request) => request.url.startsWith('https://busy.example.com/') && !request.url.endsWith('/robots.txt'));
    expect(pages()).toHaveLength(1);
    const deferred = [await watchRow(h, 'busy-a'), await watchRow(h, 'busy-b')].find((row) => row['last_check_at'] === null);
    expect(deferred?.['next_check_at']).toBe(clock + 30_000);
    await h.step(clock + 29_000);
    expect(pages()).toHaveLength(1);
    await h.step(clock + 30_000);
    expect(pages()).toHaveLength(2);
  });

  it('429 with Retry-After: the host is not asked before it; 503 without one backs off 15 minutes, doubling', async () => {
    await at(clock + DAY);
    h.sites.set('https://limited.example.com/p', { status: 429, headers: { 'retry-after': '7200' }, body: 'slow down' });
    await create('limited', { uri: 'https://limited.example.com/p' });
    await h.run(clock);
    const watch = await h.api.getWatch({ name: 'watches/limited' });
    expect(watch.health?.lastFailure).toBe(FailureReason.RATE_LIMITED);
    expect(Number(watch.health?.backoffEndTime?.seconds) * 1000).toBe(clock + 2 * HOUR);
    // An owner's check waits for the backoff too.
    await h.api.checkWatch({ name: 'watches/limited', requestId: op() });
    await h.run(clock + HOUR);
    expect(h.sites.requestsTo('https://limited.example.com/p')).toHaveLength(1);

    h.sites.set('https://unavailable.example.com/p', { status: 503, body: 'busy' });
    await create('unavailable', { uri: 'https://unavailable.example.com/p' });
    await h.run(clock);
    const host = async () => (await h.sql<{ backoff_until: number; backoff_level: number }>('SELECT backoff_until, backoff_level FROM hosts WHERE host = ?', 'unavailable.example.com'))[0];
    expect(await host()).toEqual({ backoff_until: clock + 15 * MINUTE, backoff_level: 1 });
  });

  it('an owner\'s check runs at once, but never sooner than 15 minutes after the page\'s last fetch', async () => {
    await at(clock + DAY);
    h.sites.html('https://soon.example.com/p', body);
    await create('soon', { uri: 'https://soon.example.com/p' });
    await h.run(clock);
    await at(clock + 5 * MINUTE);
    const checked = await h.api.checkWatch({ name: 'watches/soon', requestId: op() });
    expect(Number(checked.health?.nextCheckTime?.seconds) * 1000).toBe(clock - 5 * MINUTE + 15 * MINUTE);
    await h.run(clock);
    expect(h.sites.requestsTo('https://soon.example.com/p')).toHaveLength(1);
    await h.run(clock + 10 * MINUTE);
    expect(h.sites.requestsTo('https://soon.example.com/p')).toHaveLength(2);
  });
});

describe('redirects, size and time', () => {
  it('follows a redirect to an allowed URL; refuses one to an IP literal, the own zone, http or a sixth hop', async () => {
    await at(clock + DAY);
    h.sites.set('https://moved.example.com/old', { status: 301, headers: { location: '/new' } });
    h.sites.html('https://moved.example.com/new', body);
    const targets = ['http://127.0.0.1/admin', 'https://home.ziyixi.science/', 'http://plain.example.com/', 'https://[::1]/'];
    targets.forEach((target, n) => h.sites.set(`https://evil${String(n)}.example.com/p`, { status: 302, headers: { location: target } }));
    for (let hop = 0; hop < 7; hop++) h.sites.set(`https://loop.example.com/${String(hop)}`, { status: 302, headers: { location: `/${String(hop + 1)}` } });
    await create('moved', { uri: 'https://moved.example.com/old' });
    for (const n of targets.keys()) await create(`evil${String(n)}`, { uri: `https://evil${String(n)}.example.com/p` });
    await create('loop', { uri: 'https://loop.example.com/0' });
    await h.run(clock);
    expect(await failureOf('moved')).toBe(FailureReason.UNSPECIFIED);
    for (const n of targets.keys()) expect(await failureOf(`evil${String(n)}`), targets[n]).toBe(FailureReason.REDIRECT_REFUSED);
    expect(await failureOf('loop')).toBe(FailureReason.REDIRECT_REFUSED);
    // The refused targets were never requested.
    expect(h.sites.requests.filter((request) => request.url.includes('127.0.0.1') || request.url.includes('ziyixi.science') || request.url.startsWith('http:'))).toEqual([]);
    expect(h.sites.requestsTo('https://loop.example.com/', true).filter((request) => !request.url.endsWith('robots.txt'))).toHaveLength(6);
  });

  it('a body over 2 MiB is TOO_LARGE; an answer slower than the timeout is TIMEOUT', async () => {
    await at(clock + DAY);
    h.sites.set('https://large.example.com/p', { headers: { 'content-type': 'text/html' }, body: `<html><body><p>${'x'.repeat(2 * 1024 * 1024 + 10)}</p></body></html>` });
    h.sites.set('https://slow.example.com/p', { headers: { 'content-type': 'text/html' }, body, delayMs: 1500 });
    await create('large', { uri: 'https://large.example.com/p' });
    await create('slow', { uri: 'https://slow.example.com/p' });
    await h.run(clock);
    expect(await failureOf('large')).toBe(FailureReason.TOO_LARGE);
    expect(await failureOf('slow')).toBe(FailureReason.TIMEOUT);
  });
});

describe('the alarm', () => {
  it('makes at most 40 external requests per pass and leaves the rest due for the next pass', async () => {
    await at(clock + DAY);
    for (let n = 0; n < 30; n++) {
      h.sites.html(`https://site${String(n)}.example.org/p`, body);
      await create(`many-${String(n)}`, { uri: `https://site${String(n)}.example.org/p` });
    }
    h.sites.clearRequests();
    const first = await h.step(clock);
    expect(first.requests).toBeLessThanOrEqual(40);
    expect(h.sites.requests.length).toBe(first.requests);
    expect(first.left).toBeGreaterThan(0);
    expect(first.next).toBe(clock + 1000);
    await h.run(clock + 1000);
    const { watches } = await h.api.listWatches({});
    expect(watches.filter((watch) => watch.health?.lastCheckTime === undefined)).toEqual([]);
    expect(watches.every((watch) => watch.state === Watch_State.ACTIVE)).toBe(true);
    // The day's ledger counts every request (robots.txt included).
    const [ledger] = await h.sql<{ fetches: number }>('SELECT fetches FROM ledger WHERE day = ?', new Date(clock).toISOString().slice(0, 10));
    expect(ledger?.fetches).toBeGreaterThanOrEqual(60);
  });
});
