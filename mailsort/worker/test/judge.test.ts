import { describe, expect, it } from 'vitest';
import { AiError, toBlob } from '../src/ai.ts';
import { embeddedCount, nearest, unembedded } from '../src/examples.ts';
import { applyFeedback, setVerdict } from '../src/feedback.ts';
import { gather, judge, senderHistory } from '../src/judge.ts';
import { CLEF } from '../src/limits.ts';
import { readMessage } from '../src/mime.ts';
import { PRIORITY_LABELS } from '../src/priority.ts';
import { startReplay } from '../src/replay.ts';
import { Budget } from '../src/session.ts';
import { Store } from '../src/store.ts';
import { FakeAi, embedText } from './fakes/fake-ai.ts';
import { apiMessage } from './fakes/fixtures.ts';
import { memorySql } from './fakes/sql.ts';

const CUT = Date.parse('2026-10-20T12:00:00Z');
const NOW = CUT + 5 * 86_400_000;
function setup(): Store {
  const store = new Store(memorySql());
  store.migrate();
  store.setMeta('priority_started_at', String(CUT));
  for (const [i, label] of PRIORITY_LABELS.entries()) store.run(`INSERT INTO labels (id, seq, display_name, description, enabled, trust, gmail_state, create_time, update_time, etag) VALUES (?, ?, ?, ?, 1, 1, 'pending', ?, ?, 'e')`, label.id, i + 1, label.displayName, label.description, CUT, CUT);
  return store;
}
function oldDecision(store: Store, id: string, label: string, at: number): void {
  store.run(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, decider, sender_hash, summary) VALUES (?, ?, ?, ?, 'applied', ?, 'clef', 'sender-hash', 'Synthetic statement')`, id, id, at, at, label);
  store.run(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time) VALUES (?, ?, ?, 'Label_1', 1, 'auto', 'applied', ?)`, `ledger-${id}`, id, label, at);
}
const synthetic = { id: 'abc0000000000001', from: 'Example Brokerage <statements@broker.example.com>', subject: 'Brokerage statement available', text: 'Your monthly brokerage statement is ready. No action is required.', dmarc: 'fail' as const, receivedAt: NOW };

async function judgement(store: Store, ai: FakeAi) {
  const read = readMessage(apiMessage(synthetic));
  if (read === null) throw new Error('fixture');
  return judge({ store, ai: { run: (model, input) => Promise.resolve(ai.run(model, input)) }, budget: new Budget(40), now: () => NOW, transact: (fn) => fn() }, CLEF, await gather(read), NOW, synthetic.id);
}

