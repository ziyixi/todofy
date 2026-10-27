/**
 * The configuration drift check in workerd (docs/design-v2.md §10): the real HomeState runs the day's check
 * across cron ticks against a fake Cloudflare API built from the bundled desired state (synthetic ids and
 * values), stores the result, shows it on GetCloudflareView and lists it in the digest's daily task that
 * the Tasks stub receives. Names only: no value, id or token reaches a view or the task.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CreateInboxTaskRequest } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import { DRIFT_CALLS_PER_TICK, DRIFT_UTC_HOUR, type CloudflareView, type OpsView } from '../../src/api-types.ts';
import { countFindings, type DriftDoc, type DriftRunDoc } from '../../src/drift.ts';
import type { DigestDoc } from '../../src/docs.ts';
import { outboundPerTick } from '../../src/registry.ts';
import { CF_API, SENTINEL_VALUE } from '../drift-fixture.ts';
import { GRAPHQL, NOW, PROBES, SYNTHETIC_BINDINGS, startFlows, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const MIN = 60_000;
const DAY_MS = 86_400_000;
const TOKEN = SYNTHETIC_BINDINGS.CF_ANALYTICS_TOKEN ?? '';

/** DRIFT_UTC_HOUR:00 UTC `daysAgo` days before NOW's day (hours before NOW, noon, even for 0). */
function driftHour(daysAgo: number): number {
  return Math.floor(NOW / DAY_MS) * DAY_MS - daysAgo * DAY_MS + DRIFT_UTC_HOUR * 60 * MIN;
}

async function view<T>(harness: FlowHarness, name: 'home' | 'flows' | 'cloudflare' | 'ops'): Promise<T> {
  const answer = await harness.view<T>(name);
  expect(answer.status).toBe(200);
  if (answer.body === null) throw new Error(`no body for ${name}`);
  return answer.body;
}

function driftRequests(harness: FlowHarness): number {
  return harness.cloudflare.requests.splice(0).length;
}

