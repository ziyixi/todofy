/**
 * Owner API of the Worker "lab" (docs/design.md §7), shared with the UI (web/ imports this file by relative
 * path). Change it only together with the UI. Every route needs the Access owner; mutations also need Origin
 * + CSRF (header X-CSRF-Token, cookie lab_csrf). Errors: `{error: {code, message, request_id}}`.
 */
import type { TldrModel } from './models.ts';

export const API_PREFIX = '/api';
export const CSRF_HEADER = 'X-CSRF-Token';

/** `arxiv:<id>` without version, e.g. `arxiv:2609.35773`. */
export type PaperId = string;
/** `YYYY-MM-DD`: the feed's announce date (US Eastern calendar day of the channel pubDate). */
export type Day = string;
/** RFC 3339 UTC. */
export type Timestamp = string;
export type Label = 'save' | 'skip';

export const TODAY_LIMIT = 20;
export const TLDR_LIMIT = 10;
export const SAVED_PAGE = 50;
export const SEEDS_MAX = 50;
export const CATEGORIES_MAX = 6;

export interface Paper {
  readonly id: PaperId;
  /** Latest version number seen, e.g. 1. */
  readonly version: number;
  readonly title: string;
  readonly authors: string;
  readonly categories: readonly string[];
  readonly abstract: string;
  readonly announce_type: 'new' | 'cross';
  readonly announced_on: Day;
  /** Built from the ID only: https://arxiv.org/abs/<id> and https://arxiv.org/pdf/<id>. */
  readonly abs_url: string;
  readonly pdf_url: string;
  readonly label: Label | null;
  /** A newer version was announced after the owner saved it. */
  readonly new_version: boolean;
}

export interface Pick extends Paper {
  readonly rank: number;
  readonly score: number;
  /** One Chinese sentence (plain text), top TLDR_LIMIT only; null until written or when skipped by the cap. */
  readonly tldr: string | null;
}

export type RunPhase = 'waiting' | 'fetching' | 'embedding' | 'ranking' | 'summarizing' | 'done' | 'paused' | 'cap_hit' | 'failed';

export interface TodayResponse {
  readonly day: Day | null;
  readonly phase: RunPhase;
  /** No positive vectors yet: the UI asks for seeds. */
  readonly cold_start: boolean;
  readonly picks: readonly Pick[];
  readonly generated_at: Timestamp | null;
}

export interface SavedResponse {
  readonly papers: readonly Paper[];
  readonly next_cursor: string | null;
}

export interface FeedbackRequest {
  readonly paper_id: PaperId;
  /** null undoes the label. */
  readonly label: Label | null;
}
export interface FeedbackResponse {
  readonly paper_id: PaperId;
  readonly label: Label | null;
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
/** POST /api/seeds: bare arXiv IDs or abs URLs; the Worker keeps only the validated IDs. */
export interface AddSeedsRequest {
  readonly ids: readonly string[];
}

export interface Settings {
  /** e.g. ['cs.IR', 'cs.CL', 'cs.LG'], at most CATEGORIES_MAX. */
  readonly categories: readonly string[];
  /** λ of the negative centroid, 0–1. */
  readonly lambda: number;
  /** Daily neuron cap, at most `ceiling`. */
  readonly neuron_cap: number;
  readonly tldr_model: TldrModel;
  readonly ingest_paused: boolean;
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
    readonly saved_7d: number;
    readonly neurons_today: number;
    readonly neuron_cap: number;
  };
  readonly last_fetch_at: Timestamp | null;
  readonly last_fetch_error: string | null;
  readonly guard: { readonly level: 'normal' | 'shed'; readonly until: Timestamp | null };
  readonly build: string | null;
}

export interface CsrfResponse {
  readonly token: string;
}

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string; readonly request_id: string };
}
