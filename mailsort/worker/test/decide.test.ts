import { describe, expect, it } from 'vitest';
import { AiError, clefInput, clefState, criterion, cutTokens, decide, estimateTokens, isQuotaError, readClefAnswer } from '../src/ai.ts';
import { combined, decideViews, historyText, secondViewLabels, type LabelFacts, type View } from '../src/decide.ts';
import { CLEF, CLEF_FLASH, NONE } from '../src/limits.ts';
import { modelUnavailable, retryDelay } from '../src/judge.ts';
import { P1_ID, PRIORITY_LABELS } from '../src/priority.ts';
import { FakeAi, QUOTA_MESSAGE } from './fakes/fake-ai.ts';

const labels = new Map<string, LabelFacts>(PRIORITY_LABELS.map((label) => [label.id, { id: label.id, enabled: true }]));
const options = PRIORITY_LABELS.map((label) => ({ id: label.id, key: label.id, name: label.displayName, description: label.description }));
function view(probabilities: Record<string, number>): View {
  return { probabilities, top: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? NONE };
}
const state = { received_at: '2026-10-23T16:00:00Z', current_local_time: 'Friday, 10/23/2026, 09:00:00', current_week: '2026-10-19 through 2026-10-25', time_zone: 'America/Los_Angeles', subject: 'Synthetic brokerage statement is ready' };

describe('priority views', () => {
  it('preserves the 0.7 threshold and view agreement', () => {
    const first = view({ p2: 0.8, p1: 0.15, none: 0.05 });
    expect(decideViews(first, view({ p2: 0.7, p1: 0.2, none: 0.1 }), labels)).toMatchObject({ kind: 'label', label: 'p2', confidence: 0.75 });
    expect(decideViews(first, view({ p2: 0.55, p1: 0.35, none: 0.1 }), labels)).toMatchObject({ kind: 'unsure', reason: 'low_confidence' });
    expect(decideViews(first, view({ p1: 0.8, p2: 0.15, none: 0.05 }), labels)).toMatchObject({ kind: 'unsure', reason: 'views_disagree' });
    expect(decideViews(first, null, labels)).toMatchObject({ kind: 'unsure', reason: 'low_confidence' });
  });

  it('keeps the second view on the first view scale', () => {
    const first = view({ p2: 0.62, p1: 0.2, p3: 0.08, p4: 0.05, none: 0.05 });
    const second = view({ p2: 0.8, p1: 0.1, p3: 0.05, none: 0.05 });
    expect(combined(first, second, 'p2')).toBeCloseTo((0.62 + 0.8 * 0.95) / 2);
    expect(secondViewLabels(first)).toEqual(['p2', 'p1', 'p3']);
    expect(secondViewLabels(view({ p2: 0.39, p1: 0.31, none: 0.3 }))).toBeNull();
    expect(secondViewLabels(view({ none: 0.8, p1: 0.2 }))).toBeNull();
  });

  it('has no sender authentication or trust requirement', () => {
    const legacyTrust = new Map(labels);
    legacyTrust.set('p2', { id: 'p2', enabled: true, trust: true });
    const answer = view({ p2: 0.92, none: 0.08 });
    expect(decideViews(answer, answer, legacyTrust)).toMatchObject({ kind: 'label', label: 'p2' });
  });

  it('keeps model failure distinct from a valid answer', () => {
    expect(modelUnavailable()).toMatchObject({ decision: { kind: 'unsure', reason: 'model_unavailable' }, view1: null, view2: null });
    expect(P1_ID).toBe('p1');
    expect(retryDelay(1)).toBe(300_000);
  });
});

