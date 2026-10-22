/** Private Watch API and cursor feed over real service bindings, SQLite and synthetic pages. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { WatchUiService } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { Watch_NotifyPolicy } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { page } from '../fake-sites.ts';
import { DAY, HOUR, MINUTE, op, reasonOf, rejection, resetWatches, startHarness, T0, type Harness } from './harness.ts';

let h: Harness;
let clock = T0;
let client: ReturnType<typeof privateClient>;

function privateClient(harness: Harness) {
  return createHttpClient(WatchUiService, call => harness.serviceFetch(call.url, {
    method: call.httpMethod, ...(call.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: call.body }),
  }));
}

beforeAll(async () => { h = await startHarness({ tasks: true }); client = privateClient(h); });
afterEach(async () => { await resetWatches(h); await h.sql('DELETE FROM intents'); await h.tasks({}); await h.tasksState(); });
afterAll(async () => { await h.dispose(); });

async function at(now: number) { clock = now; await h.clock(clock); await h.run(clock); }
async function create(id: string, policy: Watch_NotifyPolicy = Watch_NotifyPolicy.NONE, confirm = false) {
  const uri = `https://${id}.example.com/page`;
  h.sites.html(uri, page('Synthetic release', '<p>Stable heading for context.</p><p>Version 1 is available.</p><p>Stable footer text.</p>'));
  const watch = await client.createWatch({ requestId: op(), watchId: id, watch: {
    displayName: id, uri, intent: 'Only tell me when a new version is available.', notifyPolicy: policy,
    stability: { skipConfirmation: !confirm, confirmDelayMinutes: confirm ? 60 : 0 }, checkIntervalMinutes: 60,
  } });
  await h.run(clock);
  return watch;
}

const changed = (uri: string, version: number) => h.sites.html(uri, page('Synthetic release', `<p>Stable heading for context.</p><p>Version ${String(version)} is available.</p><p>Stable footer text.</p>`));

describe('WatchApi', () => {
  it('requires binding capability, keeps the feed private and leaves browser authentication intact', async () => {
    await at(T0 + DAY);
    expect((await h.serviceFetch('/api/v1/watches', {}, '')).status).toBe(403);
    expect((await h.serviceFetch('/api/v1/watches', { method: 'POST', body: '{}' }, 'read')).status).toBe(403);
    expect((await h.serviceFetch('/api/v1/watches', {}, 'read')).status).toBe(200);
    expect((await h.serviceFetch('/health')).status).toBe(404);
    const publicFeed = await h.fetch('/api/v1/watchEvents:poll?baseline=true', { headers: { 'x-watch-private-api': 'true' } });
    expect(publicFeed.status).toBe(403);
    expect((await h.fetch('/api/v1/watches', { method: 'POST', body: '{}' })).status).toBe(403);
    const watch = await create('private');
    expect(watch.intent).toContain('new version');
    expect(watch.notifyPolicy).toBe(Watch_NotifyPolicy.NONE);
    const updated = await client.updateWatch({ watch: { name: watch.name, etag: watch.etag, intent: 'Only important releases.' }, updateMask: { paths: ['intent'] }, requestId: op() });
    expect(updated.intent).toBe('Only important releases.');
    expect(updated.notifyPolicy).toBe(Watch_NotifyPolicy.NONE);
  });

  it('orders by confirmation, keeps NONE out of Tasks and remains readable after Tasks delivery', async () => {
    await at(T0 + 3 * DAY);
    const slow = await create('slow', Watch_NotifyPolicy.NONE, true);
    const fast = await create('fast', Watch_NotifyPolicy.DIGEST);
    changed(slow.uri, 2);
    await at(clock + 2 * HOUR);
    // Its candidate exists before the subscription, but is not confirmed yet.
    const baseline = await client.pollWatchEvents({ baseline: true });
    expect(baseline.events).toEqual([]);
    changed(fast.uri, 2);
    await client.checkWatch({ name: fast.name, requestId: op() });
    await at(clock + 20 * MINUTE);
    const first = await client.pollWatchEvents({ cursor: baseline.cursor, pageSize: 1 });
    expect(first.events.map(event => event.watch)).toEqual([fast.name]);
    await at(clock + 60 * MINUTE);
    const rest = await client.pollWatchEvents({ cursor: first.cursor });
    const events = [...first.events, ...rest.events];
    expect(events.map(event => event.watch).sort()).toEqual([fast.name, slow.name].sort());
    expect(events.every(event => event.change.startsWith(`${event.watch}/changes/`))).toBe(true);
    expect(events.map(event => Number(event.sequence))).toEqual(events.map(event => Number(event.sequence)).sort((a, b) => a - b));
    await at(T0 + 3 * DAY + 15 * HOUR);
    const tasks = await h.tasksState();
    expect(tasks.tasks).toHaveLength(1);
    expect(JSON.stringify(tasks.tasks)).toContain('fast');
    expect(JSON.stringify(tasks.tasks)).not.toContain('/watches/slow');
    expect((await client.pollWatchEvents({ cursor: baseline.cursor })).events).toHaveLength(2);
    const [pending] = await h.sql<{ n: number }>(`SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL`);
    expect(pending?.n).toBe(0);
    // Polling and acknowledging do not alter comparison state or suppress subsequent relevant differences.
    changed(slow.uri, 3);
    await at(clock + 2 * HOUR);
    await at(clock + 70 * MINUTE);
    expect((await client.pollWatchEvents({ cursor: rest.cursor })).events.map(event => event.watch)).toEqual([slow.name]);
  });

  it('freezes context independently of pruned snapshots and keeps intent edits out of the baseline', async () => {
    await at(T0 + 5 * DAY);
    const watch = await create('evidence');
    const baseline = await client.pollWatchEvents({ baseline: true });
    const [before] = await h.sql<{ baseline_id: number }>('SELECT baseline_id FROM watches WHERE id = ?', 'evidence');
    changed(watch.uri, 2);
    await at(clock + 2 * HOUR);
    const events = await client.pollWatchEvents({ cursor: baseline.cursor });
    const name = events.events[0]?.change ?? '';
    const evidence = await client.getChange({ name });
    expect(evidence.contextAvailable).toBe(true);
    expect(evidence.contextTruncated).toBe(false);
    expect(evidence.beforeContext).toContain('Version 1 is available.');
    expect(evidence.afterContext).toContain('Version 2 is available.');
    expect(evidence.afterContext).toContain('Stable heading for context.');
    for (let version = 3; version < 26; version++) { changed(watch.uri, version); await at(clock + 2 * HOUR); }
    expect(await h.sql('SELECT id FROM snapshots WHERE id = ?', before?.baseline_id ?? 0)).toEqual([]);
    const frozen = await client.getChange({ name });
    expect(frozen.beforeContext).toEqual(evidence.beforeContext);
    expect(frozen.afterContext).toEqual(evidence.afterContext);
    const [current] = await h.sql<{ baseline_id: number }>('SELECT baseline_id FROM watches WHERE id = ?', 'evidence');
    await client.updateWatch({ watch: { name: watch.name, intent: 'Reconsider this work goal.' }, updateMask: { paths: ['intent'] }, requestId: op() });
    await at(clock + 2 * HOUR);
    const [after] = await h.sql<{ baseline_id: number }>('SELECT baseline_id FROM watches WHERE id = ?', 'evidence');
    expect(after?.baseline_id).toBe(current?.baseline_id);
  });

  it('rejects expired cursors after the bounded feed is pruned, including when no rows remain', async () => {
    await at(T0 + 10 * DAY);
    const watch = await create('bounded');
    const baseline = await client.pollWatchEvents({ baseline: true });
    for (let index = 0; index < 501; index++) await h.sql(`INSERT INTO notifications (kind, watch_id, change_id, policy, created_at, delivered_at) VALUES ('watch_broken', 'bounded', NULL, 'digest', ?, ?)`, clock, clock);
    await client.pauseWatch({ name: watch.name, requestId: op() });
    await at(clock + HOUR);
    expect(reasonOf(await rejection(client.pollWatchEvents({ cursor: baseline.cursor })))).toBe('CURSOR_EXPIRED');
    const recent = await client.pollWatchEvents({ baseline: true });
    expect(recent.cursor).not.toBe(baseline.cursor);
    await at(clock + 31 * DAY);
    expect(await h.sql('SELECT id FROM notifications')).toEqual([]);
    const afterExpiry = await client.pollWatchEvents({ baseline: true });
    expect(afterExpiry.cursor).toBe(recent.cursor);
    expect((await client.pollWatchEvents({ cursor: afterExpiry.cursor })).events).toEqual([]);
    expect(reasonOf(await rejection(client.pollWatchEvents({ cursor: baseline.cursor })))).toBe('CURSOR_EXPIRED');
  });
});
