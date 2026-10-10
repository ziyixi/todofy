/**
 * The decision's pure parts (../../docs/design.md §4): the two views and their decision table (the trust gate,
 * needs_action, confident none), view 2's labels, the review queue's quota and its informative band, the sender
 * history's text, DMARC from Gmail's own header (forged From headers), Clef's request and the strict read of its answer;
 * the neuron estimate, quota detection, the per-mail backoff and the mode lowering.
 */
import { describe, expect, it } from 'vitest';
import { AiError, clefInput, clefState, cosine, criterion, cutTokens, decide, estimateTokens, isQuotaError, readClefAnswer } from '../src/ai.ts';
import { decideViews, historyText, informative, joinsReview, needsAction, reviewQuota, secondViewLabels, type Decision, type LabelFacts, type SenderTrust, type View } from '../src/decide.ts';
import { dmarcAligned, neutralise } from '../src/dmarc.ts';
import { modeCeiling } from '../src/env.ts';
import { CLEF, CLEF_FLASH, MAIL_ATTEMPTS_MAX, NONE, RETRY_MAX_MS } from '../src/limits.ts';
import { features } from '../src/mask.ts';
import { readMessage } from '../src/mime.ts';
import { retryDelay } from '../src/pipeline.ts';
import { effectiveMode } from '../src/settings.ts';
import { embedText, FakeAi, QUOTA_MESSAGE } from './fakes/fake-ai.ts';
import { apiMessage, MAILS } from './fakes/fixtures.ts';

const labels = new Map<string, LabelFacts>([
  ['newsletter', { id: 'newsletter', enabled: true, trust: false }],
  ['receipt', { id: 'receipt', enabled: true, trust: false }],
  ['travel', { id: 'travel', enabled: true, trust: false }],
  ['bank', { id: 'bank', enabled: true, trust: true }],
  ['off', { id: 'off', enabled: false, trust: false }],
]);

/** A view of the model: its probabilities (the top is the most likely), p(suspicious) and p(needs_action). */
function view(probabilities: Record<string, number>, suspicious = 0.02, needs = 0.05): View {
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? NONE;
  return { probabilities, top, suspicious, needsAction: needs };
}

/** A sender that passed DMARC, trusted for the bank label; one that did not; one authenticated but not trusted. */
const trusted: SenderTrust = { authenticated: true, trusted: (id) => id === 'bank' };
const forged: SenderTrust = { authenticated: false, trusted: (id) => id === 'bank' };
const unknown: SenderTrust = { authenticated: true, trusted: () => false };

