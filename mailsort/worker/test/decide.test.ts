/**
 * The decision's pure parts (../../docs/design.md §4.4-§4.6): rules (their order, subject carve-outs, DMARC for sender
 * rules and trust labels, DKIM for lists, forged From headers), the neighbour shortcut, Clef's request, the strict read
 * of its answer and the decision from it; the neuron estimate, quota detection, the Wilson bound, the mode lowering
 * and the Gmail filter export.
 */
import { describe, expect, it } from 'vitest';
import { wilsonLowerBound } from '../src/accuracy.ts';
import { AiError, clefInput, clefState, cosine, criterion, cutTokens, decide, estimateTokens, isQuotaError, readClefAnswer } from '../src/ai.ts';
import { clefDecision, neighbourDecision, orderRules, ruleDecision, type LabelFacts, type MailAuth } from '../src/decide.ts';
import { dkimPassDomains, dmarcAligned, listSigned, neutralise } from '../src/dmarc.ts';
import { modeCeiling } from '../src/env.ts';
import { exportableRules, gmailFilterXml, type ExportCandidate } from '../src/filters.ts';
import { CLEF, CLEF_FLASH, MAIL_ATTEMPTS_MAX, NONE, RETRY_MAX_MS } from '../src/limits.ts';
import { features } from '../src/mask.ts';
import { readMessage } from '../src/mime.ts';
import { retryDelay } from '../src/pipeline.ts';
import { ruleValueOk } from '../src/rule-value.ts';
import { effectiveMode } from '../src/settings.ts';
import type { RuleRow } from '../src/store.ts';
import { embedText, FakeAi, QUOTA_MESSAGE } from './fakes/fake-ai.ts';
import { apiMessage, MAILS } from './fakes/fixtures.ts';

const labels = new Map<string, LabelFacts>([
  ['newsletter', { id: 'newsletter', enabled: true, trust: false, threshold: 0 }],
  ['receipt', { id: 'receipt', enabled: true, trust: false, threshold: 0.95 }],
  ['bank', { id: 'bank', enabled: true, trust: true, threshold: 0 }],
  ['off', { id: 'off', enabled: false, trust: false, threshold: 0 }],
]);

function rule(id: string, kind: RuleRow['kind'], label: string, extra: Partial<RuleRow> = {}): RuleRow {
  return {
    id,
    kind,
    value: kind === 'list_id' ? 'x' : 'x@example.com',
    label_id: label,
    state: 'active',
    correction_count: 0,
    match_count: 0,
    create_time: 0,
    update_time: 0,
    subject_includes: '[]',
    subject_excludes: '[]',
    keep_in_inbox: 0,
    require_dmarc: 0,
    evidence: '',
    notes: '',
    import_id: '',
    ...extra,
  };
}

/** A mail that passed DMARC aligned (and DKIM for news.example.com), or one that did not. */
const signed: MailAuth & { subject: string } = { dmarcAligned: true, dkimDomains: ['news.example.com'], subject: '' };
const unsigned: MailAuth & { subject: string } = { dmarcAligned: false, dkimDomains: [], subject: '' };

