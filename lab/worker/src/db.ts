/**
 * D1 "lab" reads (docs/design.md §6, §8) and the owner API views built from them. The Worker's GET routes
 * and LabState both use these; only LabState writes D1. Every query is bounded (a deck has ≤ 20 cards, the
 * liked list pages by 50) and uses bound parameters.
 */
import { CATEGORIES_MAX, DECK_SIZE, LIKED_PAGE } from './limits.ts';
import {
  type Deck,
  type DeckCard,
  type DeckKind,
  type DeckState,
  type DeckSummary,
  type Decision,
  type LikedPaper,
  type LikedResponse,
  type Paper,
  type Seed,
  type SeedState,
  type SendMode,
  type Settings,
  type SummaryItem,
  type UndoTarget,
} from './model.ts';
import { absUrl, bareId, pdfUrl } from './arxiv.ts';
import { firstSentence } from './brief.ts';
import { iso } from './config.ts';
import { deckState } from './deck.ts';
import { isSendMode, sendStatus, unfrozen, type LabErrorCode, type SendRow } from './intent.ts';
import { DEFAULT_TLDR_MODEL, TLDR_MODELS, type TldrModel } from './models.ts';
import type { SendState } from './model.ts';

// ---- settings -----------------------------------------------------------------------------------------

export const DEFAULT_CATEGORIES = ['cs.IR', 'cs.CL', 'cs.LG'] as const;
export const DEFAULT_LAMBDA = 0.3;
export const CATEGORY_SETTING_RE = /^[a-z][a-z-]{0,19}\.[A-Za-z-]{1,20}$/;

export interface StoredSettings extends Omit<Settings, 'neuron_cap'> {
  /** The owner's cap, or null (= the deployment ceiling). */
  readonly neuron_cap: number | null;
}

export function defaultSettings(): StoredSettings {
  return {
    categories: [...DEFAULT_CATEGORIES],
    lambda: DEFAULT_LAMBDA,
    neuron_cap: null,
    tldr_model: DEFAULT_TLDR_MODEL,
    ingest_paused: false,
    send_mode: 'subtasks',
  };
}

/** Settings from their D1 rows; a missing or invalid row reads as the default. */
export function settingsFrom(rows: readonly { key: string; value: string }[]): StoredSettings {
  const out: { -readonly [K in keyof StoredSettings]: StoredSettings[K] } = defaultSettings();
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      continue;
    }
    switch (row.key) {
      case 'categories':
        if (Array.isArray(value) && value.length >= 1 && value.length <= CATEGORIES_MAX && value.every((c) => typeof c === 'string' && CATEGORY_SETTING_RE.test(c))) {
          out.categories = value as string[];
        }
        break;
      case 'lambda':
        if (typeof value === 'number' && value >= 0 && value <= 1) out.lambda = value;
        break;
      case 'neuron_cap':
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out.neuron_cap = value;
        break;
      case 'tldr_model':
        if ((TLDR_MODELS as readonly unknown[]).includes(value)) out.tldr_model = value as TldrModel;
        break;
      case 'ingest_paused':
        if (typeof value === 'boolean') out.ingest_paused = value;
        break;
      case 'send_mode':
        if (isSendMode(value)) out.send_mode = value;
        break;
    }
  }
  return out;
}

export async function readSettings(db: D1Database): Promise<StoredSettings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  return settingsFrom(results);
}

// ---- papers and decks ---------------------------------------------------------------------------------

interface PaperRow {
  id: string;
  version: number;
  title: string;
  authors: string;
  categories: string;
  primary_category: string;
  announce_type: string;
  announced_on: string;
  abstract: string;
  new_version: number;
}

function parseCategories(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function paperFrom(row: PaperRow): Paper {
  const id = bareId(row.id) ?? '';
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    authors: row.authors,
    categories: parseCategories(row.categories),
    primary_category: row.primary_category,
    abstract: row.abstract,
    announce_type: row.announce_type === 'cross' ? 'cross' : 'new',
    announced_on: row.announced_on,
    abs_url: absUrl(id),
    pdf_url: pdfUrl(id),
    new_version: row.new_version === 1,
  };
}

export interface DeckRow {
  deck_id: string;
  kind: DeckKind;
  size: number;
  version: number;
  created_at: number;
  ready_at: number | null;
  finished_at: number | null;
  later_at: number | null;
  undo: string | null;
}

export interface CardRow extends PaperRow {
  position: number;
  paper_id: string;
  decision: Decision | null;
  decided_seq: number | null;
  send_excluded: number;
  sent_generation: number | null;
  brief: string | null;
  because_id: string | null;
  because_title: string | null;
}

export interface SendDbRow {
  deck_id: string;
  generation: number;
  intent_id: string;
  mode: SendMode;
  paper_ids: string;
  payload: string | null;
  payload_sha256: string;
  state: SendState;
  recorded: number;
  tasks_total: number;
  tasks_created: number;
  error_code: string | null;
  next_poll_at: number | null;
  created_at: number;
  updated_at: number;
}

