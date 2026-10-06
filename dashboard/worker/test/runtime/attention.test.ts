/** Owner reminder controls against real SQLite HomeState; only synthetic statuses. */
import { afterEach, describe, expect, it } from 'vitest';
import { DRIFT_UTC_HOUR, VIEW_BODY_MAX, VIEW_ROWS_READ_MAX, type AttentionItem, type HomeView, type OpsView } from '../../src/api-types.ts';
import { REALISTIC_USAGE } from '../graphql-fixture.ts';
import { answerProbes, NOW, startFlows, status, type FlowHarness } from './flows.ts';

let h: FlowHarness | undefined;
afterEach(async () => { await h?.dispose(); h = undefined; });
const MINUTE = 60_000;
function activeHarness(): FlowHarness { if (h === undefined) throw new Error('synthetic harness not started'); return h; }

async function start(): Promise<FlowHarness> {
  const result = await startFlows({ usage: REALISTIC_USAGE, bindings: { CANARY_ENABLED: 'false', CANARY_UTC_HOUR: '23' } });
  answerProbes(result);
  return result;
}
async function newsletter(count: number | null, hostStale = false) {
  return status('newsletter', { health: count === 0 ? 'ok' : 'degraded',
    signals: hostStale ? [{ code: 'host_stale', severity: 'warning', metrics: {} }]
      : count === 0 ? [] : [{ code: 'newsletter_unknown', severity: 'warning', metrics: { unknown_count: count ?? 0 } }],
    counters: count === null ? {} : { unknown_count: count } });
}
async function home(): Promise<HomeView> {
  const result = await activeHarness().view<HomeView>('home');
  if (result.body === null) throw new Error('missing synthetic view');
  return result.body;
}
function managed(item: AttentionItem | undefined): AttentionItem & { name: string; etag: string } {
  if (!item?.name || !item.etag) throw new Error('missing reminder control revision');
  return item as AttentionItem & { name: string; etag: string };
}
async function change(item: AttentionItem, action: 'dismiss' | 'restore', id = crypto.randomUUID()) {
  const current = managed(item);
  return activeHarness().post(`/api/v1/${current.name}:${action}`, { etag: current.etag, request_id: id });
}
async function advance(step: number): Promise<void> {
  const at = NOW + step * 11 * MINUTE;
  await activeHarness().redeploy({ DEV_NOW: new Date(at).toISOString(), BUILD_SHA: `synthetic-${String(step)}` });
  await activeHarness().tick(at);
}