describe('rules', () => {
  it('the most specific kind decides; ties are broken by age, then ID, never by the order SQLite returned', () => {
    expect(ruleDecision([rule('r1', 'sender_domain', 'newsletter'), rule('r2', 'sender_address', 'receipt')], labels, signed)).toEqual({ label: 'receipt', ruleId: 'r2', keepInInbox: false });
    const a = rule('r1', 'sender_address', 'newsletter', { create_time: 5 });
    const b = rule('r2', 'sender_address', 'receipt', { create_time: 3 });
    expect(ruleDecision([a, b], labels, signed)?.ruleId).toBe('r2');
    expect(ruleDecision([b, a], labels, signed)?.ruleId).toBe('r2');
    const c = rule('r9', 'sender_address', 'newsletter', { create_time: 3 });
    expect(ruleDecision([c, b], labels, signed)?.ruleId).toBe('r2');
    expect(ruleDecision([rule('r1', 'list_id', 'off')], labels, signed)).toBeNull();
    // A longer domain is more specific than its parent.
    const parent = rule('r1', 'sender_domain', 'newsletter', { value: 'example.com' });
    const child = rule('r2', 'sender_domain', 'receipt', { value: 'shop.example.com' });
    expect(orderRules([parent, child]).map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('a sender rule needs DMARC aligned with the From domain, whatever its label', () => {
    expect(ruleDecision([rule('r1', 'sender_address', 'newsletter')], labels, unsigned)).toBeNull();
    expect(ruleDecision([rule('r1', 'sender_domain', 'newsletter')], labels, unsigned)).toBeNull();
    expect(ruleDecision([rule('r1', 'sender_address', 'bank')], labels, signed)).toEqual({ label: 'bank', ruleId: 'r1', keepInInbox: false });
  });

  it('a trust label, or a rule that asks for it, needs DMARC on a list or delivered-to rule too', () => {
    expect(ruleDecision([rule('r1', 'delivered_to', 'newsletter')], labels, unsigned)?.label).toBe('newsletter');
    expect(ruleDecision([rule('r1', 'delivered_to', 'bank')], labels, unsigned)).toBeNull();
    expect(ruleDecision([rule('r1', 'delivered_to', 'newsletter', { require_dmarc: 1 })], labels, unsigned)).toBeNull();
    expect(ruleDecision([rule('r1', 'delivered_to', 'newsletter', { require_dmarc: 1 })], labels, signed)?.label).toBe('newsletter');
  });

  it('a list rule needs a DKIM signature of the list’s domain (or a parent) when its namespace is a domain', () => {
    const list = rule('r1', 'list_id', 'newsletter', { value: 'digest.news.example.com' });
    expect(ruleDecision([list], labels, { ...unsigned, dkimDomains: ['news.example.com'] })?.label).toBe('newsletter');
    expect(ruleDecision([list], labels, { ...unsigned, dkimDomains: ['example.com'] })?.label).toBe('newsletter');
    expect(ruleDecision([list], labels, { ...unsigned, dkimDomains: ['evil.example.net'] })).toBeNull();
    expect(ruleDecision([list], labels, unsigned)).toBeNull();
    expect(listSigned('digest.news.example.com', ['mail.news.example.com'])).toBe(true);
    expect(listSigned('digest.news.example.com', ['xnews.example.com'])).toBe(false);
    // An opaque namespace has no domain to check: the List-Id alone counts.
    expect(listSigned('a1b2c3', [])).toBe(true);
  });

  it('a carve-out with subject conditions goes before the sender’s plain rule, case-insensitively', () => {
    const plain = rule('r1', 'sender_address', 'newsletter', { create_time: 1 });
    const login = rule('r2', 'sender_address', 'receipt', { create_time: 9, subject_includes: '["login","登录"]', keep_in_inbox: 1 });
    expect(ruleDecision([plain, login], labels, { ...signed, subject: 'Your LOGIN code' })).toEqual({ label: 'receipt', ruleId: 'r2', keepInInbox: true });
    expect(ruleDecision([plain, login], labels, { ...signed, subject: '新设备登录提醒' })?.ruleId).toBe('r2');
    expect(ruleDecision([plain, login], labels, { ...signed, subject: 'Your monthly statement' })?.ruleId).toBe('r1');
    // Full-width letters fold too (NFKC).
    expect(ruleDecision([plain, login], labels, { ...signed, subject: 'ＬＯＧＩＮ alert' })?.ruleId).toBe('r2');
    const notPromo = rule('r3', 'sender_address', 'newsletter', { subject_excludes: '["sale"]' });
    expect(ruleDecision([notPromo], labels, { ...signed, subject: 'Big SALE today' })).toBeNull();
    expect(ruleDecision([notPromo], labels, { ...signed, subject: 'Weekly digest' })?.ruleId).toBe('r3');
  });

  it('an exclusion narrows a broad rule but is no carve-out: the exact address rule still goes first', () => {
    const broad = rule('invest', 'sender_domain', 'newsletter', { value: 'bank.example.com', subject_excludes: '["广告"]', create_time: 1 });
    const security = rule('security', 'sender_address', 'receipt', { value: 'security@bank.example.com', keep_in_inbox: 1, create_time: 9 });
    expect(orderRules([broad, security]).map((r) => r.id)).toEqual(['security', 'invest']);
    expect(ruleDecision([broad, security], labels, { ...signed, subject: '新设备登录提醒' })).toEqual({ label: 'receipt', ruleId: 'security', keepInInbox: true });
    // Its label disabled, the exclusion rule steps aside instead of ending the search.
    const offBroad = { ...broad, label_id: 'off' };
    const plainDomain = rule('plain', 'sender_domain', 'newsletter', { value: 'bank.example.com', create_time: 5 });
    expect(ruleDecision([offBroad, plainDomain], labels, { ...signed, subject: 'monthly news' })?.ruleId).toBe('plain');
    // Against a plain rule of the same kind and value, the exclusion goes first, and its excluded words fall through.
    const promo = rule('promo', 'sender_domain', 'receipt', { value: 'bank.example.com', create_time: 0 });
    expect(orderRules([promo, broad]).map((r) => r.id)).toEqual(['invest', 'promo']);
    expect(ruleDecision([promo, broad], labels, { ...signed, subject: '理财广告' })?.ruleId).toBe('promo');
    expect(ruleDecision([promo, broad], labels, { ...signed, subject: '月度对账单' })?.ruleId).toBe('invest');
    // An include carve-out with an exclusion still outranks the plain address rule.
    const carve = rule('carve', 'sender_domain', 'receipt', { value: 'bank.example.com', subject_includes: '["登录"]', subject_excludes: '["广告"]' });
    expect(orderRules([security, carve])[0]?.id).toBe('carve');
  });

  it('a carve-out that matches but cannot fire never lets its mail fall through to the plain rule', () => {
    const plain = rule('r1', 'list_id', 'newsletter', { value: 'digest.news.example.com' });
    const carve = rule('r2', 'list_id', 'off', { value: 'digest.news.example.com', subject_includes: '["login"]' });
    expect(ruleDecision([plain, carve], labels, { ...signed, subject: 'login code' })).toBeNull();
    expect(ruleDecision([plain, carve], labels, { ...signed, subject: 'weekly' })?.ruleId).toBe('r1');
  });

  it('reads DMARC and DKIM from Gmail’s topmost Authentication-Results only: a forged From fires no rule', async () => {
    const results = (header: string) => [header];
    expect(dmarcAligned(results('mx.google.com; dkim=pass header.i=@bank.example.com; dmarc=pass (p=REJECT) header.from=bank.example.com'), 'bank.example.com')).toBe(true);
    // The display name pretends, the address is another domain's: DMARC is about the address's domain.
    expect(dmarcAligned(results('mx.google.com; dmarc=pass header.from=evil.example.net'), 'bank.example.com')).toBe(false);
    expect(dmarcAligned(results('mx.google.com; dmarc=fail (p=REJECT) header.from=bank.example.com'), 'bank.example.com')).toBe(false);
    expect(dmarcAligned(results('evil.example.net; dmarc=pass header.from=bank.example.com'), 'bank.example.com')).toBe(false);
    expect(dmarcAligned(['mx.google.com; dmarc=fail header.from=bank.example.com', 'mx.google.com; dmarc=pass header.from=bank.example.com'], 'bank.example.com')).toBe(false);
    expect(dkimPassDomains(results('mx.google.com; dkim=pass header.i=@news.example.com header.s=s1; dkim=fail header.d=other.example.org; dkim=pass header.d=example.com'))).toEqual(['news.example.com', 'example.com']);
    expect(dkimPassDomains(results('relay.example.net; dkim=pass header.d=news.example.com'))).toEqual([]);
    // Comments and quoted strings are the sender's text: a result planted there never counts, and an unclosed one
    // makes the header unreadable rather than letting what follows it count.
    const planted = MAILS.injectedDmarc.authenticationResults;
    expect(dmarcAligned([planted], 'bank.example.com')).toBe(false);
    expect(dmarcAligned([planted.replace('dmarc=fail', 'dmarc=pass')], 'bank.example.com')).toBe(true);
    expect(dkimPassDomains([MAILS.injectedListDkim.authenticationResults])).toEqual([]);
    expect(listSigned('digest.news.example.com', dkimPassDomains([MAILS.injectedListDkim.authenticationResults]))).toBe(false);
    // A ')' inside the quoted local part does not close the spf comment early.
    expect(dmarcAligned(['mx.google.com; spf=pass (google.com: domain of "a)b;dmarc=pass header.from=bank.example.com"@evil.example.net designates 192.0.2.1) smtp.mailfrom=evil.example.net; dmarc=fail header.from=bank.example.com'], 'bank.example.com')).toBe(false);
    expect(dmarcAligned(['mx.google.com; spf=pass (unclosed; dmarc=pass header.from=bank.example.com'], 'bank.example.com')).toBe(false);
    expect(dmarcAligned(['mx.google.com; spf=pass smtp.mailfrom="a\\"; dmarc=pass header.from=bank.example.com'], 'bank.example.com')).toBe(false);
    // Two dmarc results are ambiguous; an ARC comment that mentions dmarc=pass is only a comment.
    expect(dmarcAligned(['mx.google.com; dmarc=pass header.from=bank.example.com; dmarc=fail header.from=bank.example.com'], 'bank.example.com')).toBe(false);
    expect(dmarcAligned(['mx.google.com; arc=pass (i=1 spf=pass dkim=pass dmarc=pass fromdomain=bank.example.com); dmarc=pass (p=REJECT) header.from=bank.example.com'], 'bank.example.com')).toBe(true);
    const sample = 'a (b "c)" d) e "f\\"g" h';
    expect(neutralise(sample)?.length).toBe(sample.length);
    expect(neutralise(sample)?.replace(/ +/g, ' ')).toBe('a e h');
    // Each forged mail against the rule its From or List-Id would match (ruleDecision gets only matching rules).
    const cases = [
      [MAILS.injectedDmarc, rule('r1', 'sender_address', 'bank', { value: 'statements@bank.example.com' })],
      [MAILS.injectedListDkim, rule('r2', 'list_id', 'newsletter', { value: 'digest.news.example.com' })],
    ] as const;
    for (const [mail, matching] of cases) {
      const read = readMessage(apiMessage(mail));
      if (read === null) throw new Error('fixture');
      const f = await features(read);
      const auth = { subject: f.rawSubject, dmarcAligned: dmarcAligned(read.headers.authenticationResults, f.senderDomain), dkimDomains: dkimPassDomains(read.headers.authenticationResults) };
      expect(ruleDecision([matching], labels, auth)).toBeNull();
    }
    // The whole path: a synthetic mail whose From copies the bank's address but whose DMARC failed.
    const forged = readMessage(apiMessage({ ...MAILS.bankEn, id: 'b00000000000b001', dmarc: 'fail' }));
    const genuine = readMessage(apiMessage(MAILS.bankEn));
    if (forged === null || genuine === null) throw new Error('fixture');
    const bankRule = rule('r1', 'sender_address', 'bank', { value: 'statements@bank.example.com' });
    const auth = async (read: NonNullable<typeof forged>) => {
      const f = await features(read);
      return { subject: f.rawSubject, dmarcAligned: dmarcAligned(read.headers.authenticationResults, f.senderDomain), dkimDomains: dkimPassDomains(read.headers.authenticationResults) };
    };
    expect(ruleDecision([bankRule], labels, await auth(genuine))?.label).toBe('bank');
    expect(ruleDecision([bankRule], labels, await auth(forged))).toBeNull();
  });
});

describe('neighbours', () => {
  const near = (label: string, similarity: number) => ({ label, similarity });
  it('decides only with DMARC, three unanimous close neighbours and a non-trust enabled label', () => {
    expect(neighbourDecision([near('newsletter', 0.95), near('newsletter', 0.94), near('newsletter', 0.93)], labels, true)).toBe('newsletter');
    expect(neighbourDecision([near('newsletter', 0.95), near('newsletter', 0.94), near('newsletter', 0.93)], labels, false)).toBeNull();
    expect(neighbourDecision([near('newsletter', 0.95), near('receipt', 0.94), near('newsletter', 0.93)], labels, true)).toBeNull();
    expect(neighbourDecision([near('newsletter', 0.95), near('newsletter', 0.94), near('newsletter', 0.5)], labels, true)).toBeNull();
    expect(neighbourDecision([near('bank', 0.99), near('bank', 0.99), near('bank', 0.99)], labels, true)).toBeNull();
    expect(neighbourDecision([near('newsletter', 0.99)], labels, true)).toBeNull();
  });

  it('similar texts have similar fake embeddings', () => {
    const a = Float32Array.from(embedText('Your weekly digest: 5 new posts'));
    const b = Float32Array.from(embedText('Your weekly digest: 6 new posts'));
    const c = Float32Array.from(embedText('航班行程确认'));
    expect(cosine(a, b)).toBeGreaterThan(0.8);
    expect(cosine(a, c)).toBeLessThan(0.2);
  });
});

describe('Clef', () => {
  const options = [
    { id: 'newsletter', key: 'subscriptions', name: '订阅', description: 'newsletter weekly digest' },
    { id: 'receipt', key: 'receipts', name: '收据', description: 'receipt invoice' },
  ];
  const state = { from: 'Digest <news.example.com>', to: 'to-abc123', list: 'mailing list', subject: 'Your weekly digest', snippet: '', body: '', gmail_category: 'updates', similar_examples: [] };

  it('asks one choice over the labels plus none, and two noul questions', () => {
    const input = clefInput(CLEF, state, options);
    expect(input['model']).toBe('clef');
    expect(clefInput(CLEF_FLASH, state, options)['model']).toBe('clef-flash');
    const questions = input['questions'] as Record<string, { type: string; criteria?: Record<string, string> }>;
    expect(Object.keys(questions).sort()).toEqual(['bulk', 'label', 'suspicious']);
    expect(Object.keys(questions['label']?.criteria ?? {})).toEqual(['subscriptions', 'receipts', NONE]);
    expect(questions['label']?.criteria?.['subscriptions']).toBe('订阅: newsletter weekly digest');
    expect(JSON.stringify(input)).not.toContain('"newsletter":');
  });

  it('gives every option its path: a random ID (an imported label) never stands for the meaning', () => {
    expect(criterion({ name: '学校', description: '' })).toBe('学校');
    expect(criterion({ name: '学校与社群', description: '课程、成绩、学术会议' })).toBe('学校与社群: 课程、成绩、学术会议');
    expect(criterion({ name: '金融/投资', description: '券商对账单' })).toBe('金融/投资: 券商对账单');
    const input = clefInput(CLEF, state, [{ id: 'lxy260f75g', key: 'school', name: '学校', description: '' }]);
    expect(JSON.stringify(input)).not.toContain('lxy260f75g');
  });

  it('answers by label ID, whatever keys the model saw', async () => {
    const ai = new FakeAi();
    const answer = await decide({ run: (model, input) => Promise.resolve(ai.run(model, input)) }, CLEF, state, options);
    expect(answer.top).toBe('newsletter');
    expect(Object.keys(answer.probabilities).sort()).toEqual(['newsletter', 'none', 'receipt']);
  });

  it('keeps the state lean: no snippet the body starts with, no empty fields', () => {
    const f = { listId: '', sender: 'Shop <shop.example.com>', subject: 'Receipt', toCode: 'to-abc123', category: '' };
    const body = 'Thank you for your order.\nYour receipt and invoice total is 42.00. More text follows here.';
    const lean = clefState({ ...f, snippet: 'Thank you for your order. Your receipt and invoice total is 42.00.', body }, []);
    expect(lean).toEqual({ from: 'Shop <shop.example.com>', to: 'to-abc123', subject: 'Receipt', body });
    expect(clefState({ ...f, snippet: 'Something else entirely', body }, []).snippet).toBe('Something else entirely');
    expect(clefState({ ...f, snippet: 'Thank you for your order.', body: '' }, []).snippet).toBe('Thank you for your order.');
    expect(clefState({ ...f, listId: 'x.example.com', snippet: '', body }, [{ label: 'receipts', summary: 'Receipt · Shop' }])).toMatchObject({ list: 'mailing list', similar_examples: [{ label: 'receipts', text: 'Receipt · Shop' }] });
  });

  it('reads the fake model’s answer and estimates neurons from input tokens', () => {
    const ai = new FakeAi();
    const answer = readClefAnswer(CLEF, ai.run(CLEF, clefInput(CLEF, state, options)), ['subscriptions', 'receipts']);
    expect(answer.top).toBe('subscriptions');
    expect(answer.neurons).toBeCloseTo(2000 * 0.021818, 3);
    const flash = readClefAnswer(CLEF_FLASH, ai.run(CLEF_FLASH, clefInput(CLEF_FLASH, state, options)), ['subscriptions', 'receipts']);
    expect(flash.neurons).toBeCloseTo(2000 * 0.008182, 3);
  });

  it('refuses an answer whose keys, options or probabilities are not exactly what was asked', () => {
    const good = new FakeAi().run(CLEF, clefInput(CLEF, state, options));
    const answers = good['answers'] as Record<string, Record<string, unknown>>;
    const variants: unknown[] = [
      null,
      { ...good, answers: { ...answers, extra: { type: 'noul', noul: 0.5 } } },
      { ...good, answers: { label: answers['label'], bulk: answers['bulk'] } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { subscriptions: 0.5, receipts: 0.5 } } } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { subscriptions: 0.9, receipts: 0.9, none: 0.9 } } } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { subscriptions: 2, receipts: -1, none: 0 } } } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { subscriptions: 0.5, receipts: 0.5, none: 0, hacked: 0 } } } },
      { ...good, answers: { ...answers, suspicious: { type: 'choice', noul: 0.1 } } },
      { ...good, usage: {} },
    ];
    expect(readClefAnswer(CLEF, good, ['subscriptions', 'receipts']).top).toBe('subscriptions');
    for (const variant of variants) expect(() => readClefAnswer(CLEF, variant, ['subscriptions', 'receipts'])).toThrow(AiError);
  });

  it('decides a label only when every condition holds', () => {
    const answer = (probabilities: Record<string, number>, suspicious = 0.05) => {
      const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? NONE;
      return { model: 'clef', probabilities, top, suspicious, bulk: 0, inputTokens: 1, neurons: 0 };
    };
    expect(clefDecision(answer({ newsletter: 0.9, receipt: 0.05, none: 0.05 }), 'clef', labels, 0.8)).toMatchObject({ confident: true, label: 'newsletter' });
    expect(clefDecision(answer({ newsletter: 0.7, receipt: 0.2, none: 0.1 }), 'clef', labels, 0.8)).toMatchObject({ confident: false, reason: 'below_threshold' });
    expect(clefDecision(answer({ newsletter: 0.05, receipt: 0.05, none: 0.9 }), 'clef', labels, 0.8)).toMatchObject({ confident: false, reason: 'none', top: null });
    expect(clefDecision(answer({ newsletter: 0.9, receipt: 0.05, none: 0.05 }, 0.3), 'clef', labels, 0.8)).toMatchObject({ confident: false, reason: 'suspicious' });
    // A label's own threshold: 0.9 is below receipt's 0.95.
    expect(clefDecision(answer({ newsletter: 0.05, receipt: 0.9, none: 0.05 }), 'clef', labels, 0.8)).toMatchObject({ confident: false, reason: 'below_threshold' });
    expect(clefDecision(answer({ bank: 0.99, none: 0.01 }), 'clef', labels, 0.8)).toMatchObject({ confident: false, reason: 'trust_needs_rule' });
    expect(clefDecision(answer({ off: 0.99, none: 0.01 }), 'clef', labels, 0.8)).toMatchObject({ confident: false, reason: 'label_disabled' });
  });

  it('knows a quota refusal from another failure', () => {
    expect(isQuotaError(new Error(QUOTA_MESSAGE))).toBe(true);
    expect(isQuotaError(new Error('3043: internal server error'))).toBe(false);
  });

  it('estimates and cuts tokens in one pass', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(cutTokens('一二三四五六', 3)).toBe('一二三…');
    expect(estimateTokens(cutTokens('x'.repeat(10_000), 120))).toBeLessThanOrEqual(121);
  });
});

