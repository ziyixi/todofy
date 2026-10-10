/**
 * The HTTP surface and the owner API in workerd (../../../docs/design.md §9): Access, Origin and CSRF in front of the
 * transcoder, the private headers, the old /api/v1 paths answering 410 RELOAD_REQUIRED, AIP-155 request IDs, AIP-154
 * etags, the value rules the IDL cannot hold, the review queue's answers, and ops-v1 over the service binding (counts
 * and codes only, the guard).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { Label_GmailState, LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { ReviewItem_State } from '@ziyixi/proto/mailsort/ui/v2/review_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { fromWire } from '@ziyixi/proto/wire-json';
import { OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import { MAILS, message } from '../fakes/fixtures.ts';
import { HOUR, op, ORIGIN, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

describe('the HTTP surface', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('serves /health without data and the UI with the private headers', async () => {
    const health = await h.fetch('/health');
    expect(await health.json()).toEqual({ service: 'mailsort', status: 'ok', build: 'test' });
    const page = await h.fetch('/review');
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('refuses a mutation without the CSRF token or from another origin, before reading the body', async () => {
    const plain = await h.fetch('/api/v2/labels', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' });
    expect(plain.status).toBe(403);
    const csrf = await h.fetch('/api/csrf');
    const { token } = await csrf.json<{ token: string }>();
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const foreign = await h.fetch('/api/v2/labels', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.net', 'x-csrf-token': token, cookie }, body: '{}' });
    expect(foreign.status).toBe(403);
    expect(h.logs.some((line) => line.includes('"reason":"CSRF_FAILED"'))).toBe(true);
  });

  it('refuses a request outside loopback when the dev bypass is on (no Access login)', async () => {
    const response = await h.fetch('/api/v2/labels', { headers: { 'cf-ray': 'synthetic' } });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('answers unknown API paths with a Status and the UI paths with the page', async () => {
    const missing = await h.fetch('/api/v2/nothing');
    expect(missing.status).toBe(404);
    expect((await missing.json<{ error: { status: string } }>()).error.status).toBe('NOT_FOUND');
  });

  it('answers every path of the old API (an open tab of the page before the update) with 410 and a reload message', async () => {
    for (const [method, path] of [['GET', '/api/v1/labels'], ['GET', '/api/v1/rules'], ['POST', '/api/v1/reviewItems/x:confirm'], ['GET', '/api/v1']] as const) {
      const response = await h.fetch(path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' } : {}) });
      expect(response.status, path).toBe(410);
      const body = await response.json<{ error: { status: string; details: { reason?: string; message?: string; locale?: string }[] } }>();
      expect(body.error.status).toBe('FAILED_PRECONDITION');
      expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'RELOAD_REQUIRED' }), expect.objectContaining({ locale: 'zh-CN', message: '邮件分拣已更新，请刷新页面' })]));
    }
  });
});

describe('the owner API', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('creates labels by the rules, once per request ID', async () => {
    const requestId = op();
    const first = await h.api.createLabel({ labelId: 'newsletter', label: create(LabelSchema, { displayName: '订阅', description: 'newsletter', enabled: true }), requestId });
    const again = await h.api.createLabel({ labelId: 'newsletter', label: create(LabelSchema, { displayName: '订阅', description: 'newsletter', enabled: true }), requestId });
    expect(again.etag).toBe(first.etag);
    expect(first).toMatchObject({ name: 'labels/newsletter', displayName: '订阅', gmailState: 1, descriptionVersion: 1 });
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'other', label: create(LabelSchema, { displayName: '订阅' }), requestId: op() })))).toBe('LABEL_EXISTS');
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'none', label: create(LabelSchema, { displayName: 'x' }), requestId: op() })))).toBe('INVALID_LABEL');
    // A path of up to three segments; a parent or child of another label is refused (only leaves are labels).
    for (const displayName of ['a//b', 'a/b/c/d', '/a', '订阅/周报']) {
      expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'bad', label: create(LabelSchema, { displayName }), requestId: op() }))), displayName).toBe('INVALID_LABEL');
    }
    // A repeated request ID answers the first response, whatever the body says now (AIP-155).
    expect((await h.api.createLabel({ labelId: 'newsletter', label: create(LabelSchema, { displayName: '另一个' }), requestId })).displayName).toBe('订阅');
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'travel', label: create(LabelSchema, { displayName: '出行' }), requestId })))).toBe('BAD_REQUEST');
  });

  it('updates with an etag and a mask, and bumps the description version', async () => {
    const label = await h.api.getLabel({ name: 'labels/newsletter' });
    const updated = await h.api.updateLabel({ label: create(LabelSchema, { name: 'labels/newsletter', description: '订阅 weekly digest', etag: label.etag }), updateMask: { paths: ['description', 'etag'] }, requestId: op() });
    expect(updated).toMatchObject({ description: '订阅 weekly digest', descriptionVersion: 2, enabled: true });
    const stale = await rejection(h.api.updateLabel({ label: create(LabelSchema, { name: 'labels/newsletter', enabled: false, etag: label.etag }), updateMask: { paths: ['enabled', 'etag'] }, requestId: op() }));
    // The mask names `etag`, so the client sends it (it sends only the masked fields).
    expect(reasonOf(stale)).toBe('ETAG_MISMATCH');
  });

  it('settings need an explicit mask; choosing a mode resets the breaker', async () => {
    expect(reasonOf(await rejection(h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), requestId: op() })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', runWriteLimit: 50 }), updateMask: { paths: ['run_write_limit'] }, requestId: op() })))).toBe('INVALID_SETTINGS');
    await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', '{"mode":"live","breaker":"daily_limit"}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ breakerTripped: true, effectiveMode: Mode.SHADOW });
    const reset = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: op() });
    expect(reset).toMatchObject({ breakerTripped: false, effectiveMode: Mode.LIVE, mode: Mode.LIVE });
  });

  it('SyncLabels adopts the Gmail label of a label\'s exact path (never one with labels nested under it), follows renames by ID, and never imports another label', async () => {
    await h.step(T0);
    const gmail = h.up.gmail;
    // The owner's labels: one with the path of mailsort's 订阅, the rest their own (none is ever imported or linked).
    const adopted = gmail.createUserLabel('订阅', true);
    const nested = gmail.createUserLabel('订阅/周报');
    for (const name of ['旅行', 'Personal', '分拣/订阅']) gmail.createUserLabel(name);
    const before = (await h.api.listLabels({})).labels.length;
    const writes = () => gmail.calls.filter((call) => call.method !== 'GET' && !call.url.includes('/token')).length;
    const writesBefore = writes();
    // 订阅 has 订阅/周报 under it: a parent in Gmail, never adopted (a mail's label is always a leaf). Its name is taken.
    const parentFirst = await h.api.syncLabels({ requestId: op() });
    expect(parentFirst).toMatchObject({ linkedCount: 0, renamedCount: 0, missingCount: 0 });
    expect(parentFirst.labels.find((label) => label.name === 'labels/newsletter')).toMatchObject({ gmailLabelId: '', gmailState: Label_GmailState.NAME_TAKEN });
    gmail.labels.delete(nested);
    const first = await h.api.syncLabels({ requestId: op() });
    expect(first).toMatchObject({ linkedCount: 1, renamedCount: 0, missingCount: 0 });
    expect(first.labels).toHaveLength(before);
    const newsletter = () => first.labels.find((label) => label.name === 'labels/newsletter');
    expect(newsletter()).toMatchObject({ displayName: '订阅', gmailLabelId: adopted, gmailState: Label_GmailState.ADOPTED });
    // Renamed in Gmail: the label follows its Gmail ID.
    const named = (name: string) => {
      const label = gmail.labels.get(adopted);
      if (label !== undefined) label.name = name;
    };
    named('资讯');
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ linkedCount: 0, renamedCount: 1, missingCount: 0 });
    expect(await h.api.getLabel({ name: 'labels/newsletter' })).toMatchObject({ displayName: '资讯', gmailLabelId: adopted, gmailState: Label_GmailState.ADOPTED });
    // A name the store cannot hold (the legacy prefix, not a path) is left alone; writes still go by the ID.
    named('分拣/资讯');
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ renamedCount: 0 });
    expect((await h.api.getLabel({ name: 'labels/newsletter' })).displayName).toBe('资讯');
    // Deleted in Gmail: missing; a Gmail label of its path again: linked again.
    gmail.labels.delete(adopted);
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ missingCount: 1 });
    expect((await h.api.getLabel({ name: 'labels/newsletter' })).gmailState).toBe(Label_GmailState.MISSING);
    const again = gmail.createUserLabel('资讯', true);
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ linkedCount: 1 });
    expect(await h.api.getLabel({ name: 'labels/newsletter' })).toMatchObject({ gmailLabelId: again, gmailState: Label_GmailState.ADOPTED });
    // A sync only reads Gmail.
    expect(writes()).toBe(writesBefore);
    // A system label is never adopted, whatever its name (nor by CreateLabel, which tries Gmail at once in live mode):
    // its name is taken.
    const inbox = await h.api.createLabel({ labelId: 'inbox-name', label: create(LabelSchema, { displayName: 'INBOX' }), requestId: op() });
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ linkedCount: 0 });
    expect(await h.api.getLabel({ name: inbox.name })).toMatchObject({ gmailLabelId: '', gmailState: Label_GmailState.NAME_TAKEN });
    await h.api.deleteLabel({ name: inbox.name, requestId: op() });
  });

  it('the review queue: uncertain mail only, resolve, skip, already resolved', async () => {
    // A week of 100 mails a day: the day's quota is 5, so both uncertain mails are shown.
    for (let day = 1; day <= 7; day++) await h.sql(`INSERT INTO usage (day, decided) VALUES (?, 100)`, new Date(T0 - day * 86_400_000).toISOString().slice(0, 10));
    h.up.ai.confidence = 0.5;
    h.up.gmail.deliver(message({ ...MAILS.newsletterEn, receivedAt: T0 }));
    h.up.gmail.deliver(message({ ...MAILS.receiptEn, receivedAt: T0 }));
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW }), updateMask: { paths: ['mode'] }, requestId: op() });
    const pass = await h.step(T0 + HOUR);
    h.up.ai.confidence = 0.92;
    const { reviewItems } = await h.api.listReviewItems({});
    expect(reviewItems.length, JSON.stringify({ pass, decisions: await h.sql('SELECT message_id, outcome, unsure_reason FROM decisions') })).toBe(2);
    expect(reviewItems.map((item) => item.reason)).toEqual(['low_confidence', 'low_confidence']);
    const newsletter = reviewItems.find((item) => item.subject.includes('digest'));
    const other = reviewItems.find((item) => item !== newsletter);
    expect(newsletter?.candidates[0]).toMatchObject({ label: 'labels/newsletter', probability: 0.5 });
    // Choosing a label that does not exist is refused before anything changes.
    expect(reasonOf(await rejection(h.api.resolveReviewItem({ name: newsletter?.name ?? '', label: 'labels/nothing', requestId: op() })))).toBe('NOT_FOUND');
    expect(await h.api.resolveReviewItem({ name: newsletter?.name ?? '', label: 'labels/newsletter', requestId: op() })).toMatchObject({ state: ReviewItem_State.RESOLVED, resolvedLabel: 'labels/newsletter' });
    expect((await h.api.skipReviewItem({ name: other?.name ?? '', requestId: op() })).state).toBe(ReviewItem_State.SKIPPED);
    expect(reasonOf(await rejection(h.api.skipReviewItem({ name: other?.name ?? '', requestId: op() })))).toBe('ALREADY_RESOLVED');
    expect(reasonOf(await rejection(h.api.resolveReviewItem({ name: newsletter?.name ?? '', label: '', requestId: op() })))).toBe('ALREADY_RESOLVED');
    // Shadow mode wrote nothing; the answer made an example of the label.
    expect(h.up.gmail.calls.filter((call) => call.url.endsWith('/modify'))).toEqual([]);
    expect((await h.api.listExamples({ label: 'labels/newsletter' })).examples).toHaveLength(1);
  });

  it('ops-v1: counts and codes only, and the guard', async () => {
    const status = await h.opsStatus();
    const read = fromWire(OpsStatusSchema, status);
    expect(read.unrecognized).toEqual([]);
    expect(status).toMatchObject({ version: 'ops-v1', app: 'mailsort', health: 'ok', ui_url: 'https://sort.example.com/', capabilities: ['guard'] });
    expect(Object.keys(status['counters'] as object)).toEqual(expect.arrayContaining(['decided_today', 'applied_today', 'unsure_today', 'review_pending', 'pending', 'neurons_today', 'neuron_budget']));
    const text = JSON.stringify(status);
    for (const secret of ['Weekly', 'digest@', 'owner@example.com', '订阅', 'Lunch']) expect(text).not.toContain(secret);
    const until = new Date(T0 + 2 * HOUR).toISOString().replace('.000Z', 'Z');
    const shed = (await h.opsSetGuard({ level: 'shed', reason: 'usage_80', until })) as { level: string; deferred: string[] };
    expect(shed).toMatchObject({ level: 'shed', deferred: ['full_model', 'replay', 'embedding_rebuild'] });
    expect((await h.opsSetGuard({ level: 'bogus' }).catch((error: unknown) => (error as Error).message))).toContain('invalid_input');
    expect(await h.opsSetGuard({ level: 'normal', reason: 'quota_recovered', until: null })).toMatchObject({ level: 'normal' });
  });
});
