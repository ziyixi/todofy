/**
 * The daily pipeline (docs/design.md §4), run by LabState's alarm in bounded slices: fetch the feed once
 * per UTC day → parse and dedupe → embed (≤ 8 calls per slice) → rank and create the deck → 简介 (≤ 5
 * calls per slice) → deck ready; when idle, seed resolve and retention. Every step is idempotent and
 * keyed by the announce day; every AI call passes the neuron ledger first (§5).
 */
import { DECK_SIZE } from './api-types.ts';
import { ABSTRACT_MAX, bareId, codePoints, parseAtom, parseFeed, paperKey, type FeedItem } from './arxiv.ts';
import { BRIEF_MAX_TOKENS, BRIEF_TEMPERATURE, briefPrompt, checkBrief, generatedText, promptText } from './brief.ts';
import { DAY, HOUR, MINUTE, addDays, fetchHour, neuronCeiling, nextFetchSlot, utcDay } from './config.ts';
import { readSettings, type StoredSettings } from './db.ts';
import type { Env } from './env.ts';
import { ARXIV_MIN_GAP_MS, ATOM_MAX_BYTES, FEED_MAX_BYTES, apiUrl, feedUrl, fetchArxiv } from './fetch-arxiv.ts';
import { EMBED_BATCH_MAX, EMBED_MODEL, type ModelId } from './models.ts';
import { effectiveCap, embedEstimate, fits, isAllowanceError, neuronsFor, reportedUsage, textEstimate } from './neurons.ts';
import type { Store } from './store.ts';
import { centroid, explore, fromBlob, normalize, rank, toBlob, type Vector } from './vectors.ts';

/** The Workers AI binding as Lab uses it (docs/design.md §5); tests pass a fake with the same shape. */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface Deps {
  readonly store: Store;
  readonly db: D1Database;
  readonly ai: AiRunner;
  readonly env: Env;
  readonly fetcher: typeof fetch;
}

/** Re-arm delay while work remains. */
export const SOON_MS = 2_000;
export const EMBED_CALLS_PER_SLICE = 8;
export const BRIEF_CALLS_PER_SLICE = 5;
export const AI_TIMEOUT_MS = 60_000;
/** Failed fetches of one day: then wait for the next day's slot. */
export const FETCH_BACKOFF_MS = [5 * MINUTE, 30 * MINUTE] as const;
export const STEP_BACKOFF_MS = [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR] as const;
/** Consecutive failures of an embed or rank step before the rest of that day is given up. */
export const STEP_GIVE_UP_ERRORS = 5;
/** Feed text embedded per paper (title + abstract). */
export const EMBED_TEXT_MAX = 2000;
/** Items written to D1 per statement (bound parameters: one JSON array per statement). */
export const INSERT_CHUNK_ITEMS = 100;
export const INSERT_CHUNK_BYTES = 400_000;
/** A shed guard never defers the pipeline longer than this (ops-v1: every deferred job has a bound). */
export const GUARD_BOUND_MS = 48 * HOUR;
export const POSITIVES_MAX = 1000;
export const NEGATIVES_MAX = 500;
/** After a failed seed lookup, seeds wait this long (the day's pipeline does not). */
export const SEED_ERROR_PAUSE_MS = 30 * MINUTE;
/** Missing 简介 of a capped deck are retried on later UTC days while the deck is at most this old. */
export const BRIEF_RETRY_DAYS = 2;
export const VECTOR_RETENTION_MS = 30 * DAY;
export const MAX_VECTORS = 60_000;
export const DEFERRED_JOBS = ['feed_fetch', 'embed', 'rank', 'brief', 'seed_resolve', 'retention'] as const;

type Phase = 'embedding' | 'ranking' | 'briefing' | 'ready' | 'ready_capped' | 'empty';

interface JobRow extends Record<string, SqlStorageValue> {
  day: string;
  phase: Phase;
  brief_cursor: number;
  errors: number;
  retry_at: number | null;
  capped_day: string | null;
  created_at: number;
  updated_at: number;
}

// ---- guard ----------------------------------------------------------------------------------------------

export interface GuardRow {
  level: 'normal' | 'shed';
  reason: string;
  until: number | null;
  set_at: number;
}

export function activeGuard(store: Store, now: number): GuardRow | null {
  const row = store.one<GuardRow & Record<string, SqlStorageValue>>('SELECT level, reason, until, set_at FROM guard WHERE id = 1');
  if (row === undefined || row.level !== 'shed' || row.until === null || row.until <= now) return null;
  return row;
}

// ---- AI calls through the ledger ------------------------------------------------------------------------

