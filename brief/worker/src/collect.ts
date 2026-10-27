/**
 * A fetch round (../../docs/design.md §2-§5.1): poll the due sources, deduplicate, find mentions, embed, cluster, and
 * gate, over as many alarms as the round needs (each alarm bounded by its subrequests and its own wall time, StepBudget).
 * Every part can run again: polls upsert by canonical key and commit per source, embeddings and gate scores per batch.
 *
 * - Due: a source polls in a round by its `poll_per_day` (4: every round; 2: 18:30 and the 03:30 cutoff; 1: 18:30),
 *   once per round (`last_round`), an arXiv query page by page; a paused source once a day. Sources are taken host by
 *   host in turn, so one host's spacing never holds up the others; a host not ready defers its sources.
 * - Health: a failed poll counts; SOURCE_FAILURES_PAUSE in a row pause the source.
 * - Items: the canonical key; the same key from another source adds that source; a key that ran (sent_keys, 400 days)
 *   never comes back, nor does an entry dated past its section's age (RESEARCH_ENTRY_MAX_AGE_MS, WORLD_ENTRY_MAX_AGE_MS:
 *   a feed that lists months of posts adds none of them, and an entry it keeps listing never returns as new after its
 *   item is pruned). A `feed_full` or `page_full` item's arXiv IDs and DOIs record mentions on the items of the last 7
 *   days they name; one that names an item not fetched yet is kept 7 days (`pending_mentions`) and recorded when the
 *   item comes.
 * - Embeddings (cluster.ts) within the daily neuron cap; world items join clusters. (The hold-back, 已报道, is computed
 *   at the cutoff against the items that ran by then: select.ts.)
 * - The gate (Haiku 5.5): groups of GATE_GROUP, at most GATE_CALLS_PER_ROUND calls a round and GATE_DAILY_MAX
 *   candidates a day, the highest-weight sources first. A group answered with a refusal or an answer the check refuses
 *   is split in two and tried once more; a candidate still refused is marked `refused` and scored by the fallback at
 *   the cutoff (select.ts). A call that failed (a mid-stream error, a stall, the deadline) says nothing about its
 *   candidates: they stay pending for a later alarm. Gate calls are charged to the round's local day.
 */
import type { StepBudget } from './budget.ts';
import { callModel, type CallContext } from './claude.ts';
import { addToCentroid, AiError, AiQuotaError, embed, embeddingNeurons, embeddingQuotaRate, embeddingText, nearest, unit } from './cluster.ts';
import type { ModelBinding } from '@ziyixi/model-router-client';
import type { FeedEntry } from './fetch/feeds.ts';
import type { Clock, Hosts } from './fetch/hosts.ts';
import type { FetchFn } from './fetch/net.ts';
import { cutDocument } from './fetch/page.ts';
import { pollSource, pollUrl, type PollOutcome } from './fetch/poll.ts';
import { canonicalKey } from './keys.ts';
import {
  ACCEPT_HISTORY_MAX,
  ACCEPT_HISTORY_MS,
  CLUSTER_COSINE,
  CLUSTER_NEAR,
  CLUSTER_WINDOW_MS,
  DAILY_NEURON_CAP,
  DAILY_ROUND,
  EMBED_BATCH,
  EMBED_SUMMARY_CHARS,
  FETCH_TIMEOUT_MS,
  GATE_CALLS_PER_ROUND,
  GATE_DAILY_MAX,
  GATE_GROUP,
  GATE_MODEL,
  GATE_SUMMARY_CHARS,
  HOST_WAIT_SLEEP_MAX_MS,
  MENTION_WINDOW_MS,
  MINUTE,
  PAUSED_RETRY_MS,
  RESEARCH_ENTRY_MAX_AGE_MS,
  SOURCE_FAILURES_PAUSE,
  SUMMARY_MAX,
  TITLE_MAX,
  WORLD_ENTRY_MAX_AGE_MS,
} from './limits.ts';
import { gateRequest, readGate, type GateCandidate } from './prompts.ts';
import { keywordsMatch, reviewOf, type Registry, type Source, type Topic } from './registry.ts';
import type { Round } from './schedule.ts';
import { fromBlob, parseJson, toBlob, type ItemRow, type SourceRow, type Store } from './store.ts';

