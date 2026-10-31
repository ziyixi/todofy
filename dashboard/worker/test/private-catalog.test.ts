import { describe, expect, it } from 'vitest';
import fixture from './fixtures/private-catalog.json';
import inventory from '../src/account-inventory.json';
import { REGISTRY, registryView, outboundPerTick, outboundPerRefresh } from '../src/registry.ts';
import { DESIRED, compareDrift } from '../src/drift.ts';
import { homeCatalog, parsePrivateCatalog, PRIVATE_CATALOG_ERROR } from '../src/private-catalog.ts';
import { resourceRows, workerRows, mergeScripts } from '../src/discovery.ts';

const raw = JSON.stringify(fixture);

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("empty synthetic fixture");
  return item;
}

describe('optional private registration', () => {
  it('preserves public defaults and joins private IDs consistently across owner views and drift', () => {
    expect(homeCatalog()).toEqual({ registry: REGISTRY, desired: DESIRED });
    expect(homeCatalog('')).toEqual(homeCatalog());
    const catalog = homeCatalog(raw);
    expect(catalog.registry.entries).toHaveLength(REGISTRY.entries.length + 2);
    expect(catalog.desired.workers).toMatchObject(DESIRED.workers);
    expect(outboundPerTick(catalog.registry)).toBe(outboundPerTick() + 1);
    expect(outboundPerRefresh(catalog.registry)).toBe(outboundPerRefresh() + 1);
    const view = registryView('test', catalog.registry);
    expect(view.entries.find((entry) => entry.id === 'demo-one')).toMatchObject({ name: '演示one', scripts: ['demo-edge-one'] });
    expect(JSON.stringify(view)).not.toContain('/healthz');
    expect(JSON.stringify(view)).not.toContain('private/demo');
    const now = Date.parse('2026-10-01T14:00:00Z');
    const scripts = mergeScripts(null, ['demo-edge-one', 'unknown-extra'].map((script) => ({ script, requests: 10, errors: 0, subrequests: 0,
      cpu_p50_us: null, cpu_p99_us: null, do_requests: 0, do_errors: 0 })), false, now);
    expect(workerRows(scripts, now, catalog.registry).find((worker) => worker.script === 'demo-edge-one')?.entry).toBe('demo-one');
    expect(workerRows(scripts, now, catalog.registry).find((worker) => worker.script === 'unknown-extra')?.entry).toBeNull();
    expect(resourceRows({ d1: [], do: [], r2: [{ id: 'demo-store-one', size_bytes: 1, class_a: 0, class_b: 0 },
      { id: 'unknown-extra', size_bytes: 1, class_a: 0, class_b: 0 }] }, scripts, now, catalog.registry)).toMatchObject([
      { id: 'demo-store-one', resource: 'demo-store-one', entry: 'demo-one' }, { id: 'unknown-extra', resource: null, entry: null },
    ]);
    const findings = compareDrift(catalog.desired, { scripts: [...inventory.workers, 'demo-edge-one', 'demo-edge-two', 'unknown-extra'],
      domains: [], routes: [], changes: [], zones_unchecked: 0, truncated: false }, {});
    expect(findings.filter((finding) => finding.category === 'scripts')).toEqual([{ category: 'scripts', script: 'unknown-extra', name: 'unknown-extra', kind: 'extra' }]);
  });

  it('rejects malformed attachments, public identity collisions, unsupported sources and probes outside the owner zone', () => {
    const bad = (edit: (value: typeof fixture) => void): string => { const value = structuredClone(fixture); edit(value); return JSON.stringify(value); };
    for (const input of [' ', '{}', raw.repeat(20),
      bad((value) => { first(value.registry.entries).id = 'home'; }),
      bad((value) => { first(value.registry.workers).script = 'home'; }),
      bad((value) => { first(value.registry.resources).id = 'infra-state'; }),
      bad((value) => { first(value.registry.resources).match = 'infra-state'; }),
      bad((value) => { first(value.registry.entries).status.type = 'ops_v1'; }),
      bad((value) => { first(value.registry.entries).status.url = 'https://other.example/healthz'; }),
      bad((value) => { value.desired.workers['demo-edge-one'].custom_domains = ['home.ziyixi.science']; }),
      bad((value) => { value.desired.zones = ['other.example']; }),
      bad((value) => { value.desired.workers['demo-edge-one'].bindings.push({ name: 'STORE', type: 'r2_bucket', source: 'config' }); }),
    ]) expect(() => parsePrivateCatalog(input)).toThrow(PRIVATE_CATALOG_ERROR);
  });
});
