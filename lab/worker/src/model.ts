/**
 * Lab's internal records (docs/design.md §7-§9): the views D1 and LabState produce and the owner op log stores,
 * in Lab's own snake_case shapes with the wire names D1 keeps (`'like'`, `'subtasks'`). They are not the owner
 * API: src/api.ts maps them to lab.ui.v1 messages (proto/lab/ui/v1), the one description of what the UI sees.
 * The value rules of that API (sizes, counts) are in limits.ts, which the UI imports too.
 */
import type { ErrorCode, Mode } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import type { WireName } from '@ziyixi/proto/wire-json';
import type { TldrModel } from './models.ts';

/** `arxiv:<id>` without version, e.g. `arxiv:2609.35773`. */
export type PaperId = string;
/** `YYYY-MM-DD`: the feed's announce date (US Eastern calendar day of the channel pubDate). Also the deck id. */
export type Day = string;
/** RFC 3339 UTC. */
export type Timestamp = string;
/** UUID v4 chosen by the browser for one mutation. */
export type OpId = string;
export type Decision = 'like' | 'dislike';
/**
 * task-intent-v1's Mode and ErrorCode by wire name, derived from the generated enums (proto/README.md), so a
 * new code in the IDL is a type error in src/api.ts until it maps to lab.ui.v1's SendErrorCode.
 */
export type SendMode = WireName<typeof Mode>;
export type TodofyErrorCode = WireName<typeof ErrorCode>;

export interface Paper {
  readonly id: PaperId;
  /** Latest version number seen, e.g. 1. */
  readonly version: number;
  readonly title: string;
  readonly authors: string;
  readonly categories: readonly string[];
  readonly primary_category: string;
  readonly abstract: string;
  readonly announce_type: 'new' | 'cross';
  readonly announced_on: Day;
  /** Built from the ID only: https://arxiv.org/abs/<id> and https://arxiv.org/pdf/<id>. */
  readonly abs_url: string;
  readonly pdf_url: string;
  /** A newer version was announced after the owner liked it. */
  readonly new_version: boolean;
}

export interface DeckCard {
  /** 1-based, frozen when the deck was made. */
  readonly position: number;
  readonly paper: Paper;
  /** 2–4 Chinese sentences from the abstract (plain text); null when missing (cap, refused output). */
  readonly brief: string | null;
  /** The nearest liked or seed paper ("为什么推荐"); null on explore decks. */
  readonly because: { readonly id: PaperId; readonly title: string } | null;
}

export type DeckKind = 'ranked' | 'explore';

/** What an undo can take back next, for the button label and the fly-back animation. */
export type UndoTarget =
  | { readonly kind: 'decide'; readonly paper_id: PaperId; readonly decision: Decision }
  | { readonly kind: 'restart'; readonly cleared: number }
  | null;

/** The mutable part of a deck; every mutation returns it. */
export interface DeckState {
  readonly deck_id: Day;
  /** Bumped by every decide/undo/restart; send it back as base_version. */
  readonly version: number;
  readonly decisions: Readonly<Record<PaperId, Decision>>;
  readonly counts: { readonly total: number; readonly decided: number; readonly liked: number; readonly disliked: number };
  /** Position of the first undecided card; null when every card is decided. */
  readonly next_position: number | null;
  readonly finished_at: Timestamp | null;
  readonly undo: UndoTarget;
}

export interface Deck {
  readonly deck_id: Day;
  readonly kind: DeckKind;
  readonly created_at: Timestamp;
  readonly cards: readonly DeckCard[];
  readonly state: DeckState;
  /** The latest send of this deck, if any. */
  readonly send: SendStatus | null;
  readonly later_at: Timestamp | null;
}

export type BuildPhase = 'waiting' | 'fetching' | 'embedding' | 'ranking' | 'summarizing' | 'paused' | 'cap_hit' | 'failed';

export interface DeckPointer {
  readonly deck_id: Day;
  readonly kind: DeckKind;
  readonly total: number;
  readonly decided: number;
  readonly finished: boolean;
}

export interface TodayResponse {
  /** The newest ready deck; null before the first one exists. */
  readonly deck: DeckPointer | null;
  /** Set while the next deck is being prepared (or the pipeline is held); null when idle. */
  readonly building: { readonly day: Day | null; readonly phase: BuildPhase } | null;
  /** The next scheduled feed fetch. */
  readonly next_run_at: Timestamp | null;
  /** No seeds and no likes yet: the deck is an explore deck, the UI invites seeds. */
  readonly cold_start: boolean;
  /** Unfinished decks other than `deck`, at most DECK_OFFER_DAYS old, newest first. */
  readonly older_unfinished: readonly DeckPointer[];
  /** Today's banner, e.g. the neuron cap was hit or the feed is stale; null when all is well. */
  readonly notice: 'cap_hit' | 'feed_stale' | 'paused' | null;
}