describe('retries of one mail', () => {
  it('back off per mail, doubling from 5 minutes, and give up after about five hours', () => {
    expect(retryDelay(1)).toBe(5 * 60_000);
    expect(retryDelay(2)).toBe(10 * 60_000);
    expect(retryDelay(20)).toBe(RETRY_MAX_MS);
    let total = 0;
    for (let attempt = 1; attempt < MAIL_ATTEMPTS_MAX; attempt++) total += retryDelay(attempt);
    expect(total).toBeGreaterThanOrEqual(4 * 3_600_000);
  });
});

describe('the precision bound', () => {
  it('is the Wilson 95 % lower bound', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    // Zero errors in 35 confirmations is just above 0.9 (the plan's live gate).
    expect(wilsonLowerBound(35, 35)).toBeGreaterThan(0.9);
    expect(wilsonLowerBound(30, 30)).toBeLessThan(0.9);
    expect(wilsonLowerBound(52, 53)).toBeGreaterThan(0.89);
    expect(wilsonLowerBound(5, 10)).toBeLessThan(0.5);
  });
});

describe('modes', () => {
  it('lowers the owner’s mode to the deployment’s ceiling, and to shadow while the breaker is tripped', () => {
    expect(modeCeiling({ MODE: 'live' })).toBe('live');
    expect(modeCeiling({ MODE: 'garbage' })).toBe('off');
    expect(modeCeiling({})).toBe('off');
    expect(effectiveMode({ mode: 'live', breaker: '' }, 'live')).toBe('live');
    expect(effectiveMode({ mode: 'live', breaker: '' }, 'shadow')).toBe('shadow');
    expect(effectiveMode({ mode: 'live', breaker: 'daily_limit' }, 'live')).toBe('shadow');
    expect(effectiveMode({ mode: 'shadow', breaker: '' }, 'off')).toBe('off');
  });
});