export const DECK_SQL = 'SELECT deck_id, kind, size, version, created_at, ready_at, finished_at, later_at, undo FROM decks WHERE deck_id = ?';
export const CARDS_SQL = `SELECT c.position, c.paper_id, c.decision, c.decided_seq, c.send_excluded, c.sent_generation,
    p.id, p.version, p.title, p.authors, p.categories, p.primary_category, p.announce_type, p.announced_on, p.abstract, p.new_version,
    k.brief, k.because_id, b.title AS because_title
  FROM deck_cards c
  JOIN papers p ON p.id = c.paper_id
  LEFT JOIN picks k ON k.day = c.deck_id AND k.rank = c.position
  LEFT JOIN papers b ON b.id = k.because_id
  WHERE c.deck_id = ? ORDER BY c.position LIMIT ${String(DECK_SIZE)}`;
export const LAST_SEND_SQL = 'SELECT * FROM sends WHERE deck_id = ? ORDER BY generation DESC LIMIT 1';

export function sendRowFrom(row: SendDbRow): SendRow {
  let ids: string[] = [];
  try {
    const value: unknown = JSON.parse(row.paper_ids);
    if (Array.isArray(value)) ids = value.filter((v): v is string => typeof v === 'string');
  } catch {
    ids = [];
  }
  return {
    deck_id: row.deck_id,
    generation: row.generation,
    intent_id: row.intent_id,
    mode: row.mode,
    paper_ids: ids,
    payload: row.payload,
    payload_sha256: row.payload_sha256,
    state: row.state,
    recorded: row.recorded === 1,
    tasks_total: row.tasks_total,
    tasks_created: row.tasks_created,
    error_code: row.error_code as LabErrorCode,
    next_poll_at: row.next_poll_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function parseUndo(json: string | null): UndoTarget {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && ['decide', 'restart'].includes((value as { kind?: unknown }).kind as string)) return value as UndoTarget;
  } catch {
    return null;
  }
  return null;
}

/** DeckState from the materialised columns (the replay LabState wrote with the last event). */
export function stateFromRows(deck: DeckRow, cards: readonly Pick<CardRow, 'position' | 'paper_id' | 'decision' | 'decided_seq'>[]): DeckState {
  const decisions = new Map<string, { decision: Decision; seq: number }>();
  for (const card of cards) if (card.decision !== null) decisions.set(card.paper_id, { decision: card.decision, seq: card.decided_seq ?? 0 });
  return deckState(deck.deck_id, deck.version, cards, { decisions, undo: parseUndo(deck.undo) }, deck.finished_at === null ? null : iso(deck.finished_at));
}

export interface DeckBundle {
  readonly deck: DeckRow;
  readonly cards: readonly CardRow[];
  readonly send: SendRow | null;
}

/** The deck, its cards and its latest send in one D1 batch; null when there is no such deck. */
export async function readDeck(db: D1Database, deckId: string): Promise<DeckBundle | null> {
  const [deck, cards, send] = await db.batch([db.prepare(DECK_SQL).bind(deckId), db.prepare(CARDS_SQL).bind(deckId), db.prepare(LAST_SEND_SQL).bind(deckId)]);
  const deckRow = (deck?.results as DeckRow[] | undefined)?.[0];
  if (deckRow === undefined) return null;
  const sendRow = (send?.results as SendDbRow[] | undefined)?.[0];
  return { deck: deckRow, cards: (cards?.results ?? []) as CardRow[], send: sendRow === undefined ? null : sendRowFrom(sendRow) };
}

export function deckView(bundle: DeckBundle): Deck {
  const cards: DeckCard[] = bundle.cards.map((row) => ({
    position: row.position,
    paper: paperFrom(row),
    brief: row.brief,
    because: row.because_id === null || row.because_title === null ? null : { id: row.because_id, title: row.because_title },
  }));
  return {
    deck_id: bundle.deck.deck_id,
    kind: bundle.deck.kind,
    created_at: iso(bundle.deck.created_at),
    cards,
    state: stateFromRows(bundle.deck, bundle.cards),
    send: bundle.send === null ? null : sendStatus(bundle.send),
    later_at: bundle.deck.later_at === null ? null : iso(bundle.deck.later_at),
  };
}

/** Paper IDs held by the open frozen generation (not yet recorded as sent on their cards). */
export function frozenPapers(send: SendRow | null): Set<string> {
  if (send === null || unfrozen(send) || send.state === 'created' || send.state === 'duplicate') return new Set();
  return new Set(send.paper_ids);
}

/** Liked, not excluded, never sent and not in the open frozen generation: what 发送 would send now, in deck order. */
export function sendableCards(bundle: DeckBundle): CardRow[] {
  const held = frozenPapers(bundle.send);
  return bundle.cards.filter((c) => c.decision === 'like' && c.send_excluded === 0 && c.sent_generation === null && !held.has(c.paper_id));
}