export interface CollectEnv {
  readonly store: Store;
  readonly registry: Registry;
  readonly topics: readonly Topic[];
  readonly budget: StepBudget;
  readonly clock: Clock;
  readonly hosts: Hosts;
  readonly fetchFn: FetchFn;
  readonly own: readonly string[];
  /** Workers AI, or null (no binding; Home's guard deferred embedding). */
  readonly ai: ModelBinding | null;
  /** The Claude calls, or null when the gate may not run (mode off, paused, no key). */
  readonly claude: CallContext | null;
  readonly transact: <T>(fn: () => T) => T;
  readonly round: Round;
  /** The round's local day. */
  readonly day: string;
  /** Home's guard sheds: the daily probe of paused sources waits (embedding too: `ai` is then null). */
  readonly shed?: boolean;
}

export interface CollectResult {
  readonly done: boolean;
  /** When a deferred host is ready (the next alarm), or null. */
  readonly readyAt: number | null;
  readonly polled: number;
  readonly newItems: number;
  readonly embedded: number;
  readonly screened: number;
  readonly code: string;
}

/** A gate call starts only with this much of the step's wall time left. */
const GATE_CALL_RESERVE_MS = 45_000;

const TIER_RANK: Readonly<Record<string, number>> = { feed_full: 3, page_full: 3, feed_abstract: 2, page_abstract: 2, feed_summary: 1, headline: 0 };

/** Whether `source` polls in `round` (design §2). */
export function pollsIn(source: Source, round: Round): boolean {
  if (source.pollPerDay === 4) return true;
  if (source.pollPerDay === 2) return round.time === DAILY_ROUND || round.kind === 'cutoff';
  return round.time === DAILY_ROUND;
}

function sourceRow(store: Store, id: string): SourceRow {
  return (
    store.one<SourceRow>(`SELECT * FROM sources WHERE id = ?`, id) ?? {
      id,
      state: 'new',
      failures: 0,
      last_error: '',
      last_attempt_ms: null,
      last_success_ms: null,
      last_round: '',
      etag: null,
      last_modified: null,
      seen: '',
      accepts: '[]',
      last_item_title: '',
      last_item_ms: null,
      page: 0,
      first_ms: null,
      tries: '{}',
    }
  );
}

function saveSource(store: Store, row: SourceRow): void {
  store.run(
    `INSERT INTO sources (id, state, failures, last_error, last_attempt_ms, last_success_ms, last_round, etag, last_modified, seen, accepts, last_item_title, last_item_ms, page, first_ms, tries)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET state = excluded.state, failures = excluded.failures, last_error = excluded.last_error, last_attempt_ms = excluded.last_attempt_ms,
       last_success_ms = excluded.last_success_ms, last_round = excluded.last_round, etag = excluded.etag, last_modified = excluded.last_modified, seen = excluded.seen,
       accepts = excluded.accepts, last_item_title = excluded.last_item_title, last_item_ms = excluded.last_item_ms, page = excluded.page, first_ms = excluded.first_ms, tries = excluded.tries`,
    row.id,
    row.state,
    row.failures,
    row.last_error,
    row.last_attempt_ms,
    row.last_success_ms,
    row.last_round,
    row.etag,
    row.last_modified,
    row.seen,
    row.accepts,
    row.last_item_title,
    row.last_item_ms,
    row.page,
    row.first_ms ?? row.last_attempt_ms,
    row.tries,
  );
}

