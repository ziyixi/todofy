/** Lab's side of contracts/task-intent-v1 (docs/design.md §9): building intents and mapping every answer. */
import { describe, expect, it } from 'vitest';
import type { TaskIntentResult } from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import {
  asResult,
  buildIntent,
  completed,
  contractErrors,
  freeze,
  heldRetry,
  intentId,
  nextPoll,
  parentTitle,
  pollable,
  sendStatus,
  sha256Hex,
  unfrozen,
  withRejection,
  withResult,
  type SendCard,
  type SendRow,
} from '../src/intent.ts';

const results = import.meta.glob('../../../contracts/task-intent-v1/fixtures/TaskIntentResult/*.json', { import: 'default', eager: true });

const cards: SendCard[] = [
  { position: 3, paper_id: 'arxiv:2609.00003', title: 'Third\n  paper', brief: '第三篇的简介。第二句不进子任务。' },
  { position: 1, paper_id: 'arxiv:2609.00001', title: 'First paper', brief: null },
  { position: 2, paper_id: 'arxiv:hep-th/9901001', title: 'T'.repeat(400), brief: '没有句号' },
];

const row = (overrides: Partial<SendRow> = {}): SendRow => ({
  deck_id: '2026-09-30',
  generation: 1,
  intent_id: 'deck-2026-09-30-g1',
  mode: 'subtasks',
  paper_ids: ['arxiv:2609.00001'],
  payload: '{}',
  payload_sha256: 'a'.repeat(64),
  state: 'sending',
  recorded: false,
  tasks_total: 0,
  tasks_created: 0,
  error_code: null,
  next_poll_at: null,
  created_at: 1_000_000,
  updated_at: 1_000_000,
  ...overrides,
});

