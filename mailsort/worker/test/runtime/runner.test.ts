/** Private machine classification through the real Worker/DO/transcoder, synthetic Gmail and ledger. */
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { MailsortRunnerService, Priority, RunStatus, type ClassificationMessage } from '@ziyixi/proto/mailsort/runner/v1/mailsort_runner_service_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS, type SyntheticMail } from '../fakes/fixtures.ts';
import { DAY, HOUR, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, deliver, failModifies, gmailLabels, modifies, setMode } from './helpers.ts';

const TOKEN = 'synthetic-classification-token-for-tests';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
let h: Harness;
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });
const client = () => createHttpClient(MailsortRunnerService, call => h.fetch(call.url, {
  method: call.httpMethod, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  ...(call.body === undefined ? {} : { body: call.body }),
}));
const mail = (id: number, labels = ['INBOX', 'UNREAD']): SyntheticMail => ({ ...MAILS.bankEn, id: `abc${id.toString(16).padStart(13, '0')}`, labels });
async function ready(): Promise<void> {
  h = await startHarness({ bindings: { CLASSIFICATION_TOKEN_SHA256: HASH } });
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.api.initializePriorities({ requestId: op() });
}
async function claim(runId = op()): Promise<{ runId: string; messages: ClassificationMessage[] }> {
  const messages: ClassificationMessage[] = [];
  let pageToken = '';
  do {
    const page = await client().claimClassification({ runId, pageToken });
    runId = page.runId;
    expect(page.messages.length).toBeLessThanOrEqual(10);
    messages.push(...page.messages);
    pageToken = page.nextPageToken;
  } while (pageToken !== '');
  return { runId, messages };
}
const meta = () => ({ model: 'gpt-6.1-sol', effort: 'medium', promptSha: 'a'.repeat(64), inputTokens: 123, outputTokens: 45 });
const results = (messages: ClassificationMessage[], priority: Priority = Priority.P2) => messages.map(message => ({ messageId: message.messageId, priority, reason: '可等两天再查看。' }));