/** The sources still due in `round`, host by host in turn (registry order within a host). */
export function dueSources(store: Store, registry: Registry, round: Round, now: number, shed = false): { source: Source; row: SourceRow; host: string }[] {
  const rows = new Map(store.all<SourceRow>(`SELECT * FROM sources`).map((row) => [row.id, row]));
  const due: { source: Source; row: SourceRow; host: string }[] = [];
  for (const source of registry.sources) {
    if (!source.enabled) continue;
    const row = rows.get(source.id) ?? sourceRow(store, source.id);
    const paused = row.state === 'paused';
    if (paused ? shed || now - (row.last_attempt_ms ?? 0) < PAUSED_RETRY_MS : !pollsIn(source, round) || row.last_round === round.key) continue;
    let host: string;
    try {
      host = new URL(pollUrl(source, 0, now)).hostname;
    } catch {
      continue;
    }
    due.push({ source, row, host });
  }
  const byHost = new Map<string, typeof due>();
  for (const entry of due) {
    const list = byHost.get(entry.host);
    if (list === undefined) byHost.set(entry.host, [entry]);
    else list.push(entry);
  }
  const queues = [...byHost.values()];
  const ordered: typeof due = [];
  for (let i = 0; ordered.length < due.length; i++) for (const queue of queues) if (queue[i] !== undefined) ordered.push(queue[i] as (typeof due)[number]);
  return ordered;
}

/** The percentile of each entry's upvotes within a Hugging Face list (0 to 1). */
function upvotePercentiles(entries: readonly FeedEntry[]): Map<string, number> {
  const voted = entries.filter((entry) => entry.upvotes !== null && entry.arxiv !== null);
  const sorted = voted.map((entry) => entry.upvotes ?? 0).sort((a, b) => a - b);
  const out = new Map<string, number>();
  for (const entry of voted) {
    const below = sorted.filter((value) => value < (entry.upvotes ?? 0)).length;
    out.set(entry.arxiv ?? '', sorted.length <= 1 ? 1 : below / (sorted.length - 1));
  }
  return out;
}

export interface IngestCounts {
  readonly accepted: number;
  readonly created: number;
}