describe('buildIntent', () => {
  it('builds a schema-valid intent in deck order with arXiv links and one-line 简介', () => {
    const intent = buildIntent('2026-09-30', 1, 'subtasks', cards, 'lab.example.com');
    expect(intent).not.toBeNull();
    expect(contractErrors('TaskIntent', intent)).toEqual([]);
    expect(intent?.intent_id).toBe('deck-2026-09-30-g1');
    expect(intent?.parent).toEqual({ title: '论文雷达 2026-09-30 · 3 篇', description: '来自 Lab 论文雷达\nhttps://lab.example.com/deck/2026-09-30' });
    expect(intent?.items.map((i) => i.url)).toEqual([
      'https://arxiv.org/abs/2609.00001',
      'https://arxiv.org/abs/hep-th/9901001',
      'https://arxiv.org/abs/2609.00003',
    ]);
    expect(intent?.items[0]).toEqual({ title: 'First paper', url: 'https://arxiv.org/abs/2609.00001' });
    expect(Array.from(intent?.items[1]?.title ?? '').length).toBe(300);
    expect(intent?.items[1]?.description).toBe('没有句号');
    expect(intent?.items[2]).toEqual({ title: 'Third paper', url: 'https://arxiv.org/abs/2609.00003', description: '第三篇的简介。' });
    const json = intent === null ? null : freeze(intent);
    expect(json).not.toBeNull();
    expect(JSON.parse(json ?? 'null')).toEqual(intent);
  });

  it('names later generations 补发 and refuses invalid paper keys', () => {
    expect(intentId('2026-09-30', 2)).toBe('deck-2026-09-30-g2');
    expect(parentTitle('2026-09-30', 2, 1)).toBe('论文雷达 2026-09-30（补发）· 1 篇');
    const separate = buildIntent('2026-09-30', 2, 'separate', cards.slice(0, 1), null);
    expect(contractErrors('TaskIntent', separate)).toEqual([]);
    expect(separate?.parent.description).toBe('来自 Lab 论文雷达');
    expect(buildIntent('2026-09-30', 1, 'subtasks', [{ position: 1, paper_id: 'doi:10.1/x', title: 'x', brief: null }], null)).toBeNull();
    expect(buildIntent('2026-09-30', 1, 'subtasks', [], null)).toBeNull();
  });

  it('hashes the frozen bytes', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('the send row', () => {
  it('maps every TaskIntentResult fixture', () => {
    const now = 2_000_000;
    for (const [path, value] of Object.entries(results)) {
      const result = value as TaskIntentResult;
      const intent = result.intent_id;
      expect(asResult(value, intent), path).toEqual(result);
      expect(asResult(value, 'deck-other-g1'), path).toBeNull();
      const after = withResult(row({ intent_id: intent }), result, now);
      expect(after.state).toBe(result.state === 'not_found' ? 'unknown' : result.state);
      expect(after.recorded).toBe(result.state === 'not_found' ? false : result.recorded);
      expect(after.tasks_created).toBe(result.tasks_created);
      expect(after.error_code).toBe(result.error_code);
      // Polling only while Todofy works or holds it; never faster than 3 s.
      if (pollable(after)) expect(after.next_poll_at ?? 0).toBeGreaterThanOrEqual(now + 3000);
      else expect(after.next_poll_at).toBeNull();
      const status = sendStatus(after);
      expect(status.frozen).toBe(!unfrozen(after));
    }
  });

  it('unfreezes only what Todofy did not record', () => {
    expect(unfrozen({ state: 'paused', recorded: false })).toBe(true);
    expect(unfrozen({ state: 'rejected', recorded: false })).toBe(true);
    expect(unfrozen({ state: 'paused', recorded: true })).toBe(false);
    expect(unfrozen({ state: 'rejected', recorded: true })).toBe(false);
    expect(unfrozen({ state: 'unknown', recorded: false })).toBe(false);
    expect(unfrozen({ state: 'failed', recorded: true })).toBe(false);
    expect(completed({ state: 'created' })).toBe(true);
    expect(completed({ state: 'duplicate' })).toBe(true);
    expect(completed({ state: 'failed' })).toBe(false);
  });

  it('treats a rejected RPC as unknown (retry is safe) except invalid_input', () => {
    const unknown = withRejection(row(), 'unavailable', 5_000_000);
    expect(unknown).toMatchObject({ state: 'unknown', error_code: 'unavailable', recorded: false });
    expect(unknown.next_poll_at).toBe(5_000_000 + 60_000);
    expect(withRejection(row(), 'busy', 1_000_500)).toMatchObject({ state: 'unknown', error_code: 'busy', next_poll_at: 1_003_500 });
    const invalid = withRejection(row(), 'invalid_input', 5_000_000);
    expect(invalid).toMatchObject({ state: 'rejected', error_code: 'invalid_input', recorded: false, next_poll_at: null });
    expect(unfrozen(invalid)).toBe(true);
  });

  it('polls every 3 s at first, then once a minute, honouring retry_after', () => {
    expect(nextPoll(10_000, 0, null, 'pending', true)).toBe(13_000);
    expect(nextPoll(10_000, 0, 20, 'pending', true)).toBe(30_000);
    expect(nextPoll(200_000, 0, 3, 'pending', true)).toBe(260_000);
    expect(nextPoll(10_000, 0, 3, 'paused', true)).toBe(70_000);
    expect(nextPoll(10_000, 0, 3, 'created', true)).toBeNull();
    expect(nextPoll(10_000, 0, 3, 'paused', false)).toBeNull();
  });

  it('keeps a retry of a failed send failed when Todofy held it for a pause (nothing was re-queued)', () => {
    const held = heldRetry(row({ state: 'paused', recorded: true, error_code: 'todoist_paused', tasks_total: 3, tasks_created: 1, next_poll_at: 5 }));
    expect(held).toMatchObject({ state: 'failed', recorded: true, error_code: 'todoist_paused', tasks_created: 1, next_poll_at: null });
    expect(pollable(held)).toBe(false);
    expect(sendStatus(held).frozen).toBe(true);
    // Anything else passes through.
    const pending = row({ state: 'pending', recorded: true });
    expect(heldRetry(pending)).toBe(pending);
    const unrecorded = row({ state: 'paused', recorded: false });
    expect(heldRetry(unrecorded)).toBe(unrecorded);
  });
});
