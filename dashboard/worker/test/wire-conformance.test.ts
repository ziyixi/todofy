/**
 * The conformance check of wire-conformance.ts bites: every way a hand-serialized view could drift from
 * dashboard.ui.v1 is refused. (The views themselves are checked where they are built: views.test.ts, registry.test.ts
 * and the workerd suite.)
 */
import { describe, expect, it } from 'vitest';
import { registryBody } from '../src/registry.ts';
import { nonConformance, VIEW_SCHEMAS } from './wire-conformance.ts';

const body = registryBody('abc123');
const value = JSON.parse(body) as Record<string, unknown>;

describe('the conformance check', () => {
  it('accepts the registry as the Worker serializes it', () => {
    expect(nonConformance(VIEW_SCHEMAS.registry, body)).toBeNull();
  });

  it('refuses a field the IDL does not have', () => {
    expect(nonConformance(VIEW_SCHEMAS.registry, JSON.stringify({ ...value, version: 'home-v2' }))).toMatch(/does not know version/);
  });

  it('refuses a missing REQUIRED field and a wrong type', () => {
    const withoutBuild = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'build'));
    expect(nonConformance(VIEW_SCHEMAS.registry, JSON.stringify(withoutBuild))).toMatch(/refuses/);
    expect(nonConformance(VIEW_SCHEMAS.registry, JSON.stringify({ ...value, build: 7 }))).toMatch(/refuses/);
  });

  it('refuses fields out of their numbered order', () => {
    const { name, build, ...rest } = value;
    expect(nonConformance(VIEW_SCHEMAS.registry, JSON.stringify({ build, name, ...rest }))).toMatch(/other bytes/);
  });

  it('refuses a value outside an allowed list and an enum name the IDL does not have', () => {
    const entries = value['entries'] as Record<string, unknown>[];
    const icon = { ...value, entries: [{ ...entries[0], icon: 'rocket' }, ...entries.slice(1)] };
    expect(nonConformance(VIEW_SCHEMAS.registry, JSON.stringify(icon))).toMatch(/refuses/);
    const resources = value['resources'] as Record<string, unknown>[];
    const kind = { ...value, resources: [{ ...resources[0], kind: 'kv' }, ...resources.slice(1)] };
    expect(nonConformance(VIEW_SCHEMAS.registry, JSON.stringify(kind))).toMatch(/does not know/);
  });

  it('keeps timestamps as written, whole seconds and milliseconds alike (the format Timestamp is a string)', () => {
    const refresh = { last_tick_at: '2026-10-01T11:59:00.000Z', next_tick_at: '2026-10-01T12:30:00Z', last_refresh_at: null, next_refresh_at: '2026-10-01T12:00:00.500Z', refreshed: false };
    const view = {
      name: 'flowsView',
      generated_at: '2026-10-01T12:00:00.000Z',
      rev: 1,
      build: 'test',
      attention: { level: 'unknown', items: [], info: [], held: [] },
      badges: { home: 0, flows: 0, cloudflare: 0, ops: 0 },
      refresh,
      flows: [],
    };
    expect(nonConformance(VIEW_SCHEMAS.flows, JSON.stringify(view))).toBeNull();
    expect(nonConformance(VIEW_SCHEMAS.flows, JSON.stringify({ ...view, generated_at: '2026-10-01 12:00' }))).toMatch(/refuses/);
  });
});