it('authenticates the two machine paths independently before decoding, without granting owner API access', async () => {
  h = await startHarness({ bindings: { CLASSIFICATION_TOKEN_SHA256: HASH, DEV_AUTH_BYPASS: undefined } });
  const missing = await h.fetch('/api/machine/v1/classification:claim', { method: 'POST', body: '{bad' });
  expect(missing.status).toBe(401);
  const owner = await h.mf.dispatchFetch('https://sort.example.com/api/v2/serviceStatus', { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(owner.status).toBe(401);
  const bad = await h.fetch('/api/machine/v1/classification:claim', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{bad' });
  expect(bad.status).toBe(400);
  expect((await h.fetch('/api/machine/v1/other', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
});

it('selects only ungraded unread messages, strips HTML before the 12k mask and never runs Workers AI', async () => {
  await ready();
  const p3 = h.up.gmail.labelIdByName('P3') ?? '';
  const selected = { ...mail(1), text: undefined, html: `<script>SECRET_SCRIPT</script><style>hidden</style><p>contact user@example.com code 123456 https://example.com/private/path ${'长'.repeat(13_000)}</p>` };
  // exactOptionalPropertyTypes: omit text rather than assigning undefined.
  const htmlMail: SyntheticMail = { id: selected.id, labels: selected.labels ?? [], from: selected.from, subject: selected.subject, html: selected.html };
  deliver(h, htmlMail, T0 - DAY);
  for (const message of [mail(2, ['UNREAD', p3]), mail(3, ['INBOX']), mail(4, ['UNREAD', 'SPAM']), mail(5, ['UNREAD', 'TRASH'])]) deliver(h, message, T0 - DAY);
  const batch = await claim();
  expect(batch.messages.map(message => message.messageId)).toEqual([htmlMail.id]);
  const body = batch.messages[0]?.body ?? '';
  expect(body.length).toBeGreaterThan(10_000);
  expect(body).not.toContain('SECRET_SCRIPT');
  expect(body).not.toContain('user@example.com');
  expect(body).not.toContain('123456');
  expect(body).not.toContain('/private/path');
  expect(body).toContain('[email]');
  expect(body.length).toBeLessThanOrEqual(12_000);
  expect(batch.messages[0]).toMatchObject({ timeZone: 'America/Los_Angeles', bodyTruncated: true });
  expect(h.up.ai.calls).toHaveLength(0);
  await h.step(T0 + MINUTE);
  expect(h.up.ai.calls).toHaveLength(0);
  expect(modifies(h)).toHaveLength(0);
});

it('persists a successful report once, then caps and resumes Gmail writes while preserving read/star/other labels', async () => {
  await ready();
  const own = h.up.gmail.createUserLabel('Personal');
  for (let i = 10; i < 23; i++) deliver(h, mail(i, ['INBOX', 'UNREAD', 'STARRED', own]), T0 - DAY);
  const batch = await claim();
  expect(batch.messages).toHaveLength(13);
  const request = { runId: batch.runId, requestId: op(), results: results(batch.messages), status: RunStatus.COMPLETED, ...meta() };
  expect(await client().reportClassification(request)).toMatchObject({ acceptedCount: 13, pendingWriteCount: 13 });
  expect(await client().reportClassification(request)).toMatchObject({ acceptedCount: 13, pendingWriteCount: 13 });
  expect(await h.sql(`SELECT count(*) AS n FROM ledger`)).toEqual([{ n: 13 }]);
  await h.step(T0 + MINUTE);
  expect(modifies(h)).toHaveLength(5);
  await h.step(T0 + 2 * MINUTE);
  await h.step(T0 + 3 * MINUTE);
  expect(modifies(h)).toHaveLength(13);
  expect((await h.api.getSettings({ name: 'settings' })).breakerTripped).toBe(false);
  const p2 = h.up.gmail.labelIdByName('P2') ?? '';
  for (const message of batch.messages) expect(gmailLabels(h, message.messageId)).toEqual(['UNREAD', 'STARRED', own, p2].sort());
  const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
  expect(status.batchStatus).toMatchObject({ state: 'completed', model: 'gpt-6.1-sol', effort: 'medium', promptSha: 'a'.repeat(64), selectedCount: 13, judgedCount: 13, pendingWriteCount: 0, inputTokens: 123, outputTokens: 45 });
  expect((await claim()).messages).toEqual([]);
});

it('rechecks explicitly all unread including existing P1-P4 while leaving read mail unchanged', async () => {
  await ready();
  const p1 = h.up.gmail.labelIdByName('P1') ?? '';
  const graded = mail(30, ['UNREAD', 'STARRED', p1]);
  const read = mail(31, ['INBOX', p1]);
  deliver(h, graded, T0 - DAY); deliver(h, read, T0 - DAY);
  await h.api.startUnreadClassification({ name: 'unreadClassification', requestId: op(), recheckAllUnread: true });
  const batch = await claim();
  expect(batch.messages.map(message => message.messageId)).toEqual([graded.id]);
  await client().reportClassification({ runId: batch.runId, requestId: op(), results: results(batch.messages, Priority.P3), status: RunStatus.COMPLETED, ...meta() });
  await h.step(T0 + MINUTE);
  const p3 = h.up.gmail.labelIdByName('P3') ?? '';
  expect(gmailLabels(h, graded.id)).toEqual(['UNREAD', 'STARRED', p3].sort());
  expect(gmailLabels(h, read.id)).toEqual(['INBOX', p1].sort());
});

it('reports empty runs as successful only after completion and surfaces failure or stale runner state', async () => {
  await ready();
  const batch = await claim();
  expect(batch.messages).toEqual([]);
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).batchStatus?.completedTime).toBeUndefined();
  await client().reportClassification({ runId: batch.runId, requestId: op(), status: RunStatus.COMPLETED, ...meta(), inputTokens: 0, outputTokens: 0 });
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).batchStatus).toMatchObject({ state: 'completed', selectedCount: 0, inputTokens: 0, outputTokens: 0 });
  deliver(h, mail(40), T0);
  const failed = await claim();
  await client().reportClassification({ runId: failed.runId, requestId: op(), status: RunStatus.FAILED, errorCode: 'model_failed', ...meta() });
  expect(modifies(h)).toHaveLength(0);
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).batchStatus).toMatchObject({ state: 'failed', errorCode: 'model_failed', judgedCount: 0 });
  await h.clock(T0 + 3 * HOUR);
  expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'batch_failed' }), expect.objectContaining({ code: 'batch_stale' })]));
  expect((await claim()).messages.map(message => message.messageId)).toEqual([mail(40).id]);
});

it('does not return already reported decisions for inference and keeps reports idempotent across new IDs', async () => {
  await ready();
  deliver(h, mail(50), T0);
  const batch = await claim();
  await client().reportClassification({ runId: batch.runId, requestId: op(), results: results(batch.messages), status: RunStatus.RUNNING, ...meta() });
  expect((await claim(batch.runId)).messages).toEqual([]);
  expect(await client().reportClassification({ runId: batch.runId, requestId: op(), results: results(batch.messages), status: RunStatus.COMPLETED, ...meta() })).toMatchObject({ acceptedCount: 0, pendingWriteCount: 1 });
  expect(await h.sql(`SELECT count(*) AS n FROM ledger`)).toEqual([{ n: 1 }]);
});

