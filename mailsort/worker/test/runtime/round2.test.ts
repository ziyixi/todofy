/**
 * The owner's round-2 requests in workerd with a real SQLite MailsortState, the fake Gmail and the fake Workers AI
 * (../../../docs/design.md §3, §4.3, §6, §10): the template and the rule file imported with a preview and a
 * confirmation; nested labels created in Gmail with their parents, the mail getting only the leaf; labels and rules
 * that keep their mail in the inbox (UNREAD untouched, undo removing only the label); a subject carve-out before the
 * sender's plain rule; forged and look-alike From headers firing no rule; nested Gmail labels adopted, never imported; the flow
 * counters with the ledger's label filter; and the export's round trip. Every request Google got is checked against
 * the independent table after each test. All data is synthetic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Label_GmailState, LabelSchema } from '@ziyixi/proto/mailsort/ui/v1/label_pb';
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v1/flow_pb';
import { ImportChange_Action, ImportRulesResponseSchema, RuleImportSchema, type RuleImport } from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb';
import { RuleSchema, Rule_Kind } from '@ziyixi/proto/mailsort/ui/v1/rule_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
import { readDetail, type Status } from '@ziyixi/proto/rpc-status';
import { MAILS } from '../fakes/fixtures.ts';
import { MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, gmailLabels, modifies, setLabelLive, setMode } from './helpers.ts';

/**
 * The owner's rule file, synthetic: a CI sender, a bank's login carve-out and its plain rule, a pickup carve-out. In
 * the file's own format, whose labels still carry the legacy `分拣/` prefix.
 */
function ruleFile(): RuleImport[] {
  return [
    create(RuleImportSchema, { id: 'ci-builds', match: { fromAddress: 'builds@ci.example.com' }, label: '分拣/开发/CI通知', evidence: 'synthetic: every CI mail' }),
    create(RuleImportSchema, { id: 'bank-login', match: { fromAddress: 'statements@bank.example.com' }, label: '分拣/账号安全', trust: true, keepInInbox: true, subjectIncludes: ['登录', 'login'] }),
    create(RuleImportSchema, { id: 'bank', match: { fromAddress: 'statements@bank.example.com' }, label: '分拣/金融/银行支付', trust: true }),
    create(RuleImportSchema, { id: 'pickup', match: { fromAddress: 'orders@shop.example.com' }, label: '分拣/购物/订单物流', keepInInbox: true, subjectIncludes: ['取件码'] }),
    create(RuleImportSchema, { id: 'shop', match: { fromAddress: 'orders@shop.example.com' }, label: '分拣/购物/订单物流' }),
  ];
}