describe('the Gmail filter export', () => {
  it('writes Gmail’s filter XML: the label by its path, archive only, values quoted', () => {
    const xml = gmailFilterXml(
      [
        { kind: 'sender_address', value: 'digest@news.example.com', labelName: '订阅' },
        { kind: 'list_id', value: 'digest.news.example.com', labelName: '订阅' },
        { kind: 'sender_domain', value: 'ci.example.com', labelName: '开发/CI通知' },
        { kind: 'sender_domain', value: 'shop.example.com', labelName: "收'据" },
      ],
      Date.parse('2026-10-06T00:00:00Z'),
    );
    expect(xml).toContain("<apps:property name='from' value='&quot;digest@news.example.com&quot;'/>");
    expect(xml).toContain("<apps:property name='hasTheWord' value='list:(&quot;digest.news.example.com&quot;)'/>");
    expect(xml).toContain("<apps:property name='label' value='收&apos;据'/>");
    expect(xml).toContain("<apps:property name='label' value='订阅'/>");
    expect(xml).not.toContain('分拣');
    // A nested label by its Gmail name, the path itself.
    expect(xml).toContain("<apps:property name='label' value='开发/CI通知'/>");
    expect(xml).toContain("name='shouldArchive' value='true'");
    // A rule or label that keeps its mail in the inbox only labels.
    const kept = gmailFilterXml([{ kind: 'sender_address', value: 'codes@login.example.com', labelName: '账号安全', archive: false }], Date.parse('2026-10-06T00:00:00Z'));
    expect(kept).toContain("<apps:property name='label' value='账号安全'/>");
    expect(kept).not.toContain('shouldArchive');
    expect(xml).not.toMatch(/shouldMarkAsRead|shouldTrash|forwardTo|shouldStar|shouldNeverSpam/);
  });
});