describe('the decision table', () => {
  it('accepts a label when both views choose it, their mean reaches 0.7 and nothing is suspicious', () => {
    const v1 = view({ newsletter: 0.8, receipt: 0.1, none: 0.1 });
    expect(decideViews(v1, view({ newsletter: 0.7, receipt: 0.2, none: 0.1 }), labels, unknown)).toMatchObject({ kind: 'label', label: 'newsletter', confidence: 0.75 });
    // The mean is what counts: 0.8 and 0.55 is below 0.7, though the first view alone was above.
    expect(decideViews(v1, view({ newsletter: 0.55, receipt: 0.35, none: 0.1 }), labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'low_confidence', top: 'newsletter', confidence: 0.675 });
    // Exactly at the threshold is enough.
    expect(decideViews(view({ newsletter: 0.7, none: 0.3 }), view({ newsletter: 0.7, none: 0.3 }), labels, unknown)).toMatchObject({ kind: 'label' });
  });

  it('is uncertain when the views disagree, when view 2 did not run, or when either view finds it suspicious', () => {
    const v1 = view({ newsletter: 0.6, receipt: 0.3, none: 0.1 });
    expect(decideViews(v1, view({ receipt: 0.6, newsletter: 0.3, none: 0.1 }), labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'views_disagree', top: 'newsletter' });
    expect(decideViews(v1, view({ none: 0.7, newsletter: 0.2, receipt: 0.1 }), labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'views_disagree' });
    expect(decideViews(view({ newsletter: 0.35, receipt: 0.33, none: 0.32 }), null, labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'low_confidence', confidence: 0.35 });
    expect(decideViews(view({ newsletter: 0.9, none: 0.1 }, 0.3), view({ newsletter: 0.9, none: 0.1 }), labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'suspicious' });
    // The higher of the two views' p(suspicious).
    expect(decideViews(view({ newsletter: 0.9, none: 0.1 }), view({ newsletter: 0.9, none: 0.1 }, 0.35), labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'suspicious' });
    expect(decideViews(view({ newsletter: 0.9, none: 0.1 }), view({ newsletter: 0.9, none: 0.1 }, 0.29), labels, unknown)).toMatchObject({ kind: 'label' });
  });

  it('is confident that no label fits when view 1 says none with p >= 0.6, or both views say none', () => {
    expect(decideViews(view({ none: 0.6, newsletter: 0.3, receipt: 0.1 }), null, labels, unknown)).toMatchObject({ kind: 'none', confidence: 0.6 });
    expect(decideViews(view({ none: 0.5, newsletter: 0.3, receipt: 0.2 }), null, labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'low_confidence', top: null });
    expect(decideViews(view({ none: 0.5, newsletter: 0.3, receipt: 0.2 }), view({ none: 0.8, newsletter: 0.2 }), labels, unknown)).toMatchObject({ kind: 'none' });
  });

  it('a trust label also needs an authenticated sender of a trusted domain and p(suspicious) below 0.1', () => {
    const v = view({ bank: 0.9, none: 0.1 });
    expect(decideViews(v, v, labels, trusted)).toMatchObject({ kind: 'label', label: 'bank' });
    // A forged From (DMARC failed) or a look-alike domain never borrows the trust label.
    expect(decideViews(v, v, labels, forged)).toMatchObject({ kind: 'unsure', reason: 'untrusted_sender' });
    expect(decideViews(v, v, labels, unknown)).toMatchObject({ kind: 'unsure', reason: 'untrusted_sender' });
    const slightly = view({ bank: 0.9, none: 0.1 }, 0.15);
    expect(decideViews(slightly, slightly, labels, trusted)).toMatchObject({ kind: 'unsure', reason: 'suspicious' });
    // The same p(suspicious) does not stop a label that implies no trust.
    const plain = view({ receipt: 0.9, none: 0.1 }, 0.15);
    expect(decideViews(plain, plain, labels, unknown)).toMatchObject({ kind: 'label', label: 'receipt' });
  });

  it('never accepts a label that is not enabled (it changed while the mail was decided)', () => {
    const v = view({ off: 0.95, none: 0.05 });
    expect(decideViews(v, v, labels, trusted)).toMatchObject({ kind: 'unsure', reason: 'low_confidence', top: 'off' });
  });

  it('runs view 2 over view 1\'s three most likely labels, only after a label top of at least 0.4', () => {
    expect(secondViewLabels(view({ travel: 0.45, receipt: 0.2, none: 0.25, newsletter: 0.06, bank: 0.04 }))).toEqual(['travel', 'receipt', 'newsletter']);
    expect(secondViewLabels(view({ travel: 0.39, receipt: 0.31, none: 0.3 }))).toBeNull();
    expect(secondViewLabels(view({ none: 0.5, travel: 0.4, receipt: 0.1 }))).toBeNull();
    expect(secondViewLabels(view({ travel: 0.9, none: 0.1 }))).toEqual(['travel']);
  });

  it('keeps a mail in the inbox when it asks the owner to act soon (p(needs_action) >= 0.6)', () => {
    expect(needsAction(0.6)).toBe(true);
    expect(needsAction(0.59)).toBe(false);
    expect(needsAction(null)).toBe(false);
  });

  it('reads DMARC from Gmail’s topmost Authentication-Results only: a forged From is not authenticated', async () => {
    const results = (header: string) => [header];
    expect(dmarcAligned(results('mx.google.com; dkim=pass header.i=@bank.example.com; dmarc=pass (p=REJECT) header.from=bank.example.com'), 'bank.example.com')).toBe(true);
    // The display name pretends, the address is another domain's: DMARC is about the address's domain.
    expect(dmarcAligned(results('mx.google.com; dmarc=pass header.from=evil.example.net'), 'bank.example.com')).toBe(false);
    expect(dmarcAligned(results('mx.google.com; dmarc=fail (p=REJECT) header.from=bank.example.com'), 'bank.example.com')).toBe(false);
    expect(dmarcAligned(results('evil.example.net; dmarc=pass header.from=bank.example.com'), 'bank.example.com')).toBe(false);
    expect(dmarcAligned(['mx.google.com; dmarc=fail header.from=bank.example.com', 'mx.google.com; dmarc=pass header.from=bank.example.com'], 'bank.example.com')).toBe(false);
    // Comments and quoted strings are the sender's text: a result planted there never counts, and an unclosed one
    // makes the header unreadable rather than letting what follows it count.
    const planted = MAILS.injectedDmarc.authenticationResults;
    expect(dmarcAligned([planted], 'bank.example.com')).toBe(false);
    expect(dmarcAligned([planted.replace('dmarc=fail', 'dmarc=pass')], 'bank.example.com')).toBe(true);
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
    // The whole path: synthetic mails whose From copies the bank's address, the forged one's DMARC failed, the
    // look-alike's passed for another domain. Neither is authenticated for the bank, so the trust label waits.
    const authenticated = async (mail: Parameters<typeof apiMessage>[0]) => {
      const read = readMessage(apiMessage(mail));
      if (read === null) throw new Error('fixture');
      const f = await features(read);
      return dmarcAligned(read.headers.authenticationResults, f.senderDomain) && f.senderDomain === 'bank.example.com';
    };
    expect(await authenticated(MAILS.bankEn)).toBe(true);
    expect(await authenticated(MAILS.forgedBankLogin)).toBe(false);
    expect(await authenticated(MAILS.lookalikeBank)).toBe(false);
    expect(await authenticated(MAILS.injectedDmarc)).toBe(false);
  });
});

