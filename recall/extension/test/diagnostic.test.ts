import type { IngestBatch } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { describe, expect, it, vi } from 'vitest';
import { executeFile, queryTabs } from '../src/browser.ts';
import { countItems, queueItem, setToken } from '../src/db.ts';
import { DIAGNOSTIC_URL, diagnosticEvent, diagnosticStatus, observe, observeTabs, startDiagnostic, submitDiagnostic } from '../src/diagnostic.ts';
import { INITIAL_UPLOAD, uploadState } from '../src/store.ts';
import { flush } from '../src/upload.ts';
import { harness, INGEST_TOKEN, MINUTE, T0, type FakeTab } from './fake-chrome.ts';

async function setup() {
  const h = await harness();
  const ctx = { ...h.ctx, mobile: true };
  await setToken(ctx.db, INGEST_TOKEN);
  Object.assign(h.browser.api.tabs, { create: ({ url }: { url: string }, callback: (tab: FakeTab) => void) => { callback(h.browser.open(url)); } });
  h.net.answer = () => new Response(JSON.stringify({ accepted_count: 0, rejected: [], denylist_patterns: [], denylist_etag: 'synthetic' }));
  return { ...h, ctx };
}

async function sentBatch(h: Awaited<ReturnType<typeof setup>>): Promise<IngestBatch> {
  const body = h.net.requests.at(-1)?.init.body;
  if (!(body instanceof ArrayBuffer)) throw new Error('missing gzip diagnostic');
  return JSON.parse(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text()) as IngestBatch;
}