describe('which rules become Gmail filters', () => {
  const rule = (id: string, kind: RuleRow['kind'], value: string, extra: Partial<ExportCandidate> = {}): ExportCandidate => ({
    id,
    kind,
    value,
    require_dmarc: 0,
    subject_includes: '[]',
    subject_excludes: '[]',
    trust: 0,
    ...extra,
  });
  const ids = (rules: readonly ExportCandidate[]) => exportableRules(rules).exported.map((item) => item.id);

  it('leaves out the plain rule of a sender a pickup-code carve-out covers, so Gmail never archives the code', () => {
    const pickup = rule('shop-pickup', 'sender_address', 'orders@shop.example.com', { subject_includes: '["取件码"]' });
    const all = rule('shop-all', 'sender_address', 'orders@shop.example.com');
    const other = rule('ci', 'sender_address', 'builds@ci.example.com');
    expect(exportableRules([pickup, all, other])).toEqual({ exported: [other], skipped: 2 });
  });

  it('treats a domain and an address or subdomain under it as the same sender, either way round', () => {
    const carvedAddress = rule('login', 'sender_address', 'alerts@bank.example.com', { subject_includes: '["登录"]', trust: 1 });
    expect(ids([carvedAddress, rule('bank', 'sender_domain', 'bank.example.com')])).toEqual([]);
    expect(ids([carvedAddress, rule('parent', 'sender_domain', 'example.com')])).toEqual([]);
    const carvedDomain = rule('promo', 'sender_domain', 'mail.shop.example.com', { subject_excludes: '["广告"]' });
    expect(ids([carvedDomain, rule('shop', 'sender_domain', 'shop.example.com')])).toEqual([]);
    expect(ids([carvedDomain, rule('addr', 'sender_address', 'news@mail.shop.example.com')])).toEqual([]);
    // Unrelated senders and look-alike domains keep their filters.
    expect(ids([carvedAddress, rule('other', 'sender_address', 'news@bank.example.com'), rule('lookalike', 'sender_domain', 'notbank.example.com')])).toEqual(['other', 'lookalike']);
    // A list or delivered-to carve-out covers only the same list or address.
    const carvedList = rule('list-carve', 'list_id', 'digest.news.example.com', { subject_includes: '["周报"]' });
    expect(ids([carvedList, rule('list', 'list_id', 'digest.news.example.com'), rule('list2', 'list_id', 'other.news.example.com'), rule('dom', 'sender_domain', 'news.example.com')])).toEqual(['list2', 'dom']);
  });

  it('still leaves out trust, DMARC and unplain rules', () => {
    expect(exportableRules([rule('t', 'sender_address', 'a@bank.example.com', { trust: 1 }), rule('d', 'sender_domain', 'gov.example.com', { require_dmarc: 1 }), rule('bad', 'list_id', 'x)or(from:*')])).toEqual({ exported: [], skipped: 3 });
  });
});

