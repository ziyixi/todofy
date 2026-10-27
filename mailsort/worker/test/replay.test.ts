/**
 * The retired replay evaluation's stored results over the store on Node's SQLite (./fakes/sql.ts); the workerd suite
 * (runtime/replay.test.ts) reads them over the API. The summary's cases (at most REPLAY_CASES_MAX, without the mails
 * evaluated before the numbers were recorded) and reason counts, and the API message as wire JSON: exactly those
 * fields, no mail content. Labels and IDs are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { NONE, REPLAY_CASES_MAX } from '../src/limits.ts';
import { replayMessage } from '../src/model.ts';
import { replaySummary } from '../src/replay.ts';
import { Store } from '../src/store.ts';
import { memorySql } from './fakes/sql.ts';

const T0 = Date.parse('2026-10-08T08:00:00Z');

/**
 * The fields a case may have: the decision's numbers, the owner's answer and the outcome. Never
 * `needs_action_probability`: the question is no longer asked (2026-10-11), so the optional field stays unset.
 */
const CASE_FIELDS = [
  'owner_label', 'outcome', 'top_label', 'top_probability', 'runner_up_probability', 'second_view_probability', 'combined_probability',
  'suspicious_probability', 'authenticated', 'trust_implying', 'reason',
];

describe('the summary\'s cases', () => {
  function store(): Store {
    const s = new Store(memorySql());
    s.migrate();
    s.run(`INSERT INTO replay (job_id, message_id, state, create_time, done_time) VALUES ('j', '', 'succeeded', ?, ?)`, T0, T0);
    return s;
  }

  function evaluated(s: Store, id: string, asOf: number, row: Record<string, string | number | null>): void {
    const columns = Object.keys(row);
    s.run(
      `INSERT INTO replay (job_id, message_id, state, as_of, create_time, done_time, ${columns.join(', ')}) VALUES ('j', ?, 'evaluated', ?, ?, ?, ${columns.map(() => '?').join(', ')})`,
      id, asOf, T0, T0, ...Object.values(row),
    );
  }

  it('answers each evaluated mail\'s numbers in the order of the original decisions, and the uncertain ones per reason', () => {
    const s = store();
    // m2 was evaluated before 2026-10-11 and still holds a p(needs_action): it is no longer answered.
    evaluated(s, 'm2', T0 - 1000, {
      owner_label: 'bank', outcome: 'unsure', label: 'bank', reason: 'untrusted_sender', top_option: 'bank', top_p: 0.9, runner_up_p: 0.05, view2_p: 0.92,
      combined: 0.9, suspicious: 0, needs_action: 0.05, authenticated: 1, trust: 1,
    });
    evaluated(s, 'm1', T0 - 2000, {
      owner_label: '', outcome: 'none', label: null, reason: '', top_option: NONE, top_p: 0.92, runner_up_p: 0.02, view2_p: null, combined: 0.92,
      suspicious: 0.05, authenticated: 0, trust: 0,
    });
    evaluated(s, 'm3', T0 - 500, {
      owner_label: 'receipt', outcome: 'unsure', label: null, reason: 'model_unavailable', top_option: null, top_p: null, runner_up_p: null, view2_p: null,
      combined: null, suspicious: null, authenticated: 1, trust: 0,
    });
    // Evaluated before the numbers were recorded: counted, no case.
    evaluated(s, 'm0', T0 - 3000, { owner_label: 'bank', outcome: 'unsure', label: 'bank', reason: 'untrusted_sender' });
    s.run(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES ('j', 'm4', 'skipped', 'receipt', ?, ?)`, T0, T0);
    s.run(`INSERT INTO replay (job_id, message_id, state, owner_label, as_of, create_time) VALUES ('j', 'm5', 'pending', 'receipt', ?, ?)`, T0, T0);

    const summary = replaySummary(s);
    expect(summary).toMatchObject({ evaluated: 4, skipped: 1, unsure: 3 });
    expect(summary?.reasonCounts).toEqual({ model_unavailable: 1, untrusted_sender: 2 });
    expect(summary?.cases.map((c) => c.outcome)).toEqual(['none', 'unsure', 'unsure']);

    // As the browser reads it: exactly the case's fields, an unset probability left out, a zero one written.
    const wire = toWire(ReplayEvaluationSchema, replayMessage(summary ?? expect.unreachable())) as Record<string, unknown>;
    expect(wire['reason_counts']).toEqual({ model_unavailable: 1, untrusted_sender: 2 });
    const cases = wire['cases'] as Record<string, unknown>[];
    for (const c of cases) expect(CASE_FIELDS).toEqual(expect.arrayContaining(Object.keys(c)));
    expect(cases).toEqual([
      { outcome: 'none', top_probability: 0.92, runner_up_probability: 0.02, combined_probability: 0.92, suspicious_probability: 0.05 },
      {
        owner_label: 'labels/bank', outcome: 'unsure', top_label: 'labels/bank', top_probability: 0.9, runner_up_probability: 0.05, second_view_probability: 0.92,
        combined_probability: 0.9, suspicious_probability: 0, authenticated: true, trust_implying: true, reason: 'untrusted_sender',
      },
      { owner_label: 'labels/receipt', outcome: 'unsure', authenticated: true, reason: 'model_unavailable' },
    ]);
  });

  it('answers at most REPLAY_CASES_MAX cases', () => {
    const s = store();
    for (let i = 0; i < REPLAY_CASES_MAX + 5; i++) {
      evaluated(s, `m${String(i).padStart(3, '0')}`, T0 + i, { owner_label: '', outcome: 'none', top_option: NONE, top_p: 0.9, runner_up_p: 0.1, combined: 0.9, suspicious: 0, authenticated: 1, trust: 0 });
    }
    const summary = replaySummary(s);
    expect(summary?.evaluated).toBe(REPLAY_CASES_MAX + 5);
    expect(summary?.cases).toHaveLength(REPLAY_CASES_MAX);
    expect(summary?.reasonCounts).toEqual({});
  });
});
