/**
 * The decision's pure parts (../../docs/design.md §4.4-§4.6): rules (trust labels need DMARC), the neighbour shortcut,
 * Clef's request, the strict read of its answer and the decision from it; the neuron estimate, quota detection, the
 * Wilson bound, the mode lowering and the Gmail filter export.
 */
import { describe, expect, it } from 'vitest';
import { wilsonLowerBound } from '../src/accuracy.ts';
import { AiError, clefInput, cosine, cutTokens, estimateTokens, isQuotaError, readClefAnswer } from '../src/ai.ts';
import { clefDecision, neighbourDecision, ruleDecision, type LabelFacts } from '../src/decide.ts';
import { modeCeiling } from '../src/env.ts';
import { gmailFilterXml } from '../src/filters.ts';
import { CLEF, CLEF_FLASH, NONE } from '../src/limits.ts';
import { effectiveMode } from '../src/settings.ts';
import type { RuleRow } from '../src/store.ts';
import { embedText, FakeAi, QUOTA_MESSAGE } from './fakes/fake-ai.ts';

const labels = new Map<string, LabelFacts>([
  ['newsletter', { id: 'newsletter', enabled: true, trust: false, threshold: 0 }],
  ['receipt', { id: 'receipt', enabled: true, trust: false, threshold: 0.95 }],
  ['bank', { id: 'bank', enabled: true, trust: true, threshold: 0 }],
  ['off', { id: 'off', enabled: false, trust: false, threshold: 0 }],
]);

function rule(id: string, kind: RuleRow['kind'], label: string): RuleRow {
  return { id, kind, value: 'x', label_id: label, state: 'active', correction_count: 0, match_count: 0, create_time: 0, update_time: 0 };
}

describe('rules', () => {
  it('the most specific kind decides; a disagreement there decides nothing', () => {
    expect(ruleDecision([rule('r1', 'sender_domain', 'newsletter'), rule('r2', 'sender_address', 'receipt')], labels, false)).toEqual({ label: 'receipt', ruleId: 'r2' });
    expect(ruleDecision([rule('r1', 'sender_address', 'newsletter'), rule('r2', 'sender_address', 'receipt')], labels, false)).toBeNull();
    expect(ruleDecision([rule('r1', 'list_id', 'off')], labels, false)).toBeNull();
  });

  it('a trust label needs DMARC aligned', () => {
    expect(ruleDecision([rule('r1', 'sender_address', 'bank')], labels, false)).toBeNull();
    expect(ruleDecision([rule('r1', 'sender_address', 'bank')], labels, true)).toEqual({ label: 'bank', ruleId: 'r1' });
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
    { id: 'newsletter', description: 'newsletter weekly digest' },
    { id: 'receipt', description: 'receipt invoice' },
  ];
  const state = { from: 'Digest <news.example.com>', to: 'to-abc123', list: 'mailing list', subject: 'Your weekly digest', snippet: '', body: '', gmail_category: 'updates', similar_examples: [] };

  it('asks one choice over the labels plus none, and two noul questions', () => {
    const input = clefInput(CLEF, state, options);
    expect(input['model']).toBe('clef');
    expect(clefInput(CLEF_FLASH, state, options)['model']).toBe('clef-flash');
    const questions = input['questions'] as Record<string, { type: string; criteria?: Record<string, string> }>;
    expect(Object.keys(questions).sort()).toEqual(['bulk', 'label', 'suspicious']);
    expect(Object.keys(questions['label']?.criteria ?? {})).toEqual(['newsletter', 'receipt', NONE]);
  });

  it('reads the fake model’s answer and estimates neurons from input tokens', () => {
    const ai = new FakeAi();
    const answer = readClefAnswer(CLEF, ai.run(CLEF, clefInput(CLEF, state, options)), ['newsletter', 'receipt']);
    expect(answer.top).toBe('newsletter');
    expect(answer.neurons).toBeCloseTo(2000 * 0.021818, 3);
    const flash = readClefAnswer(CLEF_FLASH, ai.run(CLEF_FLASH, clefInput(CLEF_FLASH, state, options)), ['newsletter', 'receipt']);
    expect(flash.neurons).toBeCloseTo(2000 * 0.008182, 3);
  });

  it('refuses an answer whose keys, options or probabilities are not exactly what was asked', () => {
    const good = new FakeAi().run(CLEF, clefInput(CLEF, state, options));
    const answers = good['answers'] as Record<string, Record<string, unknown>>;
    const variants: unknown[] = [
      null,
      { ...good, answers: { ...answers, extra: { type: 'noul', noul: 0.5 } } },
      { ...good, answers: { label: answers['label'], bulk: answers['bulk'] } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { newsletter: 0.5, receipt: 0.5 } } } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { newsletter: 0.9, receipt: 0.9, none: 0.9 } } } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { newsletter: 2, receipt: -1, none: 0 } } } },
      { ...good, answers: { ...answers, label: { ...answers['label'], probabilities: { newsletter: 0.5, receipt: 0.5, none: 0, hacked: 0 } } } },
      { ...good, answers: { ...answers, suspicious: { type: 'choice', noul: 0.1 } } },
      { ...good, usage: {} },
    ];
    for (const variant of variants) expect(() => readClefAnswer(CLEF, variant, ['newsletter', 'receipt'])).toThrow(AiError);
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
  it('writes Gmail’s filter XML: label and archive only, escaped', () => {
    const xml = gmailFilterXml(
      [
        { kind: 'sender_address', value: 'digest@news.example.com', labelName: '订阅' },
        { kind: 'list_id', value: "a'b.example.com", labelName: '订阅' },
      ],
      Date.parse('2026-10-06T00:00:00Z'),
    );
    expect(xml).toContain("<apps:property name='from' value='digest@news.example.com'/>");
    expect(xml).toContain("<apps:property name='hasTheWord' value='list:(a&apos;b.example.com)'/>");
    expect(xml).toContain("<apps:property name='label' value='分拣/订阅'/>");
    expect(xml).toContain("name='shouldArchive' value='true'");
    expect(xml).not.toMatch(/shouldMarkAsRead|shouldTrash|forwardTo|shouldStar|shouldNeverSpam/);
  });
});