describe('the review queue', () => {
  const unsure = (reason: Extract<Decision, { kind: 'unsure' }>['reason'], confidence: number, top: string | null = 'newsletter'): Extract<Decision, { kind: 'unsure' }> => ({ kind: 'unsure', reason, top, confidence, candidates: [] });

  it('shows 5 % of the last week\'s average daily mail, rounded up, at least 1 and at most 5', () => {
    expect(reviewQuota(0)).toBe(1);
    expect(reviewQuota(10)).toBe(1);
    expect(reviewQuota(30)).toBe(2);
    expect(reviewQuota(41)).toBe(3);
    expect(reviewQuota(1000)).toBe(5);
  });

  it('prefers the informative band: [0.35, 0.7), views that disagree, an untrusted sender', () => {
    expect(informative(unsure('low_confidence', 0.35))).toBe(true);
    expect(informative(unsure('low_confidence', 0.69))).toBe(true);
    expect(informative(unsure('low_confidence', 0.34))).toBe(false);
    expect(informative(unsure('low_confidence', 0.5, null))).toBe(false);
    expect(informative(unsure('views_disagree', 0.2))).toBe(true);
    expect(informative(unsure('untrusted_sender', 0.9))).toBe(true);
    expect(informative(unsure('model_unavailable', 0, null))).toBe(false);
  });

  it('keeps the day\'s last place for the informative band, and never asks with nothing to offer', () => {
    // A quota of 2: the first uninformative mail takes a place, the second does not; an informative one takes the last.
    expect(joinsReview(unsure('low_confidence', 0.2), 0, 2)).toBe(true);
    expect(joinsReview(unsure('low_confidence', 0.2), 1, 2)).toBe(false);
    expect(joinsReview(unsure('views_disagree', 0.5), 1, 2)).toBe(true);
    expect(joinsReview(unsure('views_disagree', 0.5), 2, 2)).toBe(false);
    // A quota of 1 is the informative band's only.
    expect(joinsReview(unsure('suspicious', 0.1), 0, 1)).toBe(false);
    expect(joinsReview(unsure('low_confidence', 0.5), 0, 1)).toBe(true);
    expect(joinsReview(unsure('no_labels', 0, null), 0, 5)).toBe(false);
  });
});

