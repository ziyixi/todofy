/**
 * The owner's deck end to end in workerd (docs/design.md §7–§9, docs/ux.md): swipe the whole deck, undo,
 * 重来 and undo it, finish, exclude one, send to the stub Todofy over a real service binding, poll to created,
 * resend (no duplicate), 补发 a later like as generation 2, and the failure paths (paused, unknown, lost
 * response). Every intent Todofy received passed the task-intent-v1 schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deck, DeckMutationResponse, DeckState, DeckSummary, FeedbackResponse, LikedResponse, SendStatus, SettingsResponse } from '../../src/api-types.ts';
import { dayItems, rssFeed } from '../feeds.ts';
import { op, startHarness, type Harness } from './harness.ts';

const DAY = '2026-09-30';
const T0 = Date.parse('2026-09-30T06:30:00Z');

let h: Harness;
let deck: Deck;
beforeEach(async () => {
  h = await startHarness();
  h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
  await h.run(T0);
  deck = await h.get<Deck>(`/api/decks/${DAY}`);
});
afterEach(async () => {
  await h.dispose();
});

async function decide(paper: string, decision: 'like' | 'dislike', base: number, opId = op()) {
  return h.mutate<DeckMutationResponse & { error?: { code: string }; state?: DeckState }>('POST', `/api/decks/${DAY}/decide`, {
    op_id: opId,
    base_version: base,
    paper_id: paper,
    decision,
  });
}

/** Likes the positions in `liked`, dislikes the rest, in deck order; returns the final state. */
async function swipeAll(liked: readonly number[]): Promise<DeckState> {
  let state = deck.state;
  for (const card of deck.cards) {
    const answer = await decide(card.paper.id, liked.includes(card.position) ? 'like' : 'dislike', state.version);
    expect(answer.status).toBe(200);
    state = answer.body.state;
  }
  return state;
}

