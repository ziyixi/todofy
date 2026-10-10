/**
 * Labels in workerd with a real SQLite MailsortState, the fake Gmail and the fake Workers AI (../../../docs/design.md §3,
 * §5, §10): nested labels created in Gmail with their parents, the mail getting only the leaf; a label that keeps its
 * mail in the inbox (UNREAD untouched, undo removing only the label); trust labels and their trusted domains (learned
 * from a review choice, removed with RemoveTrustedDomain, never borrowed by a forged or look-alike From); nested Gmail
 * labels adopted by the sync only, never imported; renames; the flow counters with corrections and the ledger's label
 * filter; sensitive labels and retired IDs. Every request Google got is checked against the independent table after
 * each test. All data is synthetic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Label_GmailState, LabelSchema } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { MAILS } from '../fakes/fixtures.ts';
import { MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, decision, deliver, gmailLabels, modifies, roomInReview, setMode } from './helpers.ts';

/** Synthetic labels with descriptions the fake model matches words of (../fakes/fake-ai.ts). */
const LABELS = [
  { path: '开发/CI通知', description: 'CI build passed failed main 构建' },
  { path: '账号安全', description: 'new login device account security 登录 设备', trust: true, keepInInbox: true },
  { path: '金融/银行支付', description: 'bank statement monthly 银行 对账单', trust: true },
  { path: '购物/订单物流', description: 'order receipt invoice shipped 订单 发货 发票' },
  { path: '购物/促销', description: 'promotion sale coupon discount 促销 优惠' },
  { path: '订阅收据', description: 'newsletter weekly digest posts 周报 订阅' },
] as const;

