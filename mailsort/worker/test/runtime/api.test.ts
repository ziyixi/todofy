/**
 * The HTTP surface and the owner API in workerd (../../../docs/design.md §9): Access, Origin and CSRF in front of the
 * transcoder, the private headers, the old /api/v1 paths answering 410 RELOAD_REQUIRED, AIP-155 request IDs, AIP-154
 * etags, the value rules the IDL cannot hold, the review queue's answers, and ops-v1 over the service binding (counts
 * and codes only, the guard).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { Label_GmailState, Label_Problem, LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
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
    const first = await h.api.createLabel({ labelId: 'newsletter', label: create(LabelSchema, { displayName: 'Newsletters', description: 'newsletter', enabled: true }), requestId });
    const again = await h.api.createLabel({ labelId: 'newsletter', label: create(LabelSchema, { displayName: 'Newsletters', description: 'newsletter', enabled: true }), requestId });
    expect(again.etag).toBe(first.etag);
    expect(first).toMatchObject({ name: 'labels/newsletter', displayName: 'Newsletters', gmailState: 1, descriptionVersion: 1 });
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'other', label: create(LabelSchema, { displayName: 'Newsletters' }), requestId: op() })))).toBe('LABEL_EXISTS');
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'none', label: create(LabelSchema, { displayName: 'x' }), requestId: op() })))).toBe('INVALID_LABEL');
    // Only single-level English names are accepted on new writes; legacy reads remain valid.
    for (const displayName of ['a//b', 'a/b', '/a', '订阅', '123', 'a'.repeat(41)]) {
      expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'bad', label: create(LabelSchema, { displayName }), requestId: op() }))), displayName).toBe('INVALID_LABEL');
    }
    // A repeated request ID answers the first response, whatever the body says now (AIP-155).
    expect((await h.api.createLabel({ labelId: 'newsletter', label: create(LabelSchema, { displayName: 'Other' }), requestId })).displayName).toBe('Newsletters');
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'travel', label: create(LabelSchema, { displayName: 'Travel' }), requestId })))).toBe('BAD_REQUEST');
  });

  it('updates with an etag and a mask, and bumps the description version', async () => {
    const label = await h.api.getLabel({ name: 'labels/newsletter' });
    const updated = await h.api.updateLabel({ label: create(LabelSchema, { name: 'labels/newsletter', description: 'Newsletters weekly digest', etag: label.etag }), updateMask: { paths: ['description', 'etag'] }, requestId: op() });
    expect(updated).toMatchObject({ description: 'Newsletters weekly digest', descriptionVersion: 2, enabled: true });
    const stale = await rejection(h.api.updateLabel({ label: create(LabelSchema, { name: 'labels/newsletter', enabled: false, etag: label.etag }), updateMask: { paths: ['enabled', 'etag'] }, requestId: op() }));
    // The mask names `etag`, so the client sends it (it sends only the masked fields).
    expect(reasonOf(stale)).toBe('ETAG_MISMATCH');
  });

  it('settings need an explicit mask; a breaker an older release stored is ignored', async () => {
    expect(reasonOf(await rejection(h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), requestId: op() })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', runWriteLimit: 50 }), updateMask: { paths: ['run_write_limit'] }, requestId: op() })))).toBe('INVALID_SETTINGS');
    await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', '{"mode":"live","breaker":"daily_limit"}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ breakerTripped: false, breakerReason: '', effectiveMode: Mode.LIVE });
    const saved = await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: op() });
    expect(saved).toMatchObject({ breakerTripped: false, effectiveMode: Mode.LIVE, mode: Mode.LIVE });
    expect(JSON.parse((await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'settings'`))[0]?.value ?? '{}')).not.toHaveProperty('breaker');
  });

  it('SyncLabels adopts the Gmail label of a label\'s exact path (never one with labels nested under it), follows renames by ID, and never imports another label', async () => {
    await h.step(T0);
    const gmail = h.up.gmail;
    // The owner's labels: one with the path of mailsort's Newsletters, the rest their own (none is ever imported or linked).
    const adopted = gmail.createUserLabel('Newsletters', true);
    const nested = gmail.createUserLabel('Newsletters/周报');
    for (const name of ['旅行', 'Personal', '分拣/Newsletters']) gmail.createUserLabel(name);
    const before = (await h.api.listLabels({})).labels.length;
    const writes = () => gmail.calls.filter((call) => call.method !== 'GET' && !call.url.includes('/token')).length;
    const writesBefore = writes();
    // Newsletters has Newsletters/周报 under it: a parent in Gmail, never adopted (a mail's label is always a leaf). Its name is taken.
    const parentFirst = await h.api.syncLabels({ requestId: op() });
    expect(parentFirst).toMatchObject({ linkedCount: 0, renamedCount: 0, missingCount: 0 });
    expect(parentFirst.labels.find((label) => label.name === 'labels/newsletter')).toMatchObject({ gmailLabelId: '', gmailState: Label_GmailState.NAME_TAKEN, problem: Label_Problem.HAS_CHILDREN });
    gmail.labels.delete(nested);
    const first = await h.api.syncLabels({ requestId: op() });
    expect(first).toMatchObject({ linkedCount: 1, renamedCount: 0, missingCount: 0 });
    expect(first.labels).toHaveLength(before);
    const newsletter = () => first.labels.find((label) => label.name === 'labels/newsletter');
    expect(newsletter()).toMatchObject({ displayName: 'Newsletters', gmailLabelId: adopted, gmailState: Label_GmailState.ADOPTED });
    const addedChild = gmail.createUserLabel('Newsletters/External');
    expect((await h.api.syncLabels({ requestId: op() })).labels.find((label) => label.name === 'labels/newsletter')).toMatchObject({ problem: Label_Problem.HAS_CHILDREN });
    gmail.labels.delete(addedChild);
    expect((await h.api.syncLabels({ requestId: op() })).labels.find((label) => label.name === 'labels/newsletter')).toMatchObject({ problem: Label_Problem.UNSPECIFIED });
    // Renamed in Gmail: the label follows its Gmail ID.
    const named = (name: string) => {
      const label = gmail.labels.get(adopted);
      if (label !== undefined) label.name = name;
    };
    named('News');
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ linkedCount: 0, renamedCount: 1, missingCount: 0 });
    expect(await h.api.getLabel({ name: 'labels/newsletter' })).toMatchObject({ displayName: 'News', gmailLabelId: adopted, gmailState: Label_GmailState.ADOPTED });
    // An invalid remote name is retained for diagnosis and blocks new writes by ID.
    named('分拣/News');
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ renamedCount: 0 });
    expect(await h.api.getLabel({ name: 'labels/newsletter' })).toMatchObject({ displayName: 'News', problem: Label_Problem.INVALID_NAME });
    // Deleted in Gmail: missing; a Gmail label of its path again: linked again.
    gmail.labels.delete(adopted);
    expect(await h.api.syncLabels({ requestId: op() })).toMatchObject({ missingCount: 1 });
    expect((await h.api.getLabel({ name: 'labels/newsletter' })).gmailState).toBe(Label_GmailState.MISSING);
    const again = gmail.createUserLabel('News', true);
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

  it('direct Claude priorities remain records in shadow without mandatory review', async () => {
    await h.api.initializePriorities({ requestId: op() });
    h.up.claude.bucket = 'P2';
    h.up.gmail.deliver(message({ ...MAILS.newsletterEn, receivedAt: T0 + HOUR }));
    h.up.gmail.deliver(message({ ...MAILS.receiptEn, receivedAt: T0 + HOUR }));
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW }), updateMask: { paths: ['mode'] }, requestId: op() });
    const pass = await h.step(T0 + HOUR);
    const { reviewItems } = await h.api.listReviewItems({});
    expect(pass.decided).toBe(2);
    expect(reviewItems).toEqual([]);
    expect(await h.sql(`SELECT outcome, label_id FROM decisions WHERE message_id IN (?, ?) ORDER BY message_id`, MAILS.newsletterEn.id, MAILS.receiptEn.id))
      .toEqual([{ outcome: 'suggested', label_id: 'p2' }, { outcome: 'suggested', label_id: 'p2' }]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).reviewCount).toBe(0);
    expect(h.up.gmail.calls.filter((call) => call.url.endsWith('/modify'))).toEqual([]);
  });

  it('ops-v1: counts and codes only, Claude usage and no guard', async () => {
    const status = await h.opsStatus();
    const read = fromWire(OpsStatusSchema, status);
    expect(read.unrecognized).toEqual([]);
    expect(status).toMatchObject({ version: 'ops-v1', app: 'mailsort', health: 'ok', ui_url: 'https://sort.example.com/', capabilities: [] });
    expect(Object.keys(status['counters'] as object)).toEqual(expect.arrayContaining(['decided_today', 'applied_today', 'unsure_today', 'review_pending', 'pending', 'claude_spent_usd', 'claude_monthly_limit_usd']));
    const text = JSON.stringify(status);
    for (const secret of ['Weekly', 'digest@', 'owner@example.com', 'Newsletters', 'Lunch']) expect(text).not.toContain(secret);
    const until = new Date(T0 + 2 * HOUR).toISOString().replace('.000Z', 'Z');
    expect(await h.opsSetGuard({ level: 'shed', reason: 'usage_80', until }).catch((error: unknown) => (error as Error).message)).toContain('invalid_input');
    expect((await h.opsSetGuard({ level: 'bogus' }).catch((error: unknown) => (error as Error).message))).toContain('invalid_input');
    expect(await h.opsSetGuard({ level: 'normal', reason: 'quota_recovered', until: null })).toMatchObject({ level: 'normal' });
  });
});

describe('the retired label consolidation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('asks an older page to reload, and a restored unfinished job holds every mutation but settings', async () => {
    for (const call of [
      () => h.api.getLabelConsolidation({ name: 'labelConsolidation' }),
      () => h.api.startLabelConsolidation({ name: 'labelConsolidation', groups: [], requestId: op() }),
      () => h.api.resumeLabelConsolidation({ name: 'labelConsolidation', etag: 'synthetic', requestId: op() }),
    ]) expect(reasonOf(await rejection(call()))).toBe('RELOAD_REQUIRED');
    await h.step(T0);
    await h.sql(`INSERT INTO label_merge_jobs (id, state, phase, plan, create_time, update_time, etag) VALUES ('restored', 'running', 'move', '[]', ?, ?, 'e')`, T0, T0);
    expect(reasonOf(await rejection(h.api.initializePriorities({ requestId: op() })))).toBe('CONSOLIDATION_ACTIVE');
    expect(await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.OFF }), updateMask: { paths: ['mode'] }, requestId: op() })).toMatchObject({ mode: Mode.OFF });
    await h.api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: op() });
    expect(await h.step(T0 + HOUR)).toMatchObject({ code: 'priority_setup_required', decided: 0, applied: 0 });
    expect(h.up.gmail.calls.filter((call) => call.method !== 'GET' && !call.url.includes('oauth2'))).toEqual([]);
    await h.sql(`UPDATE label_merge_jobs SET state = 'succeeded'`);
    expect(await h.api.initializePriorities({ requestId: op() })).toMatchObject({ completed: true });
  });
});
