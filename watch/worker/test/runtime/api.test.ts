/**
 * The owner API in workerd (proto/watch/ui/v1, ../../../docs/design.md §8): the HTTP surface (Access, CSRF, private
 * headers, the UI's paths), every rpc with its value rules and errors, AIP-134 masks, AIP-154 etags, AIP-155 request
 * IDs, AIP-158 page tokens and the AIP-160 filters, called through the shared typed client as the UI calls them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Change_State } from '@ziyixi/proto/watch/ui/v1/change_pb';
import { Watch_PauseReason, Watch_State, WatchSchema } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { readDetail } from '@ziyixi/proto/rpc-status';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { page } from '../fake-sites.ts';
import { HOUR, MINUTE, op, reasonOf, rejection, resetWatches, startHarness, T0, type Harness } from './harness.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await resetWatches(h);
});

afterAll(async () => {
  await h.dispose();
});

const URL_A = 'https://api-a.example.com/page';

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  return reasonOf(await rejection(promise));
}

describe('the HTTP surface', () => {
  it('answers every path with the private headers; the UI for any other path, /new included', async () => {
    for (const path of ['/', '/new', '/watches/x', '/api/v1/watches']) {
      const response = await h.fetch(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      await response.text();
    }
    const health = await h.fetch('/health');
    expect(await health.json()).toEqual({ service: 'watch', status: 'ok', build: 'test' });
    const unknown = await h.fetch('/api/nothing');
    expect(unknown.status).toBe(404);
    expect(reasonOf(await unknown.json())).toBe('NOT_FOUND');
    const post = await h.fetch('/', { method: 'POST' });
    expect(post.status).toBe(405);
    await post.text();
  });

  it('refuses a mutation without the CSRF token or from another origin, before reading it', async () => {
    const plain = await h.fetch('/api/v1/watches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'x', uri: URL_A }) });
    expect(plain.status).toBe(403);
    expect(reasonOf(await plain.json())).toBe('CSRF_FAILED');
    const token = await (await h.fetch('/api/csrf')).json<{ token: string }>();
    const foreign = await h.fetch('/api/v1/watches', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com', 'x-csrf-token': token.token }, body: '{}' });
    expect(foreign.status).toBe(403);
    await foreign.text();
    expect((await h.api.listWatches({})).watches).toEqual([]);
    // One log line per refusal: request ID, status and reason, never a path or a URL.
    const lines = h.logs.filter((line) => line.includes('CSRF_FAILED'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(['reason', 'request_id', 'status']);
  });

  it('local development only: /__dev/clock and /__dev/step drive WatchState with manual alarms over loopback', async () => {
    const clock = await h.fetch(`/__dev/clock?now=${String(T0 + HOUR)}`, { method: 'POST' });
    expect(await clock.json()).toEqual({ clock: T0 + HOUR });
    const step = await h.fetch(`/__dev/step?now=${String(T0 + HOUR)}`, { method: 'POST' });
    expect(await step.json()).toMatchObject({ requests: 0 });
    await h.clock(T0);
    // Without manual alarms the path is the UI's, like any other.
    const real = await startHarness({ bindings: { DEV_MANUAL_ALARMS: 'false' } });
    try {
      const response = await real.fetch(`/__dev/step?now=${String(T0)}`, { method: 'POST' });
      expect(response.status).toBe(405);
      await response.text();
    } finally {
      await real.dispose();
    }
  });

  it('needs Access without the dev bypass', async () => {
    const strict = await startHarness({ bindings: { DEV_AUTH_BYPASS: 'false' } });
    try {
      for (const path of ['/', '/api/v1/watches', '/api/csrf']) {
        const response = await strict.fetch(path);
        expect(response.status, path).toBe(401);
        expect(reasonOf(await response.json())).toBe('UNAUTHORIZED');
      }
      expect((await strict.fetch('/health')).status).toBe(200);
    } finally {
      await strict.dispose();
    }
  });
});

describe('watches', () => {
  it('CreateWatch: the defaults, the normalized URI, a generated ID, WATCH_EXISTS with the current watch', async () => {
    const created = await h.api.createWatch({ watchId: 'alpha', requestId: op(), watch: { displayName: ' Alpha ', uri: `${URL_A}#section` } });
    expect(created.name).toBe('watches/alpha');
    expect(created.displayName).toBe(' Alpha ');
    expect(created.uri).toBe(URL_A);
    expect(created.state).toBe(Watch_State.ACTIVE);
    expect(created.etag).not.toBe('');
    expect(Number(created.createTime?.seconds) * 1000).toBe(T0);
    expect(Number(created.health?.nextCheckTime?.seconds) * 1000).toBe(T0);
    const generated = await h.api.createWatch({ requestId: op(), watch: { displayName: 'b', uri: 'https://api-b.example.com/' } });
    expect(generated.name).toMatch(/^watches\/w[a-z0-9]{9}$/);
    const error = await rejection(h.api.createWatch({ watchId: 'alpha', requestId: op(), watch: { displayName: 'again', uri: URL_A } }));
    expect(reasonOf(error)).toBe('WATCH_EXISTS');
    expect(error instanceof RpcStatusError && readDetail(error.status, WatchSchema)?.name).toBe('watches/alpha');
  });

  it('CreateWatch: every value rule has its reason', async () => {
    const cases: [Record<string, unknown>, string, string?][] = [
      [{ displayName: '', uri: URL_A }, 'BAD_REQUEST'],
      [{ displayName: 'x'.repeat(81), uri: URL_A }, 'BAD_REQUEST'],
      [{ displayName: 'x', uri: 'http://api-a.example.com/' }, 'INVALID_URI'],
      [{ displayName: 'x', uri: 'https://192.168.1.1/' }, 'INVALID_URI'],
      [{ displayName: 'x', uri: 'https://links.ziyixi.science/' }, 'INVALID_URI'],
      [{ displayName: 'x', uri: 'https://localhost/' }, 'INVALID_URI'],
      [{ displayName: 'x', uri: 'https://user:pass@api-a.example.com/' }, 'INVALID_URI'],
      [{ displayName: 'x', uri: 'https://api-a.example.com:8443/' }, 'INVALID_URI'],
      [{ displayName: 'x', uri: URL_A, source: { html: { includeSelectors: ['div:has(p)'] } } }, 'INVALID_SELECTOR'],
      [{ displayName: 'x', uri: URL_A, source: { html: { includeSelectors: Array.from({ length: 11 }, (_, i) => `p.c${String(i)}`) } } }, 'INVALID_SELECTOR'],
      [{ displayName: 'x', uri: URL_A, source: { feed: {}, json: {} } }, 'INVALID_SOURCE'],
      [{ displayName: 'x', uri: URL_A, source: { json: { path: '$..items' } } }, 'INVALID_SOURCE'],
      [{ displayName: 'x', uri: URL_A, trigger: { anyChange: {}, newItem: {} } }, 'INVALID_TRIGGER'],
      [{ displayName: 'x', uri: URL_A, trigger: { number: {} } }, 'INVALID_TRIGGER'],
      [{ displayName: 'x', uri: URL_A, trigger: { availability: {} } }, 'INVALID_TRIGGER'],
      [{ displayName: 'x', uri: URL_A, trigger: { textAppears: { text: '' } } }, 'INVALID_TRIGGER'],
      [{ displayName: 'x', uri: URL_A, checkIntervalMinutes: 30 }, 'INVALID_INTERVAL'],
      [{ displayName: 'x', uri: URL_A, checkIntervalMinutes: 10_081 }, 'INVALID_INTERVAL'],
      [{ displayName: 'x', uri: URL_A, ai: { enabled: true } }, 'AI_NOT_AVAILABLE'],
      [{ displayName: 'x', uri: URL_A, fetcher: 2 }, 'BROWSER_NOT_AVAILABLE'],
      [{ displayName: 'x', uri: URL_A, requestLocale: 'en\r\nX-Evil: 1' }, 'BAD_REQUEST'],
      [{ displayName: 'x', uri: URL_A, stability: { confirmDelayMinutes: 5 } }, 'BAD_REQUEST'],
    ];
    for (const [watch, expected] of cases) {
      expect(await reason(h.api.createWatch({ requestId: op(), watch: watch as never })), JSON.stringify(watch)).toBe(expected);
    }
    expect(await reason(h.api.createWatch({ watchId: 'Upper', requestId: op(), watch: { displayName: 'x', uri: URL_A } }))).toBe('INVALID_WATCH_ID');
    // http: with the owner's allowance.
    const http = await h.api.createWatch({ requestId: op(), watch: { displayName: 'x', uri: 'http://api-a.example.com/', fetchPolicy: { allowHttp: true } } });
    expect(http.uri).toBe('http://api-a.example.com/');
    expect((await h.api.listWatches({})).watches).toHaveLength(1);
  });

  it('UpdateWatch: a mask replaces only its fields, a stale etag is ABORTED with the current watch, and a request ID replays', async () => {
    const created = await h.api.createWatch({ watchId: 'upd', requestId: op(), watch: { displayName: 'Before', uri: URL_A, notifyPolicy: 2, normalize: { maskNumbers: true } } });
    const requestId = op();
    const updated = await h.api.updateWatch({ watch: { name: 'watches/upd', etag: created.etag, displayName: 'After' }, updateMask: { paths: ['display_name', 'etag'] }, requestId });
    expect(updated.displayName).toBe('After');
    expect(updated.notifyPolicy).toBe(2);
    expect(updated.normalize?.maskNumbers).toBe(true);
    expect(updated.etag).not.toBe(created.etag);
    // The same request again answers the first response and changes nothing.
    const replay = await h.api.updateWatch({ watch: { name: 'watches/upd', etag: created.etag, displayName: 'Other' }, updateMask: { paths: ['display_name', 'etag'] }, requestId });
    expect(replay.displayName).toBe('After');
    expect(replay.etag).toBe(updated.etag);
    // The same ID for another rpc is refused.
    expect(await reason(h.api.pauseWatch({ name: 'watches/upd', requestId }))).toBe('BAD_REQUEST');
    // The mask names `etag`, so the client sends it (it sends only the masked fields).
    const stale = await rejection(h.api.updateWatch({ watch: { name: 'watches/upd', etag: created.etag, displayName: 'Lost' }, updateMask: { paths: ['display_name', 'etag'] }, requestId: op() }));
    expect(reasonOf(stale)).toBe('ETAG_MISMATCH');
    expect(stale instanceof RpcStatusError && readDetail(stale.status, WatchSchema)?.displayName).toBe('After');
    // A nested path.
    const nested = await h.api.updateWatch({ watch: { name: 'watches/upd', normalize: { ignoredLines: ['noise'] } }, updateMask: { paths: ['normalize.ignored_lines'] }, requestId: op() });
    expect(nested.normalize?.ignoredLines).toEqual(['noise']);
    expect(nested.normalize?.maskNumbers).toBe(true);
    // Without a mask every field the owner sets is replaced.
    const all = await h.api.updateWatch({ watch: { name: 'watches/upd', displayName: 'Whole', uri: URL_A }, requestId: op() });
    expect(all.notifyPolicy).toBe(0);
    expect(all.normalize).toBeUndefined();
    expect(await reason(h.api.updateWatch({ watch: { name: 'watches/missing', displayName: 'x', uri: URL_A }, requestId: op() }))).toBe('NOT_FOUND');
  });

  it('Pause, Resume, Check, Delete with etags; Delete takes the changes along', async () => {
    h.sites.html(URL_A, page('A', '<p>Some text that stays the same for this test.</p>'));
    const created = await h.api.createWatch({ watchId: 'life', requestId: op(), watch: { displayName: 'Life', uri: URL_A } });
    const paused = await h.api.pauseWatch({ name: 'watches/life', etag: created.etag, requestId: op() });
    expect(paused.state).toBe(Watch_State.PAUSED);
    expect(paused.pauseReason).toBe(Watch_PauseReason.OWNER);
    expect(paused.health?.nextCheckTime).toBeUndefined();
    expect(await reason(h.api.resumeWatch({ name: 'watches/life', etag: created.etag, requestId: op() }))).toBe('ETAG_MISMATCH');
    // A paused watch is not checked; CheckWatch checks it once and it stays paused.
    await h.run(T0 + HOUR);
    expect(h.sites.requestsTo(URL_A)).toEqual([]);
    await h.api.checkWatch({ name: 'watches/life', requestId: op() });
    await h.run(T0 + HOUR);
    expect(h.sites.requestsTo(URL_A)).toHaveLength(1);
    const still = await h.api.getWatch({ name: 'watches/life' });
    expect(still.state).toBe(Watch_State.PAUSED);
    expect(still.health?.lastCheckTime).toBeDefined();
    const resumed = await h.api.resumeWatch({ name: 'watches/life', etag: still.etag, requestId: op() });
    expect(resumed.state).toBe(Watch_State.ACTIVE);
    await h.api.deleteWatch({ name: 'watches/life', etag: resumed.etag, requestId: op() });
    expect(await reason(h.api.getWatch({ name: 'watches/life' }))).toBe('NOT_FOUND');
    expect(await h.sql('SELECT id FROM snapshots WHERE watch_id = ?', 'life')).toEqual([]);
    expect(await reason(h.api.deleteWatch({ name: 'watches/life', requestId: op() }))).toBe('NOT_FOUND');
  });

  it('ListWatches: newest first, a filter on the name and the URI, page tokens bound to the filter', async () => {
    for (let n = 0; n < 5; n++) {
      await h.clock(T0 + n * MINUTE);
      await h.api.createWatch({ watchId: `list-${String(n)}`, requestId: op(), watch: { displayName: n % 2 === 0 ? `Even ${String(n)}` : `Odd ${String(n)}`, uri: `https://list${String(n)}.example.com/` } });
    }
    await h.clock(T0);
    const first = await h.api.listWatches({ pageSize: 2 });
    expect(first.watches.map((watch) => watch.name)).toEqual(['watches/list-4', 'watches/list-3']);
    const second = await h.api.listWatches({ pageSize: 2, pageToken: first.nextPageToken });
    expect(second.watches.map((watch) => watch.name)).toEqual(['watches/list-2', 'watches/list-1']);
    const filtered = await h.api.listWatches({ filter: 'even' });
    expect(filtered.watches.map((watch) => watch.name)).toEqual(['watches/list-4', 'watches/list-2', 'watches/list-0']);
    expect((await h.api.listWatches({ filter: '"list3.example"' })).watches.map((watch) => watch.name)).toEqual(['watches/list-3']);
    expect(await reason(h.api.listWatches({ pageSize: 2, pageToken: first.nextPageToken, filter: 'even' }))).toBe('BAD_REQUEST');
    expect(await reason(h.api.listWatches({ filter: 'a OR b' }))).toBe('BAD_REQUEST');
    expect(await reason(h.api.listWatches({ pageSize: -1 }))).toBe('BAD_REQUEST');
  });
});

describe('changes', () => {
  it('the inbox across watches, the drawer, acknowledge rules, and page tokens', async () => {
    const url = 'https://changes.example.com/p';
    h.sites.html(url, page('C', '<p>Line one of the synthetic page.</p><p>Line two.</p>'));
    await h.api.createWatch({ watchId: 'chg', requestId: op(), watch: { displayName: '变化', uri: url, stability: { skipConfirmation: true }, trigger: { anyChange: { minChangedLines: 3 } } } });
    await h.run(T0);
    h.sites.html(url, page('C', '<p>Line one of the synthetic page, edited.</p><p>Line two.</p>'));
    await h.run(T0 + 8 * HOUR);
    h.sites.html(url, page('C', '<p>All new text here.</p><p>And here.</p><p>And a third line.</p>'));
    await h.run(T0 + 16 * HOUR);
    const inbox = await h.api.listChanges({ parent: 'watches/-', filter: 'state = NEW' });
    expect(inbox.changes).toHaveLength(1);
    expect(inbox.changes[0]?.watchDisplayName).toBe('变化');
    const drawer = await h.api.listChanges({ parent: 'watches/-', filter: 'state=SUPPRESSED' });
    expect(drawer.changes).toHaveLength(1);
    const all = await h.api.listChanges({ parent: 'watches/chg', pageSize: 1 });
    expect(all.changes[0]?.state).toBe(Change_State.CONFIRMED);
    const next = await h.api.listChanges({ parent: 'watches/chg', pageSize: 1, pageToken: all.nextPageToken });
    expect(next.changes[0]?.state).toBe(Change_State.SUPPRESSED);
    expect(next.nextPageToken).toBe('');
    expect(await reason(h.api.listChanges({ parent: 'watches/-', pageToken: all.nextPageToken }))).toBe('BAD_REQUEST');
    expect(await reason(h.api.listChanges({ parent: 'watches/-', filter: 'state = new' }))).toBe('BAD_REQUEST');
    expect(await reason(h.api.listChanges({ parent: 'watches/nope' }))).toBe('NOT_FOUND');
    // Acknowledge: a confirmed change leaves the inbox; again is unchanged; a suppressed one cannot be.
    const name = inbox.changes[0]?.name ?? '';
    const acknowledged = await h.api.acknowledgeChange({ name, requestId: op() });
    expect(acknowledged.state).toBe(Change_State.ACKNOWLEDGED);
    expect((await h.api.acknowledgeChange({ name, requestId: op() })).acknowledgeTime).toEqual(acknowledged.acknowledgeTime);
    const suppressed = await rejection(h.api.acknowledgeChange({ name: drawer.changes[0]?.name ?? '', requestId: op() }));
    expect(reasonOf(suppressed)).toBe('BAD_REQUEST');
    expect(suppressed instanceof RpcStatusError && suppressed.status.httpStatus).toBe(400);
    expect((await h.api.getChange({ name })).state).toBe(Change_State.ACKNOWLEDGED);
    expect(await reason(h.api.getChange({ name: 'watches/chg/changes/0000000000000000' }))).toBe('NOT_FOUND');
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect([status.activeWatchCount, status.newChangeCount, status.suppressedChangeCount, status.browserEnabled]).toEqual([1, 0, 1, false]);
    expect(status.build).toBe('test');
    expect(status.fetchCountToday).toBeGreaterThan(0);
  });
});
