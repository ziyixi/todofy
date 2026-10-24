/**
 * The smoke run (../../../docs/design.md §11): the real `wrangler dev` (the pinned wrangler, ../../../wrangler.test.toml,
 * local bindings only) against the fake Gmail and fake Workers AI of ../fakes, served on loopback by this process.
 * Nothing reaches Google or Cloudflare: DEV_FAKE_UPSTREAM sends every Google request and every model call to the fake,
 * and every request the fake receives is checked against the independent table (../fakes/table.ts).
 *
 * It exercises fixed P1-P4 setup, owner CSRF, separate machine auth, bounded claims/reports, persistent Gmail writes,
 * idempotency, failed-run recovery, explicit all-unread rechecking and authentication stop. Every mail and credential is synthetic. Run after the UI build:
 *
 *   npm run test:smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client';
import { MailsortUiService } from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb';
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb';
import { MailsortRunnerService, Priority, RunStatus, type ClassificationMessage } from '@ziyixi/proto/mailsort/runner/v1/mailsort_runner_service_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { create } from '@ziyixi/proto/protobuf';
import { MAILS, message, type SyntheticMail } from '../fakes/fixtures.ts';
import type { RecordedLedger } from '../fakes/fake-gmail.ts';
import { allowedOperation, FORBIDDEN_LABELS } from '../fakes/table.ts';
import { FakeUpstream } from '../fakes/upstream.ts';
import { DEV_REFRESH_TOKEN, serveFakeUpstream } from './fake-upstream.mts';

const WORKER = decodeURIComponent(new URL('../../', import.meta.url).pathname);
const T0 = Date.parse('2026-10-01T00:00:00Z');
const MINUTE = 60_000;
const REFRESH_TOKEN = DEV_REFRESH_TOKEN;
const MACHINE_TOKEN = 'synthetic-classification-smoke-token';

function check(condition: unknown, what: string): void {
  if (!condition) throw new Error(`smoke: ${what}`);
  console.log(`ok - ${what}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main(): Promise<void> {
  if (!existsSync(join(WORKER, '../web/dist/index.html'))) throw new Error('build the UI first: cd ../web && npm run build');
  const up = new FakeUpstream();
  up.gmail.grants.set(REFRESH_TOKEN, 'https://www.googleapis.com/auth/gmail.modify');
  let clock = T0;
  up.gmail.clock = () => clock;
  // The fake upstream: a Node HTTP server the Worker's development fetch reaches over loopback.
  const { server: fake, origin: fakeOrigin } = await serveFakeUpstream(up);

  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const persist = mkdtempSync(join(tmpdir(), 'mailsort-smoke-'));
  const vars: Record<string, string> = {
    BUILD_SHA: 'dev',
    CLASSIFICATION_TOKEN_SHA256: createHash('sha256').update(MACHINE_TOKEN).digest('hex'),
    MODE: 'live',
    DEV_AUTH_BYPASS: 'true',
    DEV_MANUAL_ALARMS: 'true',
    ACCESS_OWNER: 'owner@example.com',
    CSRF_SIGNING_KEY: 'ab'.repeat(32),
    DEV_FAKE_UPSTREAM: fakeOrigin,
    GMAIL_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
    GMAIL_CLIENT_SECRET: 'synthetic-secret',
    GMAIL_REFRESH_TOKEN: REFRESH_TOKEN,
  };
  const args = ['--no-install', 'wrangler', 'dev', '--config', '../wrangler.test.toml', '--ip', '127.0.0.1', '--port', String(port), '--local-upstream', `127.0.0.1:${String(port)}`, '--persist-to', persist, '--inspector-port', '0', '--show-interactive-dev-session=false'];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);
  // Its own process group: npx, wrangler and workerd stop together, or the survivors hold the pipes and this never exits.
  const dev: ChildProcess = spawn('npx', args, { cwd: WORKER, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  dev.stdout?.on('data', (chunk: Uint8Array) => {
    output += new TextDecoder().decode(chunk);
  });
  dev.stderr?.on('data', (chunk: Uint8Array) => {
    output += new TextDecoder().decode(chunk);
  });
  try {
    const started = Date.now();
    for (;;) {
      if (/Ready on/.test(output)) break;
      if (dev.exitCode !== null || Date.now() - started > 90_000) throw new Error(`wrangler dev did not start:\n${output.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await run(origin, up, (now) => {
      clock = now;
    });
    // Names come from the store at send time; ledger intents come from the scenarios' explicit expected outcomes.
    // This fresh mailbox owns only the four priority labels the Worker created.
    const owned = up.gmail.mailsortLabelIds();
    for (const call of up.gmail.calls) {
      const ledger = (_message: string, labelId: string) => call.ledgerRows?.find(row => row.labelId === labelId) ?? null;
      if (allowedOperation(call.method, call.url, call.body, { owned, planned: new Set(call.planned ?? []), ledger, priorityDeletes: new Set(call.priorityDeletes ?? []) }) === null) throw new Error(`smoke: a request outside the table: ${call.method} ${call.url}`);
      for (const label of FORBIDDEN_LABELS) if (call.body.includes(`"${label}"`)) throw new Error(`smoke: ${label} in a write`);
    }
    check(up.strays.length === 0, `all ${String(up.gmail.calls.length)} Google requests are in the closed table; nothing else left the Worker`);
    check(!/owner@example\.com|digest@news|weekly digest/i.test(output.replace(/--var \S+/g, '')), 'the dev server log holds no address or mail text');
  } finally {
    await stopGroup(dev);
    fake.closeAllConnections();
    fake.close();
    rmSync(persist, { recursive: true, force: true });
  }
}

/** Stops the whole process group: SIGINT for a clean wrangler shutdown, SIGKILL for whatever is left after 5 s. */
async function stopGroup(child: ChildProcess): Promise<void> {
  const group = child.pid;
  if (group === undefined) return;
  // Signal 0 only asks whether the group still exists.
  const send = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-group, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!send('SIGINT')) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && send(0)) await new Promise((resolve) => setTimeout(resolve, 100));
  send('SIGKILL');
}

