/** Owner requests use real Home SQLite receipts and synthetic service-binding responses only. */
import { afterEach, describe, expect, it } from 'vitest';
import type { HomeView, RequestWebsiteSyncResponse, WebsiteSyncRequestResult, WebsiteSyncStatus } from '../../src/api-types.ts';
import { answerProbes, NOW, PATHS, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => { await h?.dispose(); h = undefined; });
const ENDPOINT = '/api/v1/websiteSync:request';
const UUID = '84f79809-7db5-4d22-93a7-86ad06f00683';
const OTHER_UUID = '3192ebfb-321f-442d-9c8d-a38ee4e47db2';
const RUN_URL = 'https://github.com/example/cloud/actions/runs/12001';
const receipt = (id: string): WebsiteSyncRequestResult => ({ request_id: id, state: 'accepted', run_id: '12001', run_url: RUN_URL });
async function start() { const result = await startFlows({ bindings: { CANARY_ENABLED: 'false' } }); answerProbes(result); return result; }
async function request(harness: FlowHarness, id = UUID) { return harness.post(ENDPOINT, { request_id: id }); }

const DETAILS: WebsiteSyncStatus = {
  observed_at: new Date(NOW).toISOString(), next_check_at: new Date(NOW + 86_400_000).toISOString(),
  last_check: { checked_at: new Date(NOW).toISOString(), decision: 'unchanged', run_id: '12001', run_url: RUN_URL },
  last_publish: { verified_at: new Date(NOW - 86_400_000).toISOString(), worker_version_id: '47ba3ae6-017c-40ca-aab4-0e3cc58b722c', code_sha: 'a'.repeat(40), run_id: '12000', run_url: 'https://github.com/example/cloud/actions/runs/12000' },
};

