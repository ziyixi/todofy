/**
 * The owner's deck end to end in workerd (docs/design.md §7–§9, docs/ux.md), through LabUiService and the shared
 * typed client exactly as the UI calls it: swipe the whole deck, undo, 重来 and undo it, finish, exclude one, send
 * to the stub Todofy over a real service binding, poll to created, resend (no duplicate), 补发 a later like as
 * generation 2, and the failure paths (paused, unknown, lost response). Every intent Todofy received passed the
 * task-intent-v1 schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcStatusError } from '@ziyixi/proto/http-client';
import { DeckStateSchema, Send_State, SendErrorCode, SendMode, UndoKind, type Deck, type DeckState } from '@ziyixi/proto/lab/ui/v1/deck_pb';
import { Seed_State } from '@ziyixi/proto/lab/ui/v1/library_pb';
import { Decision } from '@ziyixi/proto/lab/ui/v1/paper_pb';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { quoteLiteral } from '@ziyixi/proto/filter';
import { readDetail } from '@ziyixi/proto/rpc-status';
import { dayItems, rssFeed } from '../feeds.ts';
import { op, startHarness, type Harness } from './harness.ts';

const DAY = '2026-09-30';
const NAME = `decks/${DAY}`;
const T0 = Date.parse('2026-09-30T06:30:00Z');

let h: Harness;
let deck: Deck;
beforeEach(async () => {
  h = await startHarness();
  h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
  await h.run(T0);
  deck = await h.api.getDeck({ name: NAME });
});
afterEach(async () => {
  await h.dispose();
});

/**
 * The etag of the deck state of `version`. Clients treat etags as opaque; Lab writes the version's decimal
 * digits (src/api.ts etagOf, pinned by test/api.test.ts), so these tests can name the state they act on.
 */
const etagOf = (version: number): string => String(version);

/** A decide on the state of `version`. */
function decide(paperId: string, decision: Decision, version: number, requestId = op()) {
  return h.api.decideDeck({ name: NAME, paperId, decision, etag: etagOf(version), requestId });
}

/** The RpcStatusError a call rejects with. */
async function refused(call: Promise<unknown>): Promise<RpcStatusError> {
  const error = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof RpcStatusError)) throw new Error(`expected an RpcStatusError, got ${String(error)}`);
  return error;
}

/** Likes the positions in `liked`, dislikes the rest, in deck order; returns the final state. */
async function swipeAll(liked: readonly number[]): Promise<DeckState> {
  let state = deck.state;
  for (const card of deck.cards) {
    const paper = card.paper?.id ?? '';
    state = (await decide(paper, liked.includes(card.position) ? Decision.LIKE : Decision.DISLIKE, state?.version ?? 0)).state;
  }
  if (state === undefined) throw new Error('no state');
  return state;
}

const paperOf = (position: number): string => deck.cards.find((c) => c.position === position)?.paper?.id ?? '';

