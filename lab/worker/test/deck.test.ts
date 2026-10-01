/** The deck's decision log (docs/design.md §7): replay, undo, 重来 and the materialised state. */
import { describe, expect, it } from 'vitest';
import { DECK_EVENTS_MAX } from '../src/limits.ts';
import type { Decision } from '../src/model.ts';
import { deckState, mutate, replay, type DeckEvent, type Mutation } from '../src/deck.ts';

const PAPERS = ['arxiv:p1', 'arxiv:p2', 'arxiv:p3', 'arxiv:p4'];
const CARDS = PAPERS.map((paper_id, i) => ({ position: i + 1, paper_id }));

function apply(events: DeckEvent[], mutation: Mutation): DeckEvent[] {
  const result = mutate(PAPERS, events, mutation, 1000 + events.length);
  if (!result.ok) throw new Error(result.code);
  return result.event === null ? events : [...events, result.event];
}

const decisions = (events: DeckEvent[]) => Object.fromEntries([...replay(events).decisions].map(([p, d]) => [p, d.decision]));

describe('decide, undo and 重来', () => {
  it('undoes any number of steps back to the first card', () => {
    let log: DeckEvent[] = [];
    log = apply(log, { kind: 'decide', paper_id: 'arxiv:p1', decision: 'like' });
    log = apply(log, { kind: 'decide', paper_id: 'arxiv:p2', decision: 'dislike' });
    log = apply(log, { kind: 'decide', paper_id: 'arxiv:p3', decision: 'like' });
    expect(replay(log).undo).toEqual({ kind: 'decide', paper_id: 'arxiv:p3', decision: 'like' });
    log = apply(log, { kind: 'undo' });
    log = apply(log, { kind: 'undo' });
    expect(decisions(log)).toEqual({ 'arxiv:p1': 'like' });
    log = apply(log, { kind: 'undo' });
    expect(decisions(log)).toEqual({});
    expect(mutate(PAPERS, log, { kind: 'undo' }, 0)).toEqual({ ok: false, code: 'nothing_to_undo' });
  });

  it('makes 重来 one undoable event that brings every cleared decision back', () => {
    let log: DeckEvent[] = [];
    log = apply(log, { kind: 'decide', paper_id: 'arxiv:p1', decision: 'like' });
    log = apply(log, { kind: 'decide', paper_id: 'arxiv:p2', decision: 'dislike' });
    const restart = mutate(PAPERS, log, { kind: 'restart' }, 5);
    expect(restart.ok && restart.applied).toEqual({ kind: 'restart', cleared: 2 });
    log = apply(log, { kind: 'restart' });
    expect(decisions(log)).toEqual({});
    expect(replay(log).undo).toEqual({ kind: 'restart', cleared: 2 });
    // Decide again after 重来, then undo that and the restart itself.
    log = apply(log, { kind: 'decide', paper_id: 'arxiv:p2', decision: 'like' });
    expect(decisions(log)).toEqual({ 'arxiv:p2': 'like' });
    log = apply(log, { kind: 'undo' });
    const undoRestart = mutate(PAPERS, log, { kind: 'undo' }, 9);
    expect(undoRestart.ok && undoRestart.applied).toEqual({ kind: 'undo', undone: { kind: 'restart', cleared: 2 } });
    log = apply(log, { kind: 'undo' });
    expect(decisions(log)).toEqual({ 'arxiv:p1': 'like', 'arxiv:p2': 'dislike' });
  });

  it('refuses what cannot happen and treats an empty 重来 as a no-op', () => {
    let log = apply([], { kind: 'decide', paper_id: 'arxiv:p1', decision: 'like' });
    expect(mutate(PAPERS, log, { kind: 'decide', paper_id: 'arxiv:p1', decision: 'dislike' }, 0)).toEqual({ ok: false, code: 'already_decided' });
    expect(mutate(PAPERS, log, { kind: 'decide', paper_id: 'arxiv:zz', decision: 'like' }, 0)).toEqual({ ok: false, code: 'not_in_deck' });
    log = apply(log, { kind: 'undo' });
    const noop = mutate(PAPERS, log, { kind: 'restart' }, 0);
    expect(noop.ok && noop.event).toBeNull();
    const full: DeckEvent[] = Array.from({ length: DECK_EVENTS_MAX }, (_, i) => ({
      seq: i + 1,
      kind: i % 2 === 0 ? 'decide' : 'undo',
      paper_id: i % 2 === 0 ? 'arxiv:p1' : null,
      decision: i % 2 === 0 ? 'like' : null,
      target_seq: i % 2 === 0 ? null : i,
      at: i,
    }));
    expect(mutate(PAPERS, full, { kind: 'decide', paper_id: 'arxiv:p2', decision: 'like' }, 0)).toEqual({ ok: false, code: 'deck_log_full' });
  });

  it('matches a naive stack model for random operation sequences', () => {
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 200; round++) {
      let log: DeckEvent[] = [];
      // The model: a stack of snapshots; decide/restart push, undo pops.
      const stack: Record<string, Decision>[] = [{}];
      for (let step = 0; step < 30; step++) {
        const current = stack[stack.length - 1] ?? {};
        const r = random();
        let mutation: Mutation;
        if (r < 0.55) {
          const open = PAPERS.filter((p) => !(p in current));
          const paper = open[Math.floor(random() * open.length)];
          if (paper === undefined) continue;
          mutation = { kind: 'decide', paper_id: paper, decision: random() < 0.5 ? 'like' : 'dislike' };
        } else if (r < 0.85) mutation = { kind: 'undo' };
        else mutation = { kind: 'restart' };
        const result = mutate(PAPERS, log, mutation, step);
        if (mutation.kind === 'undo') {
          expect(result.ok).toBe(stack.length > 1);
          if (result.ok) stack.pop();
        } else if (mutation.kind === 'restart') {
          if (Object.keys(current).length > 0) stack.push({});
        } else {
          stack.push({ ...current, [mutation.paper_id]: mutation.decision });
        }
        if (result.ok && result.event !== null) log = [...log, result.event];
        expect(decisions(log)).toEqual(stack[stack.length - 1]);
      }
    }
  });
});

describe('deckState', () => {
  it('counts, finds the next card and carries the undo target', () => {
    let log = apply([], { kind: 'decide', paper_id: 'arxiv:p1', decision: 'like' });
    log = apply(log, { kind: 'decide', paper_id: 'arxiv:p3', decision: 'dislike' });
    const state = deckState('2026-09-30', 2, CARDS, replay(log), null);
    expect(state).toEqual({
      deck_id: '2026-09-30',
      version: 2,
      decisions: { 'arxiv:p1': 'like', 'arxiv:p3': 'dislike' },
      counts: { total: 4, decided: 2, liked: 1, disliked: 1 },
      next_position: 2,
      finished_at: null,
      undo: { kind: 'decide', paper_id: 'arxiv:p3', decision: 'dislike' },
    });
  });
});
