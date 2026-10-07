/**
 * Label paths (nesting, the tree rule, the IDs and option keys derived from a path), the built-in template, the import
 * plan and its application, the export's round trip, the schema migrations and the flow counters, over the
 * store's own SQL on Node's SQLite (./fakes/sql.ts). Every rule value and address is synthetic (example.* domains).
 */
import { describe, expect, it } from 'vitest';
import { countFlow, readFlow } from '../src/flow.ts';
import { applyImport, exportDocument, foldTerms, planImport, planValid, templateLabels, type LabelInput, type RuleInput } from '../src/import.ts';
import { DAY, LEGACY_LABEL_PREFIX } from '../src/limits.ts';
import { labelIdFor, normalizePath, optionKeys, ownerPath, parentGmailNames, pathOfGmailName, pathSlug, treeConflict } from '../src/paths.ts';
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, Store } from '../src/store.ts';
import { LABEL_TEMPLATE } from '../src/template.ts';
import { memorySql } from './fakes/sql.ts';

const T0 = Date.parse('2026-10-06T08:00:00Z');

function store(): Store {
  const s = new Store(memorySql());
  s.migrate();
  return s;
}

/** A rule entry of the owner's rule file format, with the defaults the file writes. */
function entry(id: string, match: Partial<NonNullable<RuleInput['match']>>, label: string, extra: Partial<RuleInput> = {}): RuleInput {
  return {
    id,
    match: { fromAddress: '', fromDomain: '', listId: '', toAddress: '', ...match },
    label,
    keepInInbox: false,
    trust: false,
    requireDmarc: false,
    evidence: '',
    notes: '',
    subjectIncludes: [],
    subjectExcludes: [],
    ...extra,
  };
}

function labelEntry(path: string, extra: Partial<LabelInput> = {}): LabelInput {
  return { path, description: '', trust: false, keepInInbox: false, sensitive: false, threshold: 0, enabled: null, ...extra };
}

