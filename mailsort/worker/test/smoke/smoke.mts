/**
 * The smoke run (../../../docs/design.md §11): the real `wrangler dev` (the pinned wrangler, ../../../wrangler.test.toml,
 * local bindings only) against the fake Gmail and fake Workers AI of ../fakes, served on loopback by this process.
 * Nothing reaches Google or Cloudflare: DEV_FAKE_UPSTREAM sends every Google request and every model call to the fake,
 * and every request the fake receives is checked against the independent table (../fakes/table.ts).
 *
 * It walks the owner's whole loop through the HTTP API the UI uses (mailsort.ui.v2): a shadow decision from the model's
 * two views, only recorded; live label + archive with UNREAD untouched; a confident none left in the inbox; a mail that
 * asks for action kept in the inbox with its label; undo; a trust label waiting for a trusted domain until the owner's
 * review choice teaches it, a forged From never getting it; Gmail corrections becoming examples; an owner's Gmail label
 * of a label's path adopted; a nested label created in Gmail with its parents; the neuron budget's switch to
 * Clef-flash and the quota deferral; the flow API (deferred mail counted once, while it waits); the legacy 分拣/x read
 * as x, a former parent not imported by the sync, a range undo of one label; the replay evaluation (nothing written,
 * the evidence as of the mail's time); the old /api/v1 paths answering 410; and last the auth failure. Run from
 * worker/ after the UI's build (the dev server serves web/dist):
 *
 *   npm run test:smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client';
import { MailsortUiService } from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb';
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb';
import { Label_GmailState, LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { ReplayEvaluation_State } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { LABELS, MAILS, message, type SyntheticMail } from '../fakes/fixtures.ts';
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
    // Every request Google got is one of the closed table's shapes, with owned labels only, and a label's name one the
    // store planned when it was sent (FakeUpstream.plannedPaths, set in run).
    // Owned: the leaf labels the Worker created and the one this run made for it to adopt; never another of the owner's.
    const owned = up.gmail.mailsortLabelIds();
    for (const call of up.gmail.calls) {
      const ledger = () => ({ state: call.body.includes('"addLabelIds":["INBOX"]') || (call.body.includes('removeLabelIds') && !call.body.includes('addLabelIds')) ? 'undo_intended' : 'intended', archived: call.body.includes('INBOX') });
      if (allowedOperation(call.method, call.url, call.body, { owned, planned: new Set(call.planned ?? []), ledger }) === null) throw new Error(`smoke: a request outside the table: ${call.method} ${call.url}`);
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
  up.plannedPaths = async () => (await api.listLabels({})).labels.map((label) => label.displayName);
  const id = () => crypto.randomUUID();
  let now = T0;
  const step = async (advance = 5 * MINUTE) => {
    now += advance;
    setClock(now);
    const response = await fetch(`${origin}/__dev/step?now=${String(now)}`, { method: 'POST' });
    if (!response.ok) throw new Error(`step: ${String(response.status)}`);
    return response.json<{ decided?: number; code: string }>();
  };
  const deliver = (mail: SyntheticMail) => { up.gmail.deliver(message({ ...mail, receivedAt: now })); };
  const labelsOf = (messageId: string) => [...(up.gmail.messages.get(messageId)?.labelIds ?? [])];
  const modifies = () => up.gmail.calls.filter((call) => call.url.endsWith('/modify')).length;

  const health = await fetch(`${origin}/health`);
  check(health.ok, 'the dev Worker answers /health');
  for (const label of LABELS) {
    await api.createLabel({ labelId: label.id, label: create(LabelSchema, { displayName: label.displayName, description: label.description, enabled: true, trustImplying: 'trust' in label && label.trust }), requestId: id() });
  }
  check((await api.listLabels({})).labels.length === LABELS.length, 'labels created through the owner API');
  const first = await step(0);
  check(first.code === 'ok', 'the first pass stores the install-time cursor (no backfill)');

  // Shadow (the default): the model's two views agree, the decision is only recorded; no write, nothing to review.
  const before = up.ai.calls.length;
  deliver(MAILS.newsletterEn);
  await step();
  const views = up.ai.calls.slice(before).filter((call) => call.model.includes('clef'));
  check(views.length === 2 && (await api.listReviewItems({})).reviewItems.length === 0 && modifies() === 0, 'shadow: two views of the model agree; the decision is only recorded, nothing waits for review, nothing is written');

  // Live: label + archive, UNREAD untouched; a mail no label fits stays in the inbox; one that asks for action keeps
  // its label in the inbox.
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: id() });
  deliver(MAILS.newsletterZh);
  deliver(MAILS.unsure);
  deliver({ ...MAILS.receiptZh, id: 'a1000000000000b1', subject: '订单已到快递柜', text: '订单包裹已到快递柜，凭取件码 1234 取件。' });
  await step();
  const sorted = up.gmail.labelIdByName('订阅') ?? '';
  const zh = labelsOf(MAILS.newsletterZh.id);
  check(sorted !== '' && zh.includes(sorted) && !zh.includes('INBOX') && zh.includes('UNREAD'), 'live: the label is added and INBOX removed, UNREAD untouched');
  const none = labelsOf(MAILS.unsure.id);
  check(none.includes('INBOX') && none.every((label) => !label.startsWith('Label_')), 'confident none: the mail keeps INBOX and gets no label');
  const pickup = labelsOf('a1000000000000b1');
  check(pickup.includes(up.gmail.labelIdByName('收据') ?? '-') && pickup.includes('INBOX'), 'needs action: a pickup code keeps its label in the inbox');

  // Undo.
  const entry = (await api.listLedgerEntries({})).ledgerEntries.find((item) => item.messageId === MAILS.newsletterZh.id);
  await api.undoLedgerEntry({ name: entry?.name ?? '', requestId: id() });
  const undone = labelsOf(MAILS.newsletterZh.id);
  check(undone.includes('INBOX') && !undone.includes(sorted) && undone.includes('UNREAD'), 'undo: the label is removed and INBOX restored');

  // A trust label waits for a trusted domain; the owner's review choice teaches it; a forged From never gets it.
  deliver(MAILS.bankEn);
  await step();
  const [bankItem] = (await api.listReviewItems({})).reviewItems;
  check(bankItem?.reason === 'untrusted_sender' && labelsOf(MAILS.bankEn.id).includes('INBOX'), 'a trust label for a sender not yet trusted: uncertain, shown in the review queue, nothing written');
  await api.resolveReviewItem({ name: bankItem?.name ?? '', label: 'labels/bank', requestId: id() });
  const bank = up.gmail.labelIdByName('银行') ?? '-';
  check(labelsOf(MAILS.bankEn.id).includes(bank) && (await api.getLabel({ name: 'labels/bank' })).trustedDomains.join() === 'bank.example.com', 'the owner\'s choice writes the label and teaches the sender\'s domain');
  deliver({ ...MAILS.bankEn, id: 'b100000000000001', subject: 'Your monthly bank statement for October' });
  deliver(MAILS.forgedBankLogin);
  await step();
  check(labelsOf('b100000000000001').includes(bank) && labelsOf(MAILS.forgedBankLogin.id).every((label) => !label.startsWith('Label_')), 'the trusted sender\'s next statement is labelled; a forged From (DMARC failed) gets nothing');

  // Corrections in Gmail (to 收据, which mailsort made) -> examples; Personal is a label of the owner's own.
  const receipt = up.gmail.labelIdByName('收据') ?? '';
  const personal = up.gmail.createUserLabel('Personal');
  for (const [i, messageId] of ['c000000000000c01', 'c000000000000c02'].entries()) {
    deliver({ ...MAILS.newsletterEn, id: messageId, subject: `Weekly digest ${String(i)}` });
    await step();
    up.gmail.ownerModify(messageId, [receipt], [sorted]);
    await step();
  }
  await step();
  const examples = (await api.listExamples({ label: 'labels/receipt' })).examples;
  check(examples.length === 2 && examples.every((example) => example.embedded), 'corrections in Gmail become embedded examples of the new label');
  // The owner made 出行 in Gmail by hand: the sync adopts the one of a label's path only.
  const travel = up.gmail.createUserLabel('出行', true);
  const adopted = await api.syncLabels({ requestId: id() });
  const travelLabel = adopted.labels.find((label) => label.name === 'labels/travel');
  check(adopted.linkedCount === 1 && travelLabel?.gmailLabelId === travel && travelLabel.gmailState === Label_GmailState.ADOPTED && !adopted.labels.some((label) => label.gmailLabelId === personal), 'sync: the owner\'s Gmail label of a label\'s exact path is adopted, no other label imported');

  // A nested label: created at Gmail's top level with its parent, the mail getting only the leaf.
  await api.createLabel({ label: create(LabelSchema, { displayName: '开发/CI通知', description: 'CI build passed failed main 构建', enabled: true }), requestId: id() });
  deliver(MAILS.ciBuild);
  await step();
  const names = [...up.gmail.labels.values()].map((label) => label.name);
  const ciLeaf = up.gmail.labelIdByName('开发/CI通知') ?? '';
  const ci = labelsOf(MAILS.ciBuild.id);
  check(names.includes('开发') && !names.some((name) => name === '分拣' || name.startsWith('分拣/')) && ciLeaf !== '' && ci.includes(ciLeaf) && !ci.includes('INBOX') && ci.filter((label) => label.startsWith('Label_')).length === 1, 'nested label: created at Gmail\'s top level with its parent 开发, no 分拣; the mail gets only the leaf, archived');

  // The replay evaluation: the owner's one answer (the bank mail) decided again as of its own time, nothing written
  // (before the quota test below, which stops it for the day). Its domain was taught by that very answer, later: as of
  // then its sender was not trusted, so it is uncertain, never a match borrowed from the answer.
  const writes = modifies();
  const replay = await api.startReplayEvaluation({ name: 'replayEvaluation', requestId: id() });
  await step();
  const summary = await api.getReplayEvaluation({ name: 'replayEvaluation' });
  check(
    replay.totalCount === 1 && summary.state === ReplayEvaluation_State.SUCCEEDED && summary.evaluatedCount === 1 && summary.autoCount === 0 && summary.unsureCount === 1 && modifies() === writes,
    'the replay evaluation decides the answered mail again as of its time (its domain not taught yet: uncertain) and writes nothing',
  );

  // The neuron budget: Clef-flash past 70 %.
  // 16,000 input tokens: Clef about 349 neurons a call, Clef-flash 131; two views a mail; the day has used about 900 of
  // its 3,000 so far, and the switch comes at 2,100.
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyNeuronBudget: 3000 }), updateMask: { paths: ['daily_neuron_budget'] }, requestId: id() });
  up.ai.tokensPerCall = 16_000;
  for (let i = 0; i < 5; i++) deliver({ ...MAILS.receiptZh, id: `f00000000000f00${String(i)}`, subject: `订单 ${String(i)} 已发货` });
  await step();
  const models = up.ai.calls.filter((call) => call.model.includes('clef')).map((call) => call.model);
  const status = await api.getServiceStatus({ name: 'serviceStatus' });
  check(models.includes('@cf/cloudflare/clef-flash') && status.decisionModel === 'clef-flash', 'past 70 % of the neuron budget the day continues on Clef-flash');
  up.ai.tokensPerCall = 2000;
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyNeuronBudget: 10_000 }), updateMask: { paths: ['daily_neuron_budget'] }, requestId: id() });

  // The quota: deferred, not failed.
  up.ai.quota = true;
  deliver({ ...MAILS.travelZh, id: 'f10000000000f101' });
  const deferred = await step();
  const quota = await api.getServiceStatus({ name: 'serviceStatus' });
  check(deferred.code === 'deferred' && quota.deferredCount >= 1 && quota.aiQuotaExhausted, 'Workers AI out of quota: the mail waits for the next UTC day (deferred, not failed)');
  up.ai.quota = false;
  const flow = await api.getMailFlow({ name: 'mailFlows/today' });
  const waiting = (await api.getServiceStatus({ name: 'serviceStatus' })).deferredCount;
  const counted = (stage: MailFlow_Stage, outcome: MailFlow_Outcome, label: string) => flow.counts.some((item) => item.stage === stage && item.outcome === outcome && item.label === label && item.mailCount >= 1);
  check(
    counted(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/dev-ci-notices') &&
      counted(MailFlow_Stage.CLEF, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/receipt') &&
      counted(MailFlow_Stage.CLEF, MailFlow_Outcome.NO_LABEL, '') &&
      counted(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE_SHOWN, '') &&
      flow.counts.filter((item) => item.stage === MailFlow_Stage.DEFERRED).reduce((sum, item) => sum + item.mailCount, 0) === waiting &&
      waiting >= 1,
    'the flow API counts each stage and outcome per label (archived, kept in inbox, no label, shown; deferred = the mail still waiting)',
  );

  // The legacy prefix, a rename, the sync and a range undo of one label.
  const typed = await api.createLabel({ label: create(LabelSchema, { displayName: '分拣/新闻/周报', description: '新闻网站的每周摘要与精选文章推送' }), requestId: id() });
  check(typed.displayName === '新闻/周报' && up.gmail.labelIdByName('新闻/周报') === typed.gmailLabelId && up.gmail.labelIdByName('分拣') === undefined, 'CreateLabel reads the legacy 分拣/新闻/周报 as 新闻/周报, created in Gmail as 新闻/周报');
  await api.updateLabel({ label: create(LabelSchema, { name: typed.name, displayName: '资讯/精选', etag: typed.etag }), updateMask: { paths: ['display_name', 'etag'] }, requestId: id() });
  const synced = await api.syncLabels({ requestId: id() });
  check(up.gmail.labelIdByName('资讯/精选') === typed.gmailLabelId && up.gmail.labelIdByName('新闻') !== undefined && !synced.labels.some((label) => label.displayName === '新闻'), 'rename: Gmail\'s label follows (资讯/精选); sync: the parent 新闻 this app created is not imported once its child is renamed away');
  const rangeUndo = await api.undoLedgerEntries({ startTime: timestampFromMs(T0), endTime: timestampFromMs(now + MINUTE), label: 'labels/dev-ci-notices', requestId: id() });
  const ciAfter = labelsOf(MAILS.ciBuild.id);
  const bankAfter = labelsOf('b100000000000001');
  check(rangeUndo.undoneCount === 1 && ciAfter.includes('INBOX') && !ciAfter.includes(ciLeaf) && !bankAfter.includes('INBOX'), 'range undo filtered to one label: only 开发/CI通知 is undone, the bank statement stays filed');

  // A page of the API before v2 is told to reload.
  const old = await fetch(`${origin}/api/v1/labels`);
  check(old.status === 410 && (await old.text()).includes('RELOAD_REQUIRED'), 'the old /api/v1 paths answer 410 RELOAD_REQUIRED');

  // The grant refused three times: Google is no longer called.
  up.gmail.grants.clear();
  await step(2 * 60 * MINUTE);
  await step();
  await step();
  const calls = up.gmail.calls.length;
  const stopped = await step();
  const auth = await api.getServiceStatus({ name: 'serviceStatus' });
  check(stopped.code === 'stopped' && up.gmail.calls.length === calls && auth.authState === 3, 'after three refusals of the grant the Worker stops calling Google (auth_state failed, the ops signal gmail_auth_failed)');
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