describe('labels: nested, kept in the inbox, trusted domains, Gmail labels, the flow', () => {
  let h: Harness;
  let now = T0;
  beforeAll(async () => {
    h = await startHarness();
    for (const label of LABELS) {
      await h.api.createLabel({
        label: create(LabelSchema, { displayName: label.path, description: label.description, enabled: true, trustImplying: 'trust' in label, keepInInbox: 'keepInInbox' in label }),
        requestId: op(),
      });
    }
    await roomInReview(h, now);
    await h.step(now);
  });
  afterAll(async () => {
    await h.dispose();
  });
  afterEach(() => {
    checkGoogleCalls(h);
  });

  it('gives each label an ID from its path and nothing in Gmail before its first write', async () => {
    const labels = (await h.api.listLabels({})).labels;
    expect(labels.map((label) => label.name)).toEqual(['labels/dev-ci-notices', 'labels/account-security', 'labels/finance-bank-pay', 'labels/shop-orders-shipping', 'labels/shop-promo', 'labels/subscriptions-receipts']);
    expect(labels.find((label) => label.displayName === '账号安全')).toMatchObject({ enabled: true, trustImplying: true, keepInInbox: true, trustedDomains: [] });
    expect(h.up.gmail.calls.filter((call) => call.method !== 'GET' && !call.url.includes('/token'))).toEqual([]);
  });

  it('a live write to a nested label creates its parents in Gmail; the mail gets only the leaf', async () => {
    await setMode(h, Mode.LIVE);
    deliver(h, MAILS.ciBuild, now);
    now += 5 * MINUTE;
    await h.step(now);
    const names = [...h.up.gmail.labels.values()].filter((label) => label.type === 'user').map((label) => label.name);
    // At Gmail's top level: the parent 开发 and the leaf, no root label.
    expect(names).toEqual(expect.arrayContaining(['开发', '开发/CI通知']));
    expect(names.some((name) => name === '分拣' || name.startsWith('分拣/'))).toBe(false);
    const leaf = h.up.gmail.labelIdByName('开发/CI通知') ?? '';
    expect(gmailLabels(h, MAILS.ciBuild.id)).toEqual(['CATEGORY_UPDATES', leaf, 'UNREAD'].sort());
    expect(await decision(h, MAILS.ciBuild.id)).toMatchObject({ outcome: 'applied', decider: 'clef', label_id: 'dev-ci-notices' });
    // The parents are never linked: the guard's owned set is the leaves only.
    expect((await h.api.getLabel({ name: 'labels/dev-ci-notices' })).gmailLabelId).toBe(leaf);
  });

  it('a trust label learns its domain from the owner\'s choice, and keeps its mail in the inbox; undo removes only the label', async () => {
    deliver(h, MAILS.bankLogin, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.bankLogin.id)).toMatchObject({ outcome: 'unsure', unsure_reason: 'untrusted_sender', top_label: 'account-security', shown: 1 });
    const [item] = await h.sql<{ id: string }>(`SELECT id FROM review WHERE message_id = ? AND state = 'pending'`, MAILS.bankLogin.id);
    const before = h.up.gmail.calls.length;
    await h.api.resolveReviewItem({ name: `reviewItems/${item?.id ?? ''}`, label: 'labels/account-security', requestId: op() });
    const security = h.up.gmail.labelIdByName('账号安全') ?? '';
    expect(gmailLabels(h, MAILS.bankLogin.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', security, 'UNREAD'].sort());
    const written = h.up.gmail.calls.slice(before).filter((call) => call.url.endsWith('/modify'));
    expect(written.map((call) => call.body)).toEqual([JSON.stringify({ addLabelIds: [security] })]);
    expect((await h.api.getLabel({ name: 'labels/account-security' })).trustedDomains).toEqual(['bank.example.com']);
    const [entry] = (await h.api.listLedgerEntries({ label: 'labels/account-security' })).ledgerEntries;
    expect(entry).toMatchObject({ messageId: MAILS.bankLogin.id, archived: false, origin: 'owner' });
    await h.api.undoLedgerEntry({ name: entry?.name ?? '', requestId: op() });
    expect(gmailLabels(h, MAILS.bankLogin.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    // The next login notice of that domain is confident: labelled, and kept in the inbox by its label.
    deliver(h, { ...MAILS.bankLogin, id: 'a0000000000000d1', subject: '新设备登录提醒 New login (2)' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'a0000000000000d1')).toMatchObject({ outcome: 'applied', label_id: 'account-security' });
    expect(gmailLabels(h, 'a0000000000000d1')).toEqual(['CATEGORY_UPDATES', 'INBOX', security, 'UNREAD'].sort());
  });

  it('a forged or look-alike From never borrows a trusted domain: uncertain, nothing written', async () => {
    const before = modifies(h).length;
    deliver(h, MAILS.forgedBankLogin, now);
    deliver(h, MAILS.lookalikeBank, now);
    // A dmarc=pass planted in a quoted envelope local part (Gmail repeats it in its spf comment) is not Gmail's result.
    deliver(h, MAILS.injectedDmarc, now);
    now += 5 * MINUTE;
    await h.step(now);
    for (const mail of [MAILS.forgedBankLogin, MAILS.lookalikeBank, MAILS.injectedDmarc]) {
      const row = await decision(h, mail.id);
      expect(row, mail.id).toMatchObject({ decider: 'clef', outcome: 'unsure' });
      expect(['untrusted_sender', 'suspicious'], mail.id).toContain(row?.['unsure_reason']);
      expect(gmailLabels(h, mail.id), mail.id).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
    }
    expect(modifies(h).length).toBe(before);
    // In 待审, what a trust label's answer would teach: the look-alike's own domain (its DMARC passed for that one),
    // which the question before such an answer names; a forged From (DMARC failed) teaches nothing.
    const teachable = async (id: string) => {
      const [row] = await h.sql<{ id: string }>(`SELECT id FROM review WHERE message_id = ? AND state = 'pending'`, id);
      return (await h.api.getReviewItem({ name: `reviewItems/${row?.id ?? ''}` })).teachableDomain;
    };
    expect(await teachable(MAILS.lookalikeBank.id)).toBe('bank-alerts.example.net');
    expect(await teachable(MAILS.forgedBankLogin.id)).toBe('');
    expect(await teachable(MAILS.injectedDmarc.id)).toBe('');
    const listed = (await h.api.listReviewItems({})).reviewItems.filter((item) => item.teachableDomain !== '');
    expect(listed.map((item) => [item.subject, item.teachableDomain])).toEqual([[MAILS.lookalikeBank.subject, 'bank-alerts.example.net']]);
  });

  it('RemoveTrustedDomain takes a domain off (etag and request ID honoured); the label then waits again', async () => {
    const label = await h.api.getLabel({ name: 'labels/account-security' });
    expect(reasonOf(await rejection(h.api.removeTrustedDomain({ name: label.name, domain: 'bank.example.com', etag: 'stale', requestId: op() })))).toBe('ETAG_MISMATCH');
    expect(reasonOf(await rejection(h.api.removeTrustedDomain({ name: label.name, domain: 'other.example.com', requestId: op() })))).toBe('NOT_FOUND');
    const requestId = op();
    const removed = await h.api.removeTrustedDomain({ name: label.name, domain: 'bank.example.com', etag: label.etag, requestId });
    expect(removed.trustedDomains).toEqual([]);
    expect(removed.etag).not.toBe(label.etag);
    expect(await h.api.removeTrustedDomain({ name: label.name, domain: 'bank.example.com', etag: label.etag, requestId })).toEqual(removed);
    deliver(h, { ...MAILS.bankLogin, id: 'a0000000000000d2', subject: '新设备登录提醒 New login (3)' }, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, 'a0000000000000d2')).toMatchObject({ outcome: 'unsure', unsure_reason: 'untrusted_sender' });
  });

  it('a receipt is labelled and archived; a pickup notice no label fits stays in the inbox untouched', async () => {
    deliver(h, MAILS.pickupZh, now);
    deliver(h, MAILS.receiptEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    const orders = h.up.gmail.labelIdByName('购物/订单物流') ?? '';
    expect(gmailLabels(h, MAILS.receiptEn.id)).toEqual(['CATEGORY_UPDATES', orders, 'UNREAD'].sort());
    expect(await decision(h, MAILS.pickupZh.id)).toMatchObject({ outcome: 'none' });
    expect(gmailLabels(h, MAILS.pickupZh.id)).toEqual(['CATEGORY_UPDATES', 'INBOX', 'UNREAD']);
  });

  it('the owner\'s Gmail label of a new label\'s exact path is never taken over at once: the sync adopts it, never its parent, and imports nothing', async () => {
    // The owner made 项目 and 项目/阿尔法 in Gmail by hand; a label of that path is created here in live mode.
    const parent = h.up.gmail.createUserLabel('项目');
    const leaf = h.up.gmail.createUserLabel('项目/阿尔法', true);
    h.up.gmail.createUserLabel('项目/贝塔');
    const before = h.up.gmail.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/labels')).length;
    const created = await h.api.createLabel({ label: create(LabelSchema, { displayName: '项目/阿尔法', description: '阿尔法项目的协作通知与周会纪要' }), requestId: op() });
    expect(created).toMatchObject({ gmailLabelId: '', gmailState: Label_GmailState.NAME_TAKEN });
    // Nothing created twice: no labels.create.
    expect(h.up.gmail.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/labels')).length).toBe(before);
    // Its ID comes from its path (a word outside the glossary as a short hash), never a random one.
    expect(created.name).toMatch(/^labels\/project-x[0-9a-f]{4}$/);
    // The owner's 从 Gmail 同步 adopts the leaf; their parent is neither linked nor recorded as ours.
    const result = await h.api.syncLabels({ requestId: op() });
    expect(result).toMatchObject({ linkedCount: 1 });
    expect(result.labels.find((label) => label.name === created.name)).toMatchObject({ gmailLabelId: leaf, gmailState: Label_GmailState.ADOPTED });
    expect(await h.sql(`SELECT count(*) AS n FROM gmail_parents WHERE gmail_id = ?`, parent)).toEqual([{ n: 0 }]);
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
    const ci = h.up.gmail.labels.get(h.up.gmail.labelIdByName('开发/CI通知') ?? '');
    if (ci === undefined) throw new Error('no CI label');
    ci.name = '临时/测试';
    const created = await h.api.createLabel({ label: create(LabelSchema, { displayName: '临时/测试', description: '只用于测试重名的标签' }), requestId: op() });
    expect(created).toMatchObject({ gmailLabelId: '', gmailState: Label_GmailState.NAME_TAKEN });
    const synced = await h.api.syncLabels({ requestId: op() });
    expect(synced).toMatchObject({ linkedCount: 0, renamedCount: 0 });
    expect(synced.labels.find((label) => label.name === 'labels/dev-ci-notices')).toMatchObject({ displayName: '开发/CI通知', gmailLabelId: ci.id });
    ci.name = '开发/CI通知';
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
    // The owner made 购物/促销 in Gmail by hand: the sync adopts it for the label of that path.
    const promo = h.up.gmail.createUserLabel('购物/促销', true);
    await h.api.syncLabels({ requestId: op() });
    h.up.gmail.ownerModify(MAILS.receiptEn.id, [promo], [shop]);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.receiptEn.id)).toMatchObject({ verdict: 'corrected', verdict_label: 'shop-promo' });
    const flow = await h.api.getMailFlow({ name: 'mailFlows/today' });
    const count = (stage: MailFlow_Stage, outcome: MailFlow_Outcome, label = '') =>
      flow.counts.filter((item) => item.stage === stage && item.outcome === outcome && item.label === label).reduce((sum, item) => sum + item.mailCount, 0);
    expect(count(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/dev-ci-notices')).toBe(1);
    expect(count(MailFlow_Stage.CLEF, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/account-security')).toBe(1);
    expect(count(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/shop-orders-shipping')).toBe(1);
    expect(count(MailFlow_Stage.CLEF, MailFlow_Outcome.CORRECTED, 'labels/shop-orders-shipping')).toBe(1);
    // The uncertain mails (the first login notice, the forged ones, the one after the removal) fill the day's quota.
    expect(count(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE_SHOWN)).toBe(5);
    expect(count(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE)).toBe(0);
    expect(flow.startTime !== undefined && flow.endTime !== undefined).toBe(true);
    expect((await h.api.getMailFlow({ name: 'mailFlows/last-30-days' })).counts.length).toBe(flow.counts.length);
    expect(reasonOf(await rejection(h.api.getMailFlow({ name: 'mailFlows/forever' })))).toBe('NOT_FOUND');
    const entries = (await h.api.listLedgerEntries({ label: 'labels/shop-orders-shipping' })).ledgerEntries;
    expect(entries.map((entry) => entry.messageId)).toEqual([MAILS.receiptEn.id]);
    // The label report of the week: the corrected receipt under 订单物流, the login notices under 账号安全.
    const report = await h.api.getLabelReport({ name: 'labelReport' });
    expect(report.labels.find((row) => row.label === 'labels/shop-orders-shipping')).toMatchObject({ autoCount: 1, gmailCorrectionCount: 1, reviewCorrectionCount: 0 });
    expect(report.labels.find((row) => row.label === 'labels/account-security')).toMatchObject({ autoCount: 1, unsureCount: 4, shownCount: 4, reviewCorrectionCount: 0 });
    expect(report).toMatchObject({ unsureCount: 5, shownCount: 5 });
  });

  it('turning a label sensitive deletes the examples it has', async () => {
    // The correction above made the receipt an example of 购物/促销.
    expect((await h.api.listExamples({ label: 'labels/shop-promo' })).examples.length).toBe(1);
    await h.api.updateLabel({ label: create(LabelSchema, { name: 'labels/shop-promo', sensitive: true }), updateMask: { paths: ['sensitive'] }, requestId: op() });
    expect((await h.api.listExamples({ label: 'labels/shop-promo' })).examples).toEqual([]);
    expect(await h.sql(`SELECT count(*) AS n FROM examples WHERE label_id = 'shop-promo'`)).toEqual([{ n: 0 }]);
  });

  it('a deleted label’s ID is never given to a new label of the same path, and its trusted domains go with it', async () => {
    await h.sql(`INSERT INTO trusted_domains (label_id, domain, origin, create_time) VALUES ('shop-promo', 'promo.example.com', 'owner', 1)`);
    const promo = await h.api.getLabel({ name: 'labels/shop-promo' });
    expect(promo.trustedDomains).toEqual(['promo.example.com']);
    await h.api.deleteLabel({ name: promo.name, etag: promo.etag, requestId: op() });
    expect(await h.sql(`SELECT count(*) AS n FROM trusted_domains WHERE label_id = 'shop-promo'`)).toEqual([{ n: 0 }]);
    const again = await h.api.createLabel({ label: create(LabelSchema, { displayName: '购物/促销', description: '商家与金融机构的营销推广' }), requestId: op() });
    expect(again.name).toBe('labels/shop-promo-2');
    // The old ID keeps its history (the correction's counter) and an explicit reuse is refused.
    expect((await h.sql(`SELECT count(*) AS n FROM decisions WHERE verdict_label = 'shop-promo'`))[0]?.['n']).toBe(1);
    expect(reasonOf(await rejection(h.api.createLabel({ labelId: 'shop-promo', label: create(LabelSchema, { displayName: '购物/旧促销' }), requestId: op() })))).toBe('LABEL_EXISTS');
  });

  it('a range undo filtered to one label undoes that label’s entries only', async () => {
    const applied = async (label: string) => Number((await h.sql(`SELECT count(*) AS n FROM ledger WHERE state = 'applied' AND label_id = ?`, label))[0]?.['n'] ?? 0);
    deliver(h, MAILS.newsletterEn, now);
    now += 5 * MINUTE;
    await h.step(now);
    expect(await decision(h, MAILS.newsletterEn.id)).toMatchObject({ decider: 'clef', label_id: 'subscriptions-receipts', outcome: 'applied' });
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