describe('Clef priority contract', () => {
  it('asks only how long the owner can wait, without fraud or bulk questions', () => {
    const input = clefInput(CLEF, state, options);
    const questions = input['questions'] as Record<string, { type: string; criteria: Record<string, string>; instructions: string }>;
    expect(Object.keys(questions)).toEqual(['label']);
    expect(questions['label']?.type).toBe('choice');
    expect(Object.keys(questions['label']?.criteria ?? {})).toEqual(['p1', 'p2', 'p3', 'p4', 'none']);
    expect(questions['label']?.instructions).toContain('important follow-up (P2)');
    expect(questions['label']?.instructions).toContain('substantive optional reading (P3)');
    expect(questions['label']?.instructions).toContain('routine FYI or promotions (P4)');
    expect(JSON.stringify(input)).not.toMatch(/phishing|scam|impersonat|suspicious|sender_authenticated|\bbulk\b|Robinhood/i);
    expect(clefInput(CLEF_FLASH, state, options)['model']).toBe('clef-flash');
    expect(criterion({ name: 'P2', description: '这周处理' })).toBe('P2: 这周处理');
  });

  it('provides receipt time and the local day, clock and calendar week', () => {
    const f = { sender: 'Broker <broker.example.com>', toCode: 'to-synthetic', listId: '', subject: 'Statement', snippet: 'Your statement is ready.', body: 'Your statement is ready. Read it when convenient.', category: '' };
    const s = clefState(f, [], { history: '', receivedAt: Date.parse('2026-10-23T07:00:00Z'), now: Date.parse('2026-10-24T01:30:00Z') });
    expect(s).toMatchObject({ received_at: '2026-10-23T07:00:00.000Z', time_zone: 'America/Los_Angeles', current_week: '2026-10-19 through 2026-10-25 (Monday through Sunday)' });
    expect(s.current_local_time).toContain('Friday');
    expect(s.current_local_time).toContain('18:30:00');
    expect(s.snippet).toBeUndefined();
    expect(s).not.toHaveProperty('sender_authenticated');
    expect(s).not.toHaveProperty('sender_history');
  });

  it('maps model keys to IDs and keeps neuron accounting unchanged', async () => {
    const ai = new FakeAi();
    ai.choiceOverride = () => ({ p3: 0.92, none: 0.08 });
    const answer = await decide({ run: (model, input) => Promise.resolve(ai.run(model, input)) }, CLEF, state, options);
    expect(answer.top).toBe('p3');
    expect(answer.neurons).toBeCloseTo(2000 * 0.021818);
    const flash = readClefAnswer(CLEF_FLASH, ai.run(CLEF_FLASH, clefInput(CLEF_FLASH, state, options)), ['p1', 'p2', 'p3', 'p4']);
    expect(flash.neurons).toBeCloseTo(2000 * 0.008182);
    expect(answer).not.toHaveProperty('suspicious');
    expect(answer).not.toHaveProperty('bulk');
  });

  it('strictly refuses extra fraud questions, missing options and malformed probabilities', () => {
    const good = new FakeAi().run(CLEF, clefInput(CLEF, state, options));
    const answers = good['answers'] as Record<string, unknown>;
    for (const changed of [
      null,
      { ...good, answers: {} },
      { ...good, answers: { ...answers, suspicious: { type: 'noul', noul: 0.9 } } },
      { ...good, answers: { label: { type: 'choice', probabilities: { p1: 1 } } } },
      { ...good, answers: { label: { type: 'choice', probabilities: { p1: 2, p2: -1, p3: 0, p4: 0, none: 0 } } } },
      { ...good, usage: {} },
    ]) expect(() => readClefAnswer(CLEF, changed, ['p1', 'p2', 'p3', 'p4'])).toThrow(AiError);
    expect(isQuotaError(new Error(QUOTA_MESSAGE))).toBe(true);
    expect(isQuotaError(new Error('3043: internal server error'))).toBe(false);
  });

  it('retains bounded sender context and token estimates', () => {
    expect(historyText([{ label: 'p2', owner: 1, auto: 0 }, { label: 'old-topic', owner: 5, auto: 0 }], (id) => labels.has(id) ? id : null)).toBe('p2 ×1');
    expect(estimateTokens('你好世界')).toBe(4);
    expect(cutTokens('一二三四五六', 3)).toBe('一二三…');
  });
});