export interface DeckMutationResponse {
  readonly state: DeckState;
  /** What this call changed (decide: the card; undo: what was taken back; restart: how many were cleared). */
  readonly applied:
    | { readonly kind: 'decide'; readonly paper_id: PaperId; readonly decision: Decision }
    | { readonly kind: 'undo'; readonly undone: NonNullable<UndoTarget> }
    | { readonly kind: 'restart'; readonly cleared: number };
}

export interface SummaryItem {
  readonly position: number;
  readonly paper_id: PaperId;
  readonly title: string;
  /** The 简介's first sentence (what the Todoist subtask carries); null without 简介. */
  readonly brief_line: string | null;
  readonly abs_url: string;
  /** Removed from the next send by the owner (the like stays). */
  readonly excluded: boolean;
  /** The send generation that carried it; null while unsent. */
  readonly sent_generation: number | null;
}

export interface DeckSummary {
  readonly deck_id: Day;
  readonly state: DeckState;
  /** Liked cards in deck order. */
  readonly liked: readonly SummaryItem[];
  /** Liked, not excluded, not yet sent: what 发送 would send now. */
  readonly sendable: number;
  readonly send: SendStatus | null;
  /** The owner's default mode (settings). */
  readonly default_mode: SendMode;
}

/**
 * Lab's view of one send generation (docs/design.md §9). `sending`: stored, RPC in flight; `unknown`: the RPC
 * rejected, so Lab does not know whether Todofy recorded it (a retry is safe). The rest mirror
 * task-intent-v1 states.
 */
export type SendState = 'sending' | 'pending' | 'created' | 'duplicate' | 'paused' | 'failed' | 'rejected' | 'unknown';

export interface SendStatus {
  readonly generation: number;
  readonly intent_id: string;
  readonly mode: SendMode;
  readonly state: SendState;
  /** Todofy holds it; when false (paused, rejected) the next send may change content and mode. */
  readonly recorded: boolean;
  /** Papers in this send. */
  readonly items: number;
  readonly tasks_total: number;
  readonly tasks_created: number;
  /** A task-intent-v1 error code, or Lab's own `invalid_input` / `unavailable` / `busy`. */
  readonly error_code: TodofyErrorCode | 'invalid_input' | 'unavailable' | 'busy' | null;
  /** The content is frozen: a retry resends it unchanged. */
  readonly frozen: boolean;
  /** When the UI may poll again; null when settled. */
  readonly poll_after: Timestamp | null;
  readonly updated_at: Timestamp;
}

export interface LikedPaper extends Paper {
  readonly liked_at: Timestamp;
  readonly deck_id: Day | null;
  readonly brief: string | null;
}
export interface LikedResponse {
  readonly papers: readonly LikedPaper[];
  readonly next_cursor: string | null;
}

export interface FeedbackResponse {
  readonly paper_id: PaperId;
  readonly label: Decision | null;
}

export type SeedState = 'pending' | 'resolved' | 'not_found';
export interface Seed {
  readonly paper_id: PaperId;
  readonly title: string | null;
  readonly state: SeedState;
  readonly added_at: Timestamp;
}
export interface SeedsResponse {
  readonly seeds: readonly Seed[];
}
export interface Settings {
  /** e.g. ['cs.IR', 'cs.CL', 'cs.LG'], at most CATEGORIES_MAX. */
  readonly categories: readonly string[];
  /** λ of the negative centroid, 0–1. */
  readonly lambda: number;
  /** Daily neuron cap, at most `ceiling`. */
  readonly neuron_cap: number;
  /** The 简介 model. */
  readonly tldr_model: TldrModel;
  readonly ingest_paused: boolean;
  readonly send_mode: SendMode;
}
export interface SettingsResponse extends Settings {
  /** LAB_DAILY_NEURONS (read-only). */
  readonly ceiling: number;
  readonly tldr_models: readonly TldrModel[];
}

export interface StatusResponse {
  readonly counters: {
    readonly ingested_24h: number;
    readonly ranked_24h: number;
    readonly liked_7d: number;
    readonly decided_7d: number;
    readonly neurons_today: number;
    readonly neuron_cap: number;
  };
  readonly last_fetch_at: Timestamp | null;
  readonly last_fetch_error: string | null;
  readonly guard: { readonly level: 'normal' | 'shed'; readonly until: Timestamp | null };
  readonly build: string | null;
}
