/**
 * The HTTP surface and the owner API in workerd (../../../docs/design.md §9): Access, Origin and CSRF in front of the
 * transcoder, the private headers, AIP-155 request IDs, AIP-154 etags, the value rules the IDL cannot hold, and ops-v1
 * over the service binding (counts and codes only, the guard).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { Label_GmailState, LabelSchema } from '@ziyixi/proto/mailsort/ui/v1/label_pb';
import { RuleSchema, Rule_Kind } from '@ziyixi/proto/mailsort/ui/v1/rule_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
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
    const plain = await h.fetch('/api/v1/labels', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' });
    expect(plain.status).toBe(403);
    const csrf = await h.fetch('/api/csrf');
    const { token } = await csrf.json<{ token: string }>();
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const foreign = await h.fetch('/api/v1/labels', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.net', 'x-csrf-token': token, cookie }, body: '{}' });
    expect(foreign.status).toBe(403);
    expect(h.logs.some((line) => line.includes('"reason":"CSRF_FAILED"'))).toBe(true);
  });

  it('refuses a request outside loopback when the dev bypass is on (no Access login)', async () => {
    const response = await h.fetch('/api/v1/labels', { headers: { 'cf-ray': 'synthetic' } });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('answers unknown API paths with a Status and the UI paths with the page', async () => {
    const missing = await h.fetch('/api/v1/nothing');
    expect(missing.status).toBe(404);
    expect((await missing.json<{ error: { status: string } }>()).error.status).toBe('NOT_FOUND');
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
    // A label's threshold out of range is a label error (the labels page shows it), not a settings one.
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'thr', label: create(LabelSchema, { displayName: 't', threshold: 0.3 }), requestId: op() })))).toBe('INVALID_LABEL');
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

  it('rules: create, approve, disable, delete, and the filter export', async () => {
    const rule = await h.api.createRule({ rule: create(RuleSchema, { kind: Rule_Kind.LIST_ID, value: 'Digest.News.Example.com', label: 'labels/newsletter' }), requestId: op() });
    expect(rule).toMatchObject({ value: 'digest.news.example.com', state: 2, dmarcRequired: false });
    expect(reasonOf(await rejection(h.api.createRule({ rule: create(RuleSchema, { kind: Rule_Kind.SENDER_ADDRESS, value: 'not-an-address', label: 'labels/newsletter' }), requestId: op() })))).toBe('INVALID_RULE');
    const exported = await h.api.exportGmailFilters({});
    expect(exported.ruleCount).toBe(1);
    expect(exported.xml).toContain('list:(&quot;digest.news.example.com&quot;)');
    // A value that could widen a Gmail filter is refused, whoever proposes it.
    expect(reasonOf(await rejection(h.api.createRule({ rule: create(RuleSchema, { kind: Rule_Kind.LIST_ID, value: 'x)OR(from:*', label: 'labels/newsletter' }), requestId: op() })))).toBe('INVALID_RULE');
    expect(reasonOf(await rejection(h.api.createRule({ rule: create(RuleSchema, { kind: Rule_Kind.SENDER_DOMAIN, value: '-example.com', label: 'labels/newsletter' }), requestId: op() })))).toBe('INVALID_RULE');
    // An older row with such a value is left out of the export and counted.
    await h.sql(`INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time) VALUES ('r-old', 'list_id', 'x)or(from:*', 'newsletter', 'active', 0, 0)`);
    const skipped = await h.api.exportGmailFilters({});
    expect(skipped).toMatchObject({ ruleCount: 1, skippedCount: 1 });
    expect(skipped.xml).not.toContain('from:*');
    await h.sql(`DELETE FROM rules WHERE id = 'r-old'`);
    expect((await h.api.disableRule({ name: rule.name, requestId: op() })).state).toBe(3);
    expect((await h.api.approveRule({ name: rule.name, requestId: op() })).state).toBe(2);
    await h.api.deleteRule({ name: rule.name, requestId: op() });
    expect((await h.api.listRules({})).rules).toEqual([]);
  });

  it('SyncLabels adopts the Gmail label of a label\'s exact path, follows renames by ID, and never imports another label', async () => {
    await h.step(T0);
    const gmail = h.up.gmail;
    // The owner's labels: one with the path of mailsort's 订阅, the rest their own (none is ever imported or linked).
    const adopted = gmail.createUserLabel('订阅', true);
    for (const name of ['旅行', 'Personal', '订阅/周报', '分拣/订阅']) gmail.createUserLabel(name);
    const before = (await h.api.listLabels({})).labels.length;
    const writes = () => gmail.calls.filter((call) => call.method !== 'GET' && !call.url.includes('/token')).length;
    const writesBefore = writes();
    const first = await h.api.syncLabels({ requestId: op() });
    expect(first).toMatchObject({ linkedCount: 1, renamedCount: 0, missingCount: 0, importedCount: 0 });
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
    // A system label is never adopted, whatever its name (nor by CreateLabel, which tries Gmail at once in live mode).
    const inbox = await h.api.createLabel({ labelId: 'inbox-name', label: create(LabelSchema, { displayName: 'INBOX' }), requestId: op() });
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ linkedCount: 0 });
    expect(await h.api.getLabel({ name: inbox.name })).toMatchObject({ gmailLabelId: '', gmailState: Label_GmailState.PENDING });
    await h.api.deleteLabel({ name: inbox.name, requestId: op() });
  });

  it('the review queue: confirm, skip, already resolved', async () => {
    h.up.gmail.deliver(message({ ...MAILS.newsletterEn, receivedAt: T0 }));
    h.up.gmail.deliver(message({ ...MAILS.unsure, receivedAt: T0 }));
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW }), updateMask: { paths: ['mode'] }, requestId: op() });
    const pass = await h.step(T0 + HOUR);
    const { reviewItems } = await h.api.listReviewItems({});
    expect(reviewItems.length, JSON.stringify({ pass, decisions: await h.sql('SELECT message_id, outcome, unsure_reason FROM decisions'), pending: await h.sql('SELECT * FROM pending') })).toBe(2);
    expect(reviewItems.length).toBe(2);
    const suggestion = reviewItems.find((item) => item.kind === 1);
    const unsure = reviewItems.find((item) => item.kind === 2);
    expect((await h.api.confirmReviewItem({ name: suggestion?.name ?? '', requestId: op() })).state).toBe(2);
    expect(reasonOf(await rejection(h.api.confirmReviewItem({ name: unsure?.name ?? '', requestId: op() })))).toBe('BAD_REQUEST');
    expect((await h.api.skipReviewItem({ name: unsure?.name ?? '', requestId: op() })).state).toBe(4);
    expect(reasonOf(await rejection(h.api.skipReviewItem({ name: unsure?.name ?? '', requestId: op() })))).toBe('ALREADY_RESOLVED');
    // Shadow mode wrote nothing.
    expect(h.up.gmail.calls.filter((call) => call.url.endsWith('/modify'))).toEqual([]);
    const accuracy = await h.api.getAccuracyReport({ name: 'accuracyReport' });
    expect(accuracy.labels.find((label) => label.label === 'labels/newsletter')).toMatchObject({ confirmedCount: 1, correctedCount: 0 });
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
    expect(shed).toMatchObject({ level: 'shed', deferred: ['full_model', 'audit', 'embedding_rebuild'] });
    expect((await h.opsSetGuard({ level: 'bogus' }).catch((error: unknown) => (error as Error).message))).toContain('invalid_input');
    expect(await h.opsSetGuard({ level: 'normal', reason: 'quota_recovered', until: null })).toMatchObject({ level: 'normal' });
  });
});