type AiOutcome = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly reason: 'cap' | 'error' };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('ai_timeout'));
      }, ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function capFor(env: Env, settings: StoredSettings): number {
  return effectiveCap(neuronCeiling(env), settings.neuron_cap);
}

/** Whether AI work is stopped for the rest of this UTC day (cap reached or account allowance gone). */
export function aiStopped(store: Store, now: number): boolean {
  const ledger = store.ledger(now);
  return ledger.capHitAt !== null || ledger.exhausted;
}

async function callAi(deps: Deps, now: number, cap: number, model: ModelId, input: Record<string, unknown>, estimate: number): Promise<AiOutcome> {
  const { store } = deps;
  const ledger = store.ledger(now);
  if (ledger.capHitAt !== null || ledger.exhausted) return { ok: false, reason: 'cap' };
  if (!fits(ledger.used, estimate, cap)) {
    store.capHit(now, false);
    return { ok: false, reason: 'cap' };
  }
  // Charged before the call: an evicted object never under-counts.
  store.charge(now, estimate);
  try {
    return { ok: true, output: await withTimeout(deps.ai.run(model, input), AI_TIMEOUT_MS) };
  } catch (error) {
    if (isAllowanceError(error)) {
      store.capHit(now, true);
      return { ok: false, reason: 'cap' };
    }
    return { ok: false, reason: 'error' };
  }
}

/** The vectors of an embedding answer, or null when it is not one vector per input. */
export function embeddings(output: unknown, count: number): (Vector | null)[] | null {
  if (typeof output !== 'object' || output === null) return null;
  const data = (output as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== count) return null;
  return data.map((row) => (Array.isArray(row) ? normalize(row as number[]) : null));
}

// ---- fetch + parse ----------------------------------------------------------------------------------------

function embedText(title: string, abstract: string): string {
  return codePoints(`${title}\n\n${abstract}`).slice(0, EMBED_TEXT_MAX).join('');
}