describe('rule values (proposals from mail headers, the owner’s rules, the export)', () => {
  const hostile: [RuleRow['kind'], string][] = [
    ['list_id', 'x)or(from:*'],
    ['list_id', '-digest.example.com'],
    ['list_id', 'a b.example.com'],
    ['list_id', '{a b}'],
    ['list_id', "a'b.example.com"],
    ['list_id', 'a"b.example.com'],
    ['sender_address', '-x@example.com'],
    ['sender_address', 'x@-example.com'],
    ['sender_address', '(x)@example.com'],
    ['sender_address', '*@example.com'],
    ['sender_address', 'x@example'],
    ['sender_domain', '-example.com'],
    ['sender_domain', 'example.-com'],
    ['sender_domain', 'example .com'],
    ['delivered_to', 'a@b.example.com OR c@d.example.com'],
  ];

  it('accepts plain values only', () => {
    expect(ruleValueOk('list_id', 'digest.news.example.com')).toBe(true);
    expect(ruleValueOk('list_id', 'weekly_list-1.example.org')).toBe(true);
    expect(ruleValueOk('sender_address', 'statements+1@bank.example.com')).toBe(true);
    expect(ruleValueOk('sender_domain', 'news.example.com')).toBe(true);
    expect(ruleValueOk('delivered_to', 'owner@example.com')).toBe(true);
    for (const [kind, value] of hostile) expect(ruleValueOk(kind, value), `${kind} ${value}`).toBe(false);
  });

  it('never exports a value that could widen a Gmail filter', () => {
    const xml = gmailFilterXml(
      hostile.map(([kind, value]) => ({ kind, value, labelName: '订阅' })),
      Date.parse('2026-10-06T00:00:00Z'),
    );
    expect(xml).not.toContain('<entry>');
  });
});