export function summaryView(bundle: DeckBundle, defaultMode: SendMode): DeckSummary {
  const liked: SummaryItem[] = bundle.cards
    .filter((c) => c.decision === 'like')
    .map((c) => ({
      position: c.position,
      paper_id: c.paper_id,
      title: c.title,
      brief_line: c.brief === null ? null : firstSentence(c.brief),
      abs_url: absUrl(bareId(c.paper_id) ?? ''),
      excluded: c.send_excluded === 1,
      sent_generation: c.sent_generation,
    }));
  return {
    deck_id: bundle.deck.deck_id,
    state: stateFromRows(bundle.deck, bundle.cards),
    liked,
    sendable: sendableCards(bundle).length,
    send: bundle.send === null ? null : sendStatus(bundle.send),
    default_mode: defaultMode,
  };
}

// ---- liked list and seeds -----------------------------------------------------------------------------

/** D1 refuses LIKE patterns over 50 bytes: the query text is cut to fit `%q%` with escapes. */
export const LIKE_PATTERN_MAX_BYTES = 50;

export function likePattern(q: string): string | null {
  const text = q.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  let pattern = '';
  for (const char of text) {
    const escaped = char === '%' || char === '_' || char === '\\' ? `\\${char}` : char;
    if (new TextEncoder().encode(`%${pattern}${escaped}%`).byteLength > LIKE_PATTERN_MAX_BYTES) break;
    pattern += escaped;
  }
  return pattern === '' ? null : `%${pattern}%`;
}

export interface LikedCursor {
  readonly at: number;
  readonly id: string;
}

export function encodeCursor(cursor: LikedCursor): string {
  return `${String(cursor.at)}~${cursor.id}`;
}

export function decodeCursor(text: string | null): LikedCursor | null {
  if (text === null || text === '') return null;
  const match = /^([0-9]{1,16})~(arxiv:[A-Za-z0-9./-]{1,40})$/.exec(text);
  return match ? { at: Number(match[1]), id: match[2] ?? '' } : null;
}

interface LikedRow extends PaperRow {
  paper_id: string;
  at: number;
  deck_id: string | null;
  brief: string | null;
}

const LIKED_SQL = `SELECT f.paper_id, f.at, f.deck_id, p.id, p.version, p.title, p.authors, p.categories, p.primary_category, p.announce_type,
    p.announced_on, p.abstract, p.new_version,
    (SELECT k.brief FROM picks k WHERE k.paper_id = f.paper_id AND k.brief IS NOT NULL ORDER BY k.day DESC LIMIT 1) AS brief
  FROM feedback f JOIN papers p ON p.id = f.paper_id
  WHERE f.label = 'like'`;

function likedFrom(row: LikedRow): LikedPaper {
  return { ...paperFrom(row), liked_at: iso(row.at), deck_id: row.deck_id, brief: row.brief };
}

/** A page of at most `pageSize` (1-LIKED_PAGE) liked papers, newest first, after `cursor`, whose title matches `q`. */
export async function readLiked(db: D1Database, cursor: LikedCursor | null, q: string | null, pageSize = LIKED_PAGE): Promise<LikedResponse> {
  const size = Math.max(1, Math.min(LIKED_PAGE, Math.trunc(pageSize)));
  const pattern = q === null ? null : likePattern(q);
  const { results } = await db
    .prepare(
      `${LIKED_SQL}
          AND (?1 IS NULL OR f.at < ?1 OR (f.at = ?1 AND f.paper_id < ?2))
          AND (?3 IS NULL OR p.title LIKE ?3 ESCAPE '\\')
        ORDER BY f.at DESC, f.paper_id DESC LIMIT ?4`,
    )
    .bind(cursor?.at ?? null, cursor?.id ?? '', pattern, size + 1)
    .all<LikedRow>();
  const page = results.slice(0, size);
  const last = page[page.length - 1];
  return { papers: page.map(likedFrom), next_cursor: results.length > size && last !== undefined ? encodeCursor({ at: last.at, id: last.paper_id }) : null };
}

/** One liked paper, or null when the paper is not liked. */
export async function readLikedPaper(db: D1Database, paperId: string): Promise<LikedPaper | null> {
  const row = await db.prepare(`${LIKED_SQL} AND f.paper_id = ?1`).bind(paperId).first<LikedRow>();
  return row === null ? null : likedFrom(row);
}

export async function readSeeds(db: D1Database): Promise<Seed[]> {
  const { results } = await db
    .prepare('SELECT s.paper_id, s.state, s.added_at, p.title FROM seeds s LEFT JOIN papers p ON p.id = s.paper_id ORDER BY s.added_at DESC, s.paper_id LIMIT 100')
    .all<{ paper_id: string; state: SeedState; added_at: number; title: string | null }>();
  return results.map((row) => ({ paper_id: row.paper_id, title: row.title, state: row.state, added_at: iso(row.added_at) }));
}