function chunks<T>(items: readonly T[], size: (item: T) => number): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = size(item);
    if (current.length > 0 && (current.length >= INSERT_CHUNK_ITEMS || bytes + itemBytes > INSERT_CHUNK_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += itemBytes;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const INSERT_PAPERS = `INSERT INTO papers (id, version, title, authors, categories, primary_category, announce_type, announced_on, abstract, license, new_version, first_seen_at)
  SELECT j.value->>'id', j.value->>'v', j.value->>'t', j.value->>'a', j.value->'c', j.value->>'pc', j.value->>'at', j.value->>'day', j.value->>'ab', j.value->>'lic', 0, ?
  FROM json_each(?) AS j WHERE true
  ON CONFLICT (id) DO NOTHING`;

interface PaperJson {
  id: string;
  v: number;
  t: string;
  a: string;
  c: readonly string[];
  pc: string;
  at: 'new' | 'cross';
  day: string;
  ab: string;
  lic: string | null;
}

function paperJson(item: FeedItem, day: string): PaperJson {
  return {
    id: paperKey(item.id),
    v: item.version,
    t: item.title,
    a: item.authors,
    c: item.categories,
    pc: item.primary_category,
    at: item.announce_type === 'cross' ? 'cross' : 'new',
    day,
    ab: item.abstract.slice(0, ABSTRACT_MAX),
    lic: item.license,
  };
}

export type FetchResult = 'new_day' | 'same_day' | 'not_modified' | 'failed' | 'no_day';

/** One feed request; on a new announce day, papers go to D1 and the day's candidates to the queue. */
export async function fetchFeed(deps: Deps, now: number, settings: StoredSettings): Promise<FetchResult> {
  const { store, db } = deps;
  store.set('fetch_attempted_at', now);
  store.set('arxiv_request_at', now);
  const conditional = { etag: store.get('fetch_etag'), lastModified: store.get('fetch_last_modified') };
  const outcome = await fetchArxiv(feedUrl(settings.categories), FEED_MAX_BYTES, conditional, deps.fetcher);
  if (outcome.kind === 'error') {
    store.set('fetch_last_error', outcome.code);
    return 'failed';
  }
  store.set('fetch_last_error', null);
  store.set('fetch_last_ok_at', now);
  if (outcome.kind === 'not_modified') return 'not_modified';
  const feed = parseFeed(outcome.text);
  // The validators are kept only once the day is recorded below: a run cut short re-fetches in full.
  const remember = (): void => {
    store.set('fetch_etag', outcome.etag);
    store.set('fetch_last_modified', outcome.lastModified);
  };
  if (feed.malformed > 0) store.count(now, 'feed_malformed', feed.malformed);
  if (feed.day === null) {
    store.set('fetch_last_error', 'no_pubdate');
    return 'no_day';
  }
  if (store.one('SELECT day FROM jobs WHERE day = ?', feed.day) !== undefined) {
    remember();
    return 'same_day';
  }

  const fresh = feed.items.filter((item) => item.announce_type === 'new' || item.announce_type === 'cross');
  const replaced = feed.items.filter((item) => item.announce_type === 'replace' || item.announce_type === 'replace-cross');
  // Which of the day's IDs D1 already knows from another day (a cross-list or a seed seen before keeps its
  // first day); a rerun of the same day after an interruption finds its own papers again.
  const ids = fresh.map((item) => paperKey(item.id));
  const known = new Set<string>();
  if (ids.length > 0) {
    const { results } = await db
      .prepare('SELECT id FROM papers WHERE id IN (SELECT value FROM json_each(?)) AND announced_on != ?')
      .bind(JSON.stringify(ids), feed.day)
      .all<{ id: string }>();
    for (const row of results) known.add(row.id);
  }
  const added = fresh.filter((item) => !known.has(paperKey(item.id)));
  const statements: D1PreparedStatement[] = chunks(
    added.map((item) => paperJson(item, feed.day ?? '')),
    (item) => item.t.length * 3 + item.ab.length * 3 + item.a.length * 3 + 200,
  ).map((chunk) => db.prepare(INSERT_PAPERS).bind(now, JSON.stringify(chunk)));
  if (replaced.length > 0) {
    // A newer version of a liked paper: flag it on the liked list (no new card).
    statements.push(
      db
        .prepare(
          `UPDATE papers SET new_version = 1, version = CAST(j.value->>'v' AS INTEGER) FROM json_each(?) AS j
           WHERE papers.id = j.value->>'id' AND papers.version < CAST(j.value->>'v' AS INTEGER)
             AND papers.id IN (SELECT paper_id FROM feedback WHERE label = 'like')`,
        )
        .bind(JSON.stringify(replaced.map((item) => ({ id: paperKey(item.id), v: item.version })))),
    );
  }
  if (statements.length > 0) await db.batch(statements);

  store.sql.exec('DELETE FROM day_items WHERE day = ?', feed.day);
  added.forEach((item, pos) => {
    const key = paperKey(item.id);
    store.sql.exec(
      'INSERT INTO day_items (day, pos, paper_id, primary_category, announce_type) VALUES (?, ?, ?, ?, ?)',
      feed.day,
      pos,
      key,
      item.primary_category,
      item.announce_type,
    );
    if (store.one('SELECT paper_id FROM vectors WHERE paper_id = ?', key) === undefined) {
      store.sql.exec('INSERT OR REPLACE INTO pending_embed (paper_id, day, text) VALUES (?, ?, ?)', key, feed.day, embedText(item.title, item.abstract));
    }
  });
  store.sql.exec(
    'INSERT INTO jobs (day, phase, brief_cursor, errors, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)',
    feed.day,
    added.length === 0 ? 'empty' : 'embedding',
    now,
    now,
  );
  store.count(now, 'ingested', added.length);
  remember();
  return 'new_day';
}

// ---- embed ------------------------------------------------------------------------------------------------

export type SliceResult = 'more' | 'done' | 'capped' | 'error';

/** Embeds up to EMBED_CALLS_PER_SLICE batches of the queue for `day` ('seed' for seeds). */
export async function embedSlice(deps: Deps, now: number, cap: number, day: string): Promise<SliceResult> {
  const { store } = deps;
  for (let call = 0; call < EMBED_CALLS_PER_SLICE; call++) {
    const batch = store.rows<{ paper_id: string; text: string }>(
      'SELECT paper_id, text FROM pending_embed WHERE day = ? ORDER BY rowid LIMIT ?',
      day,
      EMBED_BATCH_MAX,
    );
    if (batch.length === 0) return 'done';
    const texts = batch.map((row) => row.text);
    const outcome = await callAi(deps, now, cap, EMBED_MODEL, { text: texts, truncate_inputs: true }, embedEstimate(EMBED_MODEL, texts));
    if (!outcome.ok) return outcome.reason === 'cap' ? 'capped' : 'error';
    const vectors = embeddings(outcome.output, batch.length);
    if (vectors === null) return 'error';
    batch.forEach((row, index) => {
      const vector = vectors[index];
      if (vector !== null && vector !== undefined) {
        store.sql.exec('INSERT OR REPLACE INTO vectors (paper_id, day, vec, at) VALUES (?, ?, ?, ?)', row.paper_id, day, toBlob(vector), now);
      } else {
        store.count(now, 'embed_invalid', 1);
        if (day === 'seed') store.sql.exec("UPDATE seed_ids SET state = 'not_found' WHERE paper_id = ? AND state = 'pending'", row.paper_id);
      }
      store.sql.exec('DELETE FROM pending_embed WHERE paper_id = ?', row.paper_id);
    });
    store.count(now, 'embedded', batch.length);
  }
  return store.one('SELECT paper_id FROM pending_embed WHERE day = ? LIMIT 1', day) === undefined ? 'done' : 'more';
}

// ---- rank + deck ---------------------------------------------------------------------------------------------

function vectorsOf(store: Store, query: string, ...params: SqlStorageValue[]): { paper_id: string; vector: Vector }[] {
  const out: { paper_id: string; vector: Vector }[] = [];
  for (const row of store.rows<{ paper_id: string; vec: ArrayBuffer }>(query, ...params)) {
    const vector = fromBlob(row.vec);
    if (vector !== null) out.push({ paper_id: row.paper_id, vector });
  }
  return out;
}

export function positives(store: Store): { paper_id: string; vector: Vector }[] {
  return vectorsOf(
    store,
    `SELECT v.paper_id, v.vec FROM vectors v WHERE v.paper_id IN (
       SELECT paper_id FROM (SELECT paper_id FROM labels WHERE label = 'like' ORDER BY at DESC LIMIT ?)
       UNION SELECT paper_id FROM seed_ids WHERE state = 'resolved')
     ORDER BY v.paper_id`,
    POSITIVES_MAX,
  );
}

/** Ranks the day's labelled-free candidates and creates the deck (picks, deck, cards) in one D1 batch. */
export async function rankDay(deps: Deps, now: number, day: string, settings: StoredSettings): Promise<number> {
  const { store, db } = deps;
  const existing = await db.prepare('SELECT size FROM decks WHERE deck_id = ?').bind(day).first<{ size: number }>();
  if (existing !== null) return existing.size;
  const candidates = store.rows<{ paper_id: string; primary_category: string; announce_type: string; vec: ArrayBuffer | null }>(
    `SELECT d.paper_id, d.primary_category, d.announce_type, v.vec FROM day_items d LEFT JOIN vectors v ON v.paper_id = d.paper_id
     WHERE d.day = ? AND d.paper_id NOT IN (SELECT paper_id FROM labels) ORDER BY d.pos`,
    day,
  );
  const positive = positives(store);
  let picks: { paper_id: string; score: number; because_id: string | null }[];
  let kind: 'ranked' | 'explore';
  if (positive.length === 0) {
    kind = 'explore';
    const news = candidates.filter((c) => c.announce_type === 'new');
    picks = explore(news.length > 0 ? news : candidates, DECK_SIZE).map((c) => ({ paper_id: c.paper_id, score: 0, because_id: null }));
  } else {
    kind = 'ranked';
    const negative = centroid(
      vectorsOf(
        store,
        `SELECT v.paper_id, v.vec FROM vectors v JOIN (SELECT paper_id FROM labels WHERE label = 'dislike' ORDER BY at DESC LIMIT ?) d ON d.paper_id = v.paper_id`,
        NEGATIVES_MAX,
      ).map((n) => n.vector),
    );
    const withVectors = candidates.flatMap((c) => {
      const vector = c.vec === null ? null : fromBlob(c.vec);
      return vector === null ? [] : [{ paper_id: c.paper_id, vector }];
    });
    picks = rank({ candidates: withVectors, positives: positive, negative, lambda: settings.lambda, size: DECK_SIZE });
  }
  if (picks.length === 0) return 0;
  const json = JSON.stringify(picks.map((p, i) => ({ r: i + 1, p: p.paper_id, s: p.score, b: p.because_id })));
  await db.batch([
    db
      .prepare(
        `INSERT INTO picks (day, rank, paper_id, score, because_id, brief, brief_model, created_at)
         SELECT ?, j.value->>'r', j.value->>'p', j.value->>'s', j.value->>'b', NULL, NULL, ? FROM json_each(?) AS j WHERE true
         ON CONFLICT (day, rank) DO NOTHING`,
      )
      .bind(day, now, json),
    db.prepare('INSERT INTO decks (deck_id, kind, size, version, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (deck_id) DO NOTHING').bind(day, kind, picks.length, now),
    db
      .prepare(
        `INSERT INTO deck_cards (deck_id, position, paper_id) SELECT ?, j.value->>'r', j.value->>'p' FROM json_each(?) AS j WHERE true
         ON CONFLICT DO NOTHING`,
      )
      .bind(day, json),
  ]);
  store.count(now, 'ranked', picks.length);
  return picks.length;
}

// ---- 简介 --------------------------------------------------------------------------------------------------------

/** Writes 简介 for ranks ≥ `cursor`; returns the next cursor and whether it stopped on the cap. */
export async function briefSlice(
  deps: Deps,
  now: number,
  cap: number,
  day: string,
  cursor: number,
  settings: StoredSettings,
): Promise<{ cursor: number; result: SliceResult }> {
  const { db, store } = deps;
  const { results } = await db
    .prepare(
      `SELECT k.rank, k.brief, p.title, p.abstract FROM picks k JOIN papers p ON p.id = k.paper_id
       WHERE k.day = ? AND k.rank >= ? ORDER BY k.rank LIMIT ?`,
    )
    .bind(day, cursor, BRIEF_CALLS_PER_SLICE)
    .all<{ rank: number; brief: string | null; title: string; abstract: string }>();
  if (results.length === 0) return { cursor, result: 'done' };
  const model = settings.tldr_model;
  const writes: D1PreparedStatement[] = [];
  let next = cursor;
  let result: SliceResult = 'more';
  for (const row of results) {
    if (row.brief !== null) {
      next = row.rank + 1;
      continue;
    }
    const prompt = briefPrompt(row.title, row.abstract);
    const estimate = textEstimate(model, promptText(prompt), BRIEF_MAX_TOKENS);
    const outcome = await callAi(deps, now, cap, model, { ...prompt, max_tokens: BRIEF_MAX_TOKENS, temperature: BRIEF_TEMPERATURE }, estimate);
    if (!outcome.ok) {
      result = outcome.reason === 'cap' ? 'capped' : 'error';
      break;
    }
    const usage = reportedUsage(outcome.output);
    if (usage !== null) store.charge(now, neuronsFor(model, usage.input, usage.output) - estimate);
    const text = generatedText(outcome.output);
    const checked = text === null ? null : checkBrief(text);
    if (checked?.ok === true) {
      writes.push(db.prepare('UPDATE picks SET brief = ?, brief_model = ? WHERE day = ? AND rank = ?').bind(checked.brief, model, day, row.rank));
      store.count(now, 'briefed', 1);
    } else {
      store.count(now, 'brief_rejected', 1);
    }
    next = row.rank + 1;
  }
  if (writes.length > 0) await db.batch(writes);
  if (result === 'more' && results.length < BRIEF_CALLS_PER_SLICE) result = 'done';
  return { cursor: next, result };
}

// ---- seeds --------------------------------------------------------------------------------------------------------

/** Resolves pending seeds: known papers from D1, the rest with one arXiv API request (≥ 3 s after the last). */
export async function seedSlice(deps: Deps, now: number, cap: number): Promise<'idle' | 'more' | 'wait' | 'capped' | 'error'> {
  const { store, db } = deps;
  // Seeds whose text is queued: embed them first.
  if (store.one("SELECT paper_id FROM pending_embed WHERE day = 'seed' LIMIT 1") !== undefined) {
    const result = await embedSlice(deps, now, cap, 'seed');
    markResolvedSeeds(store);
    await syncSeedStates(deps);
    return result === 'done' ? 'more' : result === 'capped' ? 'capped' : result === 'error' ? 'error' : 'more';
  }
  const pending = store.rows<{ paper_id: string }>("SELECT paper_id FROM seed_ids WHERE state = 'pending' ORDER BY added_at, paper_id LIMIT 20");
  if (pending.length === 0) return 'idle';
  const ids = pending.map((row) => row.paper_id);
  // Already embedded (a paper from a recent deck): resolved at once.
  markResolvedSeeds(store);
  const { results } = await db
    .prepare('SELECT id, title, abstract FROM papers WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids))
    .all<{ id: string; title: string; abstract: string }>();
  const inD1 = new Map(results.map((row) => [row.id, row]));
  const missing: string[] = [];
  for (const id of ids) {
    if (store.one("SELECT state FROM seed_ids WHERE paper_id = ? AND state = 'resolved'", id) !== undefined) continue;
    const row = inD1.get(id);
    if (row === undefined) missing.push(id);
    else store.sql.exec("INSERT OR REPLACE INTO pending_embed (paper_id, day, text) VALUES (?, 'seed', ?)", id, embedText(row.title, row.abstract));
  }
  if (missing.length > 0) {
    const last = store.getNumber('arxiv_request_at') ?? 0;
    if (now - last < ARXIV_MIN_GAP_MS) return 'wait';
    store.set('arxiv_request_at', now);
    const bare = missing.map((key) => bareId(key)).filter((id): id is string => id !== null);
    const outcome = await fetchArxiv(apiUrl(bare), ATOM_MAX_BYTES, null, deps.fetcher);
    if (outcome.kind !== 'ok') return 'error';
    const entries = parseAtom(outcome.text, 20);
    const found = new Set(entries.map((entry) => paperKey(entry.id)));
    if (entries.length > 0) {
      await db
        .prepare(INSERT_PAPERS)
        .bind(
          now,
          JSON.stringify(
            entries.map((entry) => ({
              id: paperKey(entry.id),
              v: entry.version,
              t: entry.title,
              a: entry.authors,
              c: entry.categories,
              pc: entry.primary_category,
              at: 'new',
              day: entry.published,
              ab: entry.abstract,
              lic: null,
            })),
          ),
        )
        .run();
    }
    for (const entry of entries) {
      store.sql.exec("INSERT OR REPLACE INTO pending_embed (paper_id, day, text) VALUES (?, 'seed', ?)", paperKey(entry.id), embedText(entry.title, entry.abstract));
    }
    for (const key of missing) if (!found.has(key)) store.sql.exec("UPDATE seed_ids SET state = 'not_found' WHERE paper_id = ?", key);
  }
  markResolvedSeeds(store);
  await syncSeedStates(deps);
  return 'more';
}

function markResolvedSeeds(store: Store): void {
  store.sql.exec("UPDATE seed_ids SET state = 'resolved' WHERE state = 'pending' AND paper_id IN (SELECT paper_id FROM vectors)");
}

async function syncSeedStates(deps: Deps): Promise<void> {
  const rows = deps.store.rows<{ paper_id: string; state: string }>("SELECT paper_id, state FROM seed_ids WHERE state != 'pending'");
  if (rows.length === 0) return;
  await deps.db
    .prepare(
      `UPDATE seeds SET state = j.value->>'s' FROM json_each(?) AS j
       WHERE seeds.paper_id = j.value->>'p' AND seeds.state != j.value->>'s'`,
    )
    .bind(JSON.stringify(rows.map((row) => ({ p: row.paper_id, s: row.state }))))
    .run();
}

// ---- retention --------------------------------------------------------------------------------------------------

/** Once per UTC day, bounded deletes (docs/design.md §4 step 7). */
export async function retention(deps: Deps, now: number): Promise<void> {
  const { store, db } = deps;
  const today = utcDay(now);
  if (store.get('retention_day') === today) return;
  store.set('retention_day', today);
  store.sql.exec(
    `DELETE FROM vectors WHERE rowid IN (
       SELECT rowid FROM vectors WHERE at < ? AND paper_id NOT IN (SELECT paper_id FROM labels WHERE label = 'like')
         AND paper_id NOT IN (SELECT paper_id FROM seed_ids) LIMIT 5000)`,
    now - VECTOR_RETENTION_MS,
  );
  store.sql.exec('DELETE FROM day_items WHERE day < ?', addDays(today, -14));
  store.sql.exec("DELETE FROM pending_embed WHERE day != 'seed' AND day < ?", addDays(today, -7));
  store.sql.exec('DELETE FROM jobs WHERE day < ?', addDays(today, -30));
  store.sql.exec('DELETE FROM neurons WHERE day < ?', addDays(today, -30));
  store.sql.exec('DELETE FROM activity WHERE at < ?', now - 8 * DAY);
  store.sql.exec("DELETE FROM labels WHERE label = 'dislike' AND at < ?", now - 180 * DAY);
  const yearAgo = addDays(today, -365);
  await db.batch([
    db.prepare("DELETE FROM feedback WHERE label = 'dislike' AND at < ?").bind(now - 180 * DAY),
    db.prepare('DELETE FROM owner_ops WHERE at < ?').bind(now - 30 * DAY),
    db
      .prepare("UPDATE sends SET payload = NULL WHERE payload IS NOT NULL AND state IN ('created', 'duplicate', 'rejected', 'failed') AND updated_at < ?")
      .bind(now - 30 * DAY),
    db.prepare('DELETE FROM deck_events WHERE deck_id < ?').bind(yearAgo),
    db.prepare('DELETE FROM sends WHERE deck_id < ? AND created_at < ?').bind(yearAgo, now - 400 * DAY),
    db.prepare('DELETE FROM deck_cards WHERE deck_id < ? AND deck_id NOT IN (SELECT deck_id FROM sends)').bind(yearAgo),
    db.prepare('DELETE FROM decks WHERE deck_id < ? AND deck_id NOT IN (SELECT deck_id FROM sends) AND deck_id NOT IN (SELECT deck_id FROM deck_cards)').bind(yearAgo),
    db.prepare('DELETE FROM picks WHERE day < ?').bind(yearAgo),
    db
      .prepare(
        `DELETE FROM papers WHERE rowid IN (SELECT rowid FROM papers WHERE first_seen_at < ?
           AND id NOT IN (SELECT paper_id FROM feedback WHERE label = 'like')
           AND id NOT IN (SELECT paper_id FROM seeds)
           AND id NOT IN (SELECT paper_id FROM picks)
           AND id NOT IN (SELECT paper_id FROM deck_cards) LIMIT 2000)`,
      )
      .bind(now - 90 * DAY),
  ]);
  const vectors = store.one<{ n: number }>('SELECT count(*) AS n FROM vectors')?.n ?? 0;
  if (vectors > MAX_VECTORS) store.count(now, 'vector_limit', 1);
}

// ---- the alarm ---------------------------------------------------------------------------------------------------

export interface AlarmPlan {
  /** When the alarm should fire next. */
  readonly next: number;
}

function backoff(list: readonly number[], errors: number): number {
  return list[Math.min(errors, list.length - 1)] ?? 6 * HOUR;
}

function nextUtcMidnight(now: number): number {
  return Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY + MINUTE;
}

/** The active (unfinished) job, oldest first. */
function activeJob(store: Store): JobRow | undefined {
  return store.one<JobRow>("SELECT * FROM jobs WHERE phase IN ('embedding', 'ranking', 'briefing') ORDER BY day LIMIT 1");
}

/** One alarm invocation: a bounded slice of work, then when to run again. Never throws for expected failures. */
export async function runAlarm(deps: Deps, now: number): Promise<AlarmPlan> {
  const { store, env } = deps;
  if (store.getNumber('bootstrap_at') === null) store.set('bootstrap_at', now);
  let fetchAt = store.getNumber('fetch_next_at');
  if (fetchAt === null) {
    // First run: fetch at once, so the first deck does not wait for tomorrow's slot.
    fetchAt = now;
    store.set('fetch_next_at', fetchAt);
  }
  const settings = await readSettings(deps.db);
  store.set('mirror_ingest_paused', settings.ingest_paused ? 1 : 0);
  store.set('mirror_neuron_cap', capFor(env, settings));
  if (settings.ingest_paused) {
    await retention(deps, now);
    return { next: Math.max(now + HOUR, fetchAt) };
  }

  const guard = activeGuard(store, now);
  if (guard !== null) {
    const lastOk = store.getNumber('fetch_last_ok_at') ?? store.getNumber('bootstrap_at') ?? now;
    const catchingUp = store.get('guard_catchup') === '1';
    if (!catchingUp && now - lastOk <= GUARD_BOUND_MS) return { next: Math.min(guard.until ?? now + HOUR, Math.max(fetchAt, now + MINUTE)) };
    // Past the bound: run the whole day's pipeline to its end despite the shed.
    store.set('guard_catchup', 1);
  }

  const cap = capFor(env, settings);
  const job = activeJob(store);
  if (job !== undefined) {
    if (job.retry_at !== null && job.retry_at > now) return { next: job.retry_at };
    return advanceJob(deps, now, cap, job, settings);
  }

  // Seeds first (the owner just added them; the next deck should already use them). Not under a shed guard.
  const seedPause = store.getNumber('seed_error_at');
  if (guard === null && !aiStopped(store, now) && (seedPause === null || now - seedPause > SEED_ERROR_PAUSE_MS)) {
    const seeds = await seedSlice(deps, now, cap);
    if (seeds === 'more') return { next: now + SOON_MS };
    if (seeds === 'wait') return { next: now + ARXIV_MIN_GAP_MS };
    if (seeds === 'error') store.set('seed_error_at', now);
  }

  if (now >= fetchAt) {
    // arXiv's terms: at most one request every 3 seconds, across both hosts.
    const gap = now - (store.getNumber('arxiv_request_at') ?? 0);
    if (gap < ARXIV_MIN_GAP_MS) return { next: now + ARXIV_MIN_GAP_MS - gap };
    const result = await fetchFeed(deps, now, settings);
    const hour = fetchHour(env);
    if (result === 'failed' || result === 'no_day') {
      const failures = (store.getNumber('fetch_failures') ?? 0) + 1;
      store.set('fetch_failures', failures);
      const retry = failures <= FETCH_BACKOFF_MS.length ? now + backoff(FETCH_BACKOFF_MS, failures - 1) : nextFetchSlot(now, hour);
      if (failures > FETCH_BACKOFF_MS.length) store.set('fetch_failures', 0);
      store.set('fetch_next_at', retry);
      return { next: retry };
    }
    store.set('fetch_failures', 0);
    store.set('fetch_next_at', nextFetchSlot(now, hour));
    return { next: result === 'new_day' ? now + SOON_MS : Math.min(nextFetchSlot(now, hour), now + SOON_MS) };
  }

  if (guard !== null) {
    // Caught up under a shed guard: the rest (seeds, retention) waits for the guard to end.
    store.set('guard_catchup', null);
    return { next: Math.min(guard.until ?? now + HOUR, Math.max(fetchAt, now + MINUTE)) };
  }
  store.set('guard_catchup', null);

  // A deck whose 简介 stopped on the cap: retry on a later UTC day while it is recent.
  const capped = store.one<JobRow>("SELECT * FROM jobs WHERE phase = 'ready_capped' ORDER BY day DESC LIMIT 1");
  if (capped !== undefined && capped.capped_day !== utcDay(now) && capped.day >= addDays(utcDay(now), -BRIEF_RETRY_DAYS - 1) && !aiStopped(store, now)) {
    store.sql.exec("UPDATE jobs SET phase = 'briefing', updated_at = ? WHERE day = ?", now, capped.day);
    return { next: now + SOON_MS };
  }

  await retention(deps, now);
  let next = fetchAt;
  if (capped !== undefined && capped.day >= addDays(utcDay(now), -BRIEF_RETRY_DAYS - 1)) next = Math.min(next, nextUtcMidnight(now));
  if (store.one("SELECT paper_id FROM seed_ids WHERE state = 'pending' LIMIT 1") !== undefined) {
    next = Math.min(next, seedPause !== null && now - seedPause <= SEED_ERROR_PAUSE_MS ? seedPause + SEED_ERROR_PAUSE_MS + MINUTE : nextUtcMidnight(now));
  }
  return { next: Math.max(next, now + SOON_MS) };
}

async function advanceJob(deps: Deps, now: number, cap: number, job: JobRow, settings: StoredSettings): Promise<AlarmPlan> {
  const { store, db } = deps;
  const setPhase = (phase: Phase): void => {
    store.sql.exec(`UPDATE jobs SET phase = ?, errors = 0, retry_at = NULL, updated_at = ? WHERE day = ?`, phase, now, job.day);
  };
  const fail = (): AlarmPlan => {
    if (job.errors + 1 >= STEP_GIVE_UP_ERRORS && job.phase !== 'briefing') {
      // A step that keeps failing must not block every later day: give up on what is left of it.
      store.count(now, `${job.phase}_abandoned`, 1);
      if (job.phase === 'embedding') {
        store.sql.exec('DELETE FROM pending_embed WHERE day = ?', job.day);
        setPhase('ranking');
      } else {
        setPhase('empty');
      }
      return { next: now + SOON_MS };
    }
    const retry = now + backoff(STEP_BACKOFF_MS, job.errors);
    store.sql.exec('UPDATE jobs SET errors = errors + 1, retry_at = ?, updated_at = ? WHERE day = ?', retry, now, job.day);
    return { next: retry };
  };
  const capped = (): AlarmPlan => ({ next: nextUtcMidnight(now) });

  switch (job.phase) {
    case 'embedding': {
      const result = await embedSlice(deps, now, cap, job.day);
      if (result === 'error') return fail();
      if (result === 'capped') return capped();
      if (result === 'done') setPhase('ranking');
      return { next: now + SOON_MS };
    }
    case 'ranking': {
      try {
        const size = await rankDay(deps, now, job.day, settings);
        setPhase(size === 0 ? 'empty' : 'briefing');
      } catch {
        return fail();
      }
      return { next: now + SOON_MS };
    }
    case 'briefing':
    default: {
      let step: { cursor: number; result: SliceResult };
      try {
        step = await briefSlice(deps, now, cap, job.day, job.brief_cursor, settings);
      } catch {
        return fail();
      }
      store.sql.exec('UPDATE jobs SET brief_cursor = ?, updated_at = ? WHERE day = ?', step.cursor, now, job.day);
      if (step.result === 'error') {
        if (job.errors >= 2) {
          // A card the model keeps failing on: skip it (the UI shows the abstract instead).
          store.sql.exec('UPDATE jobs SET brief_cursor = brief_cursor + 1, errors = 0, retry_at = NULL WHERE day = ?', job.day);
          store.count(now, 'brief_failed', 1);
          return { next: now + SOON_MS };
        }
        return fail();
      }
      if (step.result === 'more') {
        store.sql.exec('UPDATE jobs SET errors = 0, retry_at = NULL WHERE day = ?', job.day);
        return { next: now + SOON_MS };
      }
      // Done or capped: the deck is shown either way (a capped deck falls back to the abstracts).
      await db.prepare('UPDATE decks SET ready_at = ? WHERE deck_id = ? AND ready_at IS NULL').bind(now, job.day).run();
      if (step.result === 'capped') {
        store.sql.exec("UPDATE jobs SET phase = 'ready_capped', capped_day = ?, errors = 0, retry_at = NULL, updated_at = ? WHERE day = ?", utcDay(now), now, job.day);
        return capped();
      }
      setPhase('ready');
      return { next: now + SOON_MS };
    }
  }
}