/** Turns a poll's entries into items (inside the poll's transaction). */
export function ingest(store: Store, source: Source, row: SourceRow, entries: readonly FeedEntry[], now: number, day: string): IngestCounts {
  const percentiles = source.kind === 'json' ? upvotePercentiles(entries) : new Map<string, number>();
  const accepts = parseJson<number[]>(row.accepts, []).filter((ms) => now - ms < ACCEPT_HISTORY_MS);
  let accepted = 0;
  let created = 0;
  let lastTitle: string | null = null;
  const candidate = source.role === 'candidate' ? 1 : 0;
  const readsMentions = candidate === 1 && (source.text === 'feed_full' || source.text === 'page_full');
  const oldest = now - (source.section === 'world' ? WORLD_ENTRY_MAX_AGE_MS : RESEARCH_ENTRY_MAX_AGE_MS);
  for (const entry of entries.slice(0, source.maxItems)) {
    const key = canonicalKey(entry);
    const title = entry.title.slice(0, TITLE_MAX).trim();
    if (key === null || title === '') continue;
    if (entry.published !== null && entry.published < oldest) continue;
    if (!keywordsMatch(source.keywords, entry.title, entry.summary)) continue;
    if (source.requiresAbstract && entry.summary.trim().length < 80) continue;
    if (store.one(`SELECT 1 AS x FROM sent_keys WHERE key = ?`, key) !== undefined) continue;
    const summary = entry.summary.slice(0, SUMMARY_MAX);
    const body = candidate === 1 && source.text === 'feed_full' && entry.summary.length > SUMMARY_MAX ? cutDocument(entry.summary) : null;
    const existing = store.one<ItemRow>(`SELECT * FROM items WHERE key = ?`, key);
    let rowid: number;
    if (existing === undefined) {
      // The posts that named this key before it was fetched (design §4): their mentions are recorded now.
      const named = store.all<{ source: string; item: number }>(`SELECT source, item FROM pending_mentions WHERE key = ? AND ms >= ?`, key, now - MENTION_WINDOW_MS);
      if (named.length > 0) store.run(`DELETE FROM pending_mentions WHERE key = ?`, key);
      store.insert('items', {
        key,
        section: source.section,
        title,
        summary,
        body,
        link: entry.link.slice(0, 1000),
        doi: entry.doi,
        arxiv: entry.arxiv,
        published_ms: entry.published,
        fetched_ms: now,
        sources: JSON.stringify([source.id]),
        candidate,
        text_tier: source.text,
        upvotes: entry.upvotes ?? 0,
        upvote_pct: percentiles.get(entry.arxiv ?? '') ?? 0,
        mentions: JSON.stringify(named.map((mention) => ({ s: mention.source, i: mention.item })).slice(0, 20)),
        gate: candidate === 1 ? 'pending' : 'signal',
      });
      rowid = store.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
      created++;
    } else {
      rowid = existing.rowid;
      const sources = parseJson<string[]>(existing.sources, []);
      const isNew = !sources.includes(source.id);
      const changes: Record<string, string | number | null> = {};
      if (isNew) changes['sources'] = JSON.stringify([...sources, source.id]);
      if (candidate === 1 && existing.candidate === 0) {
        changes['candidate'] = 1;
        changes['gate'] = 'pending';
      }
      if (candidate === 1 && (TIER_RANK[source.text] ?? 0) > (TIER_RANK[existing.text_tier] ?? 0)) changes['text_tier'] = source.text;
      if (candidate === 1 && summary.length > existing.summary.length) changes['summary'] = summary;
      if (body !== null && existing.body === null) changes['body'] = body;
      if (entry.upvotes !== null && entry.upvotes > existing.upvotes) changes['upvotes'] = entry.upvotes;
      const pct = percentiles.get(entry.arxiv ?? '');
      if (pct !== undefined && pct > existing.upvote_pct) changes['upvote_pct'] = pct;
      store.update('items', 'rowid', rowid, changes);
      if (!isNew) continue;
    }
    accepted++;
    accepts.push(now);
    lastTitle = title;
    if (readsMentions) {
      for (const mentioned of entry.mentions) {
        if (mentioned === key) continue;
        const target = store.one<{ rowid: number; mentions: string; fetched_ms: number }>(`SELECT rowid, mentions, fetched_ms FROM items WHERE key = ?`, mentioned);
        if (target === undefined) {
          store.run(`INSERT OR IGNORE INTO pending_mentions (key, source, item, ms) VALUES (?, ?, ?, ?)`, mentioned, source.id, rowid, now);
          continue;
        }
        if (now - target.fetched_ms > MENTION_WINDOW_MS) continue;
        const mentions = parseJson<{ s: string; i: number }[]>(target.mentions, []);
        if (mentions.some((mention) => mention.s === source.id)) continue;
        store.update('items', 'rowid', target.rowid, { mentions: JSON.stringify([...mentions, { s: source.id, i: rowid }].slice(0, 20)) });
      }
    }
  }
  // One usage row update per poll, not one per item (each is a row written).
  if (created > 0) {
    store.addUsage(day, 'items', created);
    if (source.section === 'world') store.addUsage(day, 'world_items', created);
  }
  row.accepts = JSON.stringify(accepts.slice(-ACCEPT_HISTORY_MAX));
  if (lastTitle !== null) {
    row.last_item_title = lastTitle;
    row.last_item_ms = now;
  }
  return { accepted, created };
}

