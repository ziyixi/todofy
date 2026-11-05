/**
 * The HTTP surface and the owner API in workerd (../../../docs/design.md §9): Access, Origin and CSRF in front of the
 * transcoder, the private headers, the old /api/v1 paths answering 410 RELOAD_REQUIRED, AIP-155 request IDs, AIP-154
 * etags, the value rules the IDL cannot hold, the review queue's answers, ops-v1 over the service binding (counts
 * and codes only, the guard), automatic classification intervals, editable classification prompts, provider settings,
 * and historical replay evaluation.
 */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Label_GmailState, Label_Problem, LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { ClassificationPromptSchema } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb';
import { ReplayEvaluation_Outcome, ReplayEvaluation_State, ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { ClassificationProvider, Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import { MAX_BODY_BYTES } from '../../src/limits.ts';
import { MAILS, message } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, op, ORIGIN, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, deliver, modifies, setMode } from './helpers.ts';

const PRIORITY_PROMPT = readFileSync(new NodeURL('../../../prompts/priority-classification.txt', import.meta.url), 'utf8');
const PERSONAL_RULES = readFileSync(new NodeURL('../../../prompts/personal-rules.txt', import.meta.url), 'utf8');

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

describe('automatic classification interval', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.dispose(); });

  it('adopts the former idle hour once, persists the choice and reports the adjusted next batch', async () => {
    await h.sql(`INSERT OR REPLACE INTO meta(key,value) VALUES('settings', ?),('next_model_at', ?)`,
      JSON.stringify({ mode: 'off', classificationProvider: 'codex', dailyWriteLimit: 19, etag: 'old' }), String(T0 + HOUR));
    expect((await h.api.getSettings({ name: 'settings' })).classificationIntervalMinutes).toBe(15);
    expect(await h.sql(`SELECT value FROM meta WHERE key='next_model_at'`)).toEqual([{ value: String(T0 + HOUR) }]);
    expect(await h.step(T0 + MINUTE)).toMatchObject({ next: T0 + 6 * MINUTE, code: 'off' });
    const initial = await h.api.getSettings({ name: 'settings' });
    expect(initial).toMatchObject({ mode: Mode.OFF, classificationProvider: ClassificationProvider.CODEX, classificationIntervalMinutes: 15, dailyWriteLimit: 19 });
    await h.step(T0 + 2 * MINUTE);
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(initial);
    expect(await h.sql(`SELECT value FROM meta WHERE key='next_model_at'`)).toEqual([{ value: String(T0 + 15 * MINUTE) }]);
    const request = {
      settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: 30, etag: initial.etag }),
      updateMask: { paths: ['classification_interval_minutes', 'etag'] }, requestId: op(),
    };
    const saved = await h.api.updateSettings(request);
    expect(saved).toMatchObject({ ...initial, availableModels: [], classificationIntervalMinutes: 30, etag: saved.etag });
    expect(await h.api.updateSettings(request)).toEqual(saved);
    expect(reasonOf(await rejection(h.api.updateSettings({ ...request, requestId: op() })))).toBe('ETAG_MISMATCH');
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier).toMatchObject({
      provider: ClassificationProvider.CODEX, classificationIntervalMinutes: 30, nextBatchTime: timestampFromMs(T0 + 30 * MINUTE),
    });
    const row = await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key='settings'`);
    expect(JSON.parse(row[0]?.value ?? '{}')).toMatchObject({ classificationIntervalMinutes: 30, mode: 'off', classificationProvider: 'codex' });
    expect(h.up.gmail.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(h.up.codex.calls).toEqual([]);
  });

  it('refuses unsupported intervals and changes the interval only when its mask names it', async () => {
    const initial = await h.api.getSettings({ name: 'settings' });
    for (const minutes of [0, 1, 10, 120, -5]) {
      expect(reasonOf(await rejection(h.api.updateSettings({
        settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: minutes, etag: initial.etag }),
        updateMask: { paths: ['classification_interval_minutes'] }, requestId: op(),
      })))).toBe('INVALID_SETTINGS');
    }
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(initial);
    const saved = await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: 5, classificationProvider: ClassificationProvider.CODEX, dailyWriteLimit: 22 }),
      updateMask: { paths: ['daily_write_limit'] }, requestId: op(),
    });
    expect(saved).toMatchObject({ classificationIntervalMinutes: 15, classificationProvider: ClassificationProvider.CLAUDE, dailyWriteLimit: 22 });
    for (const minutes of [5, 15, 30, 60]) {
      const value = await h.api.updateSettings({
        settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: minutes }),
        updateMask: { paths: ['classification_interval_minutes'] }, requestId: op(),
      });
      expect(value.classificationIntervalMinutes).toBe(minutes);
    }
  });

  it('keeps a pending retry deadline during default adoption and a later shorter interval save', async () => {
    await h.sql(`INSERT OR REPLACE INTO meta(key,value) VALUES('settings','{"mode":"off"}'),('next_model_at',?)`, String(T0 + 10 * MINUTE));
    await h.sql(`INSERT INTO pending(message_id,added_at,attempts,not_before) VALUES('synthetic-retry',?,1,?)`, T0, T0 + 10 * MINUTE);
    await h.step(T0);
    const current = await h.api.getSettings({ name: 'settings' });
    expect(current.classificationIntervalMinutes).toBe(15);
    await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: 5, etag: current.etag }),
      updateMask: { paths: ['classification_interval_minutes'] }, requestId: op(),
    });
    expect(await h.sql(`SELECT value FROM meta WHERE key='next_model_at'`)).toEqual([{ value: String(T0 + 10 * MINUTE) }]);
    expect(await h.sql(`SELECT attempts,not_before FROM pending`)).toEqual([{ attempts: 1, not_before: T0 + 10 * MINUTE }]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).classifier).toMatchObject({ classificationIntervalMinutes: 5, nextBatchTime: timestampFromMs(T0 + 10 * MINUTE) });
    expect(h.up.gmail.calls).toEqual([]);
  });
});

describe('editable classification prompt', () => {
  let h: Harness;
  afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });
  const get = () => h.api.getClassificationPrompt({ name: 'classificationPrompt' });
  async function save(baseText: string, personalRules: string, etag = 'initial', requestId = op()) {
    return h.api.updateClassificationPrompt({ classificationPrompt: create(ClassificationPromptSchema, { name: 'classificationPrompt', baseText, personalRules, etag }), updateMask: { paths: ['base_text', 'personal_rules', 'etag'] }, requestId });
  }
  async function ready() {
    h = await startHarness();
    await h.step(T0);
    await setMode(h, Mode.LIVE);
    await h.api.initializePriorities({ requestId: op() });
  }
  const input = (id: number) => ({ ...MAILS.bankEn, id: `abc${id.toString(16).padStart(13, '0')}` });

  it('reads defaults without persisting and saves both texts while off, with request replay and stale-etag checks', async () => {
    h = await startHarness();
    await setMode(h, Mode.OFF);
    const initial = await get();
    expect(initial).toMatchObject({ baseText: PRIORITY_PROMPT, personalRules: PERSONAL_RULES, etag: 'initial' });
    expect(initial.updateTime).toBeUndefined();
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'classification_prompt'`)).toEqual([]);
    const requestId = op();
    const saved = await save('Synthetic base', '', 'initial', requestId);
    expect(saved).toMatchObject({ baseText: 'Synthetic base', personalRules: '' });
    expect(saved.etag).not.toBe('initial');
    expect(saved.updateTime).toBeDefined();
    expect(await save('Different retry input', 'ignored', 'initial', requestId)).toEqual(saved);
    expect(reasonOf(await rejection(save('Stale', 'rules')))).toBe('ETAG_MISMATCH');
    expect(await get()).toEqual(saved);
    expect(h.up.gmail.calls).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
  });

  it('validates UTF-8 size and masks, accepts escaped prompt bodies above 16KiB, and keeps owner/CSRF boundaries', async () => {
    h = await startHarness();
    expect(reasonOf(await rejection(save(' ', 'rules')))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(save('中'.repeat(4097), '')))).toBe('BAD_REQUEST');
    const noMask = h.api.updateClassificationPrompt({ classificationPrompt: create(ClassificationPromptSchema, { name: 'classificationPrompt', baseText: 'Synthetic base' }), requestId: op() });
    expect(reasonOf(await rejection(noMask))).toBe('BAD_REQUEST');
    const largeEscaped = '"'.repeat(10000);
    expect(new TextEncoder().encode(JSON.stringify({ base_text: largeEscaped })).length).toBeGreaterThan(16 * 1024);
    expect((await save(largeEscaped, '')).baseText).toBe(largeEscaped);
    const csrf = await h.fetch('/api/v2/classificationPrompt?update_mask=base_text', { method: 'PATCH', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
    expect(csrf.status).toBe(403);
    const outside = await h.fetch('/api/v2/classificationPrompt', { headers: { 'cf-ray': 'synthetic' } });
    expect(outside.status).toBeGreaterThanOrEqual(400);
    const tooLarge = await h.mutate('PATCH', '/api/v2/classificationPrompt?update_mask=base_text', { name: 'classificationPrompt', base_text: 'x'.repeat(MAX_BODY_BYTES) });
    expect(tooLarge.status).toBe(400);
  });

  it('uses saved prompt text on the next request without rejudging prior mail', async () => {
    await ready();
    deliver(h, input(1), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(h.up.claude.systems[0]?.map(block => block.text)).toEqual([PRIORITY_PROMPT, PERSONAL_RULES]);
    expect(h.up.claude.systems[0]?.every(block => !block.cache)).toBe(true);
    await save('New synthetic base', 'New synthetic rules');
    deliver(h, input(2), T0 + HOUR);
    await h.step(T0 + HOUR + 2 * MINUTE);
    expect(h.up.claude.systems[1]?.map(block => block.text)).toEqual(['New synthetic base', 'New synthetic rules']);
    expect(h.up.claude.systems[1]?.every(block => !block.cache)).toBe(true);
    expect(h.up.claude.calls.flat().map(email => email.id)).toEqual([input(1).id, input(2).id]);
  });

  it('never asks for a prompt cache, even for a backlog, and still records reported cache writes/reads within total input and cost', async () => {
    await ready();
    h.up.claude.cacheWriteTokens = 6000;
    for (let id = 1; id <= 11; id++) deliver(h, input(id), T0 + MINUTE);
    await h.step(T0 + 2 * MINUTE);
    expect(h.up.claude.calls[0]).toHaveLength(10);
    h.up.claude.cacheWriteTokens = 0;
    h.up.claude.cacheReadTokens = 6000;
    await h.step(T0 + 3 * MINUTE);
    expect(h.up.claude.calls[1]).toHaveLength(1);
    expect(h.up.claude.systems.flat().every(block => !block.cache)).toBe(true);
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'claude_prompt_cache_at'`)).toEqual([]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget).toMatchObject({ inputTokens: 14400, cacheWriteTokens: 6000, cacheReadTokens: 6000, outputTokens: 240, spentUsd: 0.0456 });
    expect((await h.opsStatus())['counters']).toMatchObject({ claude_cache_write_tokens: 6000, claude_cache_read_tokens: 6000 });
  });

  it('records billed cache usage even when a batch answer is invalid', async () => {
    await ready();
    h.up.claude.cacheWriteTokens = 6000;
    h.up.claude.badItems = true;
    for (let id = 1; id <= 11; id++) deliver(h, input(id), T0 + MINUTE);
    expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_bad_answer', decided: 0 });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget).toMatchObject({ cacheWriteTokens: 6000, spentUsd: 0.0372 });
  });
});

describe('classification provider settings and status', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.dispose(); });

  it('defaults legacy settings to Codex and preserves mode, limits and existing work when switching', async () => {
    await h.sql(`INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?), ('next_model_at', ?), ('claude_limited_month', '2026-10'), ('claude_error', 'claude_spend_limit')`,
      JSON.stringify({ mode: 'live', runWriteLimit: 3, dailyWriteLimit: 19, etag: 'legacy' }), String(T0 + HOUR));
    const before = await h.api.getSettings({ name: 'settings' });
    expect(before.classificationProvider).toBe(ClassificationProvider.CODEX);
    const requestId = op();
    const request = {
      settings: create(SettingsSchema, { name: 'settings', classificationProvider: ClassificationProvider.CLAUDE, mode: Mode.OFF, etag: before.etag }),
      updateMask: { paths: ['classification_provider', 'etag'] }, requestId,
    };
    const saved = await h.api.updateSettings(request);
    expect(saved).toEqual({ ...before, availableModels: [], classificationModel: 'claude-opus-5-5', classificationProvider: ClassificationProvider.CLAUDE, etag: saved.etag });
    expect(saved.etag).not.toBe(before.etag);
    expect(await h.api.getSettings({ name: 'settings' })).toEqual({ ...saved, availableModels: before.availableModels });
    expect(await h.api.updateSettings(request)).toEqual(saved);
    expect(reasonOf(await rejection(h.api.updateSettings({ ...request, requestId: op() })))).toBe('ETAG_MISMATCH');
    const stored = await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'settings'`);
    expect(JSON.parse(stored[0]?.value ?? '{}')).toMatchObject({ classificationProvider: 'claude', mode: 'live', runWriteLimit: 3, dailyWriteLimit: 19 });
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'next_model_at'`)).toEqual([{ value: String(T0) }]);
    expect(await h.sql(`SELECT key FROM meta WHERE key IN ('claude_limited_month', 'claude_error') ORDER BY key`)).toEqual([{ key: 'claude_error' }, { key: 'claude_limited_month' }]);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).unreadClassification).toBeUndefined();
    expect(h.up.gmail.calls).toHaveLength(0);
    expect(h.up.claude.calls).toHaveLength(0);
  });

  it('preserves a future schedule and deferred work when the selected provider stays the same', async () => {
    await h.sql(`INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', '{"classificationProvider":"codex","classificationIntervalMinutes":60}'), ('next_model_at', ?)`, String(T0 + HOUR));
    await h.sql(`INSERT INTO pending (message_id, added_at, not_before, deferred) VALUES ('synthetic-held', ?, ?, ?)`, T0, T0 + HOUR, T0);
    const current = await h.api.getSettings({ name: 'settings' });
    await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationProvider: ClassificationProvider.CODEX, etag: current.etag }),
      updateMask: { paths: ['classification_provider', 'etag'] }, requestId: op(),
    });
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'next_model_at'`)).toEqual([{ value: String(T0 + HOUR) }]);
    expect(await h.sql(`SELECT not_before, deferred FROM pending`)).toEqual([{ not_before: T0 + HOUR, deferred: T0 }]);
    expect(h.up.gmail.calls).toHaveLength(0);
    expect(h.up.codex.calls).toHaveLength(0);
    expect(h.up.claude.calls).toHaveLength(0);
  });

  it('refuses an unspecified provider and requires the provider in the update mask', async () => {
    const before = await h.api.getSettings({ name: 'settings' });
    const rejected = await rejection(h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings' }), updateMask: { paths: ['classification_provider'] }, requestId: op(),
    }));
    expect(reasonOf(rejected)).toBe('INVALID_SETTINGS');
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(before);
    const saved = await h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationProvider: ClassificationProvider.CODEX, dailyWriteLimit: 22 }),
      updateMask: { paths: ['daily_write_limit'] }, requestId: op(),
    });
    expect(saved.classificationProvider).toBe(ClassificationProvider.CLAUDE);
    expect(saved.dailyWriteLimit).toBe(22);
  });

  it('reports selected Codex configuration and success separately from preserved Claude usage and refusal', async () => {
    await h.sql(`INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?), ('claude_error', 'claude_spend_limit'), ('claude_limited_month', '2026-10'),
      ('codex_error', 'codex_503'), ('codex_last_request_at', ?), ('codex_last_success_at', ?), ('next_model_at', ?)`,
    JSON.stringify({ classificationProvider: 'codex' }), String(T0), String(T0 - HOUR), String(T0 + HOUR));
    await h.sql(`INSERT INTO claude_usage (day, requests, input_tokens, output_tokens, cost_micros) VALUES ('2026-10-01', 1, 500, 100, 20000000)`);
    h.up.codex.configured = false;
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status).toMatchObject({
      decisionModel: 'gpt-6.1-sol',
      classifier: {
        provider: ClassificationProvider.CODEX, model: 'gpt-6.1-sol', effort: 'medium', configured: false,
        nextBatchTime: timestampFromMs(T0 + HOUR), lastSuccessTime: timestampFromMs(T0 - HOUR),
      },
      claudeBudget: { model: 'claude-opus-5-5', spentUsd: 20, providerLimitReached: true, lastErrorCode: 'claude_spend_limit' },
    });
    expect(status.classifier?.lastErrorCode).not.toBe('claude_spend_limit');
    expect(status.claudeBudget?.nextBatchTime).toBeUndefined();
    // Model Router records Codex usage; Mailsort keeps no ledger of its own.
    expect(status.codexUsage).toBeUndefined();
  });

  it('does not interpret a historical request timestamp as a successful answer', async () => {
    await h.sql(`INSERT INTO meta (key, value) VALUES ('claude_last_request_at', ?), ('claude_error', 'claude_invalid')`, String(T0));
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.classifier).toMatchObject({ provider: ClassificationProvider.CLAUDE, model: 'claude-opus-5-5', effort: 'medium', configured: true, lastErrorCode: 'claude_invalid' });
    expect(status.classifier?.lastSuccessTime).toBeUndefined();
    expect(status.claudeBudget?.lastRequestTime).toEqual(timestampFromMs(T0));
  });

  it('saves a catalog model and effort without copying catalog state or altering mode, budgets or prompt', async () => {
    const current = await h.api.getSettings({ name: 'settings' });
    const prompt = await h.api.getClassificationPrompt({ name: 'classificationPrompt' });
    const request = {
      settings: create(SettingsSchema, { name: 'settings', classificationModel: 'openai/gpt-6.1-sol', classificationEffort: 'high', etag: current.etag }),
      updateMask: { paths: ['classification_model', 'classification_effort', 'etag'] }, requestId: op(),
    };
    const saved = await h.api.updateSettings(request);
    expect(saved).toMatchObject({ classificationProvider: ClassificationProvider.OPENAI, classificationModel: 'openai/gpt-6.1-sol', classificationEffort: 'high', mode: current.mode, dailyWriteLimit: current.dailyWriteLimit, runWriteLimit: current.runWriteLimit });
    expect(await h.api.updateSettings(request)).toEqual(saved);
    expect(await h.api.getSettings({ name: 'settings' })).toEqual({ ...saved, availableModels: current.availableModels });
    const stored = JSON.parse((await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'settings'`))[0]?.value ?? '{}') as Record<string, unknown>;
    expect(stored).toMatchObject({ classificationProvider: 'openai', classificationModel: 'openai/gpt-6.1-sol', classificationEffort: 'high' });
    expect(stored).not.toHaveProperty('availableModels');
    expect(await h.api.getClassificationPrompt({ name: 'classificationPrompt' })).toEqual(prompt);
    expect(h.up.api.calls).toHaveLength(0);
    expect(h.up.gmail.calls).toHaveLength(0);
  });

  it.each([
    ['openai/gpt-6-astra', 'high'], ['openai/missing', 'medium'], ['openai/gpt-6.1-sol', 'ultra'], ['', 'medium'],
  ])('rejects unavailable routes and unsupported efforts: %s / %s', async (model, effort) => {
    const before = await h.api.getSettings({ name: 'settings' });
    expect(reasonOf(await rejection(h.api.updateSettings({
      settings: create(SettingsSchema, { name: 'settings', classificationModel: model, classificationEffort: effort, etag: before.etag }),
      updateMask: { paths: ['classification_model', 'classification_effort'] }, requestId: op(),
    })))).toBe('INVALID_SETTINGS');
    expect(await h.api.getSettings({ name: 'settings' })).toEqual(before);
  });

  it.each([true, false])('reports Router catalog configuration (%s) without a model call', async configured => {
    h.up.codex.configured = configured;
    await h.sql(`INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', '{"classificationProvider":"codex"}')`);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.classifier).toMatchObject({ provider: ClassificationProvider.CODEX, configured, lastErrorCode: configured ? '' : 'codex_not_configured' });
    expect(h.up.gmail.calls).toHaveLength(0);
    expect(h.up.codex.calls).toHaveLength(0);
  });
});

