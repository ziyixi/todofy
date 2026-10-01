/**
 * Owner mutations, run inside LabState one at a time (docs/design.md §7–§9): deck decisions with undo and
 * 重来, the send exclusions, 暂不发送, the send to Todofy with its polling, library feedback, seeds and
 * settings. Every mutation carries an op_id; a known op_id never applies twice (deck mutations return the
 * stored response, the others the current view). Results are values; the Worker maps them to HTTP.
 */
import { State, type TaskIntentService } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import type { WireObject, WireService } from '@ziyixi/proto/wire-json';
import {
  SEEDS_MAX,
  type Decision,
  type DeckMutationResponse,
  type DeckState,
  type DeckSummary,
  type FeedbackResponse,
  type SeedsResponse,
  type SendMode,
  type SendStatus,
  type Settings,
  type SettingsResponse,
} from './api-types.ts';
import { parseSeedInput, paperKey } from './arxiv.ts';
import { iso, neuronCeiling, publicHost } from './config.ts';
import { deckState, mutate, replay, type DeckEvent, type Mutation } from './deck.ts';
import { frozenPapers, readDeck, readSeeds, readSettings, sendRowFrom, sendableCards, stateFromRows, summaryView, type DeckBundle, type SendDbRow } from './db.ts';
import type { Env } from './env.ts';
import {
  asResult,
  buildIntent,
  completed,
  freeze,
  heldRetry,
  nextPoll,
  pollable,
  sendStatus,
  sha256Hex,
  statusRef,
  unfrozen,
  withRejection,
  withResult,
  type SendRow,
} from './intent.ts';
import { TLDR_MODELS } from './models.ts';
import type { Store } from './store.ts';

export type OwnerResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly state?: DeckState };

export interface OwnerDeps {
  readonly store: Store;
  readonly db: D1Database;
  readonly env: Env;
  /** Todofy's Ops entrypoint (task-intent-v1 methods only); undefined when the binding is absent. */
  readonly todofy: WireService<typeof TaskIntentService> | undefined;
}

export const TODOFY_TIMEOUT_MS = 10_000;

const fail = <T>(status: number, code: string, state?: DeckState): OwnerResult<T> => (state === undefined ? { ok: false, status, code } : { ok: false, status, code, state });
const done = <T>(body: T, status = 200): OwnerResult<T> => ({ ok: true, status, body });

async function storedOp(db: D1Database, opId: string): Promise<{ status: number; response: string } | null> {
  return db.prepare('SELECT status, response FROM owner_ops WHERE op_id = ?').bind(opId).first<{ status: number; response: string }>();
}

function opStatement(db: D1Database, opId: string, route: string, deckId: string | null, status: number, response: unknown, now: number): D1PreparedStatement {
  const json = JSON.stringify(response);
  return db
    .prepare('INSERT INTO owner_ops (op_id, route, deck_id, status, response, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (op_id) DO NOTHING')
    .bind(opId, route, deckId, status, json.length <= 16_000 ? json : '{}', now);
}

// ---- the ranking mirror ------------------------------------------------------------------------------------

interface FeedbackRow {
  paper_id: string;
  label: Decision | null;
  source: 'deck' | 'library' | null;
  deck_id: string | null;
  at: number | null;
}

/**
 * Copies D1 `feedback` (the record) for these papers into LabState's `labels` mirror, which ranking reads.
 * Idempotent. A replayed op_id runs it: the first request's D1 batch may have committed while the call itself
 * failed before the mirror was written, and the retry must not leave the two apart for good.
 */
function mirrorLabels(store: Store, rows: readonly FeedbackRow[]): void {
  for (const row of rows) {
    if (row.label === null || row.source === null || row.at === null) {
      store.sql.exec('DELETE FROM labels WHERE paper_id = ?', row.paper_id);
    } else {
      store.sql.exec(
        `INSERT INTO labels (paper_id, label, source, deck_id, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (paper_id) DO UPDATE SET label = excluded.label, source = excluded.source, deck_id = excluded.deck_id, at = excluded.at`,
        row.paper_id,
        row.label,
        row.source,
        row.deck_id,
        row.at,
      );
    }
  }
}

/** The mirror of every card of a deck, re-read from D1 (one query). */
async function resyncDeckLabels(deps: OwnerDeps, deckId: string): Promise<void> {
  const { results } = await deps.db
    .prepare(
      `SELECT c.paper_id, f.label, f.source, f.deck_id, f.at FROM deck_cards c LEFT JOIN feedback f ON f.paper_id = c.paper_id
       WHERE c.deck_id = ?`,
    )
    .bind(deckId)
    .all<FeedbackRow>();
  mirrorLabels(deps.store, results);
}

