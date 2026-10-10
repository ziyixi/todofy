/**
 * The store over its own SQL on Node's SQLite (./fakes/sql.ts): label paths (nesting, the tree rule, the IDs and option
 * keys derived from a path), the schema's migrations (version 5 seeds the trusted domains from the rules and then drops
 * them, in one transaction), the trusted domains, the flow counters and the retention cleanup. Every address and
 * domain is synthetic (example.* domains; the public mailbox providers only by their domain names, as the denylist
 * holds them).
 */
import { describe, expect, it } from 'vitest';
import { countFlow, readFlow } from '../src/flow.ts';
import { DAY, TRUSTED_DOMAINS_PER_LABEL_MAX } from '../src/limits.ts';
import { senderHash } from '../src/mask.ts';
import { labelIdFor, normalizePath, optionKeys, ownerPath, parentGmailNames, pathOfGmailName, pathSlug, treeConflict } from '../src/paths.ts';
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, senderHashesToBackfill, Store } from '../src/store.ts';
import { memorySql } from './fakes/sql.ts';

const T0 = Date.parse('2026-10-06T08:00:00Z');

function store(): Store {
  const s = new Store(memorySql());
  s.migrate();
  return s;
}

/** The object's transactionSync on Node's SQLite: all or nothing. */
function transactional(sql: SqlStorage): <T>(fn: () => T) => T {
  return (fn) => {
    sql.exec('BEGIN');
    try {
      const result = fn();
      sql.exec('COMMIT');
      return result;
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
  };
}

/** The columns of a table. */
function columns(sql: SqlStorage, table: string): string[] {
  return sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((row) => row.name);
}

function tables(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).toArray().map((row) => row.name);
}

/**
 * A version 4 database as the live store had it: a trust label and another, rules of every kind and state (one person's
 * address at a public mailbox provider among them), decisions that still hold their exact sender addresses, review
 * items of every kind, and a live label's revocation time.
 */