describe('historical priority replay', () => {
  let h: Harness;
  const NOW = T0 + DAY;
  async function setup(): Promise<void> {
    h = await startHarness();
    await h.step(T0);
    await h.clock(NOW);
  }

  afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });

  it('refuses a new replay with a clear retired-feature error and creates no job', async () => {
    await setup();
    const error = await rejection(h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() }));
    expect(reasonOf(error)).toBe('MODEL_FEATURE_RETIRED');
    expect((error as Error).message).toContain('historical results remain readable');
    expect(await h.sql(`SELECT * FROM replay`)).toEqual([]);
    expect(h.up.claude.calls).toEqual([]);
    expect(modifies(h)).toEqual([]);
    expect(reasonOf(await rejection(h.api.getReplayEvaluation({ name: 'replayEvaluation' })))).toBe('NOT_FOUND');
  });

  it('reads a completed historical result without replacing its rows or calling either model', async () => {
    await setup();
    await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time, done_time) VALUES ('historical-job', '', 'succeeded', ?, ?)`, T0, T0 + MINUTE);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, outcome, label, create_time, done_time, top_option, top_p, runner_up_p, view2_p, combined, authenticated, trust)
      VALUES ('historical-job', 'abc0000000000011', 'evaluated', 'p3', ?, 'label', 'p3', ?, ?, 'p3', 0.8, 0.15, 0.9, 0.85, 1, 0)`, T0, T0, T0 + MINUTE);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, outcome, reason, create_time, done_time, authenticated, trust)
      VALUES ('historical-job', 'abc0000000000012', 'evaluated', 'p2', ?, 'unsure', 'model_unavailable', ?, ?, 1, 0)`, T0 + 1, T0, T0 + MINUTE);
    const rows = await h.sql(`SELECT * FROM replay ORDER BY message_id`);
    const summary = await h.api.getReplayEvaluation({ name: 'replayEvaluation' });
    expect(summary).toMatchObject({ state: ReplayEvaluation_State.SUCCEEDED, totalCount: 2, evaluatedCount: 2, autoCount: 1, autoMatchCount: 1, unsureCount: 1, reasonCounts: { model_unavailable: 1 } });
    expect(summary.cases).toMatchObject([
      { ownerLabel: 'labels/p3', outcome: ReplayEvaluation_Outcome.LABEL, topLabel: 'labels/p3', topProbability: 0.8, secondViewProbability: 0.9, combinedProbability: 0.85 },
      { ownerLabel: 'labels/p2', outcome: ReplayEvaluation_Outcome.UNSURE, reason: 'model_unavailable' },
    ]);
    expect(JSON.stringify(toWire(ReplayEvaluationSchema, summary))).not.toContain('abc0000000000011');
    expect(reasonOf(await rejection(h.api.startReplayEvaluation({ name: 'replayEvaluation', requestId: op() })))).toBe('MODEL_FEATURE_RETIRED');
    await h.step(NOW + MINUTE);
    expect(await h.sql(`SELECT * FROM replay ORDER BY message_id`)).toEqual(rows);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toEqual(summary);
    expect(h.up.claude.calls).toEqual([]);
    expect(modifies(h)).toEqual([]);
  });

  it('leaves an interrupted historical replay readable without resuming its pending mail', async () => {
    await setup();
    await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time) VALUES ('interrupted-job', '', 'running', ?)`, T0);
    await h.sql(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES ('interrupted-job', 'abc0000000000013', 'pending', 'p1', ?, ?)`, T0 + MINUTE, T0);
    const rows = await h.sql(`SELECT * FROM replay ORDER BY message_id`);
    const before = h.up.gmail.calls.length;
    await h.step(NOW + MINUTE);
    expect(h.up.gmail.calls.slice(before).some(call => call.url.includes('/messages/abc0000000000013'))).toBe(false);
    expect(h.up.claude.calls).toEqual([]);
    expect(await h.sql(`SELECT * FROM replay ORDER BY message_id`)).toEqual(rows);
    expect(await h.api.getReplayEvaluation({ name: 'replayEvaluation' })).toMatchObject({ state: ReplayEvaluation_State.RUNNING, totalCount: 1, evaluatedCount: 0 });
    expect(await h.sql(`SELECT id FROM review`)).toEqual([]);
    expect(modifies(h)).toEqual([]);
  });
});