describe('label paths', () => {
  it('normalizes up to three segments and refuses the rest', () => {
    expect(normalizePath(' 开发 / CI通知 ')).toBe('开发/CI通知');
    expect(normalizePath('出行')).toBe('出行');
    expect(normalizePath('a/b/c')).toBe('a/b/c');
    for (const bad of ['', '/', 'a//b', 'a/', 'a/b/c/d', 'x'.repeat(41), 'a\u0007', 'a\u0085b']) expect(normalizePath(bad), JSON.stringify(bad)).toBeNull();
    // A Gmail name is a label's path as it is: only the normalized spelling.
    expect(pathOfGmailName('金融/投资')).toBe('金融/投资');
    expect(pathOfGmailName('金融/ 投资')).toBeNull();
    expect(pathOfGmailName('出行 ')).toBeNull();
    expect(pathOfGmailName('a/b/c/d')).toBeNull();
    expect(parentGmailNames('开发/CI通知')).toEqual(['开发']);
    expect(parentGmailNames('生活/汽车/保养')).toEqual(['生活', '生活/汽车']);
    expect(parentGmailNames('出行')).toEqual([]);
  });

  it('reads the legacy prefix as nothing: 分拣/x is x at every entry point, and 分拣 is no first segment (QA D7)', () => {
    for (const bad of ['分拣', '分拣/x', ' 分拣 /x']) expect(normalizePath(bad), bad).toBeNull();
    expect(normalizePath('分拣箱/x')).toBe('分拣箱/x');
    expect(ownerPath('分拣/金融/投资')).toBe('金融/投资');
    expect(ownerPath(' 金融/投资 ')).toBe('金融/投资');
    expect(ownerPath('分拣/分拣/x')).toBeNull();
    expect(ownerPath('分拣')).toBeNull();
    expect(ownerPath('分拣/')).toBeNull();
    // A legacy Gmail name is not a path: SyncLabels never takes `分拣/x` for a rename to it.
    expect(pathOfGmailName('分拣/金融/投资')).toBeNull();
    expect(pathOfGmailName('分拣/分拣/x')).toBeNull();
    // The import reads a rule's label the same way: one legacy prefix at most, and with or without it the same label.
    const s = store();
    const plan = planImport(s, [], [entry('twice', { fromAddress: 'a@example.com' }, '分拣/分拣/x')]);
    expect(plan.rules[0]).toMatchObject({ action: 'invalid', problem: 'label_path' });
    applyImport(s, planImport(s, [], [entry('plain', { fromAddress: 'a@example.com' }, '金融/投资')]), T0);
    expect(s.labels().map((row) => row.display_name)).toEqual(['金融/投资']);
    expect(planImport(s, [], [entry('plain', { fromAddress: 'a@example.com' }, `${LEGACY_LABEL_PREFIX}金融/投资`)]).rules[0]?.action).toBe('skip');
  });

  it('keeps only leaves as labels: a parent and its child cannot both be labels', () => {
    expect(treeConflict('金融', ['金融/投资'])).toBe('金融/投资');
    expect(treeConflict('金融/投资/股票', ['金融/投资'])).toBe('金融/投资');
    expect(treeConflict('金融/银行支付', ['金融/投资', '金融'])).toBe('金融');
    expect(treeConflict('金融/银行支付', ['金融/投资'])).toBeNull();
    // A shared prefix of characters is not a parent.
    expect(treeConflict('金融投资', ['金融'])).toBeNull();
  });

  it('derives meaningful, stable IDs and option keys from a path', () => {
    expect(LABEL_TEMPLATE.map((item) => pathSlug(item.path))).toEqual([
      'dev-ci-notices',
      'dev-platform-tools',
      'finance-invest',
      'finance-bank-pay',
      'account-security',
      'gov-legal',
      'shop-orders-shipping',
      'shop-promo',
      'subscriptions-receipts',
      'travel',
      'life-bills-housing',
      'life-car',
      'life-health',
      'jobs',
      'school-community',
    ]);
    // The words of a personal mailbox's own labels are in the glossary (QA D8).
    expect(pathSlug('家人')).toBe('family');
    expect(pathSlug('报税')).toBe('tax-filing');
    expect(pathSlug('测试/一')).toBe('test-one');
    expect(pathSlug('学术会议')).toBe('academic-meetings');
    expect(pathSlug('项目/阿尔法')).toMatch(/^project-x[0-9a-f]{4}$/);
    // A word outside the glossary becomes a stable short hash, never a random ID; the known words around it stay.
    expect(pathSlug('猫咪')).toMatch(/^x[0-9a-f]{4}$/);
    expect(pathSlug('金融/猫咪')).toMatch(/^finance-x[0-9a-f]{4}$/);
    expect(pathSlug('猫咪')).toBe(pathSlug('猫咪'));
    expect(pathSlug('none')).toBe('none-label');
    expect(labelIdFor('出行', new Set(['travel']))).toBe('travel-2');
    const keys = optionKeys([
      { id: 'a', path: '出行' },
      { id: 'b', path: '旅行' },
      { id: 'c', path: '金融/投资' },
    ]);
    expect([...keys.values()]).toEqual(['travel', 'travel-2', 'finance-invest']);
  });
});