describe('one-shot Orion capture diagnostic', () => {
  it('starts and sends even when the native active-tab callback never answers, without changing normal uploads', async () => {
    const h = await setup();
    Object.assign(h.browser.api.tabs, { query: () => undefined });
    const started = await startDiagnostic(h.ctx);
    expect(started.diagnostic.state).toBe('running');
    expect([...h.browser.tabs.values()].map((tab) => tab.url)).toEqual([DIAGNOSTIC_URL]);
    // This is the same pending call that can block the normal focus queue on the phone.
    void queryTabs(h.ctx, { active: true });
    await vi.waitFor(async () => { expect((await diagnosticStatus(h.ctx)).diagnostic.latestState).toBe('pending'); });
    const item = { id: 'synthetic-item', kind: 'visit' as const, json: '{"kind":"visit","id":"synthetic-item"}', version: 1 };
    await queueItem(h.ctx.db, item, T0);
    await uploadState.set(h.ctx.chrome, { ...INITIAL_UPLOAD, tokenRefused: true, nextAttemptAt: T0 + MINUTE });
    const before = await uploadState.get(h.ctx.chrome);
    h.browser.badge = '!';
    const answer = await submitDiagnostic(h.ctx);
    expect(answer).toMatchObject({ ok: true, diagnostic: { state: 'sent' } });
    const batch = await sentBatch(h);
    expect(batch.items).toEqual([]);
    expect(batch.diagnostic?.steps).toContainEqual({ stage: 'active_tabs', state: 'pending' });
    expect(batch.device.queued_count).toBe(1);
    expect(await countItems(h.ctx.db)).toBe(1);
    expect(await uploadState.get(h.ctx.chrome)).toEqual(before);
    expect(h.browser.badge).toBe('!');
  });

  it('returns while tabs.create is pending, and only keeps one latest observation per stage', async () => {
    const h = await setup();
    Object.assign(h.browser.api.tabs, { create: () => undefined });
    expect(await startDiagnostic(h.ctx)).toMatchObject({ ok: true, diagnostic: { latestStage: 'open_test_page', latestState: 'pending' } });
    await observe(h.ctx, { stage: 'alarm_setup', state: 'returned', result: 'null' });
    await observe(h.ctx, { stage: 'alarm_setup', state: 'returned', result: 'created' });
    await Promise.all([diagnosticEvent(h.ctx, 'alarm'), diagnosticEvent(h.ctx, 'alarm'), diagnosticEvent(h.ctx, 'tab')]);
    await submitDiagnostic(h.ctx);
    expect((await sentBatch(h)).diagnostic).toMatchObject({ alarm_event_count: 2, tab_event_count: 1, steps: [{ stage: 'open_test_page', state: 'pending' }, { stage: 'alarm_setup', state: 'returned', result: 'created' }] });
  });

  it('snapshots only unfinished native calls, retaining a concurrent call after callback and catch both finish', async () => {
    const h = await setup();
    const callbacks: ((tabs: chrome.tabs.Tab[]) => void)[] = [];
    Object.assign(h.browser.api.tabs, { query: (_query: unknown, callback: (tabs: chrome.tabs.Tab[]) => void) => { callbacks.push(callback); } });
    const pending = queryTabs(h.ctx, { active: true });
    const failed = queryTabs(h.ctx, { active: true });
    const failure = expect(failed).rejects.toThrow('synthetic native failure');
    await vi.waitFor(() => { expect(callbacks).toHaveLength(2); });
    Object.assign(h.browser.api.runtime, { lastError: { message: 'synthetic native failure' } });
    callbacks[1]?.([]);
    delete (h.browser.api.runtime as unknown as Record<string, unknown>)['lastError'];
    await failure;
    await startDiagnostic(h.ctx);
    expect((await diagnosticStatus(h.ctx)).diagnostic.steps).toContainEqual({ stage: 'active_tabs', state: 'pending', initially_pending: true });
    callbacks[0]?.([]);
    await pending;
    // This remains the historical Start observation; it does not adopt an old call as a test-page result.
    expect((await diagnosticStatus(h.ctx)).diagnostic.steps).toContainEqual({ stage: 'active_tabs', state: 'pending', initially_pending: true });
    await startDiagnostic(h.ctx);
    expect((await diagnosticStatus(h.ctx)).diagnostic.steps.some((step) => step.stage === 'active_tabs')).toBe(false);
  });

  it('retains completed foreground observations when returning to native extension management', async () => {
    const h = await setup();
    await startDiagnostic(h.ctx);
    const tab = [...h.browser.tabs.values()][0];
    if (tab === undefined) throw new Error('test tab missing');
    await observeTabs(h.ctx, [tab as unknown as chrome.tabs.Tab]);
    const context = { stage: 'probe_context', state: 'returned', result: 'object', visibility: 'visible', stored_visibility: 'visible', sender_identity: 'missing' } as const;
    await observe(h.ctx, { stage: 'alarm_setup', state: 'returned', result: 'object' });
    await observe(h.ctx, context, tab.id);
    await observe(h.ctx, { stage: 'focus_target', state: 'returned', result: 'visible' }, tab.id);
    // A recreated background rechecks its alarm while the native test UI hides the public document.
    await observe(h.ctx, { stage: 'alarm_setup', state: 'pending' });
    await observe(h.ctx, { stage: 'probe_context', state: 'pending' }, tab.id);
    await observe(h.ctx, { ...context, visibility: 'hidden', stored_visibility: 'hidden' }, tab.id);
    await observe(h.ctx, { stage: 'focus_target', state: 'returned', result: 'hidden' }, tab.id);
    await observe(h.ctx, { stage: 'focus_target', state: 'skipped', result: 'excluded' }, tab.id);
    await submitDiagnostic(h.ctx);
    const steps = (await sentBatch(h)).diagnostic?.steps;
    expect(steps).toContainEqual({ stage: 'alarm_setup', state: 'returned', result: 'object' });
    expect(steps).toContainEqual(context);
    expect(steps).toContainEqual({ stage: 'focus_target', state: 'returned', result: 'visible' });
    expect(steps?.some((step) => step.state === 'pending')).toBe(false);
  });

  it('stops when the public test tab navigates away and does not attribute later page metadata to it', async () => {
    const h = await setup();
    const started = await startDiagnostic(h.ctx);
    const tab = [...h.browser.tabs.values()][0];
    if (tab === undefined) throw new Error('test tab missing');
    await observeTabs(h.ctx, [tab as unknown as chrome.tabs.Tab]);
    await observe(h.ctx, { stage: 'probe_reply', state: 'returned', result: 'object' }, tab.id);
    h.browser.navigate(tab.id, 'https://private.example.net/account');
    await observeTabs(h.ctx, [h.browser.tab(tab.id) as unknown as chrome.tabs.Tab]);
    expect((await diagnosticStatus(h.ctx)).diagnostic.state).toBe('stopped');
    await observe(h.ctx, { stage: 'capture_reply', state: 'returned', result: 'string' }, tab.id, started.diagnostic.runId);
    await submitDiagnostic(h.ctx);
    const report = (await sentBatch(h)).diagnostic;
    expect(report?.steps).toContainEqual({ stage: 'active_tabs', state: 'returned', result: 'array', count: 1, selection: 'test_page' });
    expect(report?.steps).toContainEqual({ stage: 'probe_reply', state: 'returned', result: 'object' });
    expect(report?.steps.some((step) => step.stage === 'capture_reply')).toBe(false);
    expect(JSON.stringify(report)).not.toContain('private.example');
  });

  it('sends separately while an ordinary upload is still waiting for its HTTP response', async () => {
    const h = await setup();
    await startDiagnostic(h.ctx);
    let finish!: (response: Response) => void;
    const successful = () => new Response(JSON.stringify({ accepted_count: 0, rejected: [], denylist_patterns: [], denylist_etag: 'synthetic' }));
    h.net.answer = () => h.net.requests.length === 1 ? new Promise<Response>((resolve) => { finish = resolve; }) : successful();
    const ordinary = flush(h.ctx, T0, 'manual');
    await vi.waitFor(() => { expect(h.net.requests).toHaveLength(1); });
    try {
      expect(await submitDiagnostic(h.ctx)).toMatchObject({ ok: true, diagnostic: { state: 'sent' } });
      expect((await sentBatch(h)).items).toEqual([]);
      expect(await uploadState.get(h.ctx.chrome)).toEqual(INITIAL_UPLOAD);
    } finally {
      finish(successful());
      await ordinary;
    }
  });

  it('sends every observation persisted before collection stops when a callback races Send', async () => {
    const h = await setup();
    await startDiagnostic(h.ctx);
    await observe(h.ctx, { stage: 'alarm_setup', state: 'returned', result: 'object' });
    let latestSteps = (await diagnosticStatus(h.ctx)).diagnostic.steps;
    let stepsAtStop = latestSteps;
    let stopped = false;
    const set = h.browser.local.set.bind(h.browser.local);
    vi.spyOn(h.browser.local, 'set').mockImplementation(async (items) => {
      const run = items['capture_diagnostic'] as { stopped: boolean; report: { steps: typeof latestSteps } } | undefined;
      if (run !== undefined) {
        if (!run.stopped) latestSteps = run.report.steps;
        else if (!stopped) {
          stepsAtStop = latestSteps;
          stopped = true;
        }
      }
      await set(items);
    });
    const sending = submitDiagnostic(h.ctx);
    const callback = observe(h.ctx, { stage: 'active_tabs', state: 'failed', result: 'api_error' });
    await Promise.all([sending, callback]);
    expect((await sentBatch(h)).diagnostic?.steps).toEqual(stepsAtStop);
    expect(stepsAtStop).toContainEqual({ stage: 'alarm_setup', state: 'returned', result: 'object' });
  });

  it('keeps page-only context and native return types, never page values, exceptions or screenshots', async () => {
    const h = await setup();
    await startDiagnostic(h.ctx);
    const tab = [...h.browser.tabs.values()][0];
    if (tab === undefined) throw new Error('test tab missing');
    await observeTabs(h.ctx, [tab as unknown as chrome.tabs.Tab]);
    Object.assign(h.browser.api.tabs, {
      executeScript: (_id: number, _details: unknown, callback: (value: unknown[]) => void) => { callback([null]); },
      sendMessage: (_id: number, message: { type: string }, callback: (value: unknown) => void) => {
        callback(message.type === 'recall-diagnostic-context' ? { visibility: 'hidden', stored_visibility: 'visible', sender_identity: 'null', url: 'https://private.example.net/secret', text: 'private body' } : null);
      },
    });
    expect(await executeFile(h.ctx, tab.id, 'probe.js')).toBeNull();
    await vi.waitFor(async () => { expect((await diagnosticStatus(h.ctx)).diagnostic.stepCount).toBeGreaterThan(3); });
    const privateTab = h.browser.open('https://private.example.net/secret', { title: 'Private title', incognito: true });
    await observe(h.ctx, { stage: 'capture_reply', state: 'returned', result: 'string' }, privateTab.id);
    await observeTabs(h.ctx, [privateTab as unknown as chrome.tabs.Tab]);
    const options = h.browser.open('chrome-extension://synthetic/options.html');
    await observeTabs(h.ctx, [options as unknown as chrome.tabs.Tab]);
    expect((await diagnosticStatus(h.ctx)).diagnostic.state).toBe('stopped');
    await observe(h.ctx, { stage: 'probe_reply', state: 'returned', result: 'object' }, tab.id);
    await submitDiagnostic(h.ctx);
    const report = (await sentBatch(h)).diagnostic;
    expect(report?.steps).toContainEqual({ stage: 'probe_context', state: 'returned', result: 'object', visibility: 'hidden', stored_visibility: 'visible', sender_identity: 'null' });
    expect(report?.steps).toContainEqual({ stage: 'probe_reply', state: 'returned', result: 'null' });
    expect(report?.steps).toContainEqual({ stage: 'active_tabs', state: 'returned', result: 'array', count: 1, selection: 'test_page' });
    const json = JSON.stringify(report);
    for (const secret of ['private.example', 'Private title', 'private body', 'data:image', INGEST_TOKEN, DIAGNOSTIC_URL]) expect(json).not.toContain(secret);
    expect(report?.steps.some((step) => step.stage === 'capture_reply')).toBe(false);
  });

  it('restores the active run after background recreation, expires and ignores late callbacks from an old run', async () => {
    const h = await setup();
    const first = await startDiagnostic(h.ctx);
    const recreated = { ...h.ctx, chrome: { ...h.ctx.chrome } };
    expect((await diagnosticStatus(recreated)).diagnostic.runId).toBe(first.diagnostic.runId);
    await diagnosticEvent(recreated, 'alarm');
    h.clock.advance(6 * MINUTE);
    await diagnosticEvent(recreated, 'alarm');
    expect((await diagnosticStatus(recreated)).diagnostic).toMatchObject({ state: 'stopped', alarmEvents: 1 });
    await startDiagnostic(recreated);
    await observe(recreated, { stage: 'active_tabs', state: 'returned', result: 'array' }, undefined, first.diagnostic.runId);
    await submitDiagnostic(recreated);
    expect((await sentBatch(h)).diagnostic?.steps.some((step) => step.stage === 'active_tabs')).toBe(false);
  });

  it('does not read native tabs or mutate local storage on desktop Chrome', async () => {
    const h = await harness();
    const before = structuredClone(h.browser.local.values);
    expect(await startDiagnostic(h.ctx)).toMatchObject({ ok: false, error: 'unsupported' });
    expect(await submitDiagnostic(h.ctx)).toMatchObject({ ok: false, error: 'unsupported' });
    await observe(h.ctx, { stage: 'active_tabs', state: 'pending' });
    await diagnosticEvent(h.ctx, 'alarm');
    expect(h.browser.local.values).toEqual(before);
    expect(h.browser.tabs.size).toBe(0);
    expect(h.net.requests).toEqual([]);
  });
});