describe('the daily drift check', () => {
  it('runs across four ticks within DRIFT_CALLS_PER_TICK calls each, with GETs only, and shows ok', async () => {
    h = await startFlows();
    const start = driftHour(1);
    await h.tick(start - 30 * MIN);
    expect(driftRequests(h)).toBe(0);
    await h.tick(start);
    const first = h.cloudflare.requests.splice(0);
    // The account step (scripts, domains, the audit log, one zone's routes) and two Workers.
    expect(first).toHaveLength(10);
    for (const request of first) {
      expect(request.method).toBe('GET');
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url.startsWith(`${CF_API}/`)).toBe(true);
    }
    // The whole tick (RPCs, GraphQL, probe, drift) stays within outboundPerTick().
    const tick = [...(await h.called()), ...h.outboundLog.splice(0)];
    expect(tick.length).toBeLessThanOrEqual(outboundPerTick());
    expect((await view<CloudflareView>(h, 'cloudflare')).drift).toMatchObject({ status: 'never_checked', checked_at: null });

    // The remaining thirteen Workers fill four ticks under the unchanged twelve-call drift bound.
    await h.tick(start + 30 * MIN);
    expect(driftRequests(h)).toBe(DRIFT_CALLS_PER_TICK);
    expect((await view<CloudflareView>(h, 'cloudflare')).drift).toMatchObject({ status: 'never_checked', checked_at: null });
    await h.tick(start + 60 * MIN);
    expect(driftRequests(h)).toBe(DRIFT_CALLS_PER_TICK);
    await h.tick(start + 90 * MIN);
    expect(driftRequests(h)).toBe(DRIFT_CALLS_PER_TICK);
    await h.tick(start + 120 * MIN);
    expect(driftRequests(h)).toBe(3);
    const cloudflare = await view<CloudflareView>(h, 'cloudflare');
    expect(cloudflare.drift).toMatchObject({ status: 'ok', in_progress: false, desired_workers: 15, findings: [], findings_omitted: 0, last_error: null });
    expect(cloudflare.drift).not.toHaveProperty('audit_unchecked');
    expect(cloudflare.drift.checked_at).toBe(new Date(start + 120 * MIN).toISOString());
    const ops = await view<OpsView>(h, 'ops');
    expect(ops.digest.items.filter((item) => item.code === 'config_drift')).toEqual([]);
    // Once a day: later ticks of the same day make no drift call.
    await h.tick(start + 150 * MIN);
    expect(driftRequests(h)).toBe(0);
    // The GraphQL query still carries the same token; nothing else got it.
    expect(h.analytics.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const probes: readonly string[] = Object.values(PROBES);
    expect(h.outboundLog.every((url) => url === GRAPHQL || url.startsWith(`${CF_API}/`) || probes.includes(url))).toBe(true);
  });

  it('reports drift by name on the Cloudflare view and by counts in the digest, never a value', async () => {
    h = await startFlows();
    h.cloudflare.tweaks = {
      bindings: { 'mail-hero': { RECEIVE_ADDRESS: 'plain_text' } },
      extraScripts: ['synthetic-orphan'],
      extraDomains: [{ hostname: 'stray.ziyixi.science', service: 'home' }],
      // A dashboard edit of a Worker, and the owner looking at analytics (not a change).
      audit: [
        { context: 'dash', action: 'update', product: 'workers', type: 'scripts' },
        { context: 'dash', action: 'create', product: 'analytics', type: 'query.summary' },
      ],
    };
    const start = driftHour(1);
    for (let k = 0; k < 5; k++) await h.tick(start + k * 30 * MIN);
    const cloudflare = await view<CloudflareView>(h, 'cloudflare');
    expect(cloudflare.drift.status).toBe('drift');
    expect(cloudflare.drift.counts).toEqual({ scripts: 1, custom_domains: 1, routes: 0, crons: 0, bindings: 1, workers_dev: 0, personal: 0, account_changes: 1 });
    expect(cloudflare.drift.findings).toContainEqual({ category: 'account_changes', script: 'dash', name: 'workers.scripts', kind: 'extra', actual: 'update 1' });
    expect(cloudflare.drift.findings).toContainEqual({ category: 'scripts', script: 'synthetic-orphan', name: 'synthetic-orphan', kind: 'extra' });
    expect(cloudflare.drift.findings).toContainEqual({ category: 'custom_domains', script: 'home', name: 'stray.ziyixi.science', kind: 'extra' });
    expect(cloudflare.drift.findings).toContainEqual({ category: 'bindings', script: 'mail-hero', name: 'RECEIVE_ADDRESS', kind: 'changed', expected: 'secret_text', actual: 'plain_text' });
    // The strip points at the Cloudflare view.
    expect(cloudflare.attention.items).toContainEqual(expect.objectContaining({ source: 'dashboard', code: 'config_drift', target: { view: 'cloudflare' } }));

    const ops = await view<OpsView>(h, 'ops');
    const item = ops.digest.items.find((i) => i.code === 'config_drift');
    expect(item).toEqual(expect.objectContaining({ source: 'dashboard', severity: 'warning', metrics: { total: 3, scripts: 1, custom_domains: 1, bindings: 1 } }));
    // The next day's task lists it: counts only.
    await h.tick(Math.floor(NOW / DAY_MS) * DAY_MS);
    const tasks = (await h.callsOf('tasks', 'createInboxTask')).map((args) => args[0] as CreateInboxTaskRequest);
    expect(tasks).toHaveLength(1);
    const line = tasks[0]?.description?.split('\n').find((text) => text.includes(' · config_drift · ')) ?? '';
    for (const metric of ['total=3', 'scripts=1', 'custom_domains=1', 'bindings=1']) expect(line).toContain(metric);
    expect(line).not.toContain('account_changes');
    const reportText = JSON.stringify(tasks);
    expect(reportText).not.toContain('RECEIVE_ADDRESS');
    expect(reportText).not.toContain('synthetic-orphan');

    for (const text of [JSON.stringify(cloudflare), JSON.stringify(ops), reportText]) {
      expect(text).not.toContain(SENTINEL_VALUE);
      expect(text).not.toContain(TOKEN);
    }
    // The audit actor's address and IP never reach a view or the task.
    for (const text of [JSON.stringify(cloudflare), JSON.stringify(ops), reportText]) expect(text).not.toContain('192.0.2.1');
    // No id of the API answers (account, zone, script tags, binding ids) reaches the drift panel.
    expect(JSON.stringify(cloudflare.drift)).not.toMatch(/[0-9a-f]{32}/);
  });

  it('keeps actual account history without a configuration warning, and omits read-query audit entries', async () => {
    h = await startFlows();
    h.cloudflare.tweaks = { audit: [
      { context: 'api', action: 'update', product: 'user' },
      { context: 'dash', action: 'create', product: 'tokens' },
      { context: 'dash', action: 'delete', product: 'tokens' },
      { context: 'dash', action: 'create', product: 'workers', type: 'durable_objects.namespaces.query' },
    ] };
    const start = driftHour(1);
    for (let k = 0; k < 5; k++) await h.tick(start + k * 30 * MIN);
    const cloudflare = await view<CloudflareView>(h, 'cloudflare');
    expect(cloudflare.drift).toMatchObject({ status: 'ok', counts: { account_changes: 2 }, findings: [
      { category: 'account_changes', script: 'api', name: 'user', kind: 'extra', actual: 'update 1' },
      { category: 'account_changes', script: 'dash', name: 'tokens', kind: 'extra', actual: 'create 1, delete 1' },
    ] });
    expect(cloudflare.attention.items.some(item => item.code === 'config_drift')).toBe(false);
    expect((await view<OpsView>(h, 'ops')).digest.items.some(item => item.code === 'config_drift')).toBe(false);
  });

  it('advances drift after the scope interval even when a recent cron already refreshed usage', async () => {
    h = await startFlows({ bindings: { DEV_NOW: new Date(NOW - 2 * MIN).toISOString() } });
    await h.refresh<CloudflareView>('cloudflare');
    await h.tick(NOW - 30_000);
    expect(h.analytics.requests).toHaveLength(2);
    await h.redeploy({ DEV_NOW: new Date(NOW).toISOString() });
    h.cloudflare.requests.splice(0);
    h.outboundLog.splice(0);

    const refreshed = await h.refresh<CloudflareView>('cloudflare');
    expect(refreshed.body?.refresh.refreshed).toBe(true);
    expect(refreshed.body?.drift.in_progress).toBe(true);
    expect(h.analytics.requests).toHaveLength(2);
    expect(h.cloudflare.requests).toHaveLength(DRIFT_CALLS_PER_TICK);
    expect(h.outboundLog).toHaveLength(DRIFT_CALLS_PER_TICK);

    expect((await h.refresh<CloudflareView>('cloudflare')).body?.refresh.refreshed).toBe(false);
    expect(h.cloudflare.requests).toHaveLength(DRIFT_CALLS_PER_TICK);
  });

  it('corrects a legacy audit-only snapshot and current warning on first read without rewriting the stored digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'home-dashboard-legacy-drift-'));
    try {
      h = await startFlows({ persist: dir });
      h.cloudflare.tweaks = { extraScripts: ['synthetic-orphan'] };
      const start = driftHour(1);
      for (let k = 0; k < 5; k++) await h.tick(start + k * 30 * MIN);
      expect((await view<CloudflareView>(h, 'cloudflare')).attention.items.some(item => item.code === 'config_drift')).toBe(true);
      await h.dispose();
      h = undefined;

      const files = (await readdir(dir, { recursive: true })).filter(name => name.endsWith('.sqlite'));
      let storedDigest: { file: string; doc: string } | null = null;
      for (const file of files) {
        const db = new DatabaseSync(join(dir, file));
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'state'").get() === undefined) {
          db.close();
          continue;
        }
        const row = db.prepare("SELECT doc FROM state WHERE key = 'drift'").get() as { doc: string } | undefined;
        if (row !== undefined) {
          const findings = [
            { category: 'account_changes' as const, script: 'api', name: 'user', kind: 'extra' as const, actual: 'update 1' },
            { category: 'account_changes' as const, script: 'dash', name: 'tokens', kind: 'extra' as const, actual: 'create 1, delete 1' },
            { category: 'account_changes' as const, script: 'dash', name: 'workers.durable_objects.namespaces.query', kind: 'extra' as const, actual: 'create 21' },
          ];
          const previous = JSON.parse(row.doc) as DriftDoc;
          db.prepare("UPDATE state SET doc = ? WHERE key = 'drift'").run(JSON.stringify({ ...previous, counts: countFindings(findings), findings }));
          const digestRow = db.prepare("SELECT doc FROM state WHERE key = 'digest'").get() as { doc: string };
          const digest = JSON.parse(digestRow.doc) as DigestDoc;
          const doc = JSON.stringify({ ...digest, items: digest.items.map(item => item.code === 'config_drift'
            ? { ...item, metrics: { total: 3, account_changes: 3 } } : item) });
          db.prepare("UPDATE state SET doc = ? WHERE key = 'digest'").run(doc);
          storedDigest = { file, doc };
        }
        db.close();
      }
      expect(storedDigest).not.toBeNull();

      h = await startFlows({ persist: dir });
      const cloudflare = await view<CloudflareView>(h, 'cloudflare');
      expect(cloudflare.drift).toMatchObject({ status: 'ok', counts: { account_changes: 2 }, findings_omitted: 0 });
      expect(cloudflare.drift.findings.map(finding => finding.name)).toEqual(['user', 'tokens']);
      expect(cloudflare.attention.items.some(item => item.code === 'config_drift')).toBe(false);
      const ops = await view<OpsView>(h, 'ops');
      expect(ops.digest.items.some(item => item.code === 'config_drift')).toBe(false);
      expect(h.cloudflare.requests).toEqual([]);
      expect(h.analytics.requests).toEqual([]);
      await h.dispose();
      h = undefined;
      if (storedDigest === null) throw new Error('missing synthetic legacy digest');
      const db = new DatabaseSync(join(dir, storedDigest.file));
      expect(db.prepare("SELECT doc FROM state WHERE key = 'digest'").get()).toEqual({ doc: storedDigest.doc });
      db.close();
    } finally {
      await h?.dispose();
      h = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([undefined, 'older-desired-state'])('rechecks changed or legacy desired context (%s), then resumes it across restart within refresh limits', async (previousHash) => {
    const dir = await mkdtemp(join(tmpdir(), 'home-dashboard-drift-context-'));
    try {
      h = await startFlows({ persist: dir });
      const start = driftHour(0);
      for (let k = 0; k < 5; k++) await h.tick(start + k * 30 * MIN);
      const completed = (await view<CloudflareView>(h, 'cloudflare')).drift.checked_at;
      h.cloudflare.requests.splice(0);
      // An explicit refresh starts another check on the day already completed by cron.
      expect((await h.refresh<CloudflareView>('cloudflare')).body?.drift).toMatchObject({ in_progress: true, checked_at: completed });
      expect(h.cloudflare.requests.splice(0)).toHaveLength(10);
      await h.dispose();
      h = undefined;

      const files = (await readdir(dir, { recursive: true })).filter(name => name.endsWith('.sqlite'));
      let previousAuditUntil: number | null = null;
      let changed = 0;
      for (const file of files) {
        const db = new DatabaseSync(join(dir, file));
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'state'").get() !== undefined) {
          const doc = JSON.parse((db.prepare("SELECT doc FROM state WHERE key = 'drift'").get() as { doc: string }).doc) as DriftDoc;
          const run = JSON.parse((db.prepare("SELECT doc FROM state WHERE key = 'drift_run'").get() as { doc: string }).doc) as DriftRunDoc;
          if (run.account === null) throw new Error('missing synthetic partial account');
          previousAuditUntil = doc.audit_until;
          db.prepare("UPDATE state SET doc = ? WHERE key = 'drift'").run(JSON.stringify({ ...doc, desired_hash: previousHash }));
          db.prepare("UPDATE state SET doc = ? WHERE key = 'drift_run'").run(JSON.stringify({ ...run, desired_hash: previousHash,
            account: { ...run.account, scripts: [...run.account.scripts, 'old-context-only'] } }));
          changed++;
        }
        db.close();
      }
      expect(changed).toBe(1);

      h = await startFlows({ persist: dir, bindings: { DEV_NOW: new Date(NOW + MIN).toISOString() } });
      // A GET stays cached, even when the deployed desired state has changed.
      expect((await view<CloudflareView>(h, 'cloudflare')).drift.checked_at).toBe(completed);
      expect(h.cloudflare.requests).toEqual([]);
      const first = await h.refresh<CloudflareView>('cloudflare');
      expect(first.body?.drift).toMatchObject({ in_progress: true, checked_at: completed });
      const calls = h.cloudflare.requests.splice(0);
      expect(calls).toHaveLength(10);
      expect(calls.some(call => call.url.endsWith('/workers/scripts'))).toBe(true);
      const audit = calls.find(call => call.url.includes('/logs/audit?'));
      expect(audit).toBeDefined();
      expect(new URL(audit?.url ?? '').searchParams.get('since')).toBe(new Date(previousAuditUntil ?? 0).toISOString());
      expect((await h.refresh<CloudflareView>('cloudflare')).body?.refresh.refreshed).toBe(false);
      expect(h.cloudflare.requests).toEqual([]);
      await h.dispose();
      h = undefined;

      // A new isolate using the same desired hash continues the current run, not the discarded one.
      h = await startFlows({ persist: dir, bindings: { DEV_NOW: new Date(NOW + 2 * MIN).toISOString() } });
      for (const minute of [2, 3, 4, 5]) {
        if (minute > 2) await h.redeploy({ DEV_NOW: new Date(NOW + minute * MIN).toISOString() });
        const refreshed = await h.refresh<CloudflareView>('cloudflare');
        expect(h.cloudflare.requests.splice(0)).toHaveLength(minute === 5 ? 3 : DRIFT_CALLS_PER_TICK);
        expect(refreshed.body?.drift.in_progress).toBe(minute < 5);
      }
      const result = (await view<CloudflareView>(h, 'cloudflare')).drift;
      expect(result).toMatchObject({ status: 'ok', findings: [], in_progress: false, checked_at: new Date(NOW + 5 * MIN).toISOString() });
      expect((await h.callsOf('tasks', 'createInboxTask'))).toEqual([]);
    } finally {
      await h?.dispose();
      h = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries a failing step on later ticks, gives the day up after three attempts, and reports drift_unavailable on the second day', async () => {
    h = await startFlows();
    h.cloudflare.tweaks = { fail: { path: /\/settings$/, status: 403 } };
    for (const daysAgo of [2, 1]) {
      const start = driftHour(daysAgo);
      for (let k = 0; k < 5; k++) await h.tick(start + k * 30 * MIN);
      // Three attempts that day (the fourth tick makes no call).
      const cloudflare = await view<CloudflareView>(h, 'cloudflare');
      expect(cloudflare.drift).toMatchObject({ status: 'failing', last_error: 'http_403', last_error_step: 'script', consecutive_failed_days: daysAgo === 2 ? 1 : 2, in_progress: false });
    }
    const ops = await view<OpsView>(h, 'ops');
    expect(ops.digest.items).toContainEqual(expect.objectContaining({ source: 'dashboard', code: 'drift_unavailable', severity: 'warning', metrics: { consecutive_failed_days: 2 } }));
    expect(ops.digest.items.filter((item) => item.code === 'config_drift')).toEqual([]);

    // The API answers again: the next day's check succeeds and both items clear.
    h.cloudflare.tweaks = {};
    const today = driftHour(0);
    for (let k = 0; k < 5; k++) await h.tick(today + k * 30 * MIN);
    const after = await view<OpsView>(h, 'ops');
    expect(after.digest.items.filter((item) => item.code === 'drift_unavailable' || item.code === 'config_drift')).toEqual([]);
    expect((await view<CloudflareView>(h, 'cloudflare')).drift).toMatchObject({ status: 'ok', consecutive_failed_days: 0 });
  });

  it('makes no call without the token and says not_configured', async () => {
    h = await startFlows({ bindings: { CF_ANALYTICS_TOKEN: '' } });
    await h.tick(driftHour(1));
    await h.tick(driftHour(1) + 30 * MIN);
    expect(driftRequests(h)).toBe(0);
    expect((await view<CloudflareView>(h, 'cloudflare')).drift.status).toBe('not_configured');
  });
});