describe('the template', () => {
  it('has 15 two-level labels with one-language descriptions of 60-120 characters', () => {
    expect(LABEL_TEMPLATE).toHaveLength(15);
    const paths = LABEL_TEMPLATE.map((item) => item.path);
    expect(new Set(paths).size).toBe(15);
    for (const item of LABEL_TEMPLATE) {
      expect(normalizePath(item.path), item.path).toBe(item.path);
      expect(item.path.split('/').length).toBeLessThanOrEqual(2);
      expect(treeConflict(item.path, paths), item.path).toBeNull();
      const length = Array.from(item.description).length;
      expect(length, item.path).toBeGreaterThanOrEqual(60);
      expect(length, item.path).toBeLessThanOrEqual(120);
      // One language: Chinese, no Latin words.
      expect(item.description, item.path).not.toMatch(/[A-Za-z]/);
    }
  });

  it('marks trust, keep-in-inbox and sensitive as the owner asked; trust labels are transactional', () => {
    const flags = (pick: (item: (typeof LABEL_TEMPLATE)[number]) => boolean) => LABEL_TEMPLATE.filter(pick).map((item) => item.path);
    expect(flags((item) => item.trust)).toEqual(['金融/投资', '金融/银行支付', '账号安全', '政府法律', '生活/医疗']);
    expect(flags((item) => item.keepInInbox)).toEqual(['账号安全', '政府法律']);
    expect(flags((item) => item.sensitive)).toEqual(['生活/医疗']);
    const promo = LABEL_TEMPLATE.find((item) => item.path === '购物/促销');
    expect(promo?.description).toMatch(/银行.*券商.*推广/);
    for (const path of ['金融/投资', '金融/银行支付']) expect(LABEL_TEMPLATE.find((item) => item.path === path)?.description).toMatch(/不含.*营销推广/);
  });

  it('imports into an empty store: 15 labels, enabled, not live, no rule', () => {
    const s = store();
    const plan = planImport(s, templateLabels(), []);
    expect(planValid(plan)).toBe(true);
    expect(plan.labels.map((item) => item.action)).toEqual(Array(15).fill('create'));
    applyImport(s, plan, T0);
    const rows = s.labels();
    expect(rows).toHaveLength(15);
    expect(rows.every((row) => row.enabled === 1 && row.live === 0 && row.gmail_state === 'pending')).toBe(true);
    expect(rows.find((row) => row.display_name === '账号安全')).toMatchObject({ id: 'account-security', trust: 1, keep_in_inbox: 1 });
    expect(rows.find((row) => row.display_name === '生活/医疗')).toMatchObject({ id: 'life-health', trust: 1, sensitive: 1 });
    // A second click changes nothing.
    expect(planImport(s, templateLabels(), []).labels.every((item) => item.action === 'skip')).toBe(true);
  });

  it('keeps a threshold the owner tuned; turning a label sensitive deletes its examples, and the preview says so', () => {
    const s = store();
    applyImport(s, planImport(s, templateLabels(), []), T0);
    s.run(`UPDATE labels SET threshold = 0.93, sensitive = 0 WHERE id = 'life-health'`);
    s.run(`INSERT INTO examples (id, label_id, summary, origin, message_id, embedding, create_time) VALUES ('e1', 'life-health', 'synthetic summary', 'confirmation', 'm1', ?, ?)`, new Float32Array([1, 0]).buffer, T0);
    s.run(`INSERT INTO examples (id, label_id, summary, origin, message_id, create_time) VALUES ('e2', 'travel', 'synthetic trip', 'confirmation', 'm2', ?)`, T0);
    const plan = planImport(s, templateLabels(), []);
    const health = plan.labels.find((item) => item.id === 'life-health');
    expect(health).toMatchObject({ action: 'update', changed: ['sensitive'], warning: 'examples_deleted' });
    expect(health?.values.threshold).toBe(0.93);
    applyImport(s, plan, T0 + 1);
    expect(s.label('life-health')).toMatchObject({ threshold: 0.93, sensitive: 1 });
    expect(s.all(`SELECT id FROM examples ORDER BY id`)).toEqual([{ id: 'e2' }]);
    // A label file that names a threshold still sets it.
    const tuned = planImport(s, [labelEntry('出行', { threshold: 0.9, description: s.label('travel')?.description ?? '' })], []);
    expect(tuned.labels[0]).toMatchObject({ action: 'update', changed: ['threshold'] });
  });

  it('never gives a new label the ID of a deleted one (its history still names it)', () => {
    const s = store();
    applyImport(s, planImport(s, [labelEntry('金融/投资')], []), T0);
    s.run(`DELETE FROM labels WHERE id = 'finance-invest'`);
    s.run(`INSERT INTO retired_labels (id, retire_time) VALUES ('finance-invest', ?)`, T0);
    const again = planImport(s, [labelEntry(`${LEGACY_LABEL_PREFIX}金融/投资`)], []);
    expect(again.labels[0]).toMatchObject({ action: 'create', id: 'finance-invest-2' });
    expect(labelIdFor('Finance/Invest', s.takenLabelIds())).toBe('finance-invest-2');
    // Free again once nothing kept can name it.
    s.prune(T0 + 402 * DAY);
    expect(s.takenLabelIds().has('finance-invest')).toBe(false);
  });
});