function applyOutcome(env: CollectEnv, source: Source, row: SourceRow, outcome: PollOutcome, now: number): number {
  const next: SourceRow = { ...row, last_attempt_ms: now };
  let created = 0;
  if (outcome.kind === 'entries' || outcome.kind === 'not_modified') {
    next.state = 'ok';
    next.failures = 0;
    next.last_error = '';
    next.last_success_ms = now;
    if (outcome.kind === 'entries') {
      created = ingest(env.store, source, next, outcome.entries, now, env.day).created;
      if (outcome.etag !== null) next.etag = outcome.etag;
      if (outcome.lastModified !== null) next.last_modified = outcome.lastModified;
      if (outcome.seen !== null) next.seen = outcome.seen;
      if (outcome.tries !== null) next.tries = outcome.tries;
      next.page = outcome.nextPage;
      if (outcome.done) next.last_round = env.round.key;
    } else next.last_round = env.round.key;
  } else if (outcome.kind === 'failed') {
    next.failures = row.failures + 1;
    next.last_error = outcome.code;
    next.state = next.failures >= SOURCE_FAILURES_PAUSE ? 'paused' : 'failing';
    next.page = 0;
    next.last_round = env.round.key;
    if (next.state === 'paused' && row.state !== 'paused') env.store.pushError('source_paused');
  }
  saveSource(env.store, next);
  return created;
}

async function pollPhase(env: CollectEnv): Promise<{ polled: number; created: number; remaining: number; readyAt: number | null }> {
  let polled = 0;
  let created = 0;
  let readyAt: number | null = null;
  const skipped = new Set<string>();
  for (;;) {
    const due = dueSources(env.store, env.registry, env.round, env.clock.now(), env.shed === true).filter((entry) => !skipped.has(entry.source.id));
    if (due.length === 0) break;
    let progressed = false;
    for (const { source, row, host } of due) {
      if (env.budget.spent(FETCH_TIMEOUT_MS)) return { polled, created, remaining: due.length, readyAt };
      const ready = env.hosts.readyAt(host);
      if (ready > env.clock.now() + HOST_WAIT_SLEEP_MAX_MS) {
        skipped.add(source.id);
        readyAt = readyAt === null ? ready : Math.min(readyAt, ready);
        continue;
      }
      const outcome = await pollSource(source, row, { hosts: env.hosts, fetchFn: env.fetchFn, own: env.own, budget: env.budget, now: env.clock.now() });
      if (outcome.kind === 'deferred') {
        skipped.add(source.id);
        if (outcome.until !== null) readyAt = readyAt === null ? outcome.until : Math.min(readyAt, outcome.until);
        if (env.budget.spent()) return { polled, created, remaining: due.length, readyAt };
        continue;
      }
      polled++;
      progressed = true;
      created += env.transact(() => applyOutcome(env, source, row, outcome, env.clock.now()));
      // An arXiv query's next page comes in the next pass (one host, its spacing).
      if (outcome.kind === 'entries' && !outcome.done) break;
    }
    if (!progressed) break;
  }
  const remaining = dueSources(env.store, env.registry, env.round, env.clock.now(), env.shed === true).length;
  return { polled, created, remaining, readyAt };
}

/** The topic vectors of the current profile, embedded once per profile version (the refused-candidate fallback). */
async function ensureTopicVectors(env: CollectEnv, ai: ModelBinding): Promise<void> {
  const version = env.topics.map((topic) => `${topic.id}:${topic.description}`).join('|');
  const stored = env.store.one<{ version: string }>(`SELECT version FROM topic_vectors LIMIT 1`);
  if (stored?.version === version || !env.budget.take()) return;
  const research = env.topics.filter((topic) => topic.section === 'research');
  const { vectors, neurons } = await embed(ai, research.map((topic) => topic.description));
  env.transact(() => {
    env.store.run(`DELETE FROM topic_vectors`);
    research.forEach((topic, i) => {
      const vector = vectors[i];
      if (vector !== undefined) env.store.insert('topic_vectors', { topic: topic.id, vec: toBlob(vector), version });
    });
    env.store.addUsage(env.day, 'neurons', neurons);
  });
}

