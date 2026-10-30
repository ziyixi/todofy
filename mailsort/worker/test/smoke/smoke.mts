/**
 * The smoke run (../../../docs/design.md §11): the real `wrangler dev` (the pinned wrangler, ../../../wrangler.test.toml,
 * local bindings only) against the fake Gmail and fake Model Router of ../fakes, served on loopback by this process.
 * Nothing reaches Google or Cloudflare: DEV_FAKE_UPSTREAM sends every Google request and every model call to the fake,
 * and every request the fake receives is checked against the independent table (../fakes/table.ts).
 *
 * It exercises fixed P1-P4 setup through the generated owner HTTP API, CSRF rejection, shadow/live sorting,
 * undo, Gmail corrections, the retired replay's refusal, provider spend and quota holds and authentication stop. Every mail and credential is synthetic. Run after the UI build:
 *
 *   npm run test:smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client';
import { MailsortUiService } from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb';
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb';
import { ClassificationProvider, Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
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
    MODE: 'live',
    DEV_AUTH_BYPASS: 'true',
    DEV_MANUAL_ALARMS: 'true',
    ACCESS_OWNER: 'owner@example.com',
    DEV_FAKE_UPSTREAM: fakeOrigin,
    GMAIL_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
    GMAIL_CLIENT_SECRET: 'synthetic-secret',
    GMAIL_REFRESH_TOKEN: REFRESH_TOKEN,
  };
  const wrangler = process.env.BAZEL_WRANGLER
    ? resolve(process.env.TEST_SRCDIR ?? '', process.env.TEST_WORKSPACE ?? '', process.env.BAZEL_WRANGLER)
    : undefined;
  const args = [...(wrangler ? [] : ['--no-install', 'wrangler']), 'dev', '--config', '../wrangler.test.toml', '--ip', '127.0.0.1', '--port', String(port), '--local-upstream', `127.0.0.1:${String(port)}`, '--persist-to', persist, '--inspector-port', '0', '--show-interactive-dev-session=false'];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);
  // Its own process group: npx, wrangler and workerd stop together, or the survivors hold the pipes and this never exits.
  const dev: ChildProcess = spawn(wrangler ?? 'npx', args, { cwd: WORKER, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
  const step = async (advance = 60 * MINUTE) => {
    now += advance;
    setClock(now);
    const response = await fetch(`${origin}/__dev/step?now=${String(now)}`, { method: 'POST' });
    if (!response.ok) throw new Error(`step: ${String(response.status)} ${(await response.text()).slice(0, 200)}`);
    return response.json<{ decided?: number; code: string }>();
  };
  const gmailId = (priority: string) => {
    const value = up.gmail.labelIdByName(priority.toUpperCase());
    if (value === undefined) throw new Error(`smoke: missing synthetic ${priority} label`);
    return value;
  };
  const force = (priority: 'p1' | 'p2' | 'p3' | 'p4') => { up.claude.bucket = priority.toUpperCase() as 'P1' | 'P2' | 'P3' | 'P4'; };
  const deliver = (mail: SyntheticMail, priority?: string, replaceLabels: readonly string[] = []) => {
    if (priority !== undefined) expected.set(mail.id, { labelId: gmailId(priority), state: 'intended', archived: priority !== 'p1', replaceLabels });
    up.gmail.deliver(message({ ...mail, receivedAt: now }));
  };
  const labelsOf = (messageId: string) => [...(up.gmail.messages.get(messageId)?.labelIds ?? [])];
  const modifies = () => up.gmail.calls.filter(call => call.url.endsWith('/modify')).length;
  const checkPriority = (messageId: string, priority: string, inbox = priority === 'p1') => {
    const labels = labelsOf(messageId);
    const priorities = ['p1', 'p2', 'p3', 'p4'].map(gmailId).filter(label => labels.includes(label));
    return priorities.length === 1 && priorities[0] === gmailId(priority) && labels.includes('UNREAD') && labels.includes('INBOX') === inbox;
  };
  const undo = async (messageId: string) => {
    const entry = (await api.listLedgerEntries({})).ledgerEntries.find(item => item.messageId === messageId);
    const row = expected.get(messageId);
    if (entry === undefined || row === undefined) throw new Error('smoke: expected undoable synthetic write');
    expected.set(messageId, { ...row, state: 'undo_intended' });
    await api.undoLedgerEntry({ name: entry.name, requestId: id() });
  };

  check((await fetch(`${origin}/health`)).ok, 'the local Worker answers /health');
  const page = await fetch(origin);
  check(page.ok && (await page.text()).includes('/assets/'), 'the local Worker serves the built UI');
  // No body: an upload the Worker refuses unread makes wrangler dev's local proxy drop that connection, which can
  // fail the next POST with a 500. The 403 is decided on headers alone (checkCsrf runs before the body is read).
  const csrfRefusal = await fetch(`${origin}/api/v2/labels:initializePriorities`, { method: 'POST', headers: { 'content-type': 'application/json', origin } });
  check(csrfRefusal.status === 403, 'the owner mutation rejects a request without CSRF');
  check((await step(0)).code === 'priority_setup_required' && up.claude.calls.length === 0 && modifies() === 0, 'sorting waits for explicit priority setup');
  const setupId = id();
  const setup = await api.initializePriorities({ requestId: setupId });
  const setupCalls = up.gmail.calls.length;
  const repeatedSetup = await api.initializePriorities({ requestId: setupId });
  check(setup.completed && setup.removedLabelCount === 0 && repeatedSetup.completed && up.gmail.calls.length === setupCalls && setup.labels.map(label => label.displayName).join() === 'P1,P2,P3,P4', 'the real owner API creates P1-P4 once on a fresh store');
  check(up.gmail.calls.every(call => call.method !== 'DELETE'), 'fresh setup removes no Gmail labels or messages');
  check((await step(0)).code === 'ok', 'the initialized pipeline starts from its setup cursor');
  const initialSettings = await api.getSettings({ name: 'settings' });
  check(initialSettings.mode === Mode.SHADOW && initialSettings.runWriteLimit === 10, 'setup preserves the shadow mode and existing write cap');
  check(initialSettings.classificationProvider === ClassificationProvider.CODEX, 'a fresh store defaults to Codex, the provider in use');
  // The rest exercises the owner's explicit Claude choice, with its usage and monthly cap.
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', classificationProvider: ClassificationProvider.CLAUDE }), updateMask: { paths: ['classification_provider'] }, requestId: id() });
  force('p2');
  deliver(MAILS.newsletterEn);
  await step();
  check(up.claude.calls.length === 1 && up.claude.calls[0]?.length === 1 && modifies() === 0, 'shadow records one native Claude batch without Gmail writes');
  check((await api.listReviewItems({})).reviewItems.length === 0, 'direct Claude results do not create mandatory review');
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: id() });
  for (const [index, priority] of (['p1', 'p2', 'p3', 'p4'] as const).entries()) {
    const messageId = `a00000000000f00${String(index)}`;
    force(priority);
    deliver({ ...MAILS.bankEn, id: messageId, dmarc: 'fail' }, priority);
    await step();
    check(checkPriority(messageId, priority), `${priority.toUpperCase()} preserves unread and the configured Inbox/archive action`);
  }
  await undo('a00000000000f001');
  check(labelsOf('a00000000000f001').includes('INBOX') && labelsOf('a00000000000f001').includes('UNREAD'), 'undo restores Inbox while preserving unread');
  let refused = false;
  try { await api.startReplayEvaluation({ name: 'replayEvaluation', requestId: id() }); } catch { refused = true; }
  check(refused, 'retired model replay is refused');
  const budget = (await api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget;
  check(budget?.model === 'claude-opus-5-5' && budget.effort === 'medium' && budget.limitUsd === 20 && budget.spentUsd > 0 && budget.inputTokens > 0, 'owner status exposes recorded Claude usage and the monthly cap');
  const flow = await api.getMailFlow({ name: 'mailFlows/today' });
  check(flow.counts.some(item => item.stage === MailFlow_Stage.CLAUDE && item.outcome === MailFlow_Outcome.ARCHIVED), 'flow attributes new decisions to Claude');
  force('p2');
  up.claude.spendLimit = true;
  const deferredId = 'a00000000000f010';
  deliver({ ...MAILS.bankEn, id: deferredId }, 'p2');
  check((await step()).code === 'claude_spend_limit', 'provider workspace spend exhaustion retains pending mail');
  const calls = up.claude.calls.length;
  up.claude.spendLimit = false;
  await step(5 * MINUTE);
  check(up.claude.calls.length === calls && labelsOf(deferredId).includes('INBOX'), 'recorded spend exhaustion stops calls for the rest of the UTC month');
  const date = new Date(now);
  await step(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now);
  check(checkPriority(deferredId, 'p2'), 'the next UTC month resumes pending classification');
  const old = await fetch(`${origin}/api/v1/labels`);
  check(old.status === 410 && (await old.text()).includes('RELOAD_REQUIRED'), 'the old /api/v1 paths answer 410 RELOAD_REQUIRED');
  up.gmail.grants.clear();
  await step(2 * 60 * MINUTE);
  await step();
  await step();
  const googleCalls = up.gmail.calls.length;
  const stopped = await step();
  const auth = await api.getServiceStatus({ name: 'serviceStatus' });
  check(stopped.code === 'stopped' && up.gmail.calls.length === googleCalls && auth.authState === 3, 'three grant refusals stop further Google requests');
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