describe('importing the owner’s rule file', () => {
  // In the file's own format: its labels still carry the legacy `分拣/` prefix.
  const file = (): RuleInput[] => [
    entry('ci-builds', { fromAddress: 'Builds@CI.example.com' }, '分拣/开发/CI通知', { evidence: 'every build mail', notes: 'synthetic' }),
    entry('broker-login', { fromDomain: 'broker.example.com' }, '分拣/账号安全', { trust: true, keepInInbox: true, subjectIncludes: ['登录', 'Login Code'] }),
    entry('broker', { fromDomain: 'broker.example.com' }, '分拣/金融/投资', { trust: true, subjectExcludes: ['登录'] }),
    entry('pickup', { fromAddress: 'notice@parcel.example.cn' }, '分拣/购物/订单物流', { keepInInbox: true, subjectIncludes: ['取件码'] }),
    entry('digest', { listId: 'digest.news.example.com' }, '分拣/订阅收据', { requireDmarc: true }),
    entry('alias', { toAddress: 'shop-alias@example.com' }, '分拣/购物/促销'),
  ];

  it('previews creates for every rule and the labels they name, and applies them in one go', () => {
    const s = store();
    const plan = planImport(s, [], file());
    expect(planValid(plan)).toBe(true);
    expect(plan.labels.map((item) => [item.key, item.action, item.values.trust])).toEqual([
      ['开发/CI通知', 'create', false],
      ['账号安全', 'create', true],
      ['金融/投资', 'create', true],
      ['购物/订单物流', 'create', false],
      ['订阅收据', 'create', false],
      ['购物/促销', 'create', false],
    ]);
    expect(plan.rules.map((item) => item.action)).toEqual(Array(6).fill('create'));
    // The preview wrote nothing.
    expect(s.labels()).toEqual([]);
    const applied = applyImport(s, plan, T0);
    expect(applied.rules.map((item) => item.id)).toEqual(['ci-builds', 'broker-login', 'broker', 'pickup', 'digest', 'alias']);
    const login = s.rule('broker-login');
    expect(login).toMatchObject({ kind: 'sender_domain', value: 'broker.example.com', state: 'active', keep_in_inbox: 1, import_id: 'broker-login', label_id: 'account-security' });
    expect(JSON.parse(login?.subject_includes ?? '')).toEqual(['登录', 'login code']);
    expect(s.rule('ci-builds')).toMatchObject({ value: 'builds@ci.example.com', evidence: 'every build mail', notes: 'synthetic' });
    expect(s.rule('digest')).toMatchObject({ kind: 'list_id', require_dmarc: 1 });
    expect(s.rule('alias')).toMatchObject({ kind: 'delivered_to' });
    // Labels only a rule names come without a description, so the model is never offered them bare.
    expect(s.labels().every((row) => row.description === '' && row.enabled === 1 && row.live === 0)).toBe(true);
    // The file's order breaks ties between rules of the same rank.
    expect((s.rule('broker-login')?.create_time ?? 0) < (s.rule('broker')?.create_time ?? 0)).toBe(true);
  });

  it('skips what is unchanged and updates what differs on a second import', () => {
    const s = store();
    applyImport(s, planImport(s, [], file()), T0);
    expect(planImport(s, [], file()).rules.every((item) => item.action === 'skip')).toBe(true);
    const changed = file();
    changed[0] = entry('ci-builds', { fromAddress: 'builds@ci.example.com' }, '分拣/开发/CI通知', { evidence: 'every build mail', notes: 'synthetic', keepInInbox: true });
    const plan = planImport(s, [], changed);
    expect(plan.rules[0]).toMatchObject({ action: 'update', id: 'ci-builds', changed: ['keep_in_inbox'] });
    applyImport(s, plan, T0 + 1000);
    expect(s.rule('ci-builds')?.keep_in_inbox).toBe(1);
  });

  it('refuses every invalid entry, says why, and applies nothing', () => {
    const s = store();
    const bad: RuleInput[] = [
      entry('ok', { fromAddress: 'a@example.com' }, '订阅收据'),
      entry('plain-path', { fromAddress: 'b@example.com' }, '订阅收据'),
      entry('two-keys', { fromAddress: 'c@example.com', fromDomain: 'example.com' }, '订阅收据'),
      entry('no-key', {}, '订阅收据'),
      entry('hostile', { listId: 'x)or(from:*' }, '订阅收据'),
      entry('deep', { fromAddress: 'd@example.com' }, 'a/b/c/d'),
      entry('many', { fromAddress: 'e@example.com' }, '订阅收据', { subjectIncludes: Array.from({ length: 9 }, (_, i) => `w${String(i)}`) }),
      entry('ok', { fromAddress: 'f@example.com' }, '订阅收据'),
      entry('bad id!', { fromAddress: 'g@example.com' }, '订阅收据'),
      entry('long', { fromAddress: 'h@example.com' }, '订阅收据', { notes: 'n'.repeat(301) }),
    ];
    const plan = planImport(s, [], bad);
    expect(planValid(plan)).toBe(false);
    expect(plan.rules.map((item) => item.problem)).toEqual(['', '', 'match', 'match', 'value', 'label_path', 'subject', 'duplicate', 'rule_id', 'text']);
    expect(foldTerms(['', 'x'])).toBeNull();
    expect(foldTerms(['ＡＢ', 'ab'])).toEqual(['ab']);
  });

  it('accepts multi-line evidence and notes and a List-Id in its header form (QA D4)', () => {
    const s = store();
    const plan = planImport(s, [labelEntry('订阅收据', { description: '第一行\r\n第二行' })], [
      entry('multi', { fromAddress: 'a@example.com' }, '订阅收据', { evidence: 'line1\nline2', notes: 'a\r\nb\rc' }),
      entry('bracket', { listId: ' <Digest.News.example.com> ' }, '订阅收据'),
      entry('bell', { fromAddress: 'b@example.com' }, '订阅收据', { evidence: 'ding\u0007' }),
      entry('tab', { fromAddress: 'c@example.com' }, '订阅收据', { notes: 'a\tb' }),
      entry('half', { listId: '<digest.example.com' }, '订阅收据'),
    ]);
    expect(plan.rules.map((item) => [item.key, item.action, item.problem])).toEqual([
      ['multi', 'create', ''],
      ['bracket', 'create', ''],
      ['bell', 'invalid', 'text'],
      ['tab', 'invalid', 'text'],
      ['half', 'invalid', 'value'],
    ]);
    const valid = planImport(s, [labelEntry('订阅收据', { description: '第一行\r\n第二行' })], [
      entry('multi', { fromAddress: 'a@example.com' }, '订阅收据', { evidence: 'line1\nline2', notes: 'a\r\nb\rc' }),
      entry('bracket', { listId: ' <Digest.News.example.com> ' }, '订阅收据'),
    ]);
    applyImport(s, valid, T0);
    expect(s.rule('multi')).toMatchObject({ evidence: 'line1\nline2', notes: 'a\nb\nc' });
    expect(s.rule('bracket')).toMatchObject({ kind: 'list_id', value: 'digest.news.example.com' });
    expect(s.labels()[0]?.description).toBe('第一行\n第二行');
    // The header form of an existing rule's List-Id is the same rule: a re-import skips it.
    expect(planImport(s, [], [entry('bracket', { listId: 'digest.news.example.com' }, '订阅收据')]).rules[0]?.action).toBe('skip');
  });

  it('keeps a disabled label disabled through an export and an import into a fresh store, and through the template (QA D10)', () => {
    const s = store();
    applyImport(s, planImport(s, templateLabels(), []), T0);
    s.run(`UPDATE labels SET enabled = 0 WHERE id = 'travel'`);
    const document = JSON.parse(exportDocument(s).json) as { labels: { path: string; enabled: boolean }[] };
    expect(document.labels.find((item) => item.path === '出行')?.enabled).toBe(false);
    expect(document.labels.filter((item) => item.enabled)).toHaveLength(14);
    // The template names no switch: the owner's choice stands.
    expect(planImport(s, templateLabels(), []).labels.every((item) => item.action === 'skip')).toBe(true);
    const fresh = store();
    applyImport(fresh, planImport(fresh, document.labels.map((item) => labelEntry(item.path, { enabled: item.enabled })), []), T0);
    expect(fresh.labels().find((row) => row.display_name === '出行')?.enabled).toBe(0);
    expect(fresh.labels().filter((row) => row.enabled === 1)).toHaveLength(14);
    // An entry with the switch updates an existing label's; one without keeps it.
    const enabling = planImport(fresh, [labelEntry('出行', { enabled: true })], []).labels[0];
    expect(enabling?.action).toBe('update');
    expect(enabling?.changed).toContain('enabled');
    expect(planImport(fresh, [labelEntry(`${LEGACY_LABEL_PREFIX}出行`)], []).labels[0]?.changed).not.toContain('enabled');
  });

  it('keeps the tree: a label may not become the parent of another', () => {
    const s = store();
    const plan = planImport(s, [labelEntry('金融', { description: '金融类邮件' })], [entry('x', { fromAddress: 'a@example.com' }, '金融/投资')]);
    expect(plan.labels.map((item) => [item.key, item.problem])).toEqual([
      ['金融', 'label_tree'],
      ['金融/投资', 'label_tree'],
    ]);
  });

  it('warns about a trust rule whose label does not imply trust, and two rules with the same match', () => {
    const s = store();
    const plan = planImport(
      s,
      [labelEntry('购物/促销', { description: '营销邮件' })],
      [entry('a', { fromDomain: 'bank.example.com' }, '购物/促销', { trust: true }), entry('b', { fromDomain: 'bank.example.com' }, '订阅收据')],
    );
    expect(plan.rules.map((item) => item.warning)).toEqual(['trust_mismatch', 'same_match']);
    expect(planValid(plan)).toBe(true);
  });

  it('round-trips through the export: everything skips', () => {
    const s = store();
    applyImport(s, planImport(s, templateLabels(), []), T0);
    applyImport(s, planImport(s, [], file()), T0);
    const { json, labels, rules } = exportDocument(s);
    // The file names only labels the template has.
    expect(labels).toBe(15);
    expect(rules).toBe(6);
    const document = JSON.parse(json) as { labels: { path: string; description: string; trust: boolean; keep_in_inbox: boolean; sensitive: boolean; threshold: number }[]; rules: { id: string; match: Record<string, string>; label: string; keep_in_inbox: boolean; trust: boolean; require_dmarc: boolean; evidence: string; notes: string; subject_includes?: string[]; subject_excludes?: string[] }[] };
    // The file says `分拣/账号安全` (the legacy prefix); the export writes the path alone.
    expect(document.rules[1]).toEqual({ id: 'broker-login', match: { from_domain: 'broker.example.com' }, label: '账号安全', keep_in_inbox: true, trust: true, require_dmarc: false, evidence: '', notes: '', subject_includes: ['登录', 'login code'] });
    expect(document.labels.map((item) => item.path)).toEqual(LABEL_TEMPLATE.map((item) => item.path));
    expect(json).not.toContain(LEGACY_LABEL_PREFIX);
    const again = planImport(
      s,
      document.labels.map((item) => labelEntry(item.path, { description: item.description, trust: item.trust, keepInInbox: item.keep_in_inbox, sensitive: item.sensitive, threshold: item.threshold })),
      document.rules.map((item) =>
        entry(item.id, { fromAddress: item.match['from_address'] ?? '', fromDomain: item.match['from_domain'] ?? '', listId: item.match['list_id'] ?? '', toAddress: item.match['to_address'] ?? '' }, item.label, {
          keepInInbox: item.keep_in_inbox,
          trust: item.trust,
          requireDmarc: item.require_dmarc,
          evidence: item.evidence,
          notes: item.notes,
          subjectIncludes: item.subject_includes ?? [],
          subjectExcludes: item.subject_excludes ?? [],
        }),
      ),
    );
    expect([...again.labels, ...again.rules].map((item) => item.action).filter((action) => action !== 'skip')).toEqual([]);
  });
});

