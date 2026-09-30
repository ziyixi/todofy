/**
 * The deck's decision log (docs/design.md §7), as pure functions: an append-only list of decide / undo /
 * restart events whose replay is the effective state. `undo` cancels the latest effective decide or
 * restart (any number of times, back to the first card); `restart` (重来) clears every decision and is
 * itself undoable. LabState materialises the replay into D1 in the same batch as the event.
 */
import { DECK_EVENTS_MAX, type Decision, type DeckMutationResponse, type DeckState, type PaperId, type UndoTarget } from './api-types.ts';

export type EventKind = 'decide' | 'undo' | 'restart';

export interface DeckEvent {
  readonly seq: number;
  readonly kind: EventKind;
  readonly paper_id: PaperId | null;
  readonly decision: Decision | null;
  readonly target_seq: number | null;
  readonly at: number;
}

export interface Replay {
  /** Effective decision per paper, with the seq of the decide event. */
  readonly decisions: ReadonlyMap<PaperId, { readonly decision: Decision; readonly seq: number }>;
  /** What the next undo takes back. */
  readonly undo: UndoTarget;
  /** The seq of the event the next undo cancels, or null. */
  readonly undoSeq: number | null;
}

export function replay(events: readonly DeckEvent[]): Replay {
  const cancelled = new Set<number>();
  for (const event of events) if (event.kind === 'undo' && event.target_seq !== null) cancelled.add(event.target_seq);
  const decisions = new Map<PaperId, { decision: Decision; seq: number }>();
  let undo: UndoTarget = null;
  let undoSeq: number | null = null;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === 'undo' || cancelled.has(event.seq)) continue;
    if (event.kind === 'decide' && event.paper_id !== null && event.decision !== null) {
      decisions.set(event.paper_id, { decision: event.decision, seq: event.seq });
      undo = { kind: 'decide', paper_id: event.paper_id, decision: event.decision };
      undoSeq = event.seq;
    } else if (event.kind === 'restart') {
      undo = { kind: 'restart', cleared: decisions.size };
      undoSeq = event.seq;
      decisions.clear();
    }
  }
  return { decisions, undo, undoSeq };
}

export type MutationError = 'not_in_deck' | 'already_decided' | 'nothing_to_undo' | 'deck_log_full';

export type Mutation =
  | { readonly kind: 'decide'; readonly paper_id: PaperId; readonly decision: Decision }
  | { readonly kind: 'undo' }
  | { readonly kind: 'restart' };

export type MutationResult =
  | { readonly ok: true; readonly event: DeckEvent | null; readonly applied: DeckMutationResponse['applied']; readonly after: Replay }
  | { readonly ok: false; readonly code: MutationError };

/**
 * Applies one mutation to the log. `event` is null for a no-op (重来 with nothing decided), which
 * appends nothing and does not bump the version.
 */
export function mutate(papers: readonly PaperId[], events: readonly DeckEvent[], mutation: Mutation, at: number): MutationResult {
  const before = replay(events);
  const seq = events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  switch (mutation.kind) {
    case 'decide': {
      if (!papers.includes(mutation.paper_id)) return { ok: false, code: 'not_in_deck' };
      if (before.decisions.has(mutation.paper_id)) return { ok: false, code: 'already_decided' };
      if (seq > DECK_EVENTS_MAX) return { ok: false, code: 'deck_log_full' };
      const event: DeckEvent = { seq, kind: 'decide', paper_id: mutation.paper_id, decision: mutation.decision, target_seq: null, at };
      return { ok: true, event, applied: { kind: 'decide', paper_id: mutation.paper_id, decision: mutation.decision }, after: replay([...events, event]) };
    }
    case 'undo': {
      if (before.undo === null || before.undoSeq === null) return { ok: false, code: 'nothing_to_undo' };
      if (seq > DECK_EVENTS_MAX) return { ok: false, code: 'deck_log_full' };
      const event: DeckEvent = { seq, kind: 'undo', paper_id: null, decision: null, target_seq: before.undoSeq, at };
      return { ok: true, event, applied: { kind: 'undo', undone: before.undo }, after: replay([...events, event]) };
    }
    case 'restart': {
      if (before.decisions.size === 0) return { ok: true, event: null, applied: { kind: 'restart', cleared: 0 }, after: before };
      if (seq > DECK_EVENTS_MAX) return { ok: false, code: 'deck_log_full' };
      const event: DeckEvent = { seq, kind: 'restart', paper_id: null, decision: null, target_seq: null, at };
      return { ok: true, event, applied: { kind: 'restart', cleared: before.decisions.size }, after: replay([...events, event]) };
    }
  }
}

export interface CardRef {
  readonly position: number;
  readonly paper_id: PaperId;
}

/** The API's DeckState from the frozen cards and a replay. */
export function deckState(
  deckId: string,
  version: number,
  cards: readonly CardRef[],
  state: Pick<Replay, 'decisions' | 'undo'>,
  finishedAt: string | null,
): DeckState {
  const decisions: Record<PaperId, Decision> = {};
  let liked = 0;
  let disliked = 0;
  let next: number | null = null;
  for (const card of [...cards].sort((a, b) => a.position - b.position)) {
    const entry = state.decisions.get(card.paper_id);
    if (entry === undefined) {
      next ??= card.position;
      continue;
    }
    decisions[card.paper_id] = entry.decision;
    if (entry.decision === 'like') liked++;
    else disliked++;
  }
  return {
    deck_id: deckId,
    version,
    decisions,
    counts: { total: cards.length, decided: liked + disliked, liked, disliked },
    next_position: next,
    finished_at: finishedAt,
    undo: state.undo,
  };
}
