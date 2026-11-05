import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { NewsletterConfigSync } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import type { Env } from '../src/env.ts';
import { statusSnapshot } from '../src/health.ts';
import { handleRequest } from '../src/http.ts';
import { CodexGatewayOps, NewsletterOps, Ops } from '../src/ops.ts';
import { handleReceipt } from '../src/receipt.ts';
import { freshness, MAX_REPORT_BYTES, parseReport, REPORT_KEY_ID, REPORT_PATH, ReceiptError, reportCodes } from '../src/report.ts';
import { FleetState } from '../src/state.ts';

function createFleetState(overrides: Partial<Env> = {}): { db: DatabaseSync; state: FleetState; env: Env } {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  const sql = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim();
      const stmt = db.prepare(trimmed);
      const params = bindings as (string | number | bigint | Uint8Array | null)[];
      if (/^(SELECT|PRAGMA|WITH)\b/i.test(trimmed)) {
        const rows = stmt.all(...params) as unknown as T[];
        return {
          toArray: () => rows,
          one: () => {
            const first = rows[0];
            if (rows.length !== 1 || !first) throw new Error(`Expected 1 row, got ${String(rows.length)}`);
            return first;
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      }
      stmt.run(...params);
      const empty: T[] = [];
      return {
        toArray: () => empty,
        one: () => { throw new Error('Expected 1 row'); },
        [Symbol.iterator]: () => empty[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  const ctx = {
    storage: {
      sql,
      transactionSync<T>(fn: () => T): T {
        const sp = `sp_${String(++depth)}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          const result = fn();
          db.exec(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          db.exec(`RELEASE SAVEPOINT ${sp}`);
          throw err;
        } finally {
          depth -= 1;
        }
      },
    },
  } as unknown as DurableObjectState;
  const holder: { state?: FleetState } = {};
  const env: Env = {
    FLEET: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => holder.state as unknown as DurableObjectStub<FleetState>,
    } as unknown as DurableObjectNamespace<FleetState>,
    ASSETS: { fetch: () => Promise.resolve(new Response('ok')) } as unknown as Fetcher,
    PUBLIC_HOST: 'fleet.example.test',
    ACCESS_ISSUER: 'https://issuer.example.test',
    ACCESS_AUDIENCE: 'b'.repeat(64),
    HOST_KEY: 'vps',
    HOST_EPOCH: '1',
    REPORT_HMAC_KEY: 'a'.repeat(64),
    BUILD_SHA: '1'.repeat(40),
    ...overrides,
  };
  const state = new FleetState(ctx, env);
  holder.state = state;
  return { db, state, env };
}

const NOW = Date.parse('2026-10-03T00:00:00Z');
const read = (value: unknown = fixture) => parseReport(JSON.stringify(value), 'vps', '1', NOW);

const NO_UNKNOWN = {
  interrupted_activities: 0, packets: 0, workflow_attempts: 0,
  notion_entities: 0, notion_versions: 0, delivery: 0,
};
/** A classified observer report with old unknown records, delivered 2 h before NOW unless changed. */
const historicalUnknown = (kinds: Partial<typeof NO_UNKNOWN> = { workflow_attempts: 32 }) => {
  const byKind = { ...NO_UNKNOWN, ...kinds };
  const count = Object.values(byKind).reduce((sum, value) => sum + value, 0);
  const report = structuredClone({
    ...fixture,
    newsletter: {
      ...fixture.newsletter, unknown_count: count, unknown_revision: 7, unknown_by_kind: byKind,
      latest_delivery_state: 'provider_accepted', latest_delivery_time: '2026-10-02T22:00:00Z',
    },
  });
  const item = report.runtime.workloads[0];
  if (!item) throw new Error('missing fixture workload');
  item.health_state = 'degraded';
  item.unknown_count = count;
  return { report, item };
};
const delivered = (state: string, time: string) => {
  const { report } = historicalUnknown({});
  return { ...report, newsletter: { ...report.newsletter, latest_delivery_state: state, latest_delivery_time: time } };
};
const codes = (report: unknown, now = NOW) => statusSnapshot('newsletter', read(report), now, now, 'fleet.example.test').signals.map((item) => item.code);

const newsletterStatus = (report: unknown) => statusSnapshot('newsletter', read(report), NOW, NOW, 'fleet.example.test');
const classifiedReport = () => ({
  ...fixture,
  newsletter: {
    ...fixture.newsletter,
    unknown_count: 4,
    unknown_revision: 7,
    unknown_by_kind: {
      interrupted_activities: 2, packets: 1, workflow_attempts: 0,
      notion_entities: 0, notion_versions: 0, delivery: 1,
    },
    latest_delivery_state: 'provider_accepted',
    latest_delivery_time: '2026-10-02T23:30:00.000Z',
  },
});

describe('metadata report boundary', () => {
  it('accepts a synthetic typed report and three expected daemons', () => {
    expect(read().sequence).toBe(1);
    expect(reportCodes(read())).toEqual([]);
  });
  it.each(['unexpected', 'logs', 'email'])('refuses extra content field %s', (key) => {
    expect(() => read({ ...fixture, [key]: 'not permitted' })).toThrow('invalid_report');
  });
  it('refuses unknown daemon aliases and a missing expected daemon', () => {
    const unexpected = { ...fixture, daemons: { ...fixture.daemons, injected: { state: 'active' } } };
    expect(() => read(unexpected)).toThrow('invalid_report');
    expect(() => read({ ...fixture, daemons: { k3s: { state: 'active' } } })).toThrow('invalid_report');
  });
  it('preserves the legacy shape while monitoring only configured daemons', () => {
    const configured = { k3s: { state: 'active' }, ssh: { state: 'active' }, cloudflared_platform: { state: 'active' } };
    const fresh = { ...fixture, daemons: { ...configured, cloudflared: { state: 'unknown' } }, configured_daemons: configured };
    expect(reportCodes(read(fresh))).toEqual([]);
    expect(reportCodes(read({ ...fresh, daemons: { ...fresh.daemons, ssh: { state: 'failed' } },
      configured_daemons: { ...configured, ssh: { state: 'failed' } } }))).toContain('daemon_ssh_failed');
    expect(reportCodes(read({ ...fixture, daemons: { ...fixture.daemons, cloudflared: { state: 'failed' } } }))).toContain('daemon_cloudflared_failed');
  });
  it('refuses empty, incomplete, unknown or inconsistent configured daemon maps', () => {
    for (const configured of [{}, { k3s: { state: 'active' } },
      { k3s: { state: 'active' }, ssh: { state: 'failed' } },
      { k3s: { state: 'active' }, ssh: { state: 'active' }, injected: { state: 'active' } }]) {
      expect(() => read({ ...fixture, configured_daemons: configured })).toThrow('invalid_report');
    }
  });
  it.each([{ host_key: 'another' }, { epoch: 2 }])('requires configured identity %j', (change) => {
    expect(() => read({ ...fixture, ...change })).toThrow('wrong_host');
  });
  it('refuses clock skew and old host observations', () => {
    expect(() => read({ ...fixture, observation_time: '2026-10-02T23:49:59Z' })).toThrow('report_clock');
    expect(() => read({ ...fixture, observation_time: '2026-10-03T00:02:01Z' })).toThrow('report_clock');
  });
  it('ages server receipt time without an alarm', () => {
    expect(freshness(null, NOW)).toBe('never_seen');
    expect(freshness(NOW, NOW + 600_000)).toBe('fresh');
    expect(freshness(NOW, NOW + 600_001)).toBe('stale');
    expect(freshness(NOW, NOW + 1_200_001)).toBe('missing');
  });
  it('reports drain separately from process health', () => {
    const report = read({ ...fixture, newsletter: { ...fixture.newsletter, drain_state: 'frozen', unknown_count: 2 } });
    expect(reportCodes(report)).toEqual(['newsletter_paused', 'newsletter_unknown']);
  });
  it('never equates declared release identity with independently verified actual identity', () => {
    const report = structuredClone(fixture);
    const item = report.runtime.workloads[0];
    if (!item) throw new Error('missing fixture workload');
    item.release.actual.source_sha = '2'.repeat(40);
    expect(reportCodes(read(report))).toContain('deployment_pending');
  });
  it('rejects an old runtime daemon observation inside a current host report', () => {
    const report = { ...fixture, runtime: { ...fixture.runtime, observed_at: '2026-10-02T23:58:59Z' } };
    expect(() => read(report)).toThrow('invalid_report');
  });
  it('keeps missing runtime evidence as unknown', () => {
    expect(reportCodes(read({ ...fixture, runtime: null }))).toContain('deployment_pending');
  });
  it('reports an explicitly held release even when the old process remains healthy', () => {
    const report = {
      ...fixture,
      runtime: {
        ...fixture.runtime,
        current_release: {
          name: 'releases/cfdd9a7b-3d46-4d2b-8983-6e99fb005a5a',
          request_id: 'cfdd9a7b-3d46-4d2b-8983-6e99fb005a5a',
          phase: 'held',
          etag: 'v1',
          update_time: '2026-10-03T00:00:00Z',
          error_code: 'RECONCILIATION_REQUIRED',
        },
      },
    };
    expect(reportCodes(read(report))).toContain('release_held');
  });
  it('rejects duplicate runtime workload aliases', () => {
    const report = { ...fixture, runtime: { ...fixture.runtime, workloads: [...fixture.runtime.workloads, ...fixture.runtime.workloads] } };
    expect(() => read(report)).toThrow('invalid_report');
  });
});

describe('Newsletter process and release projection', () => {
  it('projects accepted delivery separately from historical records and healthy execution', () => {
    const view = newsletterStatus(classifiedReport());
    expect(view.health).toBe('ok');
    expect(view.signals).toContainEqual({
      code: 'newsletter_delivery_accepted', severity: 'info',
      since: '2026-10-02T23:30:00Z', metrics: {},
    });
    expect(view.signals).toContainEqual({
      code: 'newsletter_unknown', severity: 'info', metrics: { unknown_count: 4, unknown_revision: 7 },
    });
    expect(view.signals).toContainEqual({
      code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 2, unknown_revision: 7 },
    });
    expect(view.signals.map((item) => item.code)).not.toContain('newsletter_unavailable');
    expect(view.counters).toMatchObject({ unknown_interrupted_activities: 2, unknown_delivery: 1 });
  });
  it('reports a latest provider rejection without inventing a stopped process', () => {
    const report = classifiedReport();
    report.newsletter.latest_delivery_state = 'rejected';
    const view = newsletterStatus(report);
    expect(view.signals).toContainEqual({
      code: 'newsletter_delivery_rejected', severity: 'warning',
      since: '2026-10-02T23:30:00Z', metrics: {},
    });
    expect(view.signals.map((item) => item.code)).not.toContain('newsletter_unavailable');
    expect(view.signals.map((item) => item.code)).not.toContain('newsletter_delivery_accepted');
  });
  it('keeps a failed process unavailable even after an accepted provider response', () => {
    const report = classifiedReport();
    report.newsletter.worker_healthy = false;
    expect(newsletterStatus(report).signals.map((item) => item.code)).toEqual([
      'newsletter_unavailable', 'newsletter_side_effect_unknown', 'newsletter_config_unobserved', 'newsletter_delivery_accepted', 'newsletter_unknown',
    ]);
  });
  it('keeps bookkeeping-only unknown records visible as info without a warning or process fault', () => {
    const { report } = historicalUnknown();
    expect(newsletterStatus(report)).toMatchObject({
      health: 'ok',
      signals: [
        { code: 'newsletter_config_unobserved', severity: 'info', metrics: {} },
        { code: 'newsletter_delivery_accepted', severity: 'info', since: '2026-10-02T22:00:00Z', metrics: {} },
        { code: 'newsletter_unknown', severity: 'info', metrics: { unknown_count: 32, unknown_revision: 7 } },
      ],
      counters: { unknown_count: 32, unknown_workflow_attempts: 32, unknown_revision: 7 },
    });
    expect(codes(historicalUnknown({ interrupted_activities: 3 }).report)).not.toContain('newsletter_side_effect_unknown');
    expect(reportCodes(read(report))).toEqual(['newsletter_unknown']);
    expect(statusSnapshot('fleet', read(report), NOW, NOW, 'fleet.example.test')).toMatchObject({ health: 'ok', signals: [] });
  });
  it('warns about unknown side effects without claiming a process fault', () => {
    const { report } = historicalUnknown({ delivery: 1, packets: 2, notion_entities: 3, notion_versions: 4, workflow_attempts: 5 });
    const view = newsletterStatus(report);
    expect(view.health).toBe('ok');
    expect(view.signals[0]).toEqual({ code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 10, unknown_revision: 7 } });
  });
  it('treats every record of an unclassified legacy report as a possible side effect', () => {
    const report = structuredClone(fixture);
    report.newsletter.unknown_count = 2;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 2 } });
  });
  it('keeps the side-effect batch stable as the heartbeat ages and names a new batch by revision', () => {
    const { report, item } = historicalUnknown({ delivery: 1, workflow_attempts: 31 });
    const before = newsletterStatus(report);
    const later = statusSnapshot('newsletter', read(report), NOW, NOW + 60_000, 'fleet.example.test');
    expect(later.signals).toEqual(before.signals);
    expect(later.counters.heartbeat_age_seconds).not.toBe(before.counters.heartbeat_age_seconds);
    report.newsletter.unknown_by_kind.delivery = 2;
    report.newsletter.unknown_count = 33;
    report.newsletter.unknown_revision = 8;
    item.unknown_count = 33;
    const changed = newsletterStatus(report);
    expect(changed.signals).toContainEqual({ code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: 2, unknown_revision: 8 } });
    expect(changed.counters.unknown_count).toBe(33);
  });
  it.each(['unknown', 'unhealthy', 'unsupported'] as const)('keeps %s runtime health unavailable despite unknown results', (health) => {
    const { report, item } = historicalUnknown();
    item.health_state = health;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it.each([0, undefined])('requires positive runtime unknown evidence, not just the separate process report: %s', (count) => {
    const { report, item } = historicalUnknown();
    Object.assign(item, { unknown_count: count });
    const signals = newsletterStatus(report).signals;
    expect(signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
  });
  it('does not substitute the process report for missing runtime evidence', () => {
    const { report } = historicalUnknown();
    const signals = newsletterStatus({ ...report, runtime: null }).signals;
    expect(signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
  });
  it.each(['stopped', 'unknown'] as const)('keeps a %s process unavailable despite unknown results', (process) => {
    const { report, item } = historicalUnknown();
    item.process_state = process;
    const signals = newsletterStatus(report).signals;
    expect(signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
  });
  it.each(['degraded', 'unavailable', 'unknown'] as const)('keeps a %s cluster unavailable', (state) => {
    const { report } = historicalUnknown();
    report.cluster.state = state;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it('keeps zero ready replicas unavailable', () => {
    const { report } = historicalUnknown();
    report.cluster.ready_count = 0;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it('keeps an unhealthy Newsletter worker unavailable', () => {
    const { report } = historicalUnknown();
    report.newsletter.worker_healthy = false;
    expect(newsletterStatus(report).signals).toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it.each(['source_sha', 'image_digest', 'request_id', 'generation'] as const)('keeps mismatched actual %s pending despite historical unknown results', (field) => {
    const { report, item } = historicalUnknown();
    const actual = item.release.actual;
    if (field === 'source_sha') actual.source_sha = '2'.repeat(40);
    if (field === 'image_digest') actual.image_digest = `sha256:${'2'.repeat(64)}`;
    if (field === 'request_id') actual.request_id = 'cfdd9a7b-3d46-4d2b-8983-6e99fb005a5b';
    if (field === 'generation') actual.generation = 2;
    const signals = newsletterStatus(report).signals;
    expect(signals).toContainEqual({ code: 'deployment_pending', severity: 'warning', metrics: {} });
    expect(signals).not.toContainEqual({ code: 'newsletter_unavailable', severity: 'critical', metrics: {} });
  });
  it('keeps frozen admission paused and the release pending', () => {
    const { report, item } = historicalUnknown();
    item.admission_state = 'frozen';
    item.release.state = 'paused';
    report.newsletter.drain_state = 'frozen';
    expect(newsletterStatus(report).signals).toEqual([
      { code: 'deployment_pending', severity: 'warning', metrics: {} },
      { code: 'newsletter_config_unobserved', severity: 'info', metrics: {} },
      { code: 'newsletter_delivery_accepted', severity: 'info', since: '2026-10-02T22:00:00Z', metrics: {} },
      { code: 'newsletter_paused', severity: 'info', metrics: {} },
      { code: 'newsletter_unknown', severity: 'info', metrics: { unknown_count: 32, unknown_revision: 7 } },
    ]);
  });
  it('still rejects a stale runtime observation with historical unknown results', () => {
    const { report } = historicalUnknown();
    report.runtime.observed_at = '2026-10-02T23:58:59Z';
    expect(() => read(report)).toThrow('invalid_report');
  });
});

describe('Newsletter daily delivery evidence', () => {
  it('reports a missed day only after the 07:00 Los Angeles window and its DST margin', () => {
    expect(codes(delivered('provider_accepted', '2026-10-01T22:00:00Z'))).not.toContain('newsletter_delivery_overdue');
    expect(codes(delivered('provider_accepted', '2026-10-01T19:00:00Z'))).toContain('newsletter_delivery_overdue');
    const view = newsletterStatus(delivered('provider_accepted', '2026-10-01T19:00:00Z'));
    expect(view.health).toBe('degraded');
    expect(view.signals).toContainEqual({ code: 'newsletter_delivery_overdue', severity: 'warning', since: '2026-10-01T19:00:00Z', metrics: {} });
  });
  it('waits for an unknown provider outcome to outlive one run before warning', () => {
    expect(codes(delivered('unknown', '2026-10-02T22:00:00Z'))).not.toContain('newsletter_delivery_overdue');
    expect(codes(delivered('unknown', '2026-10-02T21:00:00Z'))).toContain('newsletter_delivery_overdue');
  });
  it('leaves an old rejection to its own warning', () => {
    const signals = codes(delivered('rejected', '2026-10-01T00:00:00Z'));
    expect(signals).toContain('newsletter_delivery_rejected');
    expect(signals).not.toContain('newsletter_delivery_overdue');
  });
  it('reports missing delivery evidence as overdue', () => {
    expect(codes(fixture)).toEqual(['newsletter_delivery_overdue', 'newsletter_config_unobserved']);
  });
});

describe('Newsletter outcome receipt boundary', () => {
  it('accepts legacy reports without new outcome metadata', () => {
    expect(read(fixture).newsletter.unknown_by_kind).toBeUndefined();
    expect(read(classifiedReport()).newsletter.unknown_revision).toBe(7);
  });
  it('refuses inconsistent or unregistered category counts', () => {
    const report = classifiedReport();
    for (const counts of [
      { ...report.newsletter.unknown_by_kind, delivery: 2 },
      { ...report.newsletter.unknown_by_kind, delivery: -1 },
      { ...report.newsletter.unknown_by_kind, delivery: true },
      { ...report.newsletter.unknown_by_kind, unregistered: 0 },
      { ...report.newsletter.unknown_by_kind, delivery: undefined, unregistered: 1 },
      { delivery: 4 },
    ]) {
      expect(() => read({ ...report, newsletter: { ...report.newsletter, unknown_by_kind: counts } })).toThrow('invalid_report');
    }
  });
  it('refuses incomplete classification and unpaired delivery metadata', () => {
    const report = classifiedReport();
    for (const field of ['unknown_revision', 'unknown_by_kind', 'latest_delivery_state', 'latest_delivery_time']) {
      const newsletter = Object.fromEntries(Object.entries(report.newsletter).filter(([key]) => key !== field));
      expect(() => read({ ...report, newsletter })).toThrow('invalid_report');
    }
  });
});

describe('runtime reconcile observations', () => {
  const plan = {
    name: 'reconcilePlan', base_release: 'releases/6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    base_etag: 'version-1', fingerprint: 'a'.repeat(64), observed_at: '2026-10-03T00:00:00Z',
    state: 'clean', changes: [],
  };
  const reported = (change: object) => ({ ...fixture, runtime: { ...fixture.runtime, reconcile_plan: { ...plan, ...change } } });
  it('keeps clean checks and intentional pauses free of drift alerts', () => {
    expect(reportCodes(read(reported({})))).toEqual([]);
    expect(reportCodes(read(reported({ state: 'manual_required', reason_code: 'BUSINESS_PAUSED' })))).toEqual([]);
  });
  it.each([['repairable', 'runtime_drift'], ['unavailable', 'runtime_comparison_unavailable']])('reports %s as %s', (state, code) => {
    expect(reportCodes(read(reported({ state })))).toContain(code);
  });
  it('reports ownership conflicts and rejects old comparison times', () => {
    expect(reportCodes(read(reported({ state: 'manual_required', changes: [{ resource_key: 'newsletter', action: 'conflict', reason_code: 'RUNTIME_OWNERSHIP_CONFLICT' }] })))).toContain('runtime_repair_manual');
    expect(() => read(reported({ observed_at: '2026-10-02T23:58:59Z' }))).toThrow('invalid_report');
  });
});

describe('Codex gateway process projection', () => {
  function gatewayReport(health: string = 'healthy') {
    const source = fixture.runtime.workloads[0];
    if (!source) throw new Error('missing synthetic runtime');
    const key = 'codex-gateway';
    const gateway = {
      ...source, name: `workloads/${key}`, workload_key: key,
      admission_state: 'unsupported', health_state: health,
      release: {
        ...source.release,
        desired: { ...source.release.desired, workload_key: key },
        actual: { ...source.release.actual, workload_key: key },
      },
    };
    return parseReport(JSON.stringify({
      ...fixture,
      newsletter: { ...fixture.newsletter, drain_state: 'frozen' },
      runtime: { ...fixture.runtime, workloads: [gateway, ...fixture.runtime.workloads] },
    }), 'vps', '1', NOW);
  }

  it('reports its verified process while Newsletter is paused', () => {
    expect(statusSnapshot('codex-gateway', gatewayReport(), NOW, NOW, 'fleet.example.test')).toMatchObject({
      app: 'codex-gateway', health: 'ok', signals: [], capabilities: [],
      counters: { heartbeat_age_seconds: 0 },
    });
  });
  it('keeps failed gateway process evidence visible without calling inference', () => {
    const status = statusSnapshot('codex-gateway', gatewayReport('unknown'), NOW, NOW, 'fleet.example.test');
    expect(status.health).toBe('degraded');
    expect(status.signals.map((item) => item.code)).toEqual(['codex_gateway_unavailable', 'deployment_pending']);
  });
});

describe('Newsletter configuration observation', () => {
  const CONFIG = {
    active_revision: '1'.repeat(40), active_digest: 'a'.repeat(64),
    wanted_revision: '1'.repeat(40), wanted_digest: 'a'.repeat(64), wanted_commit: '2'.repeat(40),
    last_attempt_time: '2026-10-02T23:55:00Z', last_success_time: '2026-10-02T23:55:00Z',
  } satisfies NewsletterConfigSync;
  const configReport = (config: unknown = CONFIG) => parseReport(JSON.stringify({
    ...fixture,
    newsletter: {
      ...fixture.newsletter,
      latest_delivery_state: 'provider_accepted',
      latest_delivery_time: '2026-10-02T23:00:00Z',
      config_sync: config,
    },
  }), 'vps', '1', NOW);
  const configStatus = (config: unknown = CONFIG) => statusSnapshot('newsletter', configReport(config), NOW, NOW, 'fleet.example.test');
  const signal = (state: string, severity = 'info') => ({ code: `newsletter_config_${state}`, severity, metrics: {} });

  it('compares the observed identity pair and projects only numeric clocks to Home', () => {
    const view = configStatus();
    expect(view.health).toBe('ok');
    expect(view.signals).toContainEqual(signal('current'));
    expect(view.counters).toMatchObject({
      newsletter_config_last_attempt_at: NOW / 1000 - 300,
      newsletter_config_last_success_at: NOW / 1000 - 300,
      newsletter_config_attempt_age_seconds: 300,
    });
    expect(Object.values(view.counters).every((value) => typeof value === 'number')).toBe(true);
    expect(configStatus({ ...CONFIG, active_revision: 'packaged', wanted_revision: 'packaged' }).signals).toContainEqual(signal('current'));
  });
  it.each([{ active_revision: '3'.repeat(40) }, { active_digest: 'b'.repeat(64) }])('keeps an identity mismatch pending: %j', (patch) => {
    expect(configStatus({ ...CONFIG, ...patch }).signals).toContainEqual(signal('pending'));
  });
  it('warns on safe errors and old attempts without changing process health or delivery evidence', () => {
    for (const [config, state] of [
      [{ ...CONFIG, error: 'CONFIG_GITHUB_NETWORK_ERROR' }, 'failed'],
      [{ ...CONFIG, last_attempt_time: '2026-10-02T23:29:59Z' }, 'stale'],
    ] as const) {
      const view = configStatus(config);
      expect(view.health).toBe('ok');
      expect(view.signals).toContainEqual(signal(state, 'warning'));
      expect(view.signals).toContainEqual({ code: 'newsletter_delivery_accepted', severity: 'info', since: '2026-10-02T23:00:00Z', metrics: {} });
      expect(view.signals.map((item) => item.code)).not.toContain('newsletter_unavailable');
    }
    expect(configStatus({ ...CONFIG, last_attempt_time: '2026-10-02T23:30:00Z' }).signals).toContainEqual(signal('current'));
  });
  it('shows an effective pin independently of an old or absent remote target', () => {
    expect(configStatus({ ...CONFIG, pinned_digest: CONFIG.active_digest, wanted_digest: 'b'.repeat(64) }).signals).toContainEqual(signal('pinned'));
    expect(configStatus({
      active_revision: CONFIG.active_revision, active_digest: CONFIG.active_digest,
      pinned_digest: CONFIG.active_digest, last_attempt_time: CONFIG.last_attempt_time,
    }).signals).toContainEqual(signal('pinned'));
    expect(configStatus({ ...CONFIG, pinned_digest: 'b'.repeat(64) }).signals).toContainEqual(signal('pending'));
  });
  it.each([{}, { active_revision: 'packaged' }, { ...CONFIG, wanted_digest: undefined }])('keeps incomplete metadata unobserved: %j', (config) => {
    expect(configStatus(config).signals).toContainEqual(signal('unobserved'));
    expect(configStatus(config).signals).not.toContainEqual(signal('current'));
  });
  it('keeps an older producer without the optional config child unobserved', () => {
    const legacy = parseReport(JSON.stringify(fixture), 'vps', '1', NOW);
    expect(statusSnapshot('newsletter', legacy, NOW, NOW, 'fleet.example.test').signals).toContainEqual(signal('unobserved'));
  });
  it('does not reuse config signals or clocks after the host observation becomes stale', () => {
    const view = statusSnapshot('newsletter', configReport(), NOW, NOW + 600_001, 'fleet.example.test');
    expect(view.signals).toEqual([{ code: 'host_stale', severity: 'warning', metrics: {} }]);
    expect(view.counters).toEqual({ heartbeat_age_seconds: 600 });
  });
  it('tolerates two minutes of clock skew but keeps later clocks out of fresh configuration evidence', () => {
    const allowed = '2026-10-03T00:02:00Z';
    const future = '2026-10-03T00:02:00.001Z';
    const skewed = configStatus({ ...CONFIG, last_attempt_time: allowed, last_success_time: allowed });
    expect(skewed.signals).toContainEqual(signal('current'));
    expect(skewed.counters).toMatchObject({
      newsletter_config_last_attempt_at: NOW / 1000 + 120,
      newsletter_config_last_success_at: NOW / 1000 + 120,
      newsletter_config_attempt_age_seconds: 0,
    });
    const unobserved = configStatus({ ...CONFIG, last_attempt_time: future, last_success_time: future });
    expect(unobserved.signals).toContainEqual(signal('unobserved'));
    expect(Object.keys(unobserved.counters).filter((key) => key.startsWith('newsletter_config_'))).toEqual([]);
    expect(configStatus({ ...CONFIG, last_success_time: future }).counters).not.toHaveProperty('newsletter_config_last_success_at');
  });
  it.each([{ error: 'private error text' }, { active_digest: 'short' }, { last_attempt_time: 'yesterday' }, { url: 'https://private.invalid' }])('rejects unsafe configuration metadata %j', (patch) => {
    expect(() => configReport({ ...CONFIG, ...patch })).toThrow('invalid_report');
  });
});

describe('FleetState change tracking, retention cap, and ops entrypoints', () => {
  const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

  it('records state transitions (first_receipt, added, resolved) and caps change history at 256 rows', () => {
    const { db, state } = createFleetState();
    const firstText = JSON.stringify({ ...fixture, sequence: 1, receipt_id: '11111111-2222-4333-8444-555555555501' });
    const firstHash = hashText(firstText);
    expect(state.accept(firstText, firstHash, NOW)).toEqual({ accepted: true, sequence: 1 });
    // Duplicate retry with identical hash is idempotent and adds no change row.
    expect(state.accept(firstText, firstHash, NOW)).toEqual({ accepted: false, sequence: 1 });
    expect(() => state.accept(firstText, '0'.repeat(64), NOW)).toThrow(ReceiptError);

    // Alternate ssh failed / active across 135 sequences (> 256 state transitions) to verify the 256-entry cap.
    for (let seq = 2; seq <= 270; seq += 1) {
      const sshState = seq % 2 === 0 ? 'failed' : 'active';
      const payload = JSON.stringify({
        ...fixture,
        sequence: seq,
        receipt_id: `11111111-2222-4333-8444-${String(seq).padStart(12, '0')}`,
        daemons: { ...fixture.daemons, ssh: { state: sshState } },
      });
      expect(state.accept(payload, hashText(payload), NOW)).toEqual({ accepted: true, sequence: seq });
    }

    const totalChanges = (db.prepare('SELECT COUNT(*) AS n FROM changes').get() as { n: number }).n;
    expect(totalChanges).toBe(256);

    const view = JSON.parse(state.view(NOW)) as { changes: { code: string }[] };
    expect(view.changes).toHaveLength(32);
    expect(view.changes[0]?.code).toBe('daemon_ssh_failed');
    expect(view.changes[1]?.code).toBe('resolved_daemon_ssh_failed');
  });

  it('delegates Ops, NewsletterOps, and CodexGatewayOps status() and rejects setGuard()', async () => {
    const { env } = createFleetState();
    const ctx = {} as ExecutionContext;
    const fleetOps = new Ops(ctx, env);
    const newsletterOps = new NewsletterOps(ctx, env);
    const codexOps = new CodexGatewayOps(ctx, env);

    expect((await fleetOps.status()).app).toBe('fleet');
    expect((await newsletterOps.status()).app).toBe('newsletter');
    expect((await codexOps.status()).app).toBe('codex-gateway');

    expect(() => fleetOps.setGuard()).toThrow('invalid_input');
    expect(() => newsletterOps.setGuard()).toThrow('invalid_input');
    expect(() => codexOps.setGuard()).toThrow('invalid_input');
  });
});

describe('HTTP and receipt error surfaces (http.ts & receipt.ts)', () => {
  const signBytes = (secret: string, bytes: Uint8Array) => {
    const key = Uint8Array.from(secret.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? []);
    return createHmac('sha256', key).update(bytes).digest('hex');
  };

  it('rejects malformed receipt methods, headers, unconfigured HMAC key, empty/invalid UTF-8/oversized bodies, and DO exceptions', async () => {
    const { env } = createFleetState();
    const url = `https://fleet.example.test${REPORT_PATH}`;

    // 405 Method Not Allowed
    const getRes = await handleReceipt(new Request(url, { method: 'GET' }), env, NOW);
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get('allow')).toBe('POST');

    // 415 Unsupported Media Type
    const textRes = await handleReceipt(new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), env, NOW);
    expect(textRes.status).toBe(415);

    // 401 Missing x-fleet-key-id or malformed signature
    const noKeyRes = await handleReceipt(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleet-signature': 'a'.repeat(64) },
      body: '{}',
    }), env, NOW);
    expect(noKeyRes.status).toBe(401);

    // 503 Unconfigured REPORT_HMAC_KEY
    const unconfiguredRes = await handleReceipt(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleet-key-id': REPORT_KEY_ID, 'x-fleet-signature': 'a'.repeat(64) },
      body: '{}',
    }), { ...env, REPORT_HMAC_KEY: '' }, NOW);
    expect(unconfiguredRes.status).toBe(503);

    // 400 Empty (null) body
    const emptyBodyRes = await handleReceipt(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleet-key-id': REPORT_KEY_ID, 'x-fleet-signature': 'a'.repeat(64) },
    }), env, NOW);
    expect(emptyBodyRes.status).toBe(400);

    // 400 Invalid UTF-8 bytes with valid HMAC signature
    const badUtf8 = new Uint8Array([0xff, 0xfe]);
    const badUtf8Res = await handleReceipt(new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fleet-key-id': REPORT_KEY_ID,
        'x-fleet-signature': signBytes(env.REPORT_HMAC_KEY ?? '', badUtf8),
      },
      body: badUtf8,
    }), env, NOW);
    expect(badUtf8Res.status).toBe(400);

    // 413 Oversized body
    const huge = new Uint8Array(MAX_REPORT_BYTES + 1);
    const hugeRes = await handleReceipt(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleet-key-id': REPORT_KEY_ID, 'x-fleet-signature': 'a'.repeat(64) },
      body: huge,
    }), env, NOW);
    expect(hugeRes.status).toBe(413);

    // 503 Unexpected DO exception
    const validBytes = new TextEncoder().encode(JSON.stringify(fixture));
    const validSig = signBytes(env.REPORT_HMAC_KEY ?? '', validBytes);
    const brokenEnv: Env = {
      ...env,
      FLEET: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ accept: () => Promise.reject(new Error('sqlite_io_error')) }) as unknown as DurableObjectStub<FleetState>,
      } as unknown as DurableObjectNamespace<FleetState>,
    };
    const doErrRes = await handleReceipt(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleet-key-id': REPORT_KEY_ID, 'x-fleet-signature': validSig },
      body: validBytes,
    }), brokenEnv, NOW);
    expect(doErrRes.status).toBe(503);
    expect(await doErrRes.json()).toEqual({ error: 'unavailable' });
  });

  it('handles owner HTTP surface: wrong host 404, auth 503, non-GET 405, non-empty pageToken 400, DO exception 503, unknown /api/* 404, and asset fallback', async () => {
    const { env } = createFleetState({
      DEV_AUTH_BYPASS: 'true',
      DEV_NOW: '2026-10-03T00:00:00Z',
      ACCESS_OWNER: 'owner@example.test',
    });

    // Wrong host / non-local HTTP -> 404
    const wrongHost = await handleRequest(new Request('https://wrong.example.test/api/v1/status'), env);
    expect(wrongHost.status).toBe(404);

    // Auth not_configured / keys_unavailable -> 503
    const noBypassEnv: Env = { ...env, DEV_AUTH_BYPASS: 'false' };
    const unconfiguredAuth = await handleRequest(
      new Request('https://fleet.example.test/api/v1/status'),
      { ...noBypassEnv, ACCESS_AUDIENCE: '' },
    );
    expect(unconfiguredAuth.status).toBe(503);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network_down')));
    const keysUnavailableAuth = await handleRequest(
      new Request('https://fleet.example.test/api/v1/status', {
        headers: { 'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImxIn0.e30.sig' },
      }),
      {
        ...noBypassEnv,
        ACCESS_ISSUER: 'https://issuer.example.test',
        ACCESS_AUDIENCE: 'b'.repeat(64),
        ACCESS_OWNER: 'owner@example.test',
      },
    );
    expect(keysUnavailableAuth.status).toBe(503);
    vi.unstubAllGlobals();

    // Non-GET/HEAD on owner surface -> 405
    const postOwner = await handleRequest(new Request('http://127.0.0.1/api/v1/status', { method: 'POST' }), env);
    expect(postOwner.status).toBe(405);
    expect(postOwner.headers.get('allow')).toBe('GET, HEAD');

    // listNodes with non-empty page_token -> 400
    const badPageToken = await handleRequest(new Request('http://127.0.0.1/api/v1/nodes?page_token=next'), env);
    expect(badPageToken.status).toBe(400);

    // Unknown /api/* route -> 404
    const unknownApi = await handleRequest(new Request('http://127.0.0.1/api/v1/unknown'), env);
    expect(unknownApi.status).toBe(404);

    // DO exception in fromState -> 503
    const brokenDoEnv: Env = {
      ...env,
      FLEET: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ view: () => Promise.reject(new Error('do_down')) }) as unknown as DurableObjectStub<FleetState>,
      } as unknown as DurableObjectNamespace<FleetState>,
    };
    const doFailure = await handleRequest(new Request('http://127.0.0.1/api/v1/fleetStatus'), brokenDoEnv);
    expect(doFailure.status).toBe(503);

    // Asset fallback with STRICT_CSP
    const assetRes = await handleRequest(new Request('http://127.0.0.1/'), env);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