describe('the deck', () => {
  it('records swipes, undoes any number of steps, and makes 重来 undoable', async () => {
    const [first, second, third] = [paperOf(1), paperOf(2), paperOf(3)];
    let answer = await decide(first, Decision.LIKE, 0);
    expect(answer.state).toMatchObject({ deck: NAME, version: 1, nextPosition: 2, counts: { decidedCount: 1, likedCount: 1 } });
    await decide(second, Decision.DISLIKE, 1);
    answer = await decide(third, Decision.LIKE, 2);
    expect(answer.state?.undo).toMatchObject({ kind: UndoKind.DECIDE, paperId: third, decision: Decision.LIKE });

    // The same request_id again (a retried request after a lost response) returns the first answer unchanged.
    const requestId = op();
    const once = await h.api.undoDeck({ name: NAME, etag: etagOf(3), requestId });
    const twice = await h.api.undoDeck({ name: NAME, etag: etagOf(3), requestId });
    expect(twice).toEqual(once);
    expect(once.undone).toMatchObject({ kind: UndoKind.DECIDE, paperId: third, decision: Decision.LIKE });
    expect(once.state).toMatchObject({ version: 4, nextPosition: 3 });

    // A stale etag (another device) is DECK_CHANGED carrying the current state; a malformed one is BAD_REQUEST.
    const stale = await refused(decide(third, Decision.LIKE, 1));
    expect(stale.status).toMatchObject({ httpStatus: 409, status: 'ABORTED', reason: 'DECK_CHANGED', domain: 'lab.ziyixi.science' });
    expect(stale.status.localizedMessage?.message).toBe('这组卡片已在其他设备上改动');
    expect(readDetail(stale.status, DeckStateSchema)).toMatchObject({ version: 4, etag: once.state?.etag });
    expect((await refused(h.api.decideDeck({ name: NAME, paperId: third, decision: Decision.LIKE, etag: 'W/"4"', requestId: op() }))).status.reason).toBe('BAD_REQUEST');
    const twiceDecided = await refused(decide(first, Decision.DISLIKE, 4));
    expect(twiceDecided.status).toMatchObject({ httpStatus: 409, reason: 'ALREADY_DECIDED' });

    // 重来 clears both remaining decisions in one undoable event.
    const restart = await h.api.restartDeck({ name: NAME, etag: etagOf(4), requestId: op() });
    expect(restart.clearedCount).toBe(2);
    expect(restart.state).toMatchObject({ version: 5, nextPosition: 1, counts: { decidedCount: 0 }, undo: { kind: UndoKind.RESTART, clearedCount: 2 } });
    expect(await h.sql('SELECT paper_id FROM feedback')).toEqual([]);
    const back = await h.api.undoDeck({ name: NAME, etag: etagOf(5), requestId: op() });
    expect(back.state?.decisions).toEqual({ [first]: Decision.LIKE, [second]: Decision.DISLIKE });
    expect((await h.sql<{ label: string }>('SELECT label FROM feedback ORDER BY label')).map((r) => r.label)).toEqual(['dislike', 'like']);

    // Undo back to the first card, then nothing is left.
    await h.api.undoDeck({ name: NAME, etag: etagOf(6), requestId: op() });
    await h.api.undoDeck({ name: NAME, etag: etagOf(7), requestId: op() });
    const empty = await refused(h.api.undoDeck({ name: NAME, etag: etagOf(8), requestId: op() }));
    expect(empty.status).toMatchObject({ httpStatus: 400, status: 'FAILED_PRECONDITION', reason: 'NOTHING_TO_UNDO' });
    const reloaded = await h.api.getDeck({ name: NAME });
    expect(reloaded.state).toMatchObject({ version: 8, counts: { decidedCount: 0 }, nextPosition: 1 });
    expect(reloaded.state?.undo).toBeUndefined();
  });

  it('refuses mutations without CSRF, bad input and unknown decks', async () => {
    const card = paperOf(1);
    const bare = await h.fetch(`/api/v1/${NAME}:decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
      body: JSON.stringify({ request_id: op(), etag: '0', paper_id: card, decision: 'like' }),
    });
    expect(bare.status).toBe(403);
    expect(((await bare.json()) as { error: { status: string } }).error.status).toBe('PERMISSION_DENIED');
    expect((await refused(decide('arxiv:../../x', Decision.LIKE, 0))).status.reason).toBe('BAD_REQUEST');
    const raw = (body: unknown) => h.mutate('POST', `/api/v1/${NAME}:decide`, body);
    expect((await raw({ request_id: 'not-a-uuid', etag: '0', paper_id: card, decision: 'like' })).status).toBe(400);
    expect((await raw({ request_id: op(), etag: '0', paper_id: card, decision: 'love' })).status).toBe(400);
    expect((await raw({ request_id: op(), etag: '0', paper_id: card, decision: 'like', extra: 1 })).status).toBe(400);
    expect((await refused(h.api.getDeck({ name: 'decks/2026-09-29' }))).status).toMatchObject({ httpStatus: 404, reason: 'DECK_NOT_FOUND' });
    expect((await refused(h.api.getDeck({ name: 'decks/2026-02-30' }))).status.reason).toBe('DECK_NOT_FOUND');
    expect((await refused(decide('arxiv:2609.99999', Decision.LIKE, 0))).status).toMatchObject({ httpStatus: 404, reason: 'NOT_IN_DECK' });
    // Without a request_id a mutation still works (nothing to deduplicate it by).
    expect((await raw({ etag: '0', paper_id: card, decision: 'like' })).status).toBe(200);
  });
});

describe('sending to Todofy', () => {
  it('sends the liked papers once, polls to created, and 补发 later likes as a second generation', async () => {
    const state = await swipeAll([1, 2, 4, 7]);
    expect(state.finishTime).toBeDefined();
    expect(state.counts).toMatchObject({ cardCount: 20, decidedCount: 20, likedCount: 4, dislikedCount: 16 });

    let summary = await h.api.getDeckSummary({ name: `${NAME}/summary` });
    expect(summary.likedItems.map((i) => i.position)).toEqual([1, 2, 4, 7]);
    expect(summary.sendableCount).toBe(4);
    expect(summary.defaultMode).toBe(SendMode.SUBTASKS);
    expect(summary.likedItems[0]?.briefLine).toBe('本文提出一种合成的检索方法。');

    const removed = paperOf(4);
    summary = await h.api.excludePaper({ name: `${NAME}/summary`, paperId: removed, excluded: true, requestId: op() });
    expect(summary.sendableCount).toBe(3);
    expect(summary.likedItems.find((i) => i.paperId === removed)?.excluded).toBe(true);

    const sendRequest = op();
    const sent = (await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: sendRequest })).send;
    expect(sent).toMatchObject({ name: `${NAME}/send`, generation: 1, intentId: `deck-${DAY}-g1`, state: Send_State.PENDING, recorded: true, itemCount: 3, totalTaskCount: 4, frozen: true });
    // Excluding a paper that is being sent is refused.
    const late = await refused(h.api.excludePaper({ name: `${NAME}/summary`, paperId: paperOf(1), excluded: true, requestId: op() }));
    expect(late.status.reason).toBe('SEND_IN_PROGRESS');

    // The same request again is a replay: no second proposal.
    const replay = (await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: sendRequest })).send;
    expect(replay?.intentId).toBe(`deck-${DAY}-g1`);
    let todofy = await h.todofyState();
    expect(todofy.calls.filter((c) => c.method === 'proposeTasks')).toHaveLength(1);
    expect(todofy.invalid).toBe(0);
    const intent = todofy.intents[0]?.intent;
    expect(intent?.mode).toBe('subtasks');
    expect(intent?.parent.title).toBe(`论文雷达 ${DAY} · 3 篇`);
    expect(intent?.items.map((i) => i.url)).toEqual([1, 2, 7].map((p) => deck.cards.find((c) => c.position === p)?.paper?.abstractUri));

    // GetSend asks Todofy once the poll time has come (3 s).
    let status = await h.api.getSend({ name: `${NAME}/send` });
    expect(status.state).toBe(Send_State.PENDING);
    await new Promise((resolve) => setTimeout(resolve, 3100));
    status = await h.api.getSend({ name: `${NAME}/send` });
    expect(status).toMatchObject({ state: Send_State.CREATED, createdTaskCount: 4 });
    expect(status.nextPollTime).toBeUndefined();
    summary = await h.api.getDeckSummary({ name: `${NAME}/summary` });
    expect(summary.likedItems.filter((i) => i.sentGeneration === 1).map((i) => i.position)).toEqual([1, 2, 7]);
    expect(summary.sendableCount).toBe(0);
    expect((await refused(h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: op() }))).status.reason).toBe('NOTHING_TO_SEND');

    // A later like in the same deck (undo the last dislike, like it): 补发 as g2, nothing sent twice.
    const undone = await h.api.undoDeck({ name: NAME, etag: state.etag, requestId: op() });
    const liked = await decide(paperOf(20), Decision.LIKE, undone.state?.version ?? 0);
    expect(liked.state?.decisions[paperOf(20)]).toBe(Decision.LIKE);
    const again = (await h.api.sendDeck({ name: NAME, mode: SendMode.SEPARATE, requestId: op() })).send;
    expect(again).toMatchObject({ generation: 2, intentId: `deck-${DAY}-g2`, itemCount: 1, totalTaskCount: 1, mode: SendMode.SEPARATE });
    todofy = await h.todofyState();
    const g2 = todofy.intents.find((i) => i.id === `deck-${DAY}-g2`)?.intent;
    expect(g2?.parent.title).toBe(`论文雷达 ${DAY}（补发）· 1 篇`);
    expect(g2?.items.map((i) => i.url)).toEqual([deck.cards[19]?.paper?.abstractUri]);
    expect(todofy.invalid).toBe(0);
  });

  it('unfreezes a send Todofy did not record, and resends the identical payload after an unknown result', async () => {
    await swipeAll([1, 3]);
    await h.todofy({ propose: 'paused' });
    const paused = (await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: op() })).send;
    expect(paused).toMatchObject({ state: Send_State.PAUSED, recorded: false, frozen: false, errorCode: SendErrorCode.TODOIST_PAUSED });
    expect(paused?.nextPollTime).toBeUndefined();
    // Nothing is held: the next send may change the mode and content (same generation, same intent id).
    await h.api.excludePaper({ name: `${NAME}/summary`, paperId: paperOf(3), excluded: true, requestId: op() });
    await h.todofy({ propose: 'throw' });
    const unknown = (await h.api.sendDeck({ name: NAME, mode: SendMode.SEPARATE, requestId: op() })).send;
    expect(unknown).toMatchObject({ generation: 1, state: Send_State.UNKNOWN, frozen: true, errorCode: SendErrorCode.UNAVAILABLE, itemCount: 1, mode: SendMode.SEPARATE });
    // A retry resends the frozen payload even if the owner picks another mode now.
    await h.todofy({});
    const retried = (await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: op() })).send;
    expect(retried).toMatchObject({ generation: 1, state: Send_State.PENDING, recorded: true, mode: SendMode.SEPARATE, itemCount: 1 });
    const todofy = await h.todofyState();
    expect(todofy.intents).toHaveLength(1);
    expect(todofy.intents[0]?.intent.mode).toBe('separate');
    expect(todofy.invalid).toBe(0);
    expect(await h.sql('SELECT payload_sha256, state FROM sends')).toHaveLength(1);
  });

  it('asks Todofy after a lost answer and proposes again when it never arrived', async () => {
    await swipeAll([2]);
    await h.todofy({ propose: 'throw' });
    expect((await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: op() })).send?.state).toBe(Send_State.UNKNOWN);
    await h.todofy({});
    // The poll time (3 s after the first attempt) has to pass; then GetSend asks taskIntentStatus: not_found → propose.
    await h.sql('UPDATE sends SET next_poll_at = 0');
    expect(await h.api.getSend({ name: `${NAME}/send` })).toMatchObject({ state: Send_State.PENDING, recorded: true });
    const todofy = await h.todofyState();
    expect(todofy.calls.map((c) => c.method)).toEqual(['proposeTasks', 'taskIntentStatus', 'proposeTasks']);
  });

  it('answers NOT_FOUND for the send of a deck that has none', async () => {
    expect((await refused(h.api.getSend({ name: `${NAME}/send` }))).status).toMatchObject({ httpStatus: 404, reason: 'NOT_FOUND' });
  });
});

describe('retries and replays', () => {
  it('polls fast again after a retry, and keeps a retry Todofy held during a pause failed with the pause as reason', async () => {
    await swipeAll([1, 2]);
    expect((await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: op() })).send?.state).toBe(Send_State.PENDING);
    // Todoist refuses a task; the first attempt is long past the fast poll window by now.
    await h.todofy({ status: 'failed' });
    await h.sql('UPDATE sends SET next_poll_at = 0, created_at = created_at - 600000');
    const failed = await h.api.getSend({ name: `${NAME}/send` });
    expect(failed).toMatchObject({ state: Send_State.FAILED, errorCode: SendErrorCode.TODOIST_REJECTED, frozen: true });
    expect(failed.nextPollTime).toBeUndefined();

    // 重试 while Todofy is paused: nothing is re-queued there, so it stays failed here (no "resumes by itself").
    await h.todofy({ propose: 'held' });
    const held = (await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: op() })).send;
    expect(held).toMatchObject({ generation: 1, state: Send_State.FAILED, recorded: true, errorCode: SendErrorCode.TODOIST_PAUSED, frozen: true });
    expect(held?.nextPollTime).toBeUndefined();

    // 重试 after the pause: Todofy re-queues it, and Lab asks again within seconds, not a minute.
    await h.todofy({});
    const before = Date.now();
    const retried = (await h.api.sendDeck({ name: NAME, mode: SendMode.SUBTASKS, requestId: op() })).send;
    expect(retried).toMatchObject({ generation: 1, state: Send_State.PENDING, recorded: true });
    const wait = (retried?.nextPollTime === undefined ? 0 : timestampMs(retried.nextPollTime)) - before;
    expect(wait).toBeGreaterThanOrEqual(2_000);
    expect(wait).toBeLessThan(10_000);
    const todofy = await h.todofyState();
    expect(todofy.intents).toHaveLength(1);
    expect(todofy.invalid).toBe(0);
  });

  it('re-derives LabState’s ranking mirror and seeds from D1 when a request is replayed after its D1 write committed', async () => {
    const counters = async () => ((await h.ops('status')).ok as { counters: { liked_7d: number; decided_7d: number } }).counters;
    const [first, second, sixth] = [paperOf(1), paperOf(2), paperOf(6)];
    await decide(first, Decision.LIKE, 0);
    expect(await counters()).toMatchObject({ liked_7d: 1, decided_7d: 1 });
    // The op log row LabState stores for a deck mutation: Lab's internal record of the answer.
    const stored = (await h.sql<{ response: string }>("SELECT response FROM owner_ops WHERE route = 'deck.decide'"))[0]?.response ?? '';

    // A decide whose D1 batch committed but whose call failed before the mirror was written (the D1 rows it
    // wrote, as the batch writes them); the client retries with the same request_id.
    const decideOp = op();
    const now = Date.now();
    await h.sql("INSERT INTO feedback (paper_id, label, source, deck_id, at) VALUES (?, 'like', 'deck', ?, ?)", second, DAY, now);
    await h.sql("INSERT INTO owner_ops (op_id, route, deck_id, status, response, at) VALUES (?, 'deck.decide', ?, 200, ?, ?)", decideOp, DAY, stored, now);
    expect((await counters()).liked_7d).toBe(1);
    await decide(second, Decision.LIKE, 1, decideOp);
    expect(await counters()).toMatchObject({ liked_7d: 2, decided_7d: 2 });

    // The same for library feedback (取消喜欢)…
    const unlikeOp = op();
    await h.sql('DELETE FROM feedback WHERE paper_id = ?', first);
    await h.sql("INSERT INTO owner_ops (op_id, route, deck_id, status, response, at) VALUES (?, 'feedback', NULL, 200, '{}', ?)", unlikeOp, now);
    await h.api.deleteLikedPaper({ name: `likedPapers/${first.replace('arxiv:', '')}`, requestId: unlikeOp });
    expect((await counters()).liked_7d).toBe(1);

    // …and for a seed: LabState learns it, so the pipeline resolves it (here at once: its vector exists).
    const seedOp = op();
    await h.sql("INSERT INTO seeds (paper_id, added_at, state) VALUES (?, ?, 'pending')", sixth, now);
    await h.sql("INSERT INTO owner_ops (op_id, route, deck_id, status, response, at) VALUES (?, 'seeds.add', NULL, 200, '{}', ?)", seedOp, now);
    await h.api.importSeeds({ inputs: [sixth.replace('arxiv:', '')], requestId: seedOp });
    await h.run(T0 + 3_600_000);
    const seeds = await h.api.listSeeds({});
    expect(seeds.seeds.map((s) => [s.paperId, s.state, s.name])).toEqual([[sixth, Seed_State.RESOLVED, `seeds/${sixth.replace('arxiv:', '')}`]]);
  });
});

describe('standard methods by the AIPs', () => {
  const idOf = (paper: string) => paper.replace('arxiv:', '');
  const labels = () => h.sql<{ paper_id: string; label: string }>('SELECT paper_id, label FROM feedback ORDER BY paper_id');

  it('AIP-135: a Delete of a like or seed that does not exist is NOT_FOUND and changes nothing; a replay succeeds', async () => {
    const [first, second] = [paperOf(1), paperOf(2)];
    await decide(first, Decision.DISLIKE, 0);
    await decide(second, Decision.LIKE, 1);
    // A stale library tab removes the like of a paper that is disliked by now: the dislike stays.
    const disliked = await refused(h.api.deleteLikedPaper({ name: `likedPapers/${idOf(first)}`, requestId: op() }));
    expect(disliked.status).toMatchObject({ httpStatus: 404, reason: 'NOT_FOUND' });
    expect(await labels()).toEqual([
      { paper_id: first, label: 'dislike' },
      { paper_id: second, label: 'like' },
    ]);
    // A like goes; the same request_id again (a lost answer) still succeeds; a new request is NOT_FOUND.
    const requestId = op();
    await h.api.deleteLikedPaper({ name: `likedPapers/${idOf(second)}`, requestId });
    await h.api.deleteLikedPaper({ name: `likedPapers/${idOf(second)}`, requestId });
    expect((await refused(h.api.deleteLikedPaper({ name: `likedPapers/${idOf(second)}`, requestId: op() }))).status.reason).toBe('NOT_FOUND');
    expect(await labels()).toEqual([{ paper_id: first, label: 'dislike' }]);

    // A seed that was never added.
    expect((await refused(h.api.deleteSeed({ name: 'seeds/2601.00042', requestId: op() }))).status).toMatchObject({ httpStatus: 404, reason: 'NOT_FOUND' });
    await h.api.importSeeds({ inputs: ['2601.00042'], requestId: op() });
    const seedOp = op();
    await h.api.deleteSeed({ name: 'seeds/2601.00042', requestId: seedOp });
    await h.api.deleteSeed({ name: 'seeds/2601.00042', requestId: seedOp });
    expect((await refused(h.api.deleteSeed({ name: 'seeds/2601.00042', requestId: op() }))).status.reason).toBe('NOT_FOUND');
  });

  it('AIP-133/122: a resource ID has no slash; an old-style arXiv ID writes it as ~', async () => {
    expect((await refused(h.api.createLikedPaper({ likedPaper: {}, likedPaperId: 'hep-th/9901001', requestId: op() }))).status.reason).toBe('BAD_REQUEST');
    // The ~ form names the paper (here one Lab never stored).
    expect((await refused(h.api.createLikedPaper({ likedPaper: {}, likedPaperId: 'hep-th~9901001', requestId: op() }))).status.reason).toBe('NOT_FOUND');
    const slash = await h.mutate('DELETE', `/api/v1/likedPapers/hep-th%2F9901001?request_id=${op()}`);
    expect(slash.status).toBe(400);
    const created = await h.api.createLikedPaper({ likedPaper: {}, likedPaperId: idOf(paperOf(3)), requestId: op() });
    expect(created.name).toBe(`likedPapers/${idOf(paperOf(3))}`);
  });

  it('AIP-158: page tokens are opaque and bound to the filter; page_size bounds ListSeeds too', async () => {
    await swipeAll([1, 2, 3, 4]);
    const filter = 'e'; // in every synthetic title
    const pages: string[] = [];
    let token = '';
    do {
      const page = await h.api.listLikedPapers({ filter, pageSize: 1, pageToken: token });
      pages.push(...page.likedPapers.map((p) => p.name));
      token = page.nextPageToken;
      expect(token).not.toMatch(/arxiv|~/); // not the readable cursor
    } while (token !== '' && pages.length < 10);
    expect(pages).toHaveLength(4);
    expect(new Set(pages).size).toBe(4);
    const first = await h.api.listLikedPapers({ filter, pageSize: 1 });
    // The token of one filter does not continue another list.
    expect((await refused(h.api.listLikedPapers({ filter: 'l', pageSize: 1, pageToken: first.nextPageToken }))).status.reason).toBe('BAD_REQUEST');
    expect((await refused(h.api.listLikedPapers({ pageToken: first.nextPageToken }))).status.reason).toBe('BAD_REQUEST');
    // page_size may change between pages; a hand-made cursor is refused.
    expect((await h.api.listLikedPapers({ filter, pageSize: 3, pageToken: first.nextPageToken })).likedPapers).toHaveLength(3);
    expect((await refused(h.api.listLikedPapers({ pageToken: `${String(Date.now())}~${paperOf(1)}` }))).status.reason).toBe('BAD_REQUEST');

    await h.api.importSeeds({ inputs: ['2601.00042', '2601.00043', '2601.00044'], requestId: op() });
    const seeds: string[] = [];
    token = '';
    do {
      const page = await h.api.listSeeds({ pageSize: 1, pageToken: token });
      expect(page.seeds.length).toBeLessThanOrEqual(1);
      seeds.push(...page.seeds.map((s) => s.name));
      token = page.nextPageToken;
    } while (token !== '' && seeds.length < 10);
    expect(seeds).toEqual((await h.api.listSeeds({})).seeds.map((s) => s.name));
    expect(new Set(seeds).size).toBe(3);
    expect((await refused(h.api.listSeeds({ pageSize: -1 }))).status.reason).toBe('BAD_REQUEST');
  });

  it('AIP-160: the filter is a conjunction of literals; a quoted string is one phrase; other syntax is refused', async () => {
    await swipeAll([1]);
    // The liked title's first two words, e.g. "Dense retrieval".
    const [one = '', two = ''] = (deck.cards[0]?.paper?.title ?? '').split(' ');
    const count = async (filter: string) => (await h.api.listLikedPapers({ filter })).likedPapers.length;
    expect(await count(`${two} ${one}`)).toBe(1); // two literals, both in the title
    expect(await count(`"${two} ${one}"`)).toBe(0); // one phrase, not in the title
    expect(await count(`"${one} ${two}"`)).toBe(1);
    expect(await count(`${one} AND missing`)).toBe(0);
    for (const filter of ['a OR b', 'NOT a', '-a', 'title:x', 'a.b', '"open']) {
      expect((await refused(h.api.listLikedPapers({ filter }))).status.reason, filter).toBe('BAD_REQUEST');
    }
  });

  it('AIP-134: an update_mask replaces only the settings it names', async () => {
    const before = await h.api.getSettings({ name: 'settings' });
    const saved = await h.api.updateSettings({ settings: { name: 'settings', sendMode: SendMode.SEPARATE }, updateMask: { paths: ['send_mode'] }, requestId: op() });
    expect(saved).toMatchObject({ sendMode: SendMode.SEPARATE, categories: before.categories, neuronCap: before.neuronCap, dislikeWeight: before.dislikeWeight });
    // Two updates of different fields (two tabs) both stay.
    await h.api.updateSettings({ settings: { name: 'settings', neuronCap: 1200 }, updateMask: { paths: ['neuron_cap'] }, requestId: op() });
    await h.api.updateSettings({ settings: { name: 'settings', ingestPaused: true }, updateMask: { paths: ['ingest_paused'] }, requestId: op() });
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ sendMode: SendMode.SEPARATE, neuronCap: 1200, ingestPaused: true, categories: before.categories });
    // A masked REQUIRED field must be present; an unknown path is refused; output-only paths are ignored.
    expect((await h.mutate('PATCH', `/api/v1/settings?update_mask=neuron_cap&request_id=${op()}`, {})).status).toBe(400);
    expect((await h.mutate('PATCH', `/api/v1/settings?update_mask=color&request_id=${op()}`, {})).status).toBe(400);
    const ignored = await h.mutate('PATCH', `/api/v1/settings?update_mask=neuron_ceiling&request_id=${op()}`, { neuron_ceiling: 9 });
    expect(ignored.status).toBe(200);
    expect(((await ignored.json()) as { neuron_ceiling: number }).neuron_ceiling).toBe(5000);
  });
});

describe('the library, feedback and settings', () => {
  it('lists likes, unlikes and likes again from the library, and saves settings within the ceiling', async () => {
    await swipeAll([1, 5]);
    let liked = await h.api.listLikedPapers({});
    expect(liked.likedPapers).toHaveLength(2);
    expect(liked.likedPapers[0]?.brief).toBeDefined();
    expect(liked.likedPapers[0]?.deck).toBe(NAME);
    expect(liked.nextPageToken).toBe('');
    const title = liked.likedPapers[0]?.paper?.title ?? '';
    expect((await h.api.listLikedPapers({ filter: quoteLiteral(title.slice(0, 12)) })).likedPapers.length).toBeGreaterThan(0);
    expect((await h.api.listLikedPapers({ pageSize: 1 })).nextPageToken).not.toBe('');
    expect((await refused(h.api.listLikedPapers({ pageToken: 'bad' }))).status.reason).toBe('BAD_REQUEST');

    const name = liked.likedPapers[0]?.name ?? '';
    expect(name).toMatch(/^likedPapers\/2609\.\d{5}$/);
    await h.api.deleteLikedPaper({ name, requestId: op() });
    liked = await h.api.listLikedPapers({});
    expect(liked.likedPapers).toHaveLength(1);
    const again = await h.api.createLikedPaper({ likedPaper: {}, likedPaperId: name.slice('likedPapers/'.length), requestId: op() });
    expect(again).toMatchObject({ name, paper: { title } });
    expect((await refused(h.api.createLikedPaper({ likedPaper: {}, likedPaperId: name.slice('likedPapers/'.length), requestId: op() }))).status).toMatchObject({
      httpStatus: 409,
      reason: 'ALREADY_LIKED',
    });
    expect((await refused(h.api.deleteLikedPaper({ name: 'likedPapers/2609.99999', requestId: op() }))).status.reason).toBe('NOT_FOUND');

    const settings = await h.api.getSettings({ name: 'settings' });
    expect(settings).toMatchObject({ name: 'settings', neuronCeiling: 5000, neuronCap: 5000, sendMode: SendMode.SUBTASKS });
    const next = { ...settings, categories: ['cs.IR'], dislikeWeight: 0.5, neuronCap: 1500, summaryModel: '@cf/qwen/qwen3-30b-a3b-fp8', ingestPaused: true, sendMode: SendMode.SEPARATE };
    const saved = await h.api.updateSettings({ settings: next, requestId: op() });
    expect(saved).toMatchObject({ categories: ['cs.IR'], dislikeWeight: 0.5, neuronCap: 1500, ingestPaused: true, sendMode: SendMode.SEPARATE });
    expect((await refused(h.api.updateSettings({ settings: { ...next, neuronCap: 6000 }, requestId: op() }))).status.reason).toBe('BAD_REQUEST');
    expect((await h.api.getDeckSummary({ name: `${NAME}/summary` })).defaultMode).toBe(SendMode.SEPARATE);
    // Paused ingest: the next slot does not fetch.
    const before = h.requests.length;
    await h.run(T0 + 86_400_000);
    expect(h.requests.length).toBe(before);
  });
});