describe('website content sync owner requests', () => {
  it('rejects unsafe requests before contacting the relay', async () => {
    h = await start();
    const noCsrf = await h.fetch(ENDPOINT, { method: 'POST', body: 'not json' });
    expect(noCsrf.status).toBe(403);
    expect((await request(h, 'not-a-uuid')).status).toBe(400);
    expect(await h.callsOf('notion-publish', 'requestSync')).toEqual([]);
    expect(await h.callsOf('notion-publish', 'getSyncRequest')).toEqual([]);
  });

  it('keeps the same accepted receipt across restart, other actions and elapsed days', async () => {
    h = await start();
    await h.answer('notion-publish', 'requestSync', { value: receipt(UUID) });
    const first = await request(h);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ request: receipt(UUID) });
    await h.tick(NOW);
    for (let i = 0; i < 18; i++) {
      expect((await h.post(PATHS.guard, { level: 'normal', app: 'mail-hero', request_id: crypto.randomUUID() })).status).toBe(200);
    }
    await h.redeploy({ DEV_NOW: new Date(NOW + 5 * 86_400_000).toISOString(), BUILD_SHA: 'restart' });
    expect(await (await request(h)).json()).toEqual({ request: receipt(UUID) });
    expect(await h.callsOf('notion-publish', 'requestSync')).toEqual([[{ request_id: UUID }]]);
    expect(await h.callsOf('notion-publish', 'getSyncRequest')).toEqual([]);
    const reused = await h.post(PATHS.guard, { level: 'normal', app: 'mail-hero', request_id: UUID });
    expect(reused.status).toBe(400);
  });

  it('resolves a lost response only through exact lookup after restart', async () => {
    h = await start();
    await h.answer('notion-publish', 'requestSync', { throw: 'unavailable' });
    const first = await (await request(h)).json() as RequestWebsiteSyncResponse;
    expect(first.request).toMatchObject({ request_id: UUID, state: 'unconfirmed' });
    await h.redeploy({ BUILD_SHA: 'restart' });
    await h.answer('notion-publish', 'getSyncRequest', { value: receipt(UUID) });
    expect(await (await request(h)).json()).toEqual({ request: receipt(UUID) });
    expect(await h.callsOf('notion-publish', 'requestSync')).toEqual([[{ request_id: UUID }]]);
    expect(await h.callsOf('notion-publish', 'getSyncRequest')).toEqual([[{ request_id: UUID }]]);
  });

  it('refuses a foreign lookup receipt and dispatches different owner IDs while a run is active', async () => {
    h = await start();
    await h.answer('notion-publish', 'requestSync', { throw: 'unavailable' });
    await (await request(h)).arrayBuffer();
    await h.answer('notion-publish', 'getSyncRequest', { value: receipt(OTHER_UUID) });
    expect((await (await request(h)).json() as RequestWebsiteSyncResponse).request.state).toBe('unconfirmed');
    await h.answer('notion-publish', 'status', { value: await status('notion-publish', {
      website_sync: { ...DETAILS, active_run: { run_id: '12001', run_url: RUN_URL, run_attempt: 1, state: 'checking', started_at: new Date(NOW).toISOString() } },
    }) });
    await h.tick(NOW);
    await h.answer('notion-publish', 'requestSync', { value: receipt(OTHER_UUID) });
    expect(await (await request(h, OTHER_UUID)).json()).toEqual({ request: receipt(OTHER_UUID) });
    expect(await h.callsOf('notion-publish', 'requestSync')).toEqual([[{ request_id: UUID }], [{ request_id: OTHER_UUID }]]);
  });

  it('keeps a dismissed failed run closed across refresh and reopens a different failed run', async () => {
    h = await start();
    const harness = h;
    const observe = async (run: string, started: number, at: number) => {
      const sync: WebsiteSyncStatus = { ...DETAILS, observed_at: new Date(at).toISOString(), latest_attempt: {
        run_id: run, run_url: `https://github.com/example/cloud/actions/runs/${run}`, run_attempt: 1, state: 'failed', started_at: new Date(started).toISOString(),
      } };
      await harness.redeploy({ DEV_NOW: new Date(at).toISOString() });
      await harness.answer('notion-publish', 'status', { value: await status('notion-publish', { health: 'degraded', website_sync: sync,
        signals: [{ code: 'website_sync_failed', severity: 'warning', metrics: { run_id: Number(run) }, since: new Date(started).toISOString() }],
      }) });
      await harness.tick(at);
      return (await harness.view<HomeView>('home')).body;
    };
    const first = await observe('12001', NOW, NOW);
    const item = first?.attention.items.find(item => item.code === 'website_sync_failed');
    if (!item?.name || !item.etag) throw new Error('missing synthetic reminder');
    const dismissed = await h.post(`/api/v1/${item.name}:dismiss`, { request_id: crypto.randomUUID(), etag: item.etag });
    expect(dismissed.status).toBe(200);
    const repeat = await observe('12001', NOW, NOW + 11 * 60_000);
    expect(repeat?.attention.items.some(item => item.code === 'website_sync_failed')).toBe(false);
    expect(repeat?.attention.dismissed_items?.some(item => item.code === 'website_sync_failed')).toBe(true);
    const newer = await observe('12002', NOW + 22 * 60_000, NOW + 22 * 60_000);
    expect(newer?.attention.items.some(item => item.code === 'website_sync_failed')).toBe(true);
  });

  it('keeps public HTTP availability separate and no-op checks preserve verified publication time', async () => {
    h = await start();
    await h.answer('notion-publish', 'status', { value: await status('notion-publish', { website_sync: DETAILS }) });
    await h.tick(NOW);
    const home = (await h.view<HomeView>('home')).body;
    expect(home?.website_sync).toEqual(DETAILS);
    expect(home?.entries.find(entry => entry.id === 'website')?.level).toBe('ok');
    expect(await h.callsOf('notion-publish', 'status')).toHaveLength(1);
    expect(await h.callsOf('notion-publish', 'getSyncStatus')).toEqual([]);
    const at = NOW + 31 * 60_000;
    await h.redeploy({ DEV_NOW: new Date(at).toISOString() });
    await h.answer('notion-publish', 'status', { value: await status('notion-publish', {
      health: 'degraded', website_sync: { ...DETAILS, observed_at: new Date(at).toISOString(), error_code: 'github_unavailable' },
      signals: [{ code: 'website_sync_provider_unavailable', severity: 'warning', metrics: {} }],
    }) });
    await h.tick(at);
    const unknown = (await h.view<HomeView>('home')).body;
    expect(unknown?.entries.find(entry => entry.id === 'website')?.level).toBe('ok');
    expect(unknown?.entries.find(entry => entry.id === 'notion-publish')?.level).toBe('unknown');
    expect(unknown?.attention.items.some(item => item.source === 'notion-publish' && item.code === 'app_down')).toBe(false);
    expect(unknown?.website_sync?.last_publish).toEqual(DETAILS.last_publish);
  });
});