function version4(): SqlStorage {
  const sql = memorySql();
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4]) sql.exec(statement);
  sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '4'), ('revoked_at', '1')`);
  sql.exec(`INSERT INTO labels (id, seq, display_name, description, enabled, live, trust, threshold, gmail_id, gmail_state, create_time, update_time, etag, keep_in_inbox)
    VALUES ('bank', 1, '金融/银行', '银行的交易通知', 1, 1, 1, 0.9, 'Label_7', 'linked', 1, 2, 'e1', 1),
           ('newsletter', 2, '订阅', '周报和简报', 1, 0, 0, 0, NULL, 'pending', 1, 2, 'e2', 0)`);
  const rule = (id: string, kind: string, value: string, label: string, state = 'active', requireDmarc = 0) =>
    sql.exec(`INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time, require_dmarc) VALUES (?, ?, ?, ?, ?, 5, 5, ?)`, id, kind, value, label, state, requireDmarc);
  rule('r1', 'sender_address', 'statements@bank.example.com', 'bank');
  rule('r2', 'sender_domain', 'alerts.bank.example.com', 'bank');
  rule('r3', 'list_id', 'news.bank.example.com', 'bank');
  rule('r4', 'delivered_to', 'owner@example.com', 'bank');
  rule('r5', 'sender_address', 'offers@promo.example.com', 'bank', 'proposed');
  rule('r6', 'sender_domain', 'old.example.org', 'bank', 'disabled');
  rule('r7', 'sender_domain', 'news.example.com', 'newsletter', 'active', 1);
  rule('r8', 'sender_address', 'digest@weekly.example.net', 'newsletter');
  // An address under a domain rule's domain: the domain keeps covering its subdomains.
  rule('r9', 'sender_address', 'notices@alerts.bank.example.com', 'bank');
  // Anyone can send from a public mailbox provider: never a trusted domain, nor a subdomain of one.
  rule('r10', 'sender_address', 'someone.synthetic@gmail.com', 'bank');
  rule('r11', 'sender_domain', 'vip.qq.com', 'bank');
  const decision = (id: string, outcome: string, address: string | null) =>
    sql.exec(
      `INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider, dmarc, sender_address, sender_domain, list_id, delivered_to, subject, sender, keep_in_inbox)
       VALUES (?, ?, 1, ?, ?, 'bank', 'rule', 1, ?, 'bank.example.com', 'news.bank.example.com', 'owner@example.com', '合成主题', 'Bank <bank.example.com>', 1)`,
      id, `t${id}`, T0, outcome, address,
    );
  decision('m1', 'applied', 'statements@bank.example.com');
  decision('m2', 'suggested', 'Statements@Bank.Example.com');
  decision('m3', 'unsure', null);
  const review = (id: string, message: string, kind: string, state: string) =>
    sql.exec(`INSERT INTO review (id, message_id, kind, state, decider, subject, sender, receive_time, create_time) VALUES (?, ?, ?, ?, 'clef', 's', 'f', 1, 1)`, id, message, kind, state);
  review('q1', 'm2', 'suggestion', 'pending');
  review('q2', 'm1', 'audit', 'pending');
  review('q3', 'm3', 'unsure', 'pending');
  review('q4', 'm2', 'suggestion', 'confirmed');
  return sql;
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
    const paths = ['开发/CI通知', '开发/平台工具', '金融/投资', '金融/银行支付', '账号安全', '政府法律', '购物/订单物流', '购物/促销', '订阅收据', '出行', '生活/账单住房', '生活/汽车', '生活/医疗', '求职', '学校与社群'];
    expect(paths.map((path) => pathSlug(path))).toEqual([
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

describe('the store', () => {
  it('migrates version 4 to 5: trusted domains seeded from the sender rules of trust labels and require_dmarc, then the rules dropped', async () => {
    const sql = version4();
    const s = new Store(sql);
    const hashes = await senderHashesToBackfill(s);
    expect([...hashes.keys()].sort()).toEqual(['m1', 'm2']);
    s.migrate(transactional(sql), hashes);
    expect(s.getMeta('schema_version')).toBe('5');
    expect(SCHEMA_V5.length).toBeGreaterThan(0);
    // An address rule's domain (exactly), a domain rule's own (with its subdomains); never a list, delivered-to,
    // proposed or disabled rule, a plain rule of a label that implies no trust, or a public mailbox provider.
    expect(s.all(`SELECT label_id, domain, origin, subdomains FROM trusted_domains ORDER BY label_id, domain`)).toEqual([
      { label_id: 'bank', domain: 'alerts.bank.example.com', origin: 'seed', subdomains: 1 },
      { label_id: 'bank', domain: 'bank.example.com', origin: 'seed', subdomains: 0 },
      { label_id: 'newsletter', domain: 'news.example.com', origin: 'seed', subdomains: 1 },
    ]);
    // A former address rule trusts that exact domain, never the platform's other subdomains.
    expect(s.isTrusted('bank', 'bank.example.com')).toBe(true);
    expect(s.isTrusted('bank', 'marketplace.bank.example.com')).toBe(false);
    expect(s.isTrusted('bank', 'x.alerts.bank.example.com')).toBe(true);
    expect(s.isTrusted('bank', 'gmail.com')).toBe(false);
    expect(tables(sql)).not.toContain('rules');
    expect(tables(sql)).toEqual(expect.arrayContaining(['trusted_domains', 'replay', 'decisions', 'labels']));
    // Labels keep everything but live mode per label and the owner's thresholds.
    expect(columns(sql, 'labels')).not.toEqual(expect.arrayContaining(['live']));
    expect(columns(sql, 'labels').filter((name) => ['live', 'live_since', 'threshold'].includes(name))).toEqual([]);
    expect(s.label('bank')).toMatchObject({ display_name: '金融/银行', description: '银行的交易通知', enabled: 1, trust: 1, gmail_id: 'Label_7', gmail_state: 'linked', keep_in_inbox: 1, etag: 'e1' });
    expect(s.ownedGmailIds()).toEqual(new Set(['Label_7']));
    // Decisions keep the sender as a hash only (the same one for any spelling), and lose what only rules used.
    expect(columns(sql, 'decisions').filter((name) => ['sender_address', 'list_id', 'delivered_to', 'keep_in_inbox'].includes(name))).toEqual([]);
    const hash = await senderHash('statements@bank.example.com');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // None was shown in the new review queue: an audit, a suggestion and an uncertain mail version 4 asked about alike,
    // so they take no place of the day's quota.
    expect(s.decision('m1')).toMatchObject({ sender_hash: hash, sender_domain: 'bank.example.com', outcome: 'applied', shown: 0, probabilities2: '{}' });
    expect(s.decision('m2')).toMatchObject({ sender_hash: hash, shown: 0 });
    expect(s.decision('m3')).toMatchObject({ sender_hash: null, shown: 0 });
    // The review queue starts empty: every pending item goes (the uncertain one too), the resolved ones stay.
    expect(s.all(`SELECT id FROM review ORDER BY id`)).toEqual([{ id: 'q4' }]);
    // The sender history reads the index of the hash and the authentication.
    expect(sql.exec<{ name: string }>(`PRAGMA index_info(decisions_sender)`).toArray().map((row) => row.name)).toEqual(['sender_hash', 'dmarc', 'decided_at']);
    expect(s.getMeta('revoked_at')).toBeNull();
    // Migrating again changes nothing.
    const before = { labels: s.labels(), domains: s.allTrustedDomains(), decisions: s.all(`SELECT * FROM decisions ORDER BY message_id`) };
    s.migrate(transactional(sql), await senderHashesToBackfill(s));
    expect({ labels: s.labels(), domains: s.allTrustedDomains(), decisions: s.all(`SELECT * FROM decisions ORDER BY message_id`) }).toEqual(before);
  });

  it('a migration cut short leaves version 4 as it was: the rules and every row stay', async () => {
    const sql = version4();
    // Something in the way of one statement (a view where the rebuild puts its table) makes the migration fail.
    sql.exec(`CREATE VIEW labels_v5 AS SELECT 1 AS x`);
    const s = new Store(sql);
    const hashes = await senderHashesToBackfill(s);
    expect(() => {
      s.migrate(transactional(sql), hashes);
    }).toThrow();
    expect(s.getMeta('schema_version')).toBe('4');
    expect(tables(sql)).toContain('rules');
    expect(tables(sql)).not.toContain('trusted_domains');
    expect(sql.exec(`SELECT count(*) AS n FROM rules`).toArray()[0]).toEqual({ n: 11 });
    expect(columns(sql, 'labels')).toContain('live');
    expect(sql.exec(`SELECT count(*) AS n FROM review`).toArray()[0]).toEqual({ n: 4 });
    // Without the obstacle it goes through.
    sql.exec(`DROP VIEW labels_v5`);
    s.migrate(transactional(sql), hashes);
    expect(s.getMeta('schema_version')).toBe('5');
    expect(s.trustedDomains('bank')).toEqual(['alerts.bank.example.com', 'bank.example.com']);
  });

  it('migrates a new database and older versions straight to 5', async () => {
    const fresh = new Store(memorySql());
    expect(await senderHashesToBackfill(fresh)).toEqual(new Map());
    fresh.migrate();
    expect(fresh.getMeta('schema_version')).toBe('5');
    expect(fresh.labels()).toEqual([]);
    for (const version of [1, 2, 3]) {
      const sql = memorySql();
      for (const statement of [...SCHEMA_V1, ...(version >= 2 ? SCHEMA_V2 : []), ...(version >= 3 ? SCHEMA_V3 : [])]) sql.exec(statement);
      sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, String(version));
      sql.exec(`INSERT INTO labels (id, seq, display_name, trust, gmail_state, create_time, update_time, etag) VALUES ('bank', 1, '银行', 1, 'pending', 1, 1, 'e')`);
      sql.exec(`INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time) VALUES ('r1', 'sender_address', 'a@bank.example.com', 'bank', 'active', 1, 1)`);
      const s = new Store(sql);
      s.migrate(transactional(sql), await senderHashesToBackfill(s));
      expect(s.getMeta('schema_version'), `version ${String(version)}`).toBe('5');
      expect(s.trustedDomains('bank')).toEqual(['bank.example.com']);
      expect(s.label('bank')).toMatchObject({ gmail_adopted: 0, gmail_name_taken: 0 });
      s.run(`INSERT INTO gmail_parents (gmail_id, create_time) VALUES ('Label_9', 1)`);
      expect(s.count(`SELECT count(*) AS n FROM gmail_parents`)).toBe(1);
    }
  });

  it('trusts a listed domain exactly, its subdomains only for a former domain rule, never a look-alike or a parent', () => {
    const s = store();
    s.run(`INSERT INTO trusted_domains (label_id, domain, origin, subdomains, create_time) VALUES ('bank', 'bank.example.com', 'seed', 1, 1)`);
    s.run(`INSERT INTO trusted_domains (label_id, domain, origin, create_time) VALUES ('bank', 'shop.example.org', 'owner', ?)`, T0);
    expect(s.isTrusted('bank', 'bank.example.com')).toBe(true);
    expect(s.isTrusted('bank', 'alerts.bank.example.com')).toBe(true);
    expect(s.isTrusted('bank', 'ALERTS.Bank.Example.com')).toBe(true);
    expect(s.isTrusted('bank', 'bank-alerts.example.net')).toBe(false);
    expect(s.isTrusted('bank', 'evilbank.example.com')).toBe(false);
    expect(s.isTrusted('bank', 'example.com')).toBe(false);
    expect(s.isTrusted('other', 'bank.example.com')).toBe(false);
    expect(s.isTrusted('bank', '')).toBe(false);
    // A learned domain is that exact From domain: a seller's subdomain of the same platform is not it.
    expect(s.isTrusted('bank', 'shop.example.org')).toBe(true);
    expect(s.isTrusted('bank', 'Shop.Example.org')).toBe(true);
    expect(s.isTrusted('bank', 'sellers.shop.example.org')).toBe(false);
    // As of a time: only the domains it had then (the replay evaluation's mail before the owner taught it).
    expect(s.isTrusted('bank', 'shop.example.org', T0)).toBe(false);
    expect(s.isTrusted('bank', 'shop.example.org', T0 + 1)).toBe(true);
  });

  it('learns a trusted domain once, never a public mailbox provider\'s, and keeps at most 50 per label, the oldest going first', () => {
    const s = store();
    expect(s.addTrustedDomain('bank', 'bank.example.com', T0)).toBe(true);
    expect(s.addTrustedDomain('bank', 'bank.example.com', T0 + 1)).toBe(false);
    expect(s.addTrustedDomain('bank', 'gmail.com', T0)).toBe(false);
    expect(s.addTrustedDomain('bank', 'vip.163.com', T0)).toBe(false);
    expect(s.trustedDomains('bank')).toEqual(['bank.example.com']);
    // A domain a seeded domain rule already covers is not added again.
    s.run(`INSERT INTO trusted_domains (label_id, domain, origin, subdomains, create_time) VALUES ('broker', 'broker.example.com', 'seed', 1, 1)`);
    expect(s.addTrustedDomain('broker', 'mail.broker.example.com', T0)).toBe(false);
    expect(s.trustedDomains('broker')).toEqual(['broker.example.com']);
    for (let i = 0; i < TRUSTED_DOMAINS_PER_LABEL_MAX; i++) s.addTrustedDomain('bank', `d${String(i).padStart(2, '0')}.example.com`, T0 + 10 + i);
    const domains = s.trustedDomains('bank');
    expect(domains).toHaveLength(TRUSTED_DOMAINS_PER_LABEL_MAX);
    expect(domains).not.toContain('bank.example.com');
    expect(s.all(`SELECT DISTINCT origin, subdomains FROM trusted_domains WHERE label_id = 'bank'`)).toEqual([{ origin: 'owner', subdomains: 0 }]);
  });

  it('counts the flow per UTC day, never below zero, and reads a range of days', () => {
    const s = store();
    countFlow(s, T0, 'clef', 'archived', 'travel');
    countFlow(s, T0, 'clef', 'archived', 'travel');
    countFlow(s, T0 - DAY, 'clef', 'unsure', null);
    countFlow(s, T0 - 10 * DAY, 'clef', 'suggested', 'travel');
    countFlow(s, T0, 'clef', 'kept_in_inbox', 'travel', -1);
    expect(readFlow(s, 1, T0).counts).toEqual([
      { stage: 'clef', outcome: 'archived', label: 'travel', n: 2 },
      { stage: 'clef', outcome: 'kept_in_inbox', label: 'travel', n: 0 },
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
        `INSERT INTO review (id, message_id, kind, state, decider, subject, sender, receive_time, create_time) VALUES (?, ?, 'unsure', 'pending', 'clef', 's', 'f', ?, ?)`,
        id, `m-${id}`, receive, create,
      );
    };
    queue('fresh', T0, T0);
    // Mail three and ten days old, queued late (a deferral, a backoff).
    queue('late3', T0 - 3 * DAY, T0);
    queue('late10', T0 - 10 * DAY, T0);
    // Each goes 14 days after its mail came, though all three were queued at T0.
    s.prune(T0 + 5 * DAY);
    expect(s.all(`SELECT id FROM review ORDER BY id`)).toEqual([{ id: 'fresh' }, { id: 'late3' }]);
    s.prune(T0 + 12 * DAY);
    expect(s.all(`SELECT id FROM review ORDER BY id`)).toEqual([{ id: 'fresh' }]);
    s.prune(T0 + 15 * DAY);
    expect(s.all(`SELECT id FROM review ORDER BY id`)).toEqual([]);
  });

  it('clears a decision\'s content and sender domain after 14 days, keeps its sender hash for 180, the replay for 7, the trusted domains until deleted', () => {
    const s = store();
    s.run(
      `INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, decider, sender_hash, sender_domain, subject, sender, summary) VALUES ('m1', 't1', ?, ?, 'unsure', 'clef', 'abcdef0123456789', 'bank.example.com', 's', 'f', 'x')`,
      T0, T0,
    );
    s.run(`INSERT INTO replay (job_id, message_id, state, create_time) VALUES ('j', '', 'running', ?)`, T0);
    s.run(`INSERT INTO trusted_domains (label_id, domain, origin, create_time) VALUES ('bank', 'bank.example.com', 'owner', ?)`, T0);
    s.prune(T0 + 8 * DAY);
    expect(s.count(`SELECT count(*) AS n FROM replay`)).toBe(0);
    s.prune(T0 + 15 * DAY);
    expect(s.decision('m1')).toMatchObject({ sender_hash: 'abcdef0123456789', sender_domain: null, subject: null, sender: null, summary: null, content_cleared: 1 });
    s.prune(T0 + 181 * DAY);
    expect(s.decision('m1')).toBeUndefined();
    expect(s.trustedDomains('bank')).toEqual(['bank.example.com']);
  });
});
