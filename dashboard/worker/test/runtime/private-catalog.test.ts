import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../fixtures/private-catalog.json';
import type { CloudflareView, HomeView, Registry } from '../../src/api-types.ts';
import { homeCatalog } from '../../src/private-catalog.ts';
import { outboundPerTick } from '../../src/registry.ts';
import { NOW, PATHS, startFlows, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => { await h?.dispose(); h = undefined; });
const raw = JSON.stringify(fixture);

describe('private catalog in the owner runtime', () => {
  it('uses one health fetch and the same private identities for registry, health, attention, resources and drift', async () => {
    const catalog = homeCatalog(raw);
    h = await startFlows({ bindings: { PRIVATE_CATALOG: raw }, desired: catalog.desired, usage: {
      scripts: [{ script: 'demo-edge-one', requests: 10, errors: 0, subrequests: 0 }, { script: 'unknown-extra', requests: 10, errors: 0, subrequests: 0 }],
      r2Storage: [{ bucketName: 'demo-store-one', payloadSize: 100, metadataSize: 10 }, { bucketName: 'unknown-extra', payloadSize: 10, metadataSize: 1 }],
    } });
    h.cloudflare.tweaks = { extraScripts: ['unknown-extra'] };
    let probes = 0;
    let probeStatus = 200;
    h.routes.set('https://demo-one.ziyixi.science/healthz', () => {
      probes++;
      return new Response('synthetic body', { status: probeStatus, headers: { 'content-type': 'text/plain' } });
    });
    const registry = await h.view<Registry>('registry');
    expect(registry.body?.entries.find((entry) => entry.id === 'demo-one')).toMatchObject({ name: '演示one', scripts: ['demo-edge-one'] });
    expect(JSON.stringify(registry.body)).not.toContain('/healthz');
    for (let step = 0; step < 5; step++) {
      await h.tick(NOW - (4 - step) * 30 * 60_000);
      expect([...await h.called(), ...h.outboundLog.splice(0)].length).toBeLessThanOrEqual(outboundPerTick(catalog.registry));
    }
    expect(probes).toBe(5);
    const home = await h.view<HomeView>('home');
    expect(home.body?.entries.find((entry) => entry.id === 'demo-one')).toMatchObject({ level: 'ok', reason: null });
    const cloudflare = await h.view<CloudflareView>('cloudflare');
    expect(cloudflare.body?.workers.find((worker) => worker.script === 'demo-edge-one')?.entry).toBe('demo-one');
    expect(cloudflare.body?.workers.find((worker) => worker.script === 'unknown-extra')?.entry).toBeNull();
    expect(cloudflare.body?.resources.find((resource) => resource.id === 'demo-store-one')).toMatchObject({ entry: 'demo-one', resource: 'demo-store-one' });
    expect(cloudflare.body?.resources.find((resource) => resource.id === 'unknown-extra')).toMatchObject({ entry: null, resource: null });
    expect(cloudflare.body?.drift.desired_workers).toBe(17);
    expect(cloudflare.body?.drift.findings.filter((finding) => finding.category === 'scripts')).toEqual([
      { category: 'scripts', script: 'unknown-extra', name: 'unknown-extra', kind: 'extra' },
    ]);
    // Probe failure follows the existing attention thresholds and poll interval.
    probeStatus = 503;
    await h.redeploy({ PRIVATE_CATALOG: raw, DEV_NOW: new Date(NOW + 60 * 60_000).toISOString() });
    await h.tick(NOW + 30 * 60_000);
    await h.tick(NOW + 60 * 60_000);
    const failed = await h.view<HomeView>('home');
    expect(failed.body?.attention.items.some((item) => item.source === 'demo-one' && item.target.entry === 'demo-one')).toBe(true);
    expect(failed.body?.entries.find((entry) => entry.id === 'demo-one')?.level).toBe('critical');
  });

  it('reports an invalid nonempty catalog explicitly after owner authentication', async () => {
    h = await startFlows({ bindings: { PRIVATE_CATALOG: '{"private":"synthetic-hidden-value"}' } });
    const response = await h.fetch(PATHS.registry);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('PRIVATE_CATALOG_INVALID');
    expect(text).not.toContain('synthetic-hidden-value');
    expect((await h.fetch('/health')).status).toBe(200);
  });
});
