/** Cached private read over the real HomeState SQL store; all source statuses are synthetic. */
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { ReadHomeResponseSchema } from '@ziyixi/proto/dashboard/mcp/v1/home_service_pb';
import { expectWire } from '../wire-conformance.ts';
import type { AttentionItem, OpsApp } from '../../src/api-types.ts';
import { REGISTRY } from '../../src/registry.ts';
import { NOW, answerProbes, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => { await h?.dispose(); h = undefined; });

async function read(after = 0): Promise<ReadHomeResponse> {
  if (!h) throw new Error('synthetic harness not started');
  const namespace = await h.mf.getDurableObjectNamespace('HOME', 'home');
  const stub = namespace.get(namespace.idFromName('home-v1')) as unknown as { readHome(after: number, at: number): Promise<ReadHomeResponse> };
  const snapshot = await stub.readHome(after, NOW);
  expectWire(ReadHomeResponseSchema, snapshot);
  return snapshot;
}

describe('private Home snapshot', () => {
  it('serves current cached services, source freshness and only undismissed episodes after the cursor', async () => {
    h = await startFlows({ bindings: { CANARY_ENABLED: 'false' } });
    const active = h;
    const apps = REGISTRY.entries.filter(entry => entry.status.type === 'ops_v1').map(entry => entry.id as OpsApp);
    answerProbes(h);
    await h.answer('mail-hero', 'status', { value: await status('mail-hero', {
      health: 'degraded', signals: [{ code: 'delivery_failed', severity: 'warning', metrics: { count: 2 } }],
    }) });
    await h.tick(NOW);
    await h.called();
    await Promise.all(apps.map(app => active.calls(app)));
    const outboundBefore = h.outboundLog.length;
    const baseline = await read();
    expect(baseline.refresh).toMatchObject({ last_tick_at: new Date(NOW).toISOString(), refreshed: false });
    expect(baseline.entries.find(entry => entry.id === 'mail-hero')?.level).toBe('warning');
    const episode = baseline.attention.find(item => item.item.code === 'delivery_failed');
    expect(episode?.occurrence_seq).toBeGreaterThan(0);
    expect((await read(baseline.head_seq)).attention).toEqual([]);
    const item = episode?.item;
    if (!item?.name || !item.etag) throw new Error('missing synthetic managed episode');
    const response = await h.post(`/api/v1/${item.name}:dismiss`, { etag: item.etag, request_id: crypto.randomUUID() });
    const dismissed = await response.json() as AttentionItem;
    expect(response.status).toBe(200);
    expect((await read()).attention.some(row => row.item.code === 'delivery_failed')).toBe(false);
    expect((await read()).head_seq).toBe(baseline.head_seq);
    await h.post(`/api/v1/${item.name}:restore`, { etag: dismissed.etag, request_id: crypto.randomUUID() });
    const restored = await read();
    expect(restored.attention.find(row => row.item.code === 'delivery_failed')?.occurrence_seq).toBe(episode?.occurrence_seq);
    expect((await read(baseline.head_seq)).attention).toEqual([]);
    expect(await h.called()).toEqual([]);
    expect((await Promise.all(apps.map(app => active.calls(app)))).flat()).toEqual([]);
    expect(h.outboundLog.length).toBe(outboundBefore);
    await h.redeploy({ BUILD_SHA: 'synthetic-home-restart' });
    expect((await read()).attention.find(row => row.item.code === 'delivery_failed')?.occurrence_seq).toBe(episode?.occurrence_seq);
  });
});