it('respects off/shadow and the daily write limit without rerunning the model', async () => {
  await ready();
  await setMode(h, Mode.OFF);
  await expect(claim()).rejects.toThrow();
  await setMode(h, Mode.SHADOW);
  deliver(h, mail(60), T0);
  const shadow = await claim();
  await client().reportClassification({ runId: shadow.runId, requestId: op(), results: results(shadow.messages), status: RunStatus.COMPLETED, ...meta() });
  await h.step(T0 + MINUTE);
  expect(modifies(h)).toHaveLength(0);
  await setMode(h, Mode.LIVE);
  deliver(h, mail(61), T0);
  const batch = await claim();
  const settings = await h.api.getSettings({ name: 'settings' });
  await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', ?) ON CONFLICT (day) DO UPDATE SET applied = excluded.applied`, settings.dailyWriteLimit);
  await client().reportClassification({ runId: batch.runId, requestId: op(), results: results(batch.messages), status: RunStatus.COMPLETED, ...meta() });
  await h.step(T0 + 2 * MINUTE);
  expect(modifies(h)).toHaveLength(0);
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).batchStatus?.pendingWriteCount).toBe(1);
  await h.step(T0 + DAY + MINUTE);
  expect(modifies(h)).toHaveLength(1);
  expect(h.up.ai.calls).toHaveLength(0);
});

it('retains unknown failed-turn usage and reports missing machine configuration', async () => {
  await ready();
  const batch = await claim();
  await client().reportClassification({ runId: batch.runId, requestId: op(), model: 'gpt-6.1-sol', effort: 'medium', promptSha: 'a'.repeat(64), status: RunStatus.FAILED, errorCode: 'model_timeout' });
  const status = (await h.api.getServiceStatus({ name: 'serviceStatus' })).batchStatus;
  expect(status).toMatchObject({ state: 'failed', errorCode: 'model_timeout' });
  expect(status?.inputTokens).toBeUndefined();
  expect(status?.outputTokens).toBeUndefined();
  await h.dispose();
  h = await startHarness({ bindings: { CLASSIFICATION_TOKEN_SHA256: undefined } });
  expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'batch_not_configured' })]));
});

it('does not treat an earlier automatic Gmail history event as a correction of the immediately following recheck', async () => {
  await ready();
  const message = mail(70);
  deliver(h, message, T0);
  const first = await claim();
  await client().reportClassification({ runId: first.runId, requestId: op(), results: results(first.messages, Priority.P3), status: RunStatus.COMPLETED, ...meta() });
  const failing = failModifies(h, 503);
  await h.step(T0 + MINUTE);
  failing.off();
  await h.step(T0 + 2 * MINUTE);
  expect(gmailLabels(h, message.id)).toContain(h.up.gmail.labelIdByName('P3'));
  await h.api.startUnreadClassification({ name: 'unreadClassification', requestId: op(), recheckAllUnread: true });
  const second = await claim();
  await client().reportClassification({ runId: second.runId, requestId: op(), results: results(second.messages, Priority.P2), status: RunStatus.COMPLETED, ...meta() });
  await h.step(T0 + 3 * MINUTE);
  expect(gmailLabels(h, message.id)).toEqual(['UNREAD', h.up.gmail.labelIdByName('P2')].sort());
  expect(await h.sql(`SELECT state, superseded FROM ledger WHERE message_id = ? AND label_id = 'p2'`, message.id)).toEqual([{ state: 'applied', superseded: 0 }]);
  expect(await h.sql(`SELECT verdict FROM decisions WHERE message_id = ?`, message.id)).toEqual([{ verdict: null }]);
});

it('continues classifying new arrivals while older judged mail waits at the daily write cap', async () => {
  await ready();
  const settings = await h.api.getSettings({ name: 'settings' });
  await h.sql(`INSERT INTO usage (day, applied) VALUES ('2026-10-01', ?) ON CONFLICT (day) DO UPDATE SET applied = excluded.applied`, settings.dailyWriteLimit);
  deliver(h, mail(80), T0);
  const first = await claim();
  await client().reportClassification({ runId: first.runId, requestId: op(), results: results(first.messages), status: RunStatus.COMPLETED, ...meta() });
  await h.step(T0 + MINUTE);
  expect(modifies(h)).toEqual([]);
  deliver(h, mail(81), T0 + 2 * MINUTE);
  const second = await claim();
  expect(second.messages.map(message => message.messageId)).toEqual([mail(81).id]);
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).batchStatus?.pendingWriteCount).toBe(1);
  expect(await client().reportClassification({ runId: second.runId, requestId: op(), results: results(second.messages), status: RunStatus.COMPLETED, ...meta() })).toMatchObject({ acceptedCount: 1, pendingWriteCount: 2 });
  expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({
    code: 'gmail_write_limit_wait', severity: 'info', since: '2026-10-01T00:00:00Z',
    metrics: { applied_today: settings.dailyWriteLimit, daily_write_limit: settings.dailyWriteLimit, pending_writes: 2 },
  })]));
  await setMode(h, Mode.SHADOW); await h.step(T0 + 3 * MINUTE);
  expect(await h.sql(`SELECT state FROM ledger ORDER BY id`)).toEqual([{ state: 'intended' }, { state: 'intended' }]);
  await setMode(h, Mode.LIVE); await h.step(T0 + DAY + MINUTE);
  expect(modifies(h)).toHaveLength(2);
  expect(h.up.ai.calls).toEqual([]);
});