async function embedPhase(env: CollectEnv): Promise<{ embedded: number; remaining: number }> {
  const pending = (): number => env.store.count(`SELECT count(*) AS n FROM items WHERE embedded = 0`);
  const skipAll = (code: number): void => {
    env.transact(() => env.store.run(`UPDATE items SET embedded = ? WHERE embedded = 0`, code));
  };
  if (env.ai === null || env.store.getMeta('ai_quota_day') === env.day) {
    skipAll(2);
    return { embedded: 0, remaining: 0 };
  }
  const ai = env.ai;
  if (!env.budget.take()) return { embedded: 0, remaining: pending() };
  let quotaUnitsPerToken: number;
  try { quotaUnitsPerToken = await embeddingQuotaRate(ai); }
  catch (error) {
    if (!(error instanceof AiError)) throw error;
    skipAll(2);
    env.transact(() => { env.store.pushError(error.code); });
    return { embedded: 0, remaining: 0 };
  }
  let embedded = 0;
  try {
    await ensureTopicVectors(env, ai);
  } catch (error) {
    if (error instanceof AiQuotaError) {
      env.transact(() => {
        env.store.setMeta('ai_quota_day', env.day);
        env.store.pushError('ai_quota_exhausted');
      });
      skipAll(2);
      return { embedded: 0, remaining: 0 };
    }
    if (!(error instanceof AiError)) throw error;
  }
  const now = env.clock.now();
  for (;;) {
    if (env.budget.spent(MINUTE)) break;
    const batch = env.store.all<ItemRow>(`SELECT * FROM items WHERE embedded = 0 ORDER BY fetched_ms LIMIT ?`, EMBED_BATCH);
    if (batch.length === 0) break;
    const texts = batch.map((item) => embeddingText(item.title, item.summary, EMBED_SUMMARY_CHARS));
    const estimate = embeddingNeurons(texts, quotaUnitsPerToken);
    if (env.store.usage(env.day).neurons + estimate > DAILY_NEURON_CAP) {
      skipAll(2);
      env.transact(() => { env.store.pushError('neuron_cap'); });
      break;
    }
    if (!env.budget.take()) break;
    let result: { vectors: Float32Array[]; neurons: number };
    try {
      result = await embed(ai, texts);
    } catch (error) {
      if (error instanceof AiQuotaError) {
        env.transact(() => {
          env.store.setMeta('ai_quota_day', env.day);
          env.store.pushError('ai_quota_exhausted');
        });
        skipAll(2);
        break;
      }
      if (!(error instanceof AiError)) throw error;
      env.transact(() => {
        for (const item of batch) env.store.update('items', 'rowid', item.rowid, { embedded: 2 });
        env.store.pushError(error.code);
      });
      continue;
    }
    env.transact(() => {
      const clusters = env.store
        .all<{ id: number; centroid: ArrayBuffer; n: number }>(`SELECT id, centroid, n FROM clusters WHERE updated_ms >= ?`, now - CLUSTER_WINDOW_MS)
        .map((row) => ({ id: row.id, vector: fromBlob(row.centroid) ?? new Float32Array(0), n: row.n }));
      batch.forEach((item, i) => {
        const vector = result.vectors[i];
        if (vector === undefined) return;
        env.store.insert('embeddings', { item: item.rowid, vec: toBlob(vector), ms: now });
        const changes: Record<string, string | number | null> = { embedded: 1 };
        if (item.section === 'world') {
          const best = nearest(vector, clusters);
          if (best !== null && Math.abs(best.cosine - CLUSTER_COSINE) < CLUSTER_NEAR) console.log(JSON.stringify({ event: 'cluster_near', item: item.rowid, cluster: best.id, cosine: Math.round(best.cosine * 1000) / 1000 }));
          if (best !== null && best.cosine >= CLUSTER_COSINE) {
            const cluster = clusters.find((entry) => entry.id === best.id);
            if (cluster !== undefined) {
              cluster.vector = addToCentroid(cluster.vector, vector);
              cluster.n += 1;
              env.store.run(`UPDATE clusters SET centroid = ?, n = ?, updated_ms = ? WHERE id = ?`, toBlob(cluster.vector), cluster.n, now, cluster.id);
            }
            changes['cluster'] = best.id;
          } else {
            env.store.insert('clusters', { centroid: toBlob(unit(vector)), n: 1, created_ms: now, updated_ms: now });
            const id = env.store.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
            clusters.push({ id, vector: unit(vector), n: 1 });
            changes['cluster'] = id;
          }
        }
        env.store.update('items', 'rowid', item.rowid, changes);
      });
      env.store.addUsage(env.day, 'neurons', result.neurons);
    });
    embedded += batch.length;
  }
  return { embedded, remaining: pending() };
}