describe('the store', () => {
  it('migrates a version 1 database: its rules are kept, with the new columns at their defaults', () => {
    const sql = memorySql();
    for (const statement of SCHEMA_V1) sql.exec(statement);
    sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`);
    sql.exec(`INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time) VALUES ('r1', 'list_id', 'digest.news.example.com', 'newsletter', 'active', 1, 1)`);
    const s = new Store(sql);
    s.migrate();
    expect(s.getMeta('schema_version')).toBe('4');
    expect(s.rule('r1')).toMatchObject({ kind: 'list_id', subject_includes: '[]', keep_in_inbox: 0, require_dmarc: 0, import_id: '' });
    expect(SCHEMA_V2.length).toBeGreaterThan(0);
    // A carve-out and a plain rule of one sender to one label are two rules now.
    s.run(`INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time, subject_includes) VALUES ('r2', 'list_id', 'digest.news.example.com', 'newsletter', 'active', 1, 1, '["x"]')`);
    expect(s.count(`SELECT count(*) AS n FROM rules`)).toBe(2);
  });

  it('migrates a version 2 database to 3: the record of the parents this app created in Gmail', () => {
    const sql = memorySql();
    for (const statement of [...SCHEMA_V1, ...SCHEMA_V2]) sql.exec(statement);
    sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '2')`);
    const s = new Store(sql);
    s.migrate();
    expect(s.getMeta('schema_version')).toBe('4');
    expect(SCHEMA_V3.length).toBe(1);
    s.run(`INSERT INTO gmail_parents (gmail_id, create_time) VALUES ('Label_9', 1)`);
    expect(s.count(`SELECT count(*) AS n FROM gmail_parents`)).toBe(1);
    // Migrating again changes nothing.
    s.migrate();
    expect(s.count(`SELECT count(*) AS n FROM gmail_parents`)).toBe(1);
  });

  it('migrates a version 3 database to 4: its labels and rules are kept as they are, none adopted or name-taken', () => {
    const sql = memorySql();
    for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3]) sql.exec(statement);
    sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '3')`);
    // The live store's shape: the template's labels, none in Gmail yet, and rules naming them by ID.
    for (const [i, item] of LABEL_TEMPLATE.entries()) {
      sql.exec(
        `INSERT INTO labels (id, seq, display_name, description, enabled, trust, gmail_state, create_time, update_time, etag, keep_in_inbox, sensitive) VALUES (?, ?, ?, ?, 1, ?, 'pending', 1, 1, 'e', ?, ?)`,
        `l${String(i)}`,
        i + 1,
        item.path,
        item.description,
        item.trust ? 1 : 0,
        item.keepInInbox ? 1 : 0,
        item.sensitive ? 1 : 0,
      );
    }
    sql.exec(`INSERT INTO labels (id, seq, display_name, gmail_id, gmail_state, create_time, update_time, etag) VALUES ('linked', 99, '已建', 'Label_5', 'linked', 1, 1, 'e')`);
    sql.exec(`INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time, import_id) VALUES ('r1', 'sender_address', 'builds@ci.example.com', 'l0', 'active', 1, 1, 'ci-builds')`);
    const before = sql.exec(`SELECT * FROM labels ORDER BY seq`).toArray();
    const s = new Store(sql);
    s.migrate();
    expect(s.getMeta('schema_version')).toBe('4');
    expect(SCHEMA_V4.length).toBe(2);
    const after = s.labels();
    expect(after.map(({ gmail_adopted: adopted, gmail_name_taken: taken, ...row }) => [row, adopted, taken])).toEqual(before.map((row) => [row, 0, 0]));
    expect(after.some((row) => row.display_name.startsWith(LEGACY_LABEL_PREFIX))).toBe(false);
    expect(s.rule('r1')).toMatchObject({ label_id: 'l0', import_id: 'ci-builds' });
    expect(s.ownedGmailIds()).toEqual(new Set(['Label_5']));
    // Migrating again changes nothing.
    s.migrate();
    expect(s.labels()).toEqual(after);
  });

  it('counts the flow per UTC day, never below zero, and reads a range of days', () => {
    const s = store();
    countFlow(s, T0, 'rule', 'archived', 'travel');
    countFlow(s, T0, 'rule', 'archived', 'travel');
    countFlow(s, T0 - DAY, 'clef', 'unsure', null);
    countFlow(s, T0 - 10 * DAY, 'clef', 'suggested', 'travel');
    countFlow(s, T0, 'clef', 'kept_in_inbox', 'travel', -1);
    expect(readFlow(s, 1, T0).counts).toEqual([
      { stage: 'clef', outcome: 'kept_in_inbox', label: 'travel', n: 0 },
      { stage: 'rule', outcome: 'archived', label: 'travel', n: 2 },
    ].filter((row) => row.n > 0));
    expect(readFlow(s, 7, T0).counts).toHaveLength(2);
    expect(readFlow(s, 30, T0).counts).toHaveLength(3);
    const { start, end } = readFlow(s, 7, T0);
    expect(end - start).toBe(7 * DAY);
    expect(new Date(end).toISOString()).toBe('2026-10-07T00:00:00.000Z');
    // Pruned after 400 days, with the usage.
    s.prune(T0 + 401 * DAY);
    expect(readFlow(s, 30, T0).counts).toEqual([]);
  });
});

describe('retention', () => {
  it('drops a review item 14 days after its mail came, even when it was queued later', () => {
    const s = store();
    const queue = (id: string, receive: number, create: number): void => {
      s.run(
        `INSERT INTO review (id, message_id, kind, state, decider, subject, sender, receive_time, create_time) VALUES (?, ?, 'audit', 'pending', 'model', 's', 'f', ?, ?)`,
        id, `m-${id}`, receive, create,
      );
    };
    queue('fresh', T0, T0);
    // An audit sample of mail three days old, and a failed write's suggestion of mail ten days old.
    queue('audit', T0 - 3 * DAY, T0);
    queue('late', T0 - 10 * DAY, T0);
    // Each goes 14 days after its mail came, though all three were queued at T0.
    s.prune(T0 + 5 * DAY);
    expect(s.all(`SELECT id FROM review ORDER BY id`)).toEqual([{ id: 'audit' }, { id: 'fresh' }]);
    s.prune(T0 + 12 * DAY);
    expect(s.all(`SELECT id FROM review ORDER BY id`)).toEqual([{ id: 'fresh' }]);
    s.prune(T0 + 15 * DAY);
    expect(s.all(`SELECT id FROM review ORDER BY id`)).toEqual([]);
  });
});
