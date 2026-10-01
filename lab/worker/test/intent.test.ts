/** Lab's side of contracts/task-intent-v1 (docs/design.md §9): building intents and mapping every answer. */
import { describe, expect, it } from 'vitest';
import { TaskIntentRefSchema, TaskIntentResultSchema, TaskIntentSchema } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
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
  statusRef,
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

/** The wire JSON of a built intent (what Lab freezes and Todofy reads). */
function wire(intent: ReturnType<typeof buildIntent>) {
  if (intent === null) throw new Error('Lab built no intent');
  return toWire(TaskIntentSchema, intent) as {
    intent_id: string;
    parent: { title: string; description?: string };
    items: { title: string; url?: string; description?: string }[];
  };
}

describe('buildIntent', () => {
  it('builds a schema-valid intent in deck order with arXiv links and one-line 简介', () => {
    const intent = wire(buildIntent('2026-09-30', 1, 'subtasks', cards, 'lab.example.com'));
    expect(contractErrors('TaskIntent', intent)).toEqual([]);
    expect(intent.intent_id).toBe('deck-2026-09-30-g1');
    expect(intent.parent).toEqual({ title: '论文雷达 2026-09-30 · 3 篇', description: '来自 Lab 论文雷达\nhttps://lab.example.com/deck/2026-09-30' });
    expect(intent.items.map((i) => i.url)).toEqual([
      'https://arxiv.org/abs/2609.00001',
      'https://arxiv.org/abs/hep-th/9901001',
      'https://arxiv.org/abs/2609.00003',
    ]);
    expect(intent.items[0]).toEqual({ title: 'First paper', url: 'https://arxiv.org/abs/2609.00001' });
    expect(Array.from(intent.items[1]?.title ?? '').length).toBe(300);
    expect(intent.items[1]?.description).toBe('没有句号');
    expect(intent.items[2]).toEqual({ title: 'Third paper', url: 'https://arxiv.org/abs/2609.00003', description: '第三篇的简介。' });
    const json = freeze(buildIntent('2026-09-30', 1, 'subtasks', cards, 'lab.example.com') ?? fail());
    expect(json).toBe(JSON.stringify(intent));
  });

  it('freezes the same bytes as the hand-written builder it replaced (Todofy hashes them)', () => {
    // Exactly what Lab froze before the generated types (2026-09-30): keys in schema order, compact JSON,
    // an item's description only when it has a 简介. A recorded send replays these bytes; Todofy compares hashes.
    const before = JSON.stringify({
      version: 'task-intent-v1',
      source: 'lab',
      intent_id: 'deck-2026-09-30-g2',
      mode: 'separate',
      parent: { title: '论文雷达 2026-09-30（补发）· 3 篇', description: '来自 Lab 论文雷达' },
      items: [
        { title: 'First paper', url: 'https://arxiv.org/abs/2609.00001' },
        { title: `${'T'.repeat(299)}…`, url: 'https://arxiv.org/abs/hep-th/9901001', description: '没有句号' },
        { title: 'Third paper', url: 'https://arxiv.org/abs/2609.00003', description: '第三篇的简介。' },
      ],
    });
    expect(freeze(buildIntent('2026-09-30', 2, 'separate', cards, null) ?? fail())).toBe(before);
  });

  it('asks about an intent with the TaskIntentRef bytes of the hand-written builder', () => {
    const ref = statusRef('deck-2026-09-30-g1');
    expect(JSON.stringify(ref)).toBe('{"version":"task-intent-v1","source":"lab","intent_id":"deck-2026-09-30-g1"}');
    expect(contractErrors('TaskIntentRef', ref)).toEqual([]);
    expect(fromWire(TaskIntentRefSchema, ref, { strict: true }).message.intentId).toBe('deck-2026-09-30-g1');
  });

  it('names later generations 补发 and refuses invalid paper keys', () => {
    expect(intentId('2026-09-30', 2)).toBe('deck-2026-09-30-g2');
    expect(parentTitle('2026-09-30', 2, 1)).toBe('论文雷达 2026-09-30（补发）· 1 篇');
    const separate = wire(buildIntent('2026-09-30', 2, 'separate', cards.slice(0, 1), null));
    expect(contractErrors('TaskIntent', separate)).toEqual([]);
    expect(separate.parent.description).toBe('来自 Lab 论文雷达');
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
      const fixture = value as { intent_id: string; state: string; recorded: boolean; tasks_created: number; error_code: string | null };
      const intent = fixture.intent_id;
      const result = asResult(value, intent);
      if (result === null) throw new Error(`${path} does not read`);
      expect(toWire(TaskIntentResultSchema, result), path).toEqual(value);
      expect(asResult(value, 'deck-other-g1'), path).toBeNull();
      const after = withResult(row({ intent_id: intent }), result, now);
      expect(after.state).toBe(fixture.state === 'not_found' ? 'unknown' : fixture.state);
      expect(after.recorded).toBe(fixture.state === 'not_found' ? false : fixture.recorded);
      expect(after.tasks_created).toBe(fixture.tasks_created);
      expect(after.error_code).toBe(fixture.error_code);
      // Polling only while Todofy works or holds it; never faster than 3 s.
      if (pollable(after)) expect(after.next_poll_at ?? 0).toBeGreaterThanOrEqual(now + 3000);
      else expect(after.next_poll_at).toBeNull();
      const status = sendStatus(after);
      expect(status.frozen).toBe(!unfrozen(after));
    }
  });

  it('reads a newer Todofy leniently: an unknown code is no reason, an unknown state an unreadable answer', () => {
    const created = Object.values(results).find((v) => (v as { state: string }).state === 'created') as Record<string, unknown>;
    const intent = created['intent_id'] as string;
    // An error code and a field this build does not know: the state is still read, the code as none.
    const newer = asResult({ ...created, state: 'failed', error_code: 'quota_exhausted', hint_code: 'x' }, intent);
    expect(newer).not.toBeNull();
    if (newer === null) return;
    expect(withResult(row({ intent_id: intent }), newer, 1)).toMatchObject({ state: 'failed', error_code: null, next_poll_at: null });
    // A state this build does not know takes the default branch: unreadable, Lab asks again later.
    expect(asResult({ ...created, state: 'archived' }, intent)).toBeNull();
  });

  it('applies the value rules its control flow depends on, and the codec the structure', () => {
    const created = Object.values(results).find((v) => (v as { state: string }).state === 'created') as Record<string, unknown>;
    const intent = created['intent_id'] as string;
    expect(asResult(created, intent)).not.toBeNull();
    for (const bad of [
      { tasks_total: 32 },
      { tasks_created: -1 },
      { retry_after_seconds: 0 },
      { retry_after_seconds: 86_401 },
      { version: 'task-intent-v2' },
      { source: 'other' },
      { recorded: null },
      { recorded: 'true' },
      { tasks_total: 4.5 },
      { updated_at: '2026-09-30 14:03:07' },
      { updated_at: null },
    ]) {
      expect(asResult({ ...created, ...bad }, intent), JSON.stringify(bad)).toBeNull();
    }
    const missing = { ...created };
    delete missing['tasks_total'];
    expect(asResult(missing, intent)).toBeNull();
    expect(asResult(null, intent)).toBeNull();
    expect(asResult('created', intent)).toBeNull();
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

function fail(): never {
  throw new Error('Lab built no intent');
}