/** The mirror of one paper, re-read from D1. */
async function resyncPaperLabel(deps: OwnerDeps, paperId: string): Promise<void> {
  const row = await deps.db.prepare('SELECT paper_id, label, source, deck_id, at FROM feedback WHERE paper_id = ?').bind(paperId).first<FeedbackRow>();
  mirrorLabels(deps.store, [row ?? { paper_id: paperId, label: null, source: null, deck_id: null, at: null }]);
}

// ---- deck decisions ---------------------------------------------------------------------------------------

interface EventRow {
  seq: number;
  kind: DeckEvent['kind'];
  paper_id: string | null;
  decision: Decision | null;
  target_seq: number | null;
  at: number;
}

export type DeckMutationInput =
  | { readonly kind: 'decide'; readonly op_id: string; readonly base_version: number; readonly paper_id: string; readonly decision: Decision }
  | { readonly kind: 'undo' | 'restart'; readonly op_id: string; readonly base_version: number };

const MUTATION_STATUS: Readonly<Record<string, number>> = { not_in_deck: 404, already_decided: 409, nothing_to_undo: 409, deck_log_full: 409 };

export async function mutateDeck(deps: OwnerDeps, deckId: string, input: DeckMutationInput, now: number): Promise<OwnerResult<DeckMutationResponse>> {
  const { db, store } = deps;
  const stored = await storedOp(db, input.op_id);
  if (stored !== null) {
    await resyncDeckLabels(deps, deckId);
    return done(JSON.parse(stored.response) as DeckMutationResponse, stored.status);
  }
  const bundle = await readDeck(db, deckId);
  if (bundle === null || bundle.deck.ready_at === null) return fail(404, 'deck_not_found');
  const current = stateFromRows(bundle.deck, bundle.cards);
  if (input.base_version !== bundle.deck.version) return fail(409, 'deck_changed', current);
  const { results: eventRows } = await db
    .prepare('SELECT seq, kind, paper_id, decision, target_seq, at FROM deck_events WHERE deck_id = ? ORDER BY seq')
    .bind(deckId)
    .all<EventRow>();
  const events: DeckEvent[] = eventRows;
  const mutation: Mutation = input.kind === 'decide' ? { kind: 'decide', paper_id: input.paper_id, decision: input.decision } : { kind: input.kind };
  const cards = bundle.cards.map((c) => ({ position: c.position, paper_id: c.paper_id }));
  const result = mutate(
    cards.map((c) => c.paper_id),
    events,
    mutation,
    now,
  );
  if (!result.ok) return fail(MUTATION_STATUS[result.code] ?? 409, result.code, current);
  const before = replay(events);
  const version = result.event?.seq ?? bundle.deck.version;
  const decidedAll = cards.every((c) => result.after.decisions.has(c.paper_id));
  const finishedAt = decidedAll ? (bundle.deck.finished_at ?? now) : null;
  const state = deckState(deckId, version, cards, result.after, finishedAt === null ? null : iso(finishedAt));
  const response: DeckMutationResponse = { state, applied: result.applied };
  const statements: D1PreparedStatement[] = [];
  const route = `deck.${input.kind}`;
  if (result.event !== null) {
    const e = result.event;
    const changedLabels: { p: string; d: Decision }[] = [];
    const cleared: string[] = [];
    for (const card of cards) {
      const was = before.decisions.get(card.paper_id)?.decision ?? null;
      const is = result.after.decisions.get(card.paper_id)?.decision ?? null;
      if (was === is) continue;
      if (is === null) cleared.push(card.paper_id);
      else changedLabels.push({ p: card.paper_id, d: is });
    }
    const materialised = cards.map((c) => {
      const entry = result.after.decisions.get(c.paper_id);
      return { p: c.paper_id, d: entry?.decision ?? null, s: entry?.seq ?? null };
    });
    statements.push(
      db
        .prepare('INSERT INTO deck_events (deck_id, seq, kind, paper_id, decision, target_seq, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(deckId, e.seq, e.kind, e.paper_id, e.decision, e.target_seq, e.at),
      db
        .prepare(
          `UPDATE deck_cards SET decision = j.value->>'d', decided_seq = j.value->>'s' FROM json_each(?) AS j
           WHERE deck_cards.deck_id = ? AND deck_cards.paper_id = j.value->>'p'`,
        )
        .bind(JSON.stringify(materialised), deckId),
      db
        .prepare('UPDATE decks SET version = ?, finished_at = ?, undo = ? WHERE deck_id = ? AND version = ?')
        .bind(version, finishedAt, state.undo === null ? null : JSON.stringify(state.undo), deckId, bundle.deck.version),
      db
        .prepare("DELETE FROM feedback WHERE source = 'deck' AND deck_id = ? AND paper_id IN (SELECT value FROM json_each(?))")
        .bind(deckId, JSON.stringify(cleared)),
      db
        .prepare(
          `INSERT INTO feedback (paper_id, label, source, deck_id, at) SELECT j.value->>'p', j.value->>'d', 'deck', ?, ? FROM json_each(?) AS j WHERE true
           ON CONFLICT (paper_id) DO UPDATE SET label = excluded.label, source = 'deck', deck_id = excluded.deck_id, at = excluded.at`,
        )
        .bind(deckId, now, JSON.stringify(changedLabels)),
    );
    statements.push(opStatement(db, input.op_id, route, deckId, 200, response, now));
    await db.batch(statements);
    // The mirror ranking reads (the D1 batch above is the record).
    for (const paper of cleared) store.sql.exec("DELETE FROM labels WHERE paper_id = ? AND source = 'deck' AND deck_id = ?", paper, deckId);
    for (const { p, d } of changedLabels) {
      store.sql.exec(
        `INSERT INTO labels (paper_id, label, source, deck_id, at) VALUES (?, ?, 'deck', ?, ?)
         ON CONFLICT (paper_id) DO UPDATE SET label = excluded.label, source = 'deck', deck_id = excluded.deck_id, at = excluded.at`,
        p,
        d,
        deckId,
        now,
      );
    }
  } else {
    await opStatement(db, input.op_id, route, deckId, 200, response, now).run();
  }
  return done(response);
}

// ---- summary flags ---------------------------------------------------------------------------------------------

async function summary(deps: OwnerDeps, deckId: string): Promise<OwnerResult<DeckSummary>> {
  const [bundle, settings] = await Promise.all([readDeck(deps.db, deckId), readSettings(deps.db)]);
  if (bundle === null || bundle.deck.ready_at === null) return fail(404, 'deck_not_found');
  return done(summaryView(bundle, settings.send_mode));
}

export async function exclude(deps: OwnerDeps, deckId: string, opId: string, paperId: string, excluded: boolean, now: number): Promise<OwnerResult<DeckSummary>> {
  const { db } = deps;
  if ((await storedOp(db, opId)) !== null) return summary(deps, deckId);
  const bundle = await readDeck(db, deckId);
  if (bundle === null || bundle.deck.ready_at === null) return fail(404, 'deck_not_found');
  const card = bundle.cards.find((c) => c.paper_id === paperId);
  if (card === undefined) return fail(404, 'not_in_deck');
  if (card.sent_generation !== null || frozenPapers(bundle.send).has(paperId)) return fail(409, 'send_in_progress');
  await db.batch([
    db.prepare('UPDATE deck_cards SET send_excluded = ? WHERE deck_id = ? AND paper_id = ?').bind(excluded ? 1 : 0, deckId, paperId),
    opStatement(db, opId, 'deck.exclude', deckId, 200, {}, now),
  ]);
  return summary(deps, deckId);
}

export async function later(deps: OwnerDeps, deckId: string, opId: string, now: number): Promise<OwnerResult<DeckSummary>> {
  const { db } = deps;
  if ((await storedOp(db, opId)) === null) {
    const deck = await db.prepare('SELECT ready_at FROM decks WHERE deck_id = ?').bind(deckId).first<{ ready_at: number | null }>();
    if (deck === null || deck.ready_at === null) return fail(404, 'deck_not_found');
    await db.batch([db.prepare('UPDATE decks SET later_at = ? WHERE deck_id = ?').bind(now, deckId), opStatement(db, opId, 'deck.later', deckId, 200, {}, now)]);
  }
  return summary(deps, deckId);
}

// ---- sending to Todofy -------------------------------------------------------------------------------------------

type Rpc = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string };