describe('persistent occurrence controls', () => {
  // Current Fleet warns with newsletter_side_effect_unknown; an older Fleet still warns with newsletter_unknown.
  it.each([
    ['newsletter_side_effect_unknown', 'count'],
    ['newsletter_unknown', 'unknown_count'],
  ] as const)('does not reopen a dismissed %s batch on count reduction or an equal-count replacement without a new revision', async (code, metric) => {
    h = await start();
    const observe = async (count: number, revision: number, step: number) => {
      await activeHarness().answer('newsletter', 'status', { value: await status('newsletter', {
        health: 'ok', signals: count === 0 ? [] : [{ code, severity: 'warning', metrics: { [metric]: count, unknown_revision: revision } }],
        counters: { unknown_count: count, unknown_revision: revision },
      }) });
      await advance(step);
    };
    const open = async () => (await home()).attention.items.some(item => item.code === code);
    await observe(34, 34, 0);
    const item = (await home()).attention.items.find(item => item.code === code);
    if (!item) throw new Error('missing synthetic warning');
    expect((await change(item, 'dismiss')).status).toBe(200);
    await observe(32, 34, 1);
    expect(await open()).toBe(false);
    await observe(0, 34, 2);
    await observe(32, 34, 3);
    expect(await open()).toBe(false);
    await observe(32, 35, 4);
    expect(await open()).toBe(true);
  });

  it('dismisses across restart/views without changing facts, and reports only on a later scheduled tick', async () => {
    h = await start();
    await h.answer('newsletter', 'status', { value: await newsletter(32) });
    await h.tick(NOW);
    const item = managed((await home()).attention.items.find((entry) => entry.code === 'newsletter_unknown'));
    await h.called();
    const id = crypto.randomUUID(), first = await change(item, 'dismiss', id);
    expect(first.status).toBe(200);
    const answer = await first.json() as AttentionItem;
    expect(answer.dismissed_at).toBeDefined(); expect(answer.etag).not.toBe(item.etag);
    expect(await h.callsOf('todofy', 'reportOps')).toEqual([]);
    const replay = await change(item, 'dismiss', id);
    expect(await replay.json()).toEqual(answer);
    const reused = await change(answer, 'dismiss', id);
    expect(reused.status).toBe(400);
    await h.redeploy({ BUILD_SHA: 'synthetic-restart' });
    for (const view of ['home', 'flows', 'cloudflare', 'ops'] as const) {
      const result = await h.view<HomeView>(view);
      expect(result.body?.attention.items.some((entry) => entry.code === 'newsletter_unknown')).toBe(false);
      expect(result.body?.attention.dismissed_items?.find((entry) => entry.code === 'newsletter_unknown')).toMatchObject({ name: item.name, etag: answer.etag });
    }
    const before = await h.view<OpsView>('ops');
    expect(before.body?.apps.find((app) => app.entry === 'newsletter')?.status?.counters.unknown_count).toBe(32);
    expect(before.body?.digest.items.some((entry) => entry.code === 'newsletter_unknown')).toBe(false);
    await advance(1);
    const reports = await h.callsOf('todofy', 'reportOps');
    expect(reports).toHaveLength(1);
    expect((reports[0]?.[0] as { items: AttentionItem[] }).items.some((entry) => entry.code === 'newsletter_unknown')).toBe(false);
  });

  it('keeps the same 32 dismissed through a fresh RPC with an unavailable underlying host, then resurfaces changes', async () => {
    h = await start(); await h.answer('newsletter', 'status', { value: await newsletter(32) }); await h.tick(NOW);
    const initial = managed((await home()).attention.items.find((entry) => entry.code === 'newsletter_unknown'));
    const dismissed = await (await change(initial, 'dismiss')).json() as AttentionItem;
    await h.answer('newsletter', 'status', { value: await newsletter(null, true) }); await advance(1);
    expect((await home()).attention.items.some((entry) => entry.code === 'host_stale')).toBe(true);
    await h.answer('newsletter', 'status', { value: await newsletter(32) }); await advance(2);
    expect((await home()).attention.dismissed_items?.find((entry) => entry.code === 'newsletter_unknown')?.etag).toBe(dismissed.etag);
    await h.answer('newsletter', 'status', { value: await newsletter(33) }); await advance(3);
    const grown = managed((await home()).attention.items.find((entry) => entry.code === 'newsletter_unknown'));
    expect(grown.etag).not.toBe(dismissed.etag);
    expect((await change(dismissed, 'dismiss')).status).toBe(409);
    await change(grown, 'dismiss');
    await h.answer('newsletter', 'status', { value: await newsletter(0) }); await advance(4);
    await h.answer('newsletter', 'status', { value: await newsletter(33) }); await advance(5);
    expect((await home()).attention.items.find((entry) => entry.code === 'newsletter_unknown')).toBeDefined();
  });

  it('an evicted old request cannot undo a newer restore', async () => {
    h = await start(); await h.answer('newsletter', 'status', { value: await newsletter(32) }); await h.tick(NOW);
    const item = managed((await home()).attention.items.find((entry) => entry.code === 'newsletter_unknown'));
    const oldID = crypto.randomUUID(), closed = await (await change(item, 'dismiss', oldID)).json() as AttentionItem;
    for (let index = 0; index < 18; index++) expect((await change(closed, 'dismiss')).status).toBe(200);
    const restored = await change(closed, 'restore'); expect(restored.status).toBe(200);
    const open = await restored.json() as AttentionItem;
    expect(open.dismissed_at).toBeUndefined(); expect(open.etag).not.toBe(closed.etag);
    expect((await change(item, 'dismiss', oldID)).status).toBe(409);
    expect((await home()).attention.items.find((entry) => entry.code === 'newsletter_unknown')?.etag).toBe(open.etag);
  });

  it('meaningful failure counts reopen, but age changes do not', async () => {
    h = await start();
    const failure = (count: number, age: number) => status('mail-hero', { health: 'degraded',
      signals: [{ code: 'parse_failed', severity: 'warning', metrics: { count, age_hours: age } }] });
    await h.answer('mail-hero', 'status', { value: await failure(1, 1) }); await h.tick(NOW);
    const item = managed((await home()).attention.items.find((entry) => entry.code === 'parse_failed'));
    const closed = await (await change(item, 'dismiss')).json() as AttentionItem;
    await h.answer('mail-hero', 'status', { value: await failure(1, 2) }); await advance(1);
    expect((await home()).attention.dismissed_items?.find((entry) => entry.code === 'parse_failed')?.etag).toBe(closed.etag);
    await h.answer('mail-hero', 'status', { value: await failure(2, 3) }); await advance(2);
    expect((await home()).attention.items.find((entry) => entry.code === 'parse_failed')?.etag).not.toBe(closed.etag);
  });

  it('filters before the outbound 20-item cap so later active conditions are not lost', async () => {
    h = await start();
    for (const app of ['mail-hero', 'todofy', 'lab'] as const) await h.answer(app, 'status', { value: await status(app, {
      health: 'degraded', signals: Array.from({ length: 12 }, (_unused, index) => ({ code: `synthetic_warning_${String(index).padStart(2, '0')}`, severity: 'warning' as const, metrics: {} })),
    }) });
    await h.tick(NOW);
    const initial = (await home()).attention.items.filter((item) => item.code.startsWith('synthetic_warning_'));
    expect(initial).toHaveLength(36);
    for (const item of initial.slice(0, 20)) expect((await change(item, 'dismiss')).status).toBe(200);
    const current = await h.view<OpsView>('ops');
    expect(current.body?.digest.items.filter((item) => item.code.startsWith('synthetic_warning_'))).toHaveLength(16);
    await h.callsOf('todofy', 'reportOps'); await advance(1);
    const reports = await h.callsOf('todofy', 'reportOps');
    expect((reports[0]?.[0] as { items: AttentionItem[] }).items.filter((item) => item.code.startsWith('synthetic_warning_'))).toHaveLength(16);
  });

  it('REST drift recovery retires a dismissal even while GraphQL usage is unavailable', async () => {
    h = await start();
    const day = 86_400_000, beginning = Math.floor(NOW / day) * day + DRIFT_UTC_HOUR * 60 * MINUTE;
    const complete = async (at: number) => {
      await activeHarness().redeploy({ DEV_NOW: new Date(at + 60 * MINUTE).toISOString() });
      for (let index = 0; index < 3; index++) await activeHarness().tick(at + index * 30 * MINUTE);
    };
    h.cloudflare.tweaks = { extraScripts: ['synthetic-orphan'] };
    await complete(beginning);
    const original = managed((await home()).attention.items.find((entry) => entry.code === 'config_drift'));
    const closed = await (await change(original, 'dismiss')).json() as AttentionItem;
    h.cloudflare.tweaks = {}; h.analytics.answer = () => new Response('synthetic unavailable', { status: 503 });
    await complete(beginning + day);
    expect((await home()).attention.dismissed_items?.some((entry) => entry.code === 'config_drift')).not.toBe(true);
    h.cloudflare.tweaks = { extraScripts: ['synthetic-orphan'] };
    await complete(beginning + 2 * day);
    const again = managed((await home()).attention.items.find((entry) => entry.code === 'config_drift'));
    expect(again.etag).not.toBe(closed.etag);
  });

  it('all six bounded sources remain manageable on a bad day, closed or active after restart', async () => {
    h = await start();
    for (const app of ['mail-hero', 'todofy', 'lab', 'watch', 'fleet', 'newsletter'] as const) await h.answer(app, 'status', { value: await status(app, {
      health: 'degraded', signals: Array.from({ length: 16 }, (_unused, index) => ({ code: `stress_warning_${String(index).padStart(2, '0')}`, severity: 'warning' as const, metrics: { count: index } })),
    }) });
    await h.tick(NOW);
    const initial = (await home()).attention.items;
    expect(initial.filter((entry) => entry.code.startsWith('stress_warning_'))).toHaveLength(96);
    for (const view of ['home', 'flows', 'cloudflare', 'ops'] as const) {
      const result = await h.view<HomeView>(view);
      expect(result.bytes).toBeLessThanOrEqual(VIEW_BODY_MAX);
      expect(await h.lastRowsRead()).toBeLessThanOrEqual(VIEW_ROWS_READ_MAX);
    }
    for (const entry of initial.filter((item) => item.code.startsWith('stress_warning_'))) expect((await change(entry, 'dismiss')).status).toBe(200);
    await h.redeploy({ BUILD_SHA: 'synthetic-bad-day-restart' });
    for (const view of ['home', 'flows', 'cloudflare', 'ops'] as const) {
      const result = await h.view<HomeView>(view);
      expect(result.body?.attention.dismissed_items?.filter((entry) => entry.code.startsWith('stress_warning_'))).toHaveLength(96);
      expect(result.body?.attention.items.some((entry) => entry.code.startsWith('stress_warning_'))).toBe(false);
      expect(result.bytes).toBeLessThanOrEqual(VIEW_BODY_MAX);
      expect(await h.lastRowsRead()).toBeLessThanOrEqual(VIEW_ROWS_READ_MAX);
    }
  });
});