describe('round 2: import, nested labels, keep in inbox, carve-outs, forged From, the flow', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
    await h.step(now);
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('previews the template without writing, then imports it once per request ID', async () => {
    const preview = await h.api.importRules({ useTemplate: true, validateOnly: true });
    expect(preview).toMatchObject({ applied: false, createdLabelCount: 15, invalidCount: 0 });
    expect(preview.labels.map((label) => label.path)).toContain('金融/银行支付');
    expect((await h.api.listLabels({})).labels).toEqual([]);
    const requestId = op();
    const applied = await h.api.importRules({ useTemplate: true, requestId });
    expect(applied).toMatchObject({ applied: true, createdLabelCount: 15 });
    expect((await h.api.importRules({ useTemplate: true, requestId })).createdLabelCount).toBe(15);
    const labels = (await h.api.listLabels({})).labels;
    expect(labels).toHaveLength(15);
    expect(labels.find((label) => label.displayName === '账号安全')).toMatchObject({ name: 'labels/account-security', enabled: true, live: false, trustImplying: true, keepInInbox: true });
    expect(labels.find((label) => label.displayName === '生活/医疗')).toMatchObject({ sensitive: true, trustImplying: true });
    // Nothing reached Gmail: labels are created there before their first write.
    expect(h.up.gmail.calls.filter((call) => call.method !== 'GET' && !call.url.includes('/token'))).toEqual([]);
  });

  it('refuses an import with an invalid entry as a whole, and says which entry and why', async () => {
    const bad = [...ruleFile(), create(RuleImportSchema, { id: 'two-keys', match: { fromAddress: 'a@example.com', fromDomain: 'example.com' }, label: '订阅收据' })];
    const preview = await h.api.importRules({ rules: bad, validateOnly: true });
    expect(preview.invalidCount).toBe(1);
    expect(preview.changes.find((change) => change.action === ImportChange_Action.INVALID)).toMatchObject({ key: 'two-keys', problem: 'match', index: 5 });
    const error = await rejection(h.api.importRules({ rules: bad, requestId: op() }));
    expect(reasonOf(error)).toBe('INVALID_IMPORT');
    expect(readDetail((error as { status: Status }).status, ImportRulesResponseSchema)?.invalidCount).toBe(1);
    expect((await h.api.listRules({})).rules).toEqual([]);
  });

  it('imports the rule file: subject conditions, keep in inbox, evidence, all onto the template’s labels', async () => {
    const preview = await h.api.importRules({ rules: ruleFile(), validateOnly: true });
    expect(preview).toMatchObject({ createdRuleCount: 5, createdLabelCount: 0, invalidCount: 0 });
    await h.api.importRules({ rules: ruleFile(), requestId: op() });
    const rules = (await h.api.listRules({})).rules;
    expect(rules).toHaveLength(5);
    expect(rules.find((rule) => rule.name === 'rules/bank-login')).toMatchObject({ subjectIncludes: ['登录', 'login'], keepInInbox: true, dmarcRequired: true, importId: 'bank-login', label: 'labels/account-security' });
    expect(rules.find((rule) => rule.name === 'rules/ci-builds')).toMatchObject({ evidence: 'synthetic: every CI mail', dmarcRequired: true });
    // A second import of the same file changes nothing.
    expect((await h.api.importRules({ rules: ruleFile(), validateOnly: true })).skippedCount).toBe(5);
  });

  it('a live write to a nested label creates its parents in Gmail; the mail gets only the leaf', async () => {
    await setMode(h, Mode.LIVE);
    for (const id of ['dev-ci-notices', 'account-security', 'finance-bank-pay', 'shop-orders-shipping']) await setLabelLive(h, id, true);
    deliver(h, MAILS.ciBuild, now);
    now += 5 * MINUTE;
    await h.step(now);
    const names = [...h.up.gmail.labels.values()].filter((label) => label.type === 'user').map((label) => label.name);
    // At Gmail's top level: the parent 开发 and the leaf, no root label.
    expect(names).toEqual(expect.arrayContaining(['开发', '开发/CI通知']));
    expect(names.some((name) => name === '分拣' || name.startsWith('分拣/'))).toBe(false);
    const leaf = h.up.gmail.labelIdByName('开发/CI通知') ?? '';
    expect(gmailLabels(h, MAILS.ciBuild.id)).toEqual(['CATEGORY_UPDATES', leaf, 'UNREAD'].sort());
    expect(await decision(h, MAILS.ciBuild.id)).toMatchObject({ outcome: 'applied', decider: 'rule', label_id: 'dev-ci-notices' });
    // The parents are never linked: the guard's owned set is the leaves only.
    expect((await h.api.getLabel({ name: 'labels/dev-ci-notices' })).gmailLabelId).toBe(leaf);
  });

  it('keeps account-security mail in the inbox: the label added, INBOX and UNREAD untouched; undo removes only the label', async () => {
    deliver(h, MAILS.bankLogin, now);
    now += 5 * MINUTE;
    await h.step(now);
    const security = h.up.gmail.labelIdByName('账号安全') ?? '';
    expect(gmailLabels(h, MAILS.bankLogin.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', security, 'UNREAD'].sort());
    expect(await decision(h, MAILS.bankLogin.id)).toMatchObject({ decider: 'rule', label_id: 'account-security' });
    const [entry] = (await h.api.listLedgerEntries({ label: 'labels/account-security' })).ledgerEntries;
    expect(entry).toMatchObject({ messageId: MAILS.bankLogin.id, archived: false });
    await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    expect(gmailLabels(h, MAILS.bankLogin.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
  });

  it('the carve-out goes first: the same sender’s statement takes the plain rule, label and archive', async () => {
    deliver(h, MAILS.bankEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    const bank = h.up.gmail.labelIdByName('金融/银行支付') ?? '';
    expect(gmailLabels(h, MAILS.bankEn.id)).toEqual(['CATEGORY_UPDATES', bank, 'UNREAD'].sort());
  });

  it('a rule keeps its mail in the inbox while its label archives: a pickup code stays, a receipt goes', async () => {
    deliver(h, MAILS.pickupZh, now);
    deliver(h, MAILS.receiptEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    const orders = h.up.gmail.labelIdByName('购物/订单物流') ?? '';
    expect(gmailLabels(h, MAILS.pickupZh.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', orders, 'UNREAD'].sort());
    expect(gmailLabels(h, MAILS.receiptEn.id)).toEqual(['CATEGORY_UPDATES', orders, 'UNREAD'].sort());
  });

  it('a forged or look-alike From fires no rule: the model may only suggest, nothing is written', async () => {
    const before = h.up.gmail.calls.filter((call) => call.url.endsWith('/modify')).length;
    deliver(h, MAILS.forgedBankLogin, now);
    deliver(h, MAILS.lookalikeBank, now);
    // A dmarc=pass planted in a quoted envelope local part (Gmail repeats it in its spf comment) is not Gmail's result.
    deliver(h, MAILS.injectedDmarc, now);
    now += 5 * MINUTE;
    await h.step(now);
    for (const mail of [MAILS.forgedBankLogin, MAILS.lookalikeBank, MAILS.injectedDmarc]) {
      const row = await decision(h, mail.id);
      expect(row, mail.id).toBeDefined();
      expect(row?.['decider'], mail.id).toBe('clef');
      expect(row?.['outcome'], mail.id).not.toBe('applied');
      expect(gmailLabels(h, mail.id), mail.id).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    }
    expect(h.up.gmail.calls.filter((call) => call.url.endsWith('/modify')).length).toBe(before);
  });

  it('adopts the owner\'s Gmail label of a new label\'s exact path, never its parent, and the sync imports nothing', async () => {
    // The owner made 项目 and 项目/阿尔法 in Gmail by hand; a label of that path is created here in live mode.
    const parent = h.up.gmail.createUserLabel('项目');
    const leaf = h.up.gmail.createUserLabel('项目/阿尔法', true);
    h.up.gmail.createUserLabel('项目/贝塔');
    const before = h.up.gmail.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/labels')).length;
    const created = await h.api.createLabel({ label: create(LabelSchema, { displayName: '项目/阿尔法', description: '阿尔法项目的协作通知与周会纪要' }), requestId: op() });
    expect(created).toMatchObject({ gmailLabelId: leaf, gmailState: Label_GmailState.ADOPTED });
    // Linked, not created twice: no labels.create, and the owner's parent is neither linked nor recorded as ours.
    expect(h.up.gmail.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/labels')).length).toBe(before);
    expect(await h.sql(`SELECT count(*) AS n FROM gmail_parents WHERE gmail_id = ?`, parent)).toEqual([{ n: 0 }]);
    // Its ID comes from its path (a word outside the glossary as a short hash), never a random one.
    expect(created.name).toMatch(/^labels\/project-x[0-9a-f]{4}$/);
    const result = await h.api.syncLabels({ requestId: op() });
    expect(result).toMatchObject({ linkedCount: 0, importedCount: 0 });
    expect(result.labels.some((label) => label.displayName === '项目' || label.displayName === '项目/贝塔' || label.gmailLabelId === parent)).toBe(false);
    // Creating a label above an existing one is refused: only leaves are labels.
    expect(reasonOf(await rejection(h.api.createLabel({ label: create(LabelSchema, { displayName: '项目' }), requestId: op() })))).toBe('INVALID_LABEL');
  });

  it('a parent this app created stays its own: never imported, and a label made of it later is linked, not adopted (QA D6)', async () => {
    const news = await h.api.createLabel({ label: create(LabelSchema, { displayName: '新闻/周报', description: '新闻网站的每周摘要与精选文章推送' }), requestId: op() });
    expect(news.gmailState).toBe(Label_GmailState.LINKED);
    expect(h.up.gmail.labelIdByName('新闻')).toBeDefined();
    const renamed = await h.api.updateLabel({ label: { ...news, displayName: '资讯/周报/精选' }, updateMask: { paths: ['display_name'] }, requestId: op() });
    expect(renamed.displayName).toBe('资讯/周报/精选');
    expect(h.up.gmail.labelIdByName('资讯/周报/精选')).toBe(news.gmailLabelId);
    // Gmail keeps the old parent 新闻, now without children: still no label of mailsort's.
    const synced = await h.api.syncLabels({ requestId: op() });
    expect(synced.labels.some((label) => label.displayName === '新闻' || label.displayName === '资讯' || label.displayName === '资讯/周报')).toBe(false);
    // The owner may still add it by hand: it links to the Gmail label that is there, which this app made.
    const own = await h.api.createLabel({ label: create(LabelSchema, { displayName: '新闻', description: '新闻网站的推送与快讯' }), requestId: op() });
    expect(own).toMatchObject({ gmailLabelId: h.up.gmail.labelIdByName('新闻'), gmailState: Label_GmailState.LINKED });
    expect(await h.sql(`SELECT count(*) AS n FROM gmail_parents WHERE gmail_id = ?`, own.gmailLabelId)).toEqual([{ n: 0 }]);
    for (const label of [own, renamed]) {
      const current = await h.api.getLabel({ name: label.name });
      await h.api.deleteLabel({ name: current.name, etag: current.etag, requestId: op() });
    }
  });

  it('a rename to the name of another Gmail label is refused, and the label keeps its path', async () => {
    const label = await h.api.createLabel({ label: create(LabelSchema, { displayName: '测试/改名前', description: '只用于测试改名冲突的标签' }), requestId: op() });
    h.up.gmail.createUserLabel('Work');
    expect(reasonOf(await rejection(h.api.updateLabel({ label: { ...label, displayName: 'Work' }, updateMask: { paths: ['display_name'] }, requestId: op() })))).toBe('LABEL_EXISTS');
    expect(await h.api.getLabel({ name: label.name })).toMatchObject({ displayName: '测试/改名前', gmailLabelId: label.gmailLabelId });
    expect(h.up.gmail.labels.get(label.gmailLabelId)?.name).toBe('测试/改名前');
    const current = await h.api.getLabel({ name: label.name });
    await h.api.deleteLabel({ name: current.name, etag: current.etag, requestId: op() });
  });

  it('two labels never share a Gmail label: one renamed in Gmail to a new label\'s path stays with its own', async () => {
    const bank = h.up.gmail.labels.get(h.up.gmail.labelIdByName('金融/银行支付') ?? '');
    if (bank === undefined) throw new Error('no bank label');
    bank.name = '临时/测试';
    const created = await h.api.createLabel({ label: create(LabelSchema, { displayName: '临时/测试', description: '只用于测试重名的标签' }), requestId: op() });
    expect(created).toMatchObject({ gmailLabelId: '', gmailState: Label_GmailState.PENDING });
    const synced = await h.api.syncLabels({ requestId: op() });
    expect(synced).toMatchObject({ linkedCount: 0, renamedCount: 0 });
    expect(synced.labels.find((label) => label.name === 'labels/finance-bank-pay')).toMatchObject({ displayName: '金融/银行支付', gmailLabelId: bank.id });
    bank.name = '金融/银行支付';
    const current = await h.api.getLabel({ name: created.name });
    await h.api.deleteLabel({ name: current.name, etag: current.etag, requestId: op() });
  });

  it('CreateLabel and a rename read the legacy 分拣/x as x, never as a label under 分拣 (QA D7)', async () => {
    const typed = await h.api.createLabel({ label: create(LabelSchema, { displayName: '分拣/测试/前缀', description: '只用于测试前缀的标签' }), requestId: op() });
    expect(typed.displayName).toBe('测试/前缀');
    expect(reasonOf(await rejection(h.api.createLabel({ label: create(LabelSchema, { displayName: '分拣' }), requestId: op() })))).toBe('INVALID_LABEL');
    expect(reasonOf(await rejection(h.api.updateLabel({ label: { ...typed, displayName: '分拣/分拣/x' }, updateMask: { paths: ['display_name'] }, requestId: op() })))).toBe('INVALID_LABEL');
    const renamed = await h.api.updateLabel({ label: { ...typed, displayName: '分拣/测试/改名' }, updateMask: { paths: ['display_name'] }, requestId: op() });
    expect(renamed.displayName).toBe('测试/改名');
    expect(h.up.gmail.labels.get(renamed.gmailLabelId)?.name).toBe('测试/改名');
    expect([...h.up.gmail.labels.values()].some((label) => label.name === '分拣' || label.name.startsWith('分拣/'))).toBe(false);
    await h.api.deleteLabel({ name: renamed.name, etag: renamed.etag, requestId: op() });
  });

  it('counts the flow per stage, outcome and label, corrections included; a label links to its ledger entries', async () => {
    const shop = h.up.gmail.labelIdByName('购物/订单物流') ?? '';
    // The owner made 购物/促销 in Gmail by hand: the sync adopts it for the template's label of that path.
    const promo = h.up.gmail.createUserLabel('购物/促销', true);
    await h.api.syncLabels({ requestId: op() });
    h.up.gmail.ownerModify(MAILS.receiptEn.id, [promo], [shop]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.receiptEn.id)).toMatchObject({ verdict: 'corrected', verdict_label: 'shop-promo' });
    const flow = await h.api.getMailFlow({ name: 'mailFlows/today' });
    const count = (stage: MailFlow_Stage, outcome: MailFlow_Outcome, label = '') =>
      flow.counts.filter((item) => item.stage === stage && item.outcome === outcome && item.label === label).reduce((sum, item) => sum + item.mailCount, 0);
    expect(count(MailFlow_Stage.RULE, MailFlow_Outcome.ARCHIVED, 'labels/dev-ci-notices')).toBe(1);
    expect(count(MailFlow_Stage.RULE, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/account-security')).toBe(1);
    expect(count(MailFlow_Stage.RULE, MailFlow_Outcome.ARCHIVED, 'labels/finance-bank-pay')).toBe(1);
    expect(count(MailFlow_Stage.RULE, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/shop-orders-shipping')).toBe(1);
    expect(count(MailFlow_Stage.RULE, MailFlow_Outcome.ARCHIVED, 'labels/shop-orders-shipping')).toBe(1);
    expect(count(MailFlow_Stage.RULE, MailFlow_Outcome.CORRECTED, 'labels/shop-orders-shipping')).toBe(1);
    // The forged, look-alike and planted-result mails went to the model and stayed in the inbox.
    const modelled = flow.counts.filter((item) => item.stage === MailFlow_Stage.CLEF && (item.outcome === MailFlow_Outcome.UNSURE || item.outcome === MailFlow_Outcome.SUGGESTED)).reduce((sum, item) => sum + item.mailCount, 0);
    expect(modelled).toBe(3);
    expect(flow.startTime !== undefined && flow.endTime !== undefined).toBe(true);
    expect((await h.api.getMailFlow({ name: 'mailFlows/last-30-days' })).counts.length).toBe(flow.counts.length);
    expect(reasonOf(await rejection(h.api.getMailFlow({ name: 'mailFlows/forever' })))).toBe('NOT_FOUND');
    const entries = (await h.api.listLedgerEntries({ label: 'labels/shop-orders-shipping' })).ledgerEntries;
    expect(entries.map((entry) => entry.messageId).sort()).toEqual([MAILS.pickupZh.id, MAILS.receiptEn.id].sort());
  });

  it('exports every label and rule as the document an import reads back unchanged', async () => {
    const exported = await h.api.exportRules({});
    expect(exported).toMatchObject({ ruleCount: 5 });
    const document = JSON.parse(exported.json) as { labels: { path: string }[]; rules: { id: string; match: Record<string, string> }[] };
    expect(document.labels.map((label) => label.path)).toContain('项目/阿尔法');
    expect(exported.json).not.toContain('分拣');
    expect(document.rules.find((rule) => rule.id === 'bank-login')).toMatchObject({ match: { from_address: 'statements@bank.example.com' }, subject_includes: ['登录', 'login'], keep_in_inbox: true });
    // The Gmail filter export leaves out what a filter cannot do: trust labels, the carve-outs, and the shop's plain
    // rule, which in Gmail would label the pickup code and archive it (QA D1).
    const filters = await h.api.exportGmailFilters({});
    expect(filters).toMatchObject({ ruleCount: 1, skippedCount: 4 });
    expect(filters.xml).toContain("value='开发/CI通知'");
    expect(filters.xml).not.toContain('orders@shop.example.com');
  });

  it('confirming a rule’s suggestion keeps the mail in the inbox when the rule said so, though its label archives', async () => {
    await setLabelLive(h, 'shop-orders-shipping', false);
    const pickup = { ...MAILS.pickupZh, id: 'a0000000000000c1', subject: '取件码提醒：包裹已到驿站' };
    deliver(h, pickup, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, pickup.id)).toMatchObject({ outcome: 'suggested', decider: 'rule', label_id: 'shop-orders-shipping', keep_in_inbox: 1 });
    const [item] = await h.sql(`SELECT id FROM review WHERE message_id = ? AND state = 'pending'`, pickup.id);
    const before = h.up.gmail.calls.length;
    await h.api.confirmReviewItem({ name: `reviewItems/${String(item?.['id'])}`, requestId: op() });
    const orders = h.up.gmail.labelIdByName('购物/订单物流') ?? '';
    expect(gmailLabels(h, pickup.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', orders, 'UNREAD'].sort());
    const written = h.up.gmail.calls.slice(before).filter((call) => call.url.endsWith('/modify'));
    expect(written.map((call) => call.body)).toEqual([JSON.stringify({ addLabelIds: [orders] })]);
    await setLabelLive(h, 'shop-orders-shipping', true);
  });

  it('turning a label sensitive deletes the examples it has', async () => {
    // The correction above made the receipt an example of 购物/促销.
    expect((await h.api.listExamples({ label: 'labels/shop-promo' })).examples.length).toBe(1);
    await h.api.updateLabel({ label: create(LabelSchema, { name: 'labels/shop-promo', sensitive: true }), updateMask: { paths: ['sensitive'] }, requestId: op() });
    expect((await h.api.listExamples({ label: 'labels/shop-promo' })).examples).toEqual([]);
    expect(await h.sql(`SELECT count(*) AS n FROM examples WHERE label_id = 'shop-promo'`)).toEqual([{ n: 0 }]);
  });

  it('a deleted label’s ID is never given to a new label of the same path', async () => {
    const promo = await h.api.getLabel({ name: 'labels/shop-promo' });
    await h.api.deleteLabel({ name: promo.name, etag: promo.etag, requestId: op() });
    const again = await h.api.createLabel({ label: create(LabelSchema, { displayName: '购物/促销', description: '商家与金融机构的营销推广' }), requestId: op() });
    expect(again.name).toBe('labels/shop-promo-2');
    // The old ID keeps its history (the correction's counter) and an explicit reuse is refused.
    expect((await h.sql(`SELECT count(*) AS n FROM decisions WHERE verdict_label = 'shop-promo'`))[0]?.['n']).toBe(1);
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'shop-promo', label: create(LabelSchema, { displayName: '购物/旧促销' }), requestId: op() })))).toBe('LABEL_EXISTS');
  });

  it('a list rule needs the list domain’s own DKIM: a planted dkim=pass and a copied List-Id fire nothing', async () => {
    await h.api.createRule({ rule: create(RuleSchema, { kind: Rule_Kind.LIST_ID, value: 'digest.news.example.com', label: 'labels/subscriptions-receipts' }), requestId: op() });
    await setLabelLive(h, 'subscriptions-receipts', true);
    const before = modifies(h).length;
    deliver(h, MAILS.injectedListDkim, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect((await decision(h, MAILS.injectedListDkim.id))?.['decider']).not.toBe('rule');
    expect(gmailLabels(h, MAILS.injectedListDkim.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    expect(modifies(h).length).toBe(before);
    // The genuine list mail, signed by news.example.com, takes the rule.
    deliver(h, MAILS.newsletterEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.newsletterEn.id)).toMatchObject({ decider: 'rule', label_id: 'subscriptions-receipts', outcome: 'applied' });
  });

  it('a range undo filtered to one label undoes that label’s entries only (QA D9)', async () => {
    const applied = async (label: string) => Number((await h.sql(`SELECT count(*) AS n FROM ledger WHERE state = 'applied' AND label_id = ?`, label))[0]?.['n'] ?? 0);
    const others = await h.sql(`SELECT id FROM ledger WHERE state = 'applied' AND label_id != 'subscriptions-receipts' ORDER BY id`);
    expect(await applied('subscriptions-receipts')).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    const answer = await h.api.undoLedgerEntries({ startTime: timestampFromMs(T0), endTime: timestampFromMs(now + MINUTE), label: 'labels/subscriptions-receipts', requestId: op() });
    expect(answer).toMatchObject({ failedCount: 0, remainingCount: 0 });
    expect(answer.undoneCount).toBeGreaterThan(0);
    expect(await applied('subscriptions-receipts')).toBe(0);
    expect(await h.sql(`SELECT id FROM ledger WHERE state = 'applied' AND label_id != 'subscriptions-receipts' ORDER BY id`)).toEqual(others);
  });
});