async function rpc(invoke: () => Promise<unknown>): Promise<Rpc> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      invoke(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, TODOFY_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { ok: false, code: message === 'invalid_input' || message === 'busy' ? message : 'unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function upsertSend(db: D1Database, row: SendRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sends (deck_id, generation, intent_id, mode, paper_ids, payload, payload_sha256, state, recorded, tasks_total, tasks_created,
         error_code, next_poll_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (deck_id, generation) DO UPDATE SET mode = excluded.mode, paper_ids = excluded.paper_ids, payload = excluded.payload,
         payload_sha256 = excluded.payload_sha256, state = excluded.state, recorded = excluded.recorded, tasks_total = excluded.tasks_total,
         tasks_created = excluded.tasks_created, error_code = excluded.error_code, next_poll_at = excluded.next_poll_at,
         created_at = excluded.created_at, updated_at = excluded.updated_at`,
    )
    .bind(
      row.deck_id,
      row.generation,
      row.intent_id,
      row.mode,
      JSON.stringify(row.paper_ids),
      row.payload,
      row.payload_sha256,
      row.state,
      row.recorded ? 1 : 0,
      Math.min(31, row.tasks_total),
      Math.min(31, row.tasks_created),
      row.error_code,
      row.next_poll_at,
      row.created_at,
      row.updated_at,
    );
}

/** Stores the row; once Todofy recorded the generation, its cards carry it (never sent again). */
async function saveSend(deps: OwnerDeps, row: SendRow, extra: D1PreparedStatement[] = []): Promise<void> {
  const { db, store } = deps;
  const statements = [upsertSend(db, row), ...extra];
  if (row.recorded) {
    statements.push(
      db
        .prepare('UPDATE deck_cards SET sent_generation = ? WHERE deck_id = ? AND sent_generation IS NULL AND paper_id IN (SELECT value FROM json_each(?))')
        .bind(row.generation, row.deck_id, JSON.stringify(row.paper_ids)),
    );
  }
  await db.batch(statements);
  if (row.state === 'failed' || row.state === 'unknown') {
    store.sql.exec('INSERT OR IGNORE INTO send_watch (intent_id, since) VALUES (?, ?)', row.intent_id, row.updated_at);
  } else {
    store.sql.exec('DELETE FROM send_watch WHERE intent_id = ?', row.intent_id);
  }
}

async function propose(deps: OwnerDeps, row: SendRow, now: number): Promise<SendRow> {
  const todofy = deps.todofy;
  if (row.payload === null || todofy === undefined) return withRejection(row, 'unavailable', now);
  // The frozen bytes, parsed: a structured clone of exactly that JSON crosses the binding.
  const payload = JSON.parse(row.payload) as WireObject;
  const answer = await rpc(() => todofy.proposeTasks(payload));
  if (!answer.ok) return withRejection(row, answer.code, now);
  const result = asResult(answer.value, row.intent_id);
  return result === null ? withRejection(row, 'unavailable', now) : withResult(row, result, now);
}

async function lastSend(db: D1Database, deckId: string): Promise<SendRow | null> {
  const row = await db.prepare('SELECT * FROM sends WHERE deck_id = ? ORDER BY generation DESC LIMIT 1').bind(deckId).first<SendDbRow>();
  return row === null ? null : sendRowFrom(row);
}

export async function send(deps: OwnerDeps, deckId: string, opId: string, mode: SendMode, now: number): Promise<OwnerResult<SendStatus>> {
  const { db, env } = deps;
  if ((await storedOp(db, opId)) !== null) {
    const row = await lastSend(db, deckId);
    return row === null ? fail(404, 'deck_not_found') : done(sendStatus(row));
  }
  const bundle: DeckBundle | null = await readDeck(db, deckId);
  if (bundle === null || bundle.deck.ready_at === null) return fail(404, 'deck_not_found');
  const last = bundle.send;
  let row: SendRow;
  if (last !== null && !completed(last) && !unfrozen(last)) {
    // The open generation is frozen: a retry resends the identical payload (Todofy replays, never duplicates).
    // A new attempt starts the fast poll window again (created_at is the current attempt's start).
    if (last.payload === null) return fail(409, 'send_in_progress');
    row = { ...last, state: 'sending', next_poll_at: now + 3_000, created_at: now, updated_at: now };
  } else {
    const generation = last === null ? 1 : completed(last) ? last.generation + 1 : last.generation;
    const cards = sendableCards(bundle);
    if (cards.length === 0) return fail(409, 'nothing_to_send');
    const intent = buildIntent(
      deckId,
      generation,
      mode,
      cards.map((c) => ({ position: c.position, paper_id: c.paper_id, title: c.title, brief: c.brief })),
      publicHost(env),
    );
    const payload = intent === null ? null : freeze(intent);
    if (intent === null || payload === null) return fail(500, 'unavailable');
    row = {
      deck_id: deckId,
      generation,
      intent_id: intent.intentId,
      mode,
      paper_ids: cards.map((c) => c.paper_id),
      payload,
      payload_sha256: await sha256Hex(payload),
      state: 'sending',
      recorded: false,
      tasks_total: 0,
      tasks_created: 0,
      error_code: null,
      next_poll_at: now + 3_000,
      created_at: now,
      updated_at: now,
    };
  }
  // Frozen before the call: a lost response or an evicted object leaves `sending`, which a poll resolves.
  await saveSend(deps, row, [opStatement(db, opId, 'deck.send', deckId, 200, {}, now)]);
  const answered = await propose(deps, row, now);
  // Retrying a failed generation while Todofy is paused re-queues nothing there: it stays failed here,
  // with the pause as the reason, instead of reading as "handed over, resumes by itself".
  const after = last !== null && last.generation === row.generation && last.state === 'failed' ? heldRetry(answered) : answered;
  await saveSend(deps, after);
  return done(sendStatus(after));
}

/** GET …/send: refreshes a pending/unknown/held generation from Todofy when its poll time has come. */
export async function pollSend(deps: OwnerDeps, deckId: string, now: number): Promise<OwnerResult<SendStatus | null>> {
  const row = await lastSend(deps.db, deckId);
  if (row === null) return done(null);
  if (!pollable(row) || (row.next_poll_at !== null && row.next_poll_at > now)) return done(sendStatus(row));
  const todofy = deps.todofy;
  if (todofy === undefined) return done(sendStatus(row));
  const answer = await rpc(() => todofy.taskIntentStatus(statusRef(row.intent_id)));
  let after: SendRow;
  const result = answer.ok ? asResult(answer.value, row.intent_id) : null;
  if (result === null) {
    // Status unreadable: keep what we know and ask again later.
    after = { ...row, next_poll_at: nextPoll(now, row.created_at, null, row.state, row.recorded) ?? now + 60_000, updated_at: now };
  } else if (result.state === State.NOT_FOUND) {
    // Todofy never recorded it (the propose was lost): send the identical payload again (a new attempt).
    after = await propose(deps, { ...row, state: 'sending', recorded: false, created_at: now }, now);
  } else {
    after = withResult(row, result, now);
  }
  await saveSend(deps, after);
  return done(sendStatus(after));
}

// ---- library feedback, seeds, settings ----------------------------------------------------------------------------

export async function feedback(deps: OwnerDeps, opId: string, paperId: string, label: Decision | null, now: number): Promise<OwnerResult<FeedbackResponse>> {
  const { db, store } = deps;
  if ((await storedOp(db, opId)) === null) {
    const paper = await db.prepare('SELECT id FROM papers WHERE id = ?').bind(paperId).first<{ id: string }>();
    if (paper === null) return fail(404, 'not_found');
    const write =
      label === null
        ? db.prepare('DELETE FROM feedback WHERE paper_id = ?').bind(paperId)
        : db
            .prepare(
              `INSERT INTO feedback (paper_id, label, source, deck_id, at) VALUES (?, ?, 'library', NULL, ?)
               ON CONFLICT (paper_id) DO UPDATE SET label = excluded.label, source = 'library', deck_id = NULL, at = excluded.at`,
            )
            .bind(paperId, label, now);
    await db.batch([write, opStatement(db, opId, 'feedback', null, 200, {}, now)]);
    mirrorLabels(store, [label === null ? { paper_id: paperId, label: null, source: null, deck_id: null, at: null } : { paper_id: paperId, label, source: 'library', deck_id: null, at: now }]);
  } else {
    await resyncPaperLabel(deps, paperId);
  }
  const row = await db.prepare('SELECT label FROM feedback WHERE paper_id = ?').bind(paperId).first<{ label: Decision }>();
  return done({ paper_id: paperId, label: row?.label ?? null });
}

export async function addSeeds(deps: OwnerDeps, opId: string, inputs: readonly string[], now: number): Promise<OwnerResult<SeedsResponse>> {
  const { db, store } = deps;
  if ((await storedOp(db, opId)) === null) {
    const ids = [...new Set(inputs.map(parseSeedInput).filter((id): id is string => id !== null))].map(paperKey);
    if (ids.length === 0) return fail(400, 'bad_request');
    const existing = new Set(store.rows<{ paper_id: string }>('SELECT paper_id FROM seed_ids').map((row) => row.paper_id));
    const added = ids.filter((id) => !existing.has(id));
    if (existing.size + added.length > SEEDS_MAX) return fail(409, 'seeds_full');
    await db.batch([
      db
        .prepare("INSERT INTO seeds (paper_id, added_at, state) SELECT value, ?, 'pending' FROM json_each(?) WHERE true ON CONFLICT (paper_id) DO NOTHING")
        .bind(now, JSON.stringify(added)),
      opStatement(db, opId, 'seeds.add', null, 200, {}, now),
    ]);
    for (const id of added) store.sql.exec("INSERT OR IGNORE INTO seed_ids (paper_id, state, added_at) VALUES (?, 'pending', ?)", id, now);
  } else {
    // A replay: the seeds D1 holds for this request reach seed_ids even if the first call stopped after D1.
    const ids = [...new Set(inputs.map(parseSeedInput).filter((id): id is string => id !== null))].map(paperKey);
    const { results } = await db
      .prepare('SELECT paper_id, added_at FROM seeds WHERE paper_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<{ paper_id: string; added_at: number }>();
    for (const row of results) store.sql.exec("INSERT OR IGNORE INTO seed_ids (paper_id, state, added_at) VALUES (?, 'pending', ?)", row.paper_id, row.added_at);
  }
  return done({ seeds: await readSeeds(db) });
}

export async function removeSeed(deps: OwnerDeps, opId: string, paperId: string, now: number): Promise<OwnerResult<SeedsResponse>> {
  const { db, store } = deps;
  if ((await storedOp(db, opId)) === null) {
    await db.batch([db.prepare('DELETE FROM seeds WHERE paper_id = ?').bind(paperId), opStatement(db, opId, 'seeds.remove', null, 200, {}, now)]);
    store.sql.exec('DELETE FROM seed_ids WHERE paper_id = ?', paperId);
    store.sql.exec("DELETE FROM pending_embed WHERE paper_id = ? AND day = 'seed'", paperId);
  } else if ((await db.prepare('SELECT 1 AS x FROM seeds WHERE paper_id = ?').bind(paperId).first()) === null) {
    // A replay: D1 no longer has the seed, so LabState must not keep ranking with it.
    store.sql.exec('DELETE FROM seed_ids WHERE paper_id = ?', paperId);
    store.sql.exec("DELETE FROM pending_embed WHERE paper_id = ? AND day = 'seed'", paperId);
  }
  return done({ seeds: await readSeeds(db) });
}

export async function settingsResponse(deps: Pick<OwnerDeps, 'db' | 'env'>): Promise<SettingsResponse> {
  const stored = await readSettings(deps.db);
  const ceiling = neuronCeiling(deps.env);
  return { ...stored, neuron_cap: Math.min(ceiling, stored.neuron_cap ?? ceiling), ceiling, tldr_models: [...TLDR_MODELS] };
}

/** Replaces the settings (validated by the Worker); a cap above the ceiling is refused. */
export async function putSettings(deps: OwnerDeps, opId: string, settings: Settings, now: number): Promise<OwnerResult<SettingsResponse>> {
  const { db, store, env } = deps;
  if ((await storedOp(db, opId)) === null) {
    if (settings.neuron_cap > neuronCeiling(env)) return fail(400, 'bad_request');
    const rows: [string, unknown][] = [
      ['categories', settings.categories],
      ['lambda', settings.lambda],
      ['neuron_cap', settings.neuron_cap],
      ['tldr_model', settings.tldr_model],
      ['ingest_paused', settings.ingest_paused],
      ['send_mode', settings.send_mode],
    ];
    await db.batch([
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) SELECT j.value->>'k', j.value->>'v', ? FROM json_each(?) AS j WHERE true
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(now, JSON.stringify(rows.map(([k, v]) => ({ k, v: JSON.stringify(v) })))),
      opStatement(db, opId, 'settings', null, 200, {}, now),
    ]);
    store.set('mirror_ingest_paused', settings.ingest_paused ? 1 : 0);
    store.set('mirror_neuron_cap', Math.min(settings.neuron_cap, neuronCeiling(env)));
  }
  return done(await settingsResponse(deps));
}