function sourceWeights(store: Store): Map<string, number> {
  return new Map(store.all<{ id: string; weight: number }>(`SELECT id, weight FROM weights WHERE kind = 'source'`).map((row) => [row.id, row.weight]));
}

/** The gate's candidate of an item: its venue, review, title, summary and its other venues (a world item's cluster's). */
function gateCandidate(store: Store, registry: Registry, item: ItemRow): GateCandidate {
  const sources = parseJson<string[]>(item.sources, []).map((id) => registry.byId.get(id)).filter((source): source is Source => source !== undefined);
  const primary = sources.find((source) => source.role === 'candidate') ?? sources[0];
  const venues = new Set(sources.map((source) => source.name));
  if (item.section === 'world' && item.cluster !== null) {
    for (const member of store.all<{ sources: string }>(`SELECT sources FROM items WHERE cluster = ? AND rowid != ? LIMIT 20`, item.cluster, item.rowid)) {
      for (const id of parseJson<string[]>(member.sources, [])) {
        const source = registry.byId.get(id);
        if (source !== undefined) venues.add(source.name);
      }
    }
  }
  const venue = primary?.name ?? '';
  venues.delete(venue);
  return {
    id: `c${String(item.rowid)}`,
    section: item.section === 'world' ? 'world' : 'research',
    venue,
    review: primary === undefined ? 'news' : reviewOf(primary, item.doi),
    title: item.title,
    summary: item.summary.slice(0, GATE_SUMMARY_CHARS),
    otherVenues: [...venues].slice(0, 8),
  };
}

type GateStop = 'blocked' | 'transient' | null;

async function gateGroup(env: CollectEnv, claude: CallContext, items: readonly ItemRow[], split: boolean): Promise<{ stop: GateStop; calls: number }> {
  if (!env.budget.take(2)) return { stop: 'transient', calls: 0 };
  const candidates = items.map((item) => gateCandidate(env.store, env.registry, item));
  const { params, estimatedInputTokens } = gateRequest(candidates, env.topics);
  const outcome = await callModel(claude, { step: 'gate', issue: env.day, model: GATE_MODEL, params, estimatedInputTokens, deadlineMs: Math.min(3 * MINUTE, env.budget.timeLeft()) });
  if (outcome.kind === 'blocked' || outcome.kind === 'rejected') return { stop: 'blocked', calls: 0 };
  if (outcome.kind === 'transient') return { stop: 'transient', calls: 0 };
  // A call that failed (a mid-stream error, a stall, the deadline) is the API's moment, not its candidates': they stay
  // pending, and only a refusal or an answer the check refuses splits the group.
  if (outcome.kind === 'failed') return { stop: 'transient', calls: 1 };
  const scores = outcome.kind === 'answer' ? readGate(outcome.json, candidates, env.topics) : null;
  if (scores !== null) {
    env.transact(() => {
      let geo = 0;
      for (const item of items) {
        const score = scores.get(`c${String(item.rowid)}`);
        if (score === undefined) continue;
        env.store.update('items', 'rowid', item.rowid, { gate: 'scored', topic: score.topic, score: score.score, gate_day: env.day });
        if (score.topic.startsWith('geo.')) geo++;
      }
      env.store.addUsage(env.day, 'geo_items', geo);
      env.store.addUsage(env.day, 'screened', items.length);
    });
    return { stop: null, calls: 1 };
  }
  if (!split && items.length > 1) {
    const half = Math.ceil(items.length / 2);
    const first = await gateGroup(env, claude, items.slice(0, half), true);
    if (first.stop !== null) return { stop: first.stop, calls: 1 + first.calls };
    const second = await gateGroup(env, claude, items.slice(half), true);
    return { stop: second.stop, calls: 1 + first.calls + second.calls };
  }
  env.transact(() => {
    for (const item of items) env.store.update('items', 'rowid', item.rowid, { gate: 'refused', gate_day: env.day });
    env.store.addUsage(env.day, 'screened', items.length);
    env.store.addUsage(env.day, 'refused', items.length);
  });
  return { stop: null, calls: 1 };
}