describe('the sender history', () => {
  it('names the three labels the sender\'s mail got, the owner\'s verdicts first, as option keys', () => {
    const key = (id: string) => (id === 'gone' ? null : id === NONE ? NONE : `key-${id}`);
    const entries = [
      { label: 'newsletter', owner: 0, auto: 5 },
      { label: 'receipt', owner: 1, auto: 0 },
      { label: NONE, owner: 2, auto: 0 },
      { label: 'gone', owner: 3, auto: 0 },
      { label: 'travel', owner: 0, auto: 1 },
    ];
    expect(historyText(entries, key)).toBe('none ×2, key-receipt ×1, key-newsletter ×5');
    expect(historyText([], key)).toBe('');
  });
});

describe('neighbours', () => {
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

  it('asks one choice over the labels plus none, and three noul questions (needs_action among them)', () => {
    const input = clefInput(CLEF, state, options);
    expect(input['model']).toBe('clef');
    expect(clefInput(CLEF_FLASH, state, options)['model']).toBe('clef-flash');
    const questions = input['questions'] as Record<string, { type: string; criteria?: Record<string, string>; instructions?: string }>;
    expect(Object.keys(questions).sort()).toEqual(['bulk', 'label', 'needs_action', 'suspicious']);
    expect(questions['needs_action']).toMatchObject({ type: 'noul' });
    expect(questions['needs_action']?.instructions).toContain('pickup or verification code');
    expect(Object.keys(questions['label']?.criteria ?? {})).toEqual(['subscriptions', 'receipts', NONE]);
    expect(questions['label']?.criteria?.['subscriptions']).toBe('订阅: newsletter weekly digest');
    expect(JSON.stringify(input)).not.toContain('"newsletter":');
    // The second view offers the options in the order given (judge.ts passes view 1's reversed), none still last.
    expect(Object.keys((clefInput(CLEF, state, [...options].reverse())['questions'] as typeof questions)['label']?.criteria ?? {})).toEqual(['receipts', 'subscriptions', NONE]);
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

  it('keeps the state lean: no snippet the body starts with, no empty fields; the sender evidence always says yes or no', () => {
    const f = { listId: '', sender: 'Shop <shop.example.com>', subject: 'Receipt', toCode: 'to-abc123', category: '' };
    const body = 'Thank you for your order.\nYour receipt and invoice total is 42.00. More text follows here.';
    const plain = { authenticated: false, history: '' };
    const lean = clefState({ ...f, snippet: 'Thank you for your order. Your receipt and invoice total is 42.00.', body }, [], plain);
    expect(lean).toEqual({ from: 'Shop <shop.example.com>', sender_authenticated: 'no', to: 'to-abc123', subject: 'Receipt', body });
    expect(clefState({ ...f, snippet: 'Something else entirely', body }, [], plain).snippet).toBe('Something else entirely');
    expect(clefState({ ...f, snippet: 'Thank you for your order.', body: '' }, [], plain).snippet).toBe('Thank you for your order.');
    expect(clefState({ ...f, listId: 'x.example.com', snippet: '', body }, [{ label: 'receipts', summary: 'Receipt · Shop' }], plain)).toMatchObject({ list: 'mailing list', similar_examples: [{ label: 'receipts', text: 'Receipt · Shop' }] });
    expect(clefState({ ...f, snippet: '', body }, [], { authenticated: true, history: 'receipts ×3, none ×1' })).toMatchObject({ sender_authenticated: 'yes', sender_history: 'receipts ×3, none ×1' });
  });

  it('reads the fake model’s answer and estimates neurons from input tokens', () => {
    const ai = new FakeAi();
    const answer = readClefAnswer(CLEF, ai.run(CLEF, clefInput(CLEF, state, options)), ['subscriptions', 'receipts']);
    expect(answer.top).toBe('subscriptions');
    expect(answer.needsAction).toBeLessThan(0.6);
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
      { ...good, answers: { label: answers['label'], bulk: answers['bulk'], suspicious: answers['suspicious'] } },
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
