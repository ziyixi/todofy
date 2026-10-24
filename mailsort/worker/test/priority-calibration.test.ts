/** Offline regression checks of the captured synthetic responses, not a fresh model or mailbox evaluation. */
import { describe, expect, it } from 'vitest';
import { gather, judge, type Judgement } from '../src/judge.ts';
import { CLEF, CLEF_FLASH } from '../src/limits.ts';
import { readMessage } from '../src/mime.ts';
import { P1_ID, PRIORITY_LABELS } from '../src/priority.ts';
import { Budget } from '../src/session.ts';
import { Store } from '../src/store.ts';
import { FakeAi } from './fakes/fake-ai.ts';
import { apiMessage } from './fakes/fixtures.ts';
import { PRIORITY_CASES } from './fakes/priority-cases.ts';
import { PRIORITY_CLEF_CAPTURES } from './fakes/priority-clef-captures.ts';
import { memorySql } from './fakes/sql.ts';

describe('public Clef response calibration', () => {
  it.each([CLEF, CLEF_FLASH])('replays %s through the real two-view judgement and P1 fallback', async (model) => {
    const captures = PRIORITY_CLEF_CAPTURES.filter(capture => capture.model === model);
    expect(captures.map(capture => capture.id).sort()).toEqual(PRIORITY_CASES.map(fixture => fixture.id).sort());
    const results: { id: string; expected: string; result: Judgement }[] = [];

    for (const fixture of PRIORITY_CASES) {
      const capture = captures.find(row => row.id === fixture.id);
      if (capture === undefined) throw new Error(`Missing synthetic capture: ${fixture.id}`);
      const store = new Store(memorySql());
      store.migrate();
      const cut = fixture.receivedAt - 1;
      store.setMeta('priority_started_at', String(cut));
      for (const [i, label] of PRIORITY_LABELS.entries()) store.run(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_state, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, 'pending', ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, cut, cut);
      const read = readMessage(apiMessage({ id: fixture.id, from: 'Synthetic sender <sender@example.com>', subject: fixture.subject, text: fixture.body, receivedAt: fixture.receivedAt }));
      if (read === null) throw new Error(`Invalid synthetic fixture: ${fixture.id}`);
      const ai = new FakeAi();
      let calls = 0;
      ai.choiceOverride = () => ++calls === 1 ? { ...capture.first } : { ...capture.second };
      const budget = new Budget(40);
      const result = await judge({ store, ai: { run: (requested, input) => Promise.resolve(ai.run(requested, input)) }, budget, now: () => fixture.now, transact: fn => fn() }, model, await gather(read), fixture.now, fixture.id);
      results.push({ id: fixture.id, expected: fixture.expected, result });

      const skippedSecond = model === CLEF_FLASH && fixture.id === 'missing-deadline-zh';
      expect(ai.calls, fixture.id).toHaveLength(skippedSecond ? 1 : 2);
      expect(budget.left, fixture.id).toBe(skippedSecond ? 39 : 38);
      expect(result.view1?.probabilities, fixture.id).toEqual(capture.first);
      expect(result.view2?.probabilities ?? null, fixture.id).toEqual(skippedSecond ? null : capture.second);
      if (fixture.expected === P1_ID) expect(result.decision, fixture.id).toMatchObject({ kind: 'label', label: P1_ID });
      if (fixture.expected === 'p3' || fixture.expected === 'p4') expect(result.modelDecision, fixture.id).toMatchObject({ kind: 'label', label: fixture.expected });
      if (fixture.id === 'missing-deadline-zh') {
        expect(result.modelDecision).toMatchObject({ kind: 'unsure', top: 'p2', reason: 'low_confidence' });
        expect(result.modelDecision.confidence).toBeCloseTo(model === CLEF ? 0.53583732 : 0.3896);
      }
    }

    const correct = results.filter(({ expected, result }) => result.decision.kind === 'label' && result.decision.label === expected);
    expect(correct).toHaveLength(model === CLEF ? 16 : 13);
    const fallbacks = results.filter(({ result }) => result.modelDecision.kind !== 'label');
    expect(fallbacks).toHaveLength(model === CLEF ? 1 : 3);
    for (const { result } of fallbacks) expect(result.decision).toMatchObject({ kind: 'label', label: P1_ID });
    const errors = results.filter(row => !correct.includes(row));
    expect(errors.map(row => row.id)).toEqual(model === CLEF ? [] : ['next-week-review-en', 'friday-next-week-form-zh', 'important-policy-review-en']);
    for (const { expected, result } of errors) {
      expect(expected).toBe('p2');
      expect(result.decision).toMatchObject({ kind: 'label', label: P1_ID });
    }
  });
});