async function gatePhase(env: CollectEnv): Promise<{ screened: number; remaining: number; blocked: boolean }> {
  const pendingCount = (): number => env.store.count(`SELECT count(*) AS n FROM items WHERE gate = 'pending' AND (section = 'research' OR embedded != 0)`);
  if (env.claude === null) return { screened: 0, remaining: pendingCount(), blocked: true };
  const callsKey = `gate_calls:${env.round.key}`;
  let calls = Number(env.store.getMeta(callsKey) ?? '0');
  let screened = 0;
  const weights = sourceWeights(env.store);
  while (calls < GATE_CALLS_PER_ROUND && !env.budget.spent(GATE_CALL_RESERVE_MS)) {
    if (env.store.usage(env.day).screened >= GATE_DAILY_MAX) break;
    const pending = env.store.all<ItemRow>(`SELECT * FROM items WHERE gate = 'pending' AND (section = 'research' OR embedded != 0) ORDER BY fetched_ms LIMIT 400`);
    if (pending.length === 0) break;
    const weightOf = (item: ItemRow): number => Math.max(...parseJson<string[]>(item.sources, []).map((id) => weights.get(id) ?? 1), 0);
    const group = [...pending].sort((a, b) => weightOf(b) - weightOf(a) || a.fetched_ms - b.fetched_ms).slice(0, GATE_GROUP);
    const result = await gateGroup(env, env.claude, group, false);
    calls += Math.max(1, result.calls);
    env.transact(() => { env.store.setMeta(callsKey, String(calls)); });
    if (result.stop === 'blocked') return { screened, remaining: pendingCount(), blocked: true };
    if (result.stop === 'transient') return { screened, remaining: pendingCount(), blocked: false };
    screened += group.length;
  }
  return { screened, remaining: calls >= GATE_CALLS_PER_ROUND || env.store.usage(env.day).screened >= GATE_DAILY_MAX ? 0 : pendingCount(), blocked: false };
}

/** One alarm's share of a round; `done` when every part of the round is finished (or cannot go on this round). */
export async function collectStep(env: CollectEnv): Promise<CollectResult> {
  const polls = await pollPhase(env);
  const embeddings = await embedPhase(env);
  const gate = embeddings.remaining === 0 || env.ai === null ? await gatePhase(env) : { screened: 0, remaining: 1, blocked: false };
  const pollsDone = polls.remaining === 0 || (polls.readyAt !== null && !env.budget.spent());
  const done = polls.remaining === 0 && embeddings.remaining === 0 && (gate.remaining === 0 || gate.blocked);
  const code = !pollsDone ? 'polling' : embeddings.remaining > 0 ? 'embedding' : gate.remaining > 0 && !gate.blocked ? 'gating' : 'ok';
  return { done, readyAt: polls.remaining > 0 ? polls.readyAt : null, polled: polls.polled, newItems: polls.created, embedded: embeddings.embedded, screened: gate.screened, code };
}