async function run(origin: string, up: FakeUpstream, setClock: (now: number) => void): Promise<void> {
  let csrf: { token: string; cookie: string } | undefined;
  const send = async (call: HttpCall): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (call.httpMethod !== 'GET') {
      if (csrf === undefined) {
        const response = await fetch(`${origin}/api/csrf`);
        csrf = { token: (await response.json<{ token: string }>()).token, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
      }
      Object.assign(headers, { origin, 'x-csrf-token': csrf.token, cookie: csrf.cookie });
    }
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${origin}${call.url}`, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
  };
  const api = createHttpClient(MailsortUiService, send);
  up.plannedPaths = async () => (await api.listLabels({})).labels.map(label => label.displayName);
  // Expected intents belong to these synthetic scenarios. No request body can grant itself a ledger row.
  const expected = new Map<string, RecordedLedger>();
  up.ledgerRows = messageId => {
    const row = expected.get(messageId);
    return Promise.resolve(row === undefined ? [] : [{ ...row, replaceLabels: [...row.replaceLabels] }]);
  };
  const id = () => crypto.randomUUID();
  let now = T0;
  const step = async (advance = 5 * MINUTE) => {
    now += advance;
    setClock(now);
    const response = await fetch(`${origin}/__dev/step?now=${String(now)}`, { method: 'POST' });
    if (!response.ok) throw new Error(`step: ${String(response.status)}`);
    return response.json<{ decided?: number; code: string }>();
  };
  const gmailId = (priority: string) => {
    const value = up.gmail.labelIdByName(priority.toUpperCase());
    if (value === undefined) throw new Error(`smoke: missing synthetic ${priority} label`);
    return value;
  };
  const deliver = (mail: SyntheticMail, priority?: string, replaceLabels: readonly string[] = []) => {
    if (priority !== undefined) expected.set(mail.id, { labelId: gmailId(priority), state: 'intended', archived: priority !== 'p1', baseInbox: mail.labels?.includes('INBOX') ?? true, replaceLabels });
    up.gmail.deliver(message({ ...mail, receivedAt: now }));
  };
  const labelsOf = (messageId: string) => [...(up.gmail.messages.get(messageId)?.labelIds ?? [])].sort();
  const modifies = () => up.gmail.calls.filter(call => call.url.endsWith('/modify')).length;
  const checkPriority = (messageId: string, priority: string, inbox = priority === 'p1') => {
    const labels = labelsOf(messageId);
    const priorities = ['p1', 'p2', 'p3', 'p4'].map(gmailId).filter(label => labels.includes(label));
    return priorities.length === 1 && priorities[0] === gmailId(priority) && labels.includes('UNREAD') && labels.includes('INBOX') === inbox;
  };
  const machine = createHttpClient(MailsortRunnerService, call => fetch(`${origin}${call.url}`, {
    method: call.httpMethod, headers: { authorization: `Bearer ${MACHINE_TOKEN}`, 'content-type': 'application/json' },
    ...(call.body === undefined ? {} : { body: call.body }),
  }));
  const claim = async () => {
    let runId = id(); let pageToken = '';
    const messages: ClassificationMessage[] = [];
    do {
      const page = await machine.claimClassification({ runId, pageToken });
      runId = page.runId; pageToken = page.nextPageToken;
      if (page.messages.length > 10) throw new Error('smoke: unbounded machine page');
      messages.push(...page.messages);
    } while (pageToken !== '');
    return { runId, messages };
  };
  const metadata = { model: 'gpt-6.1-sol', effort: 'medium', promptSha: 'a'.repeat(64), inputTokens: 1200, outputTokens: 250 };

  check((await fetch(`${origin}/health`)).ok, 'the local Worker answers /health');
  const page = await fetch(origin);
  check(page.ok && (await page.text()).includes('/assets/'), 'the local Worker serves the built UI');
  const csrfRefusal = await fetch(`${origin}/api/v2/labels:initializePriorities`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
  check(csrfRefusal.status === 403, 'the owner mutation rejects a request without CSRF');
  check((await step(0)).code === 'priority_setup_required' && up.ai.calls.length === 0 && modifies() === 0, 'sorting waits for explicit priority setup');
  const setupId = id();
  const setup = await api.initializePriorities({ requestId: setupId });
  const setupCalls = up.gmail.calls.length;
  const repeatedSetup = await api.initializePriorities({ requestId: setupId });
  check(setup.completed && setup.removedLabelCount === 0 && repeatedSetup.completed && up.gmail.calls.length === setupCalls && setup.labels.map(label => label.displayName).join() === 'P1,P2,P3,P4', 'the real owner API creates P1-P4 once on a fresh store');
  check(up.gmail.calls.every(call => call.method !== 'DELETE'), 'fresh setup removes no Gmail labels or messages');
  check((await step(0)).code === 'ok', 'the initialized pipeline starts from its setup cursor');
  const initialSettings = await api.getSettings({ name: 'settings' });
  check(initialSettings.mode === Mode.SHADOW, 'setup preserves the shadow default');
  const missingMachine = await fetch(`${origin}/api/machine/v1/classification:claim`, { method: 'POST', body: '{bad' });
  check(missingMachine.status === 401, 'machine authentication rejects a missing token before JSON decoding');
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: id() });
  const personal = up.gmail.createUserLabel('Personal');
  const priorities = [Priority.P1, Priority.P2, Priority.P3, Priority.P4];
  const priorityMessages = priorities.map((priority, index) => {
    const messageId = `a11000000000000${String(index)}`;
    deliver({ ...MAILS.bankEn, id: messageId, threadId: 'synthetic-priority-thread', labels: ['INBOX', 'UNREAD', 'STARRED', personal] }, `p${String(priority)}`);
    return messageId;
  });
  const already = 'a110000000000020';
  const read = 'a110000000000021';
  deliver({ ...MAILS.bankEn, id: already, labels: ['UNREAD', 'STARRED', personal, gmailId('p2')] });
  deliver({ ...MAILS.bankEn, id: read, labels: ['INBOX', 'STARRED', personal, gmailId('p1')] });
  const readBefore = labelsOf(read).join();
  const batch = await claim();
  check(batch.messages.map(item => item.messageId).sort().join() === [...priorityMessages].sort().join(), 'the claim selects ungraded unread mail and skips read or already classified mail');
  const request = { runId: batch.runId, requestId: id(), results: priorityMessages.map((messageId, index) => ({ messageId, priority: priorities[index] ?? Priority.P4, reason: '合成阅读时效判断。' })), status: RunStatus.COMPLETED, ...metadata };
  const accepted = await machine.reportClassification(request);
  const duplicate = await machine.reportClassification(request);
  check(accepted.acceptedCount === 4 && accepted.pendingWriteCount === 4 && duplicate.acceptedCount === 4 && modifies() === 0, 'the report persists all four decisions once before any Gmail write');
  await step();
  for (const [index, messageId] of priorityMessages.entries()) {
    check(checkPriority(messageId, `p${String(index + 1)}`) && labelsOf(messageId).includes('STARRED') && labelsOf(messageId).includes(personal), `P${String(index + 1)} preserves UNREAD, STARRED and unrelated labels; only P1 keeps Inbox`);
  }
  const applied = modifies();
  await machine.reportClassification(request);
  await step();
  check(applied === 4 && modifies() === applied, 'repeated reports and alarms do not repeat Gmail modifications');
  const empty = await claim();
  check(empty.messages.length === 0, 'ordinary hourly claims skip already reported and already classified mail');
  await machine.reportClassification({ runId: empty.runId, requestId: id(), status: RunStatus.COMPLETED, ...metadata });

  const failedId = 'a110000000000030';
  deliver({ ...MAILS.unsure, id: failedId, labels: ['INBOX', 'UNREAD', 'STARRED', personal] }, 'p3');
  const failed = await claim();
  check(failed.messages.map(item => item.messageId).join() === failedId, 'a new unread arrival is claimed independently');
  await machine.reportClassification({ runId: failed.runId, requestId: id(), status: RunStatus.FAILED, errorCode: 'codex_failed', usagePartial: true, ...metadata });
  await step();
  check(labelsOf(failedId).join() === ['INBOX', 'UNREAD', 'STARRED', personal].sort().join() && modifies() === applied, 'model failure leaves mail unclassified without assigning fallback P1');
  const retry = await claim();
  check(retry.messages.map(item => item.messageId).join() === failedId, 'the next hourly run can claim a previous model failure');
  await machine.reportClassification({ runId: retry.runId, requestId: id(), results: [{ messageId: failedId, priority: Priority.P3, reason: '周末集中查看。' }], status: RunStatus.COMPLETED, ...metadata });
  await step();
  check(checkPriority(failedId, 'p3'), 'a later successful report follows the ordinary Gmail ledger');

  await api.startUnreadClassification({ name: 'unreadClassification', requestId: id(), recheckAllUnread: true });
  const recheck = await claim();
  const unreadIds = [...priorityMessages, already, failedId];
  check(recheck.messages.map(item => item.messageId).sort().join() === unreadIds.sort().join(), 'explicit all-unread recheck includes existing priorities and excludes read mail');
  for (const messageId of unreadIds) {
    const replaceLabels = ['p1', 'p3', 'p4'].map(gmailId).filter(label => labelsOf(messageId).includes(label));
    expected.set(messageId, { labelId: gmailId('p2'), state: 'intended', archived: true, baseInbox: labelsOf(messageId).includes('INBOX'), replaceLabels });
  }
  await machine.reportClassification({ runId: recheck.runId, requestId: id(), results: unreadIds.map(messageId => ({ messageId, priority: Priority.P2, reason: '两三天内查看。' })), status: RunStatus.COMPLETED, ...metadata });
  await step(); await step();
  check(unreadIds.every(messageId => checkPriority(messageId, 'p2') && labelsOf(messageId).includes('STARRED') && labelsOf(messageId).includes(personal)) && labelsOf(read).join() === readBefore, 'recheck replaces only priority and Inbox labels while preserving read mail and other state');
  const flow = await api.getMailFlow({ name: 'mailFlows/today' });
  check(flow.counts.some(item => item.stage === MailFlow_Stage.CODEX && item.outcome === MailFlow_Outcome.KEPT_IN_INBOX && item.label === 'labels/p1') && flow.counts.some(item => item.stage === MailFlow_Stage.CODEX && item.outcome === MailFlow_Outcome.ARCHIVED && item.label === 'labels/p2'), 'the real flow counters record Codex Inbox and archived outcomes');
  check(up.ai.calls.length === 0, 'claim, report, failure recovery and alarms never call Workers AI');

  const old = await fetch(`${origin}/api/v1/labels`);
  check(old.status === 410 && (await old.text()).includes('RELOAD_REQUIRED'), 'the old /api/v1 paths answer 410 RELOAD_REQUIRED');
  up.gmail.grants.clear();
  await step(2 * 60 * MINUTE);
  await step();
  await step();
  const calls = up.gmail.calls.length;
  const stopped = await step();
  const auth = await api.getServiceStatus({ name: 'serviceStatus' });
  check(stopped.code === 'stopped' && up.gmail.calls.length === calls && auth.authState === 3, 'three grant refusals stop further Google requests');
}

main().then(
  () => {
    console.log('smoke: passed');
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