describe('priority judgement and learning cutoff', () => {
  it('classifies legitimate brokerage mail without auth gating, fraud questions or review', async () => {
    const store = setup();
    const ai = new FakeAi();
    ai.choiceOverride = () => ({ p3: 0.92, none: 0.08 });
    expect(await judgement(store, ai)).toMatchObject({ decision: { kind: 'label', label: 'p3' } });
    expect(ai.calls).toHaveLength(2);
    for (const call of ai.calls) {
      expect(Object.keys(call.input['questions'] as object)).toEqual(['label']);
      expect(JSON.stringify(call.input)).not.toMatch(/scam|phishing|suspicious|sender_authenticated/i);
    }
  });

  it.each(['none', 'uncertain', 'disagreement'])('maps a valid %s answer to P1', async (kind) => {
    const ai = new FakeAi();
    let calls = 0;
    ai.choiceOverride = () => kind === 'none' ? { none: 0.92, p1: 0.08 } : kind === 'uncertain' ? { p2: 0.5, none: 0.5 } : ++calls === 1 ? { p2: 0.92, none: 0.08 } : { p1: 0.92, none: 0.08 };
    const result = await judgement(setup(), ai);
    expect(result).toMatchObject({ decision: { kind: 'label', label: 'p1' } });
    expect(result).toMatchObject({ modelDecision: kind === 'none' ? { kind: 'none' } : { kind: 'unsure', top: kind === 'disagreement' ? 'p2' : null, reason: kind === 'disagreement' ? 'views_disagree' : 'low_confidence' } });
  });

  it('preserves model failure as an error instead of inventing a P1 decision', async () => {
    const ai = new FakeAi();
    ai.broken = true;
    await expect(judgement(setup(), ai)).rejects.toThrow(AiError);
  });

  it('excludes old decisions and topic IDs from sender history even when an alias points at P1', () => {
    const store = setup();
    oldDecision(store, 'old-priority', 'p1', CUT - 1);
    oldDecision(store, 'old-topic', 'bank', CUT + 1);
    oldDecision(store, 'current', 'p2', CUT + 2);
    store.run(`INSERT INTO label_aliases (source_id, target_id) VALUES ('bank', 'p1')`);
    expect(senderHistory(store, 'sender-hash', NOW, 'not-this-message')).toEqual([{ label: 'p2', owner: 0, auto: 1 }]);
  });

  it('learns fallback mail only after an explicit owner verdict', () => {
    const store = setup();
    oldDecision(store, 'fallback', 'p1', CUT + 1);
    store.run(`UPDATE decisions SET top_label = 'p2', unsure_reason = 'low_confidence' WHERE message_id = 'fallback'`);
    expect(senderHistory(store, 'sender-hash', NOW, 'other-message')).toEqual([]);
    expect(store.decision('fallback')?.verdict).toBeNull();
    expect(store.all(`SELECT id FROM examples`)).toEqual([]);
    const row = store.decision('fallback');
    if (row === undefined) throw new Error('fixture');
    setVerdict(store, row, 'p3', 'review', NOW);
    expect(senderHistory(store, 'sender-hash', NOW + 1, 'other-message')).toEqual([{ label: 'p3', owner: 1, auto: 0 }]);
    expect(store.all(`SELECT label_id, origin FROM examples`)).toEqual([{ label_id: 'p3', origin: 'correction' }]);
  });

  it('excludes old and topic examples from embeddings, nearest neighbours and rebuilds', () => {
    const store = setup();
    const vector = Float32Array.from(embedText('Synthetic statement'));
    for (const [id, label, at, embedded] of [['old', 'p1', CUT - 1, true], ['topic', 'bank', CUT + 1, true], ['current', 'p3', CUT + 1, true], ['old-pending', 'p2', CUT - 1, false], ['current-pending', 'p4', CUT + 1, false]] as const) {
      store.run(`INSERT INTO examples (id, label_id, summary, origin, embedding, create_time) VALUES (?, ?, 'Synthetic statement', 'confirmation', ?, ?)`, id, label, embedded ? toBlob(vector) : null, at);
    }
    expect(embeddedCount(store)).toBe(1);
    expect(nearest(store, vector, 3, new Set(['p1', 'p2', 'p3', 'p4', 'bank']), NOW, synthetic.id).map((row) => row.id)).toEqual(['current']);
    expect(unembedded(store, 8).map((row) => row.id)).toEqual(['current-pending']);
  });

  it('does not turn historical writes or feedback into new examples', () => {
    const store = setup();
    oldDecision(store, 'old', 'p1', CUT - 1);
    oldDecision(store, 'topic', 'bank', CUT + 1);
    oldDecision(store, 'current', 'p2', CUT + 1);
    store.run(`INSERT INTO feedback (key, message_id, change, gmail_label_id, seq) VALUES ('old-feedback', 'old', 'added', 'Label_2', 1)`);
    applyFeedback(store, new Map([['Label_2', 'p2']]), NOW);
    const old = store.decision('old');
    if (old === undefined) throw new Error('fixture');
    setVerdict(store, old, 'p2', 'review', NOW);
    expect(store.decision('old')?.verdict).toBeNull();
    expect(store.decision('topic')?.verdict).toBeNull();
    expect(store.decision('current')?.verdict).toBeNull();
    expect(store.all<{ message_id: string }>(`SELECT message_id FROM examples`)).toEqual([]);
  });

  it('starts replay only from current priority decisions, excluding old answers and aliases', () => {
    const store = setup();
    for (const [id, label, at] of [['old', 'p1', CUT - 1], ['topic', 'bank', CUT + 1], ['current', 'p2', CUT + 2]] as const) {
      oldDecision(store, id, label, at);
      store.run(`UPDATE decisions SET verdict = 'confirmed', verdict_label = ?, verdict_source = 'gmail', verdict_at = ? WHERE message_id = ?`, label, NOW - 1, id);
    }
    const job = startReplay(store, NOW);
    expect(store.all<{ message_id: string }>(`SELECT message_id FROM replay WHERE job_id = ? AND message_id != ''`, job)).toEqual([{ message_id: 'current' }]);
  });
});
