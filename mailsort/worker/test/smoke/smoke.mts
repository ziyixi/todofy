/**
 * The smoke run (../../../docs/design.md §11): the real `wrangler dev` (the pinned wrangler, ../../../wrangler.test.toml,
 * local bindings only) against the fake Gmail and fake Workers AI of ../fakes, served on loopback by this process.
 * Nothing reaches Google or Cloudflare: DEV_FAKE_UPSTREAM sends every Google request and every model call to the fake,
 * and every request the fake receives is checked against the independent table (../fakes/table.ts).
 *
 * It walks the owner's whole loop through the HTTP API the UI uses: a shadow decision, live label + archive with UNREAD
 * untouched, an unsure mail left in the inbox, undo, Gmail corrections becoming examples and a rule proposal, the
 * neuron budget's switch to Clef-flash, the quota deferral; then round 2: an import of nested labels and the owner's
 * rule file (preview, confirm), a nested label created in Gmail with its parents, a label that keeps its mail in the
 * inbox, a subject carve-out before the sender's plain rule, a forged From that fires no rule, the flow API and the
 * export's round trip; and last the auth failure. Run from worker/ after the UI's build
 * (the dev server serves web/dist):
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
import { LabelImportSchema, MailsortUiService, RuleImportSchema } from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb';
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v1/flow_pb';
import { LabelSchema } from '@ziyixi/proto/mailsort/ui/v1/label_pb';
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
import { create } from '@ziyixi/proto/protobuf';
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
  const dev: ChildProcess = spawn('npx', args, { cwd: WORKER, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // Every request Google got is one of the closed table's shapes, with owned labels only.
    const owned = new Set([...up.gmail.labels.values()].filter((label) => label.type === 'user' && label.name.startsWith('分拣/')).map((label) => label.id));
    for (const call of up.gmail.calls) {
      const ledger = () => ({ state: call.body.includes('"addLabelIds":["INBOX"]') || (call.body.includes('removeLabelIds') && !call.body.includes('addLabelIds')) ? 'undo_intended' : 'intended', archived: call.body.includes('INBOX') });
      if (allowedOperation(call.method, call.url, call.body, { owned, ledger }) === null) throw new Error(`smoke: a request outside the table: ${call.method} ${call.url}`);
      for (const label of FORBIDDEN_LABELS) if (call.body.includes(`"${label}"`)) throw new Error(`smoke: ${label} in a write`);
    }
    check(up.strays.length === 0, `all ${String(up.gmail.calls.length)} Google requests are in the closed table; nothing else left the Worker`);
    check(!/owner@example\.com|digest@news|weekly digest/i.test(output.replace(/--var \S+/g, '')), 'the dev server log holds no address or mail text');
  } finally {
    dev.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (dev.exitCode === null) dev.kill('SIGKILL');
    fake.close();
    rmSync(persist, { recursive: true, force: true });
  }
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

  // Shadow (the default): a suggestion, no write.
  deliver(MAILS.newsletterEn);
  await step();
  const items = (await api.listReviewItems({})).reviewItems;
  check(items.some((item) => item.suggestedLabel === 'labels/newsletter') && modifies() === 0, 'shadow: a confident decision is a suggestion in the review queue and nothing is written to Gmail');

  // Live: label + archive, UNREAD untouched; the unsure mail stays in the inbox.
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: Mode.LIVE }), updateMask: { paths: ['mode'] }, requestId: id() });
  await api.updateLabel({ label: create(LabelSchema, { name: 'labels/newsletter', live: true }), updateMask: { paths: ['live'] }, requestId: id() });
  deliver(MAILS.newsletterZh);
  deliver(MAILS.unsure);
  await step();
  const sorted = up.gmail.labelIdByName('分拣/订阅') ?? '';
  const zh = labelsOf(MAILS.newsletterZh.id);
  check(sorted !== '' && zh.includes(sorted) && !zh.includes('INBOX') && zh.includes('UNREAD'), 'live: the label is added and INBOX removed, UNREAD untouched');
  const unsure = labelsOf(MAILS.unsure.id);
  check(unsure.includes('INBOX') && unsure.every((label) => !label.startsWith('Label_')), 'unsure: the mail keeps INBOX and gets no label');

  // Undo.
  const [entry] = (await api.listLedgerEntries({})).ledgerEntries;
  await api.undoLedgerEntry({ name: entry?.name ?? '', requestId: id() });
  const undone = labelsOf(MAILS.newsletterZh.id);
  check(undone.includes('INBOX') && !undone.includes(sorted) && undone.includes('UNREAD'), 'undo: the label is removed and INBOX restored');

  // Corrections in Gmail -> examples -> a rule proposal.
  const receipt = up.gmail.createUserLabel('分拣/收据');
  await api.syncLabels({ requestId: id() });
  for (const [i, messageId] of ['c000000000000c01', 'c000000000000c02'].entries()) {
    deliver({ ...MAILS.newsletterEn, id: messageId, subject: `Weekly digest ${String(i)}` });
    await step();
    up.gmail.ownerModify(messageId, [receipt], [sorted]);
    await step();
  }
  await step();
  const examples = (await api.listExamples({ label: 'labels/receipt' })).examples;
  check(examples.length === 2 && examples.every((example) => example.embedded), 'corrections in Gmail become embedded examples of the new label');
  const rules = (await api.listRules({})).rules;
  check(rules.some((rule) => rule.value === 'digest.news.example.com' && rule.label === 'labels/receipt' && rule.correctionCount === 2), 'two corrections of the same list propose a rule');

  // The neuron budget: Clef-flash past 70 %.
  // 16,000 input tokens: Clef about 349 neurons a call, Clef-flash 131; the switch comes at 1,050 of 1,500.
  await api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', dailyNeuronBudget: 1500 }), updateMask: { paths: ['daily_neuron_budget'] }, requestId: id() });
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

  // Round 2. An import: a nested label with its description, and the owner's rule file (synthetic): a CI sender, a
  // bank's login carve-out kept in the inbox, the bank's plain rule.
  const labelsIn = [create(LabelImportSchema, { path: '分拣/开发/CI通知', description: '持续集成平台的构建成功或失败通知、拉取请求与代码评审动态，多为机器自动生成的开发通知邮件。' })];
  const rulesIn = [
    create(RuleImportSchema, { id: 'ci-builds', match: { fromAddress: 'builds@ci.example.com' }, label: '分拣/开发/CI通知' }),
    create(RuleImportSchema, { id: 'bank-login', match: { fromAddress: 'statements@bank.example.com' }, label: '分拣/账号安全', trust: true, keepInInbox: true, subjectIncludes: ['登录', 'login'] }),
    create(RuleImportSchema, { id: 'bank-plain', match: { fromAddress: 'statements@bank.example.com' }, label: '分拣/金融/银行支付', trust: true }),
  ];
  const preview = await api.importRules({ labels: labelsIn, rules: rulesIn, validateOnly: true });
  const before = (await api.listLabels({})).labels.length;
  check(preview.createdLabelCount === 3 && preview.createdRuleCount === 3 && !preview.applied && (await api.listLabels({})).labels.length === before, 'import: the preview lists 3 labels and 3 rules to create and changes nothing');
  const imported = await api.importRules({ labels: labelsIn, rules: rulesIn, requestId: id() });
  check(imported.applied && (await api.listRules({})).rules.some((rule) => rule.importId === 'bank-login' && rule.subjectIncludes.includes('登录')), 'import: confirmed, the rules and their subject conditions are stored');
  for (const labelId of ['dev-ci-notices', 'account-security', 'finance-bank-pay']) {
    await api.updateLabel({ label: create(LabelSchema, { name: `labels/${labelId}`, live: true }), updateMask: { paths: ['live'] }, requestId: id() });
  }
  deliver(MAILS.ciBuild);
  deliver(MAILS.bankLogin);
  deliver(MAILS.bankEn);
  deliver(MAILS.forgedBankLogin);
  await step();
  await step();
  const names = [...up.gmail.labels.values()].map((label) => label.name);
  const ciLeaf = up.gmail.labelIdByName('分拣/开发/CI通知') ?? '';
  const ci = labelsOf(MAILS.ciBuild.id);
  check(names.includes('分拣') && names.includes('分拣/开发') && ciLeaf !== '' && ci.includes(ciLeaf) && !ci.includes('INBOX') && ci.filter((label) => label.startsWith('Label_')).length === 1, 'nested label: created in Gmail with its parents; the mail gets only the leaf, archived');
  const security = up.gmail.labelIdByName('分拣/账号安全') ?? '';
  const login = labelsOf(MAILS.bankLogin.id);
  check(security !== '' && login.includes(security) && login.includes('INBOX') && login.includes('UNREAD'), 'keep in inbox: the login notice gets 分拣/账号安全 by its carve-out and stays in the inbox, UNREAD untouched');
  const plain = labelsOf(MAILS.bankEn.id);
  check(plain.includes(up.gmail.labelIdByName('分拣/金融/银行支付') ?? '-') && !plain.includes('INBOX'), 'carve-out order: the same sender\'s statement takes the plain rule (label and archive)');
  const forged = labelsOf(MAILS.forgedBankLogin.id);
  check(forged.includes('INBOX') && forged.every((label) => !label.startsWith('Label_')), 'forged From (DMARC failed): no rule fires and nothing is written');
  const flow = await api.getMailFlow({ name: 'mailFlows/today' });
  const counted = (stage: MailFlow_Stage, outcome: MailFlow_Outcome, label: string) => flow.counts.some((item) => item.stage === stage && item.outcome === outcome && item.label === label && item.mailCount >= 1);
  check(
    counted(MailFlow_Stage.RULE, MailFlow_Outcome.ARCHIVED, 'labels/dev-ci-notices') && counted(MailFlow_Stage.RULE, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/account-security') && flow.counts.some((item) => item.stage === MailFlow_Stage.DEFERRED),
    'the flow API counts each stage and outcome per label (rule archived, kept in inbox, deferred)',
  );
  const exported = JSON.parse((await api.exportRules({})).json) as { rules: { id: string }[] };
  const again = await api.importRules({ labels: labelsIn, rules: rulesIn, validateOnly: true });
  check(exported.rules.some((rule) => rule.id === 'bank-login') && again.skippedCount === 4 && again.createdRuleCount === 0, 'export lists the imported rules; importing the same file again changes nothing');

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