describe('the deck', () => {
  it('records swipes, undoes any number of steps, and makes 重来 undoable', async () => {
    const [first, second, third] = deck.cards;
    if (!first || !second || !third) throw new Error('deck too small');
    let answer = await decide(first.paper.id, 'like', 0);
    expect(answer.body.applied).toEqual({ kind: 'decide', paper_id: first.paper.id, decision: 'like' });
    expect(answer.body.state).toMatchObject({ version: 1, next_position: 2, counts: { decided: 1, liked: 1 } });
    expect((await decide(second.paper.id, 'dislike', 1)).status).toBe(200);
    answer = await decide(third.paper.id, 'like', 2);
    expect(answer.body.state.undo).toEqual({ kind: 'decide', paper_id: third.paper.id, decision: 'like' });

    // The same op_id again (a retried request after a lost response) returns the first answer unchanged.
    const opId = op();
    const once = await h.mutate<DeckMutationResponse>('POST', `/api/decks/${DAY}/undo`, { op_id: opId, base_version: 3 });
    const twice = await h.mutate<DeckMutationResponse>('POST', `/api/decks/${DAY}/undo`, { op_id: opId, base_version: 3 });
    expect(twice.body).toEqual(once.body);
    expect(once.body.applied).toEqual({ kind: 'undo', undone: { kind: 'decide', paper_id: third.paper.id, decision: 'like' } });
    expect(once.body.state).toMatchObject({ version: 4, next_position: 3 });

    // A stale base_version (another device) is a conflict carrying the current state.
    const stale = await decide(third.paper.id, 'like', 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('deck_changed');
    expect(stale.body.state).toMatchObject({ version: 4 });
    const twiceDecided = await decide(first.paper.id, 'dislike', 4);
    expect(twiceDecided.status).toBe(409);
    expect(twiceDecided.body.error?.code).toBe('already_decided');

    // 重来 clears both remaining decisions in one undoable event.
    const restart = await h.mutate<DeckMutationResponse>('POST', `/api/decks/${DAY}/restart`, { op_id: op(), base_version: 4 });
    expect(restart.body.applied).toEqual({ kind: 'restart', cleared: 2 });
    expect(restart.body.state).toMatchObject({ version: 5, next_position: 1, counts: { decided: 0 }, undo: { kind: 'restart', cleared: 2 } });
    expect(await h.sql('SELECT paper_id FROM feedback')).toEqual([]);
    const back = await h.mutate<DeckMutationResponse>('POST', `/api/decks/${DAY}/undo`, { op_id: op(), base_version: 5 });
    expect(back.body.state.decisions).toEqual({ [first.paper.id]: 'like', [second.paper.id]: 'dislike' });
    expect((await h.sql<{ label: string }>('SELECT label FROM feedback ORDER BY label')).map((r) => r.label)).toEqual(['dislike', 'like']);

    // Undo back to the first card, then nothing is left.
    await h.mutate('POST', `/api/decks/${DAY}/undo`, { op_id: op(), base_version: 6 });
    await h.mutate('POST', `/api/decks/${DAY}/undo`, { op_id: op(), base_version: 7 });
    const empty = await h.mutate<{ error: { code: string } }>('POST', `/api/decks/${DAY}/undo`, { op_id: op(), base_version: 8 });
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe('nothing_to_undo');
    const reloaded = await h.get<Deck>(`/api/decks/${DAY}`);
    expect(reloaded.state).toMatchObject({ version: 8, counts: { decided: 0 }, undo: null, next_position: 1 });
  });

  it('refuses mutations without CSRF, bad input and unknown decks', async () => {
    const card = deck.cards[0];
    const bare = await h.fetch(`/api/decks/${DAY}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
      body: JSON.stringify({ op_id: op(), base_version: 0, paper_id: card?.paper.id, decision: 'like' }),
    });
    expect(bare.status).toBe(403);
    expect((await decide('arxiv:../../x', 'like', 0)).status).toBe(400);
    expect((await h.mutate('POST', `/api/decks/${DAY}/decide`, { op_id: 'not-a-uuid', base_version: 0, paper_id: card?.paper.id, decision: 'like' })).status).toBe(400);
    expect((await h.mutate('POST', `/api/decks/${DAY}/decide`, { op_id: op(), base_version: 0, paper_id: card?.paper.id, decision: 'love' })).status).toBe(400);
    expect((await h.fetch('/api/decks/2026-09-29')).status).toBe(404);
    expect((await h.fetch('/api/decks/2026-02-30')).status).toBe(404);
    expect((await decide('arxiv:2609.99999', 'like', 0)).status).toBe(404);
    expect((await h.fetch('/api/nothing')).status).toBe(404);
  });
});

describe('sending to Todofy', () => {
  it('sends the liked papers once, polls to created, and 补发 later likes as a second generation', async () => {
    const state = await swipeAll([1, 2, 4, 7]);
    expect(state.finished_at).not.toBeNull();
    expect(state.counts).toEqual({ total: 20, decided: 20, liked: 4, disliked: 16 });

    let summary = await h.get<DeckSummary>(`/api/decks/${DAY}/summary`);
    expect(summary.liked.map((i) => i.position)).toEqual([1, 2, 4, 7]);
    expect(summary.sendable).toBe(4);
    expect(summary.default_mode).toBe('subtasks');
    expect(summary.liked[0]?.brief_line).toBe('本文提出一种合成的检索方法。');

    const removed = deck.cards.find((c) => c.position === 4)?.paper.id ?? '';
    summary = (await h.mutate<DeckSummary>('POST', `/api/decks/${DAY}/exclude`, { op_id: op(), paper_id: removed, excluded: true })).body;
    expect(summary.sendable).toBe(3);
    expect(summary.liked.find((i) => i.paper_id === removed)?.excluded).toBe(true);

    const sendOp = op();
    const sent = await h.mutate<SendStatus>('POST', `/api/decks/${DAY}/send`, { op_id: sendOp, mode: 'subtasks' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ generation: 1, intent_id: `deck-${DAY}-g1`, state: 'pending', recorded: true, items: 3, tasks_total: 4, frozen: true });
    // Excluding a paper that is being sent is refused.
    const late = await h.mutate<{ error: { code: string } }>('POST', `/api/decks/${DAY}/exclude`, { op_id: op(), paper_id: deck.cards[0]?.paper.id, excluded: true });
    expect(late.body.error.code).toBe('send_in_progress');

    // The same op again is a replay: no second proposal.
    const replay = await h.mutate<SendStatus>('POST', `/api/decks/${DAY}/send`, { op_id: sendOp, mode: 'subtasks' });
    expect(replay.body.intent_id).toBe(`deck-${DAY}-g1`);
    let todofy = await h.todofyState();
    expect(todofy.calls.filter((c) => c.method === 'proposeTasks')).toHaveLength(1);
    expect(todofy.invalid).toBe(0);
    const intent = todofy.intents[0]?.intent;
    expect(intent?.mode).toBe('subtasks');
    expect(intent?.parent.title).toBe(`论文雷达 ${DAY} · 3 篇`);
    expect(intent?.items.map((i) => i.url)).toEqual([1, 2, 7].map((p) => deck.cards.find((c) => c.position === p)?.paper.abs_url));

    // GET …/send polls Todofy once the poll time has come (3 s).
    let status = await h.get<SendStatus>(`/api/decks/${DAY}/send`);
    expect(status.state).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 3100));
    status = await h.get<SendStatus>(`/api/decks/${DAY}/send`);
    expect(status).toMatchObject({ state: 'created', tasks_created: 4, poll_after: null });
    summary = await h.get<DeckSummary>(`/api/decks/${DAY}/summary`);
    expect(summary.liked.filter((i) => i.sent_generation === 1).map((i) => i.position)).toEqual([1, 2, 7]);
    expect(summary.sendable).toBe(0);
    expect((await h.mutate<{ error: { code: string } }>('POST', `/api/decks/${DAY}/send`, { op_id: op(), mode: 'subtasks' })).body.error.code).toBe('nothing_to_send');

    // A later like in the same deck (undo the last dislike, like it): 补发 as g2, nothing sent twice.
    const lastCard = deck.cards[19];
    let answer = await h.mutate<DeckMutationResponse>('POST', `/api/decks/${DAY}/undo`, { op_id: op(), base_version: state.version });
    answer = await decide(lastCard?.paper.id ?? '', 'like', answer.body.state.version);
    expect(answer.status).toBe(200);
    const again = await h.mutate<SendStatus>('POST', `/api/decks/${DAY}/send`, { op_id: op(), mode: 'separate' });
    expect(again.body).toMatchObject({ generation: 2, intent_id: `deck-${DAY}-g2`, items: 1, tasks_total: 1, mode: 'separate' });
    todofy = await h.todofyState();
    const g2 = todofy.intents.find((i) => i.id === `deck-${DAY}-g2`)?.intent;
    expect(g2?.parent.title).toBe(`论文雷达 ${DAY}（补发）· 1 篇`);
    expect(g2?.items.map((i) => i.url)).toEqual([lastCard?.paper.abs_url]);
    expect(todofy.invalid).toBe(0);
  });

  it('unfreezes a send Todofy did not record, and resends the identical payload after an unknown result', async () => {
    await swipeAll([1, 3]);
    await h.todofy({ propose: 'paused' });
    const paused = await h.mutate<SendStatus>('POST', `/api/decks/${DAY}/send`, { op_id: op(), mode: 'subtasks' });
    expect(paused.body).toMatchObject({ state: 'paused', recorded: false, frozen: false, error_code: 'todoist_paused', poll_after: null });
    // Nothing is held: the next send may change the mode and content (same generation, same intent id).
    await h.mutate('POST', `/api/decks/${DAY}/exclude`, { op_id: op(), paper_id: deck.cards[2]?.paper.id, excluded: true });
    await h.todofy({ propose: 'throw' });
    const unknown = await h.mutate<SendStatus>('POST', `/api/decks/${DAY}/send`, { op_id: op(), mode: 'separate' });
    expect(unknown.body).toMatchObject({ generation: 1, state: 'unknown', frozen: true, error_code: 'unavailable', items: 1, mode: 'separate' });
    // A retry resends the frozen payload even if the owner picks another mode now.
    await h.todofy({});
    const retried = await h.mutate<SendStatus>('POST', `/api/decks/${DAY}/send`, { op_id: op(), mode: 'subtasks' });
    expect(retried.body).toMatchObject({ generation: 1, state: 'pending', recorded: true, mode: 'separate', items: 1 });
    const todofy = await h.todofyState();
    expect(todofy.intents).toHaveLength(1);
    expect(todofy.intents[0]?.intent.mode).toBe('separate');
    expect(todofy.invalid).toBe(0);
    const rows = await h.sql<{ payload_sha256: string; state: string }>('SELECT payload_sha256, state FROM sends');
    expect(rows).toHaveLength(1);
  });

  it('asks Todofy after a lost answer and proposes again when it never arrived', async () => {
    await swipeAll([2]);
    await h.todofy({ propose: 'throw' });
    const unknown = await h.mutate<SendStatus>('POST', `/api/decks/${DAY}/send`, { op_id: op(), mode: 'subtasks' });
    expect(unknown.body.state).toBe('unknown');
    await h.todofy({});
    // The poll time (3 s after the first attempt) has to pass; then GET asks taskIntentStatus: not_found → propose.
    await h.sql('UPDATE sends SET next_poll_at = 0');
    const status = await h.get<SendStatus>(`/api/decks/${DAY}/send`);
    expect(status).toMatchObject({ state: 'pending', recorded: true });
    const todofy = await h.todofyState();
    expect(todofy.calls.map((c) => c.method)).toEqual(['proposeTasks', 'taskIntentStatus', 'proposeTasks']);
  });
});

describe('the library, feedback and settings', () => {
  it('lists likes, unlikes from the library and saves settings within the ceiling', async () => {
    await swipeAll([1, 5]);
    let liked = await h.get<LikedResponse>('/api/liked');
    expect(liked.papers).toHaveLength(2);
    expect(liked.papers[0]?.brief).not.toBeNull();
    expect(liked.next_cursor).toBeNull();
    const searched = await h.get<LikedResponse>(`/api/liked?q=${encodeURIComponent(liked.papers[0]?.title.slice(0, 12) ?? '')}`);
    expect(searched.papers.length).toBeGreaterThan(0);
    expect((await h.fetch('/api/liked?cursor=bad')).status).toBe(400);

    const unliked = await h.mutate<FeedbackResponse>('POST', '/api/feedback', { op_id: op(), paper_id: liked.papers[0]?.id, label: null });
    expect(unliked.body).toEqual({ paper_id: liked.papers[0]?.id, label: null });
    liked = await h.get<LikedResponse>('/api/liked');
    expect(liked.papers).toHaveLength(1);

    const settings = await h.get<SettingsResponse>('/api/settings');
    expect(settings).toMatchObject({ ceiling: 5000, neuron_cap: 5000, send_mode: 'subtasks' });
    const body = { op_id: op(), categories: ['cs.IR'], lambda: 0.5, neuron_cap: 1500, tldr_model: '@cf/qwen/qwen3-30b-a3b-fp8', ingest_paused: true, send_mode: 'separate' };
    const saved = await h.mutate<SettingsResponse>('PUT', '/api/settings', body);
    expect(saved.body).toMatchObject({ categories: ['cs.IR'], neuron_cap: 1500, ingest_paused: true, send_mode: 'separate' });
    expect((await h.mutate('PUT', '/api/settings', { ...body, op_id: op(), neuron_cap: 6000 })).status).toBe(400);
    expect((await h.get<DeckSummary>(`/api/decks/${DAY}/summary`)).default_mode).toBe('separate');
    // Paused ingest: the next slot does not fetch.
    const before = h.requests.length;
    await h.run(T0 + 86_400_000);
    expect(h.requests.length).toBe(before);
  });
});
