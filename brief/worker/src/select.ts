/**
 * Corroboration, the gate order, the cards and the shortlist (../../docs/design.md §5.2, §5.3, §6, §9). The order is
 * computed again at every cutoff from the item and its cluster as they are then, because the signals that say a paper
 * matters arrive after the gate call:
 *
 *   research: order = score × w_source × w_topic + c
 *             c     = min(3, 0.75 × (independent sources − 1) + 1 × [mentioned] + 1.5 × upvote percentile)
 *   world:    order = score × w_source × w_topic + 0.5 × log2(candidate sources + 0.5 × signal-only sources)
 *                     + 1 × [a member's full text is readable]
 *
 * Independent sources are distinct registry names (two arXiv queries are one). The weights are the weekly learned ones
 * (learn.ts), 1 before any vote. Cards: the eligible research items that passed the gate and never ran, the 40 best with
 * every topic's best 3 (a 专业 topic's 5) kept first and at most 10 per topic, since corroboration reaches ML papers
 * only; the world clusters with score ≥ 6 and a candidate source, the 10 best. Without a pick the shortlist is the gate
 * order: the 3 best clusters with score ≥ 7, and research cards up to 8 items in all, each topic's best first and at
 * most 2 per topic.
 *
 * Never repeat (design §4): an item that ran never makes a card again, nor do the members a world story's cluster had
 * when it ran; members that came after make a card marked 已报道 with the title that ran, and so does any card at cosine
 * ≥ 0.88 to an item that ran in the last 7 days. The hold-back is computed here, at the cutoff, against what ran by
 * then. 还有 never lists an item twice.
 */
import { percentileScore, cosine } from './cluster.ts';
import {
  CARD_SUMMARY_CHARS,
  CARDS_FLOOR,
  CARDS_FLOOR_PROFESSIONAL,
  DAY,
  DEEP_CARDS,
  DEEP_CARDS_FLOOR,
  DEEP_CARDS_FLOOR_PROFESSIONAL,
  GATE_PASS,
  HOLD_BACK_COSINE,
  HOLD_BACK_WINDOW_MS,
  MORE_ITEMS_MAX,
  ORDER_CORROBORATION_MAX,
  ORDER_MENTIONED,
  ORDER_SOURCES,
  ORDER_UPVOTES,
  ORDER_WORLD_READABLE,
  ORDER_WORLD_SIGNAL,
  ORDER_WORLD_SOURCES,
  PICK_PER_TOPIC,
  PICK_RESEARCH_MAX,
  PICK_TOTAL_MAX,
  PICK_WORLD_MAX,
  RESEARCH_CARDS,
  RESEARCH_CARDS_PER_TOPIC,
  RESEARCH_ELIGIBLE_MS,
  TITLE_MAX,
  WORLD_CARDS,
  WORLD_ELIGIBLE_MS,
  WORLD_FALLBACK_PASS,
  WORLD_REFUSED_SOURCES,
} from './limits.ts';
import type { Card, Picked } from './prompts.ts';
import { reviewOf, type Registry, type ReviewName, type Source, type Topic } from './registry.ts';
import { addDays, arxivEligible, cutoffOf } from './schedule.ts';
import { fromBlob, parseJson, type ItemRow, type Store } from './store.ts';

export interface Weights {
  readonly sources: ReadonlyMap<string, number>;
  readonly topics: ReadonlyMap<string, number>;
}

export function loadWeights(store: Store): Weights {
  const sources = new Map<string, number>();
  const topics = new Map<string, number>();
  for (const row of store.all<{ kind: string; id: string; weight: number }>(`SELECT kind, id, weight FROM weights`)) (row.kind === 'source' ? sources : topics).set(row.id, row.weight);
  return { sources, topics };
}

function sourcesOf(registry: Registry, item: Pick<ItemRow, 'sources'>): Source[] {
  return parseJson<string[]>(item.sources, []).map((id) => registry.byId.get(id)).filter((source): source is Source => source !== undefined);
}

/** The item's primary source: its candidate source with the best text tier (registry order on a tie). */
export function primarySource(registry: Registry, item: Pick<ItemRow, 'sources'>): Source | undefined {
  const rank: Record<string, number> = { feed_full: 3, page_full: 3, feed_abstract: 2, page_abstract: 2, feed_summary: 1, headline: 0 };
  const candidates = sourcesOf(registry, item).filter((source) => source.role === 'candidate');
  return [...candidates].sort((a, b) => (rank[b.text] ?? 0) - (rank[a.text] ?? 0) || a.index - b.index)[0];
}

/** Whether an item's full text is readable (its best tier is feed_full or page_full). */
export function readable(item: Pick<ItemRow, 'text_tier'>): boolean {
  return item.text_tier === 'feed_full' || item.text_tier === 'page_full';
}

function sourceWeight(weights: Weights, sources: readonly Source[]): number {
  const candidates = sources.filter((source) => source.role === 'candidate');
  return candidates.length === 0 ? 1 : Math.max(...candidates.map((source) => weights.sources.get(source.id) ?? 1));
}

export interface ResearchCard extends Card {
  readonly order: number;
  readonly rowid: number;
  readonly key: string;
  readonly sourceIds: readonly string[];
  /** An earlier issue's 还有 listed it. */
  readonly listed: boolean;
}

export interface WorldCard extends Card {
  readonly order: number;
  readonly cluster: number | null;
  /** The member items, the best candidate documents first (readable full text first). */
  readonly members: readonly ItemRow[];
  readonly signals: readonly string[];
  readonly score: number;
}

/** The research order of an item at the cutoff, and its corroboration in words. */
export function researchOrder(item: ItemRow, registry: Registry, weights: Weights): { order: number; corroboration: string } {
  const sources = sourcesOf(registry, item);
  const names = new Set(sources.map((source) => source.name));
  const mentions = parseJson<{ s: string }[]>(item.mentions, []);
  const mentioners = [...new Set(mentions.map((mention) => registry.byId.get(mention.s)?.name).filter((name): name is string => name !== undefined))];
  const c = Math.min(ORDER_CORROBORATION_MAX, ORDER_SOURCES * (names.size - 1) + ORDER_MENTIONED * (mentioners.length > 0 ? 1 : 0) + ORDER_UPVOTES * item.upvote_pct);
  const order = (item.score ?? 0) * sourceWeight(weights, sources) * (weights.topics.get(item.topic ?? '') ?? 1) + c;
  const words: string[] = [];
  if (names.size > 1) words.push(`${String(names.size)} 个独立来源`);
  if (mentioners.length > 0) words.push(`${mentioners.join('、')} 链接`);
  if (item.upvote_pct > 0) words.push(`Hugging Face 当日前 ${String(Math.max(1, Math.round((1 - item.upvote_pct) * 100)))}%`);
  return { order, corroboration: words.join('；') || '单一来源' };
}

/**
 * Scores the candidates Haiku refused (design §5.1), at the cutoff: a research candidate takes its nearest topic by
 * embedding and the score at its similarity's percentile among the day's Haiku-scored research candidates; a world
 * candidate takes its cluster's Haiku score, or passes with WORLD_REFUSED_SOURCES independent sources. Each is marked
 * `fallback`; one without a fallback `unscored`.
 */
export function resolveRefused(store: Store, registry: Registry, topics: readonly Topic[]): number {
  const refused = store.all<ItemRow>(`SELECT * FROM items WHERE gate = 'refused'`);
  if (refused.length === 0) return 0;
  const vectors = store
    .all<{ topic: string; vec: ArrayBuffer }>(`SELECT topic, vec FROM topic_vectors`)
    .map((row) => ({ topic: row.topic, vector: fromBlob(row.vec) }))
    .filter((row): row is { topic: string; vector: Float32Array } => row.vector !== null && topics.some((topic) => topic.id === row.topic));
  const vectorOf = (rowid: number): Float32Array | null => fromBlob(store.one<{ vec: ArrayBuffer }>(`SELECT vec FROM embeddings WHERE item = ?`, rowid)?.vec ?? null);
  const nearestTopic = (vector: Float32Array): { topic: string; similarity: number } | null => {
    let best: { topic: string; similarity: number } | null = null;
    for (const entry of vectors) {
      const similarity = cosine(vector, entry.vector);
      if (best === null || similarity > best.similarity) best = { topic: entry.topic, similarity };
    }
    return best;
  };
  const scoredByDay = new Map<string, { similarity: number; score: number }[]>();
  const scoredOf = (day: string): { similarity: number; score: number }[] => {
    let list = scoredByDay.get(day);
    if (list === undefined) {
      list = store
        .all<{ rowid: number; score: number; vec: ArrayBuffer }>(`SELECT i.rowid, i.score, e.vec FROM items i JOIN embeddings e ON e.item = i.rowid WHERE i.gate = 'scored' AND i.section = 'research' AND i.gate_day = ? LIMIT 500`, day)
        .flatMap((row) => {
          const vector = fromBlob(row.vec);
          const near = vector === null ? null : nearestTopic(vector);
          return near === null ? [] : [{ similarity: near.similarity, score: row.score }];
        });
      scoredByDay.set(day, list);
    }
    return list;
  };
  let resolved = 0;
  for (const item of refused) {
    if (item.section === 'research') {
      const vector = vectorOf(item.rowid);
      const near = vector === null ? null : nearestTopic(vector);
      const score = near === null ? null : percentileScore(near.similarity, scoredOf(item.gate_day ?? ''));
      if (near !== null && score !== null) {
        store.update('items', 'rowid', item.rowid, { gate: 'fallback', topic: near.topic, score });
        resolved++;
      } else store.update('items', 'rowid', item.rowid, { gate: 'unscored' });
      continue;
    }
    const members = item.cluster === null ? [] : store.all<ItemRow>(`SELECT * FROM items WHERE cluster = ? AND rowid != ?`, item.cluster, item.rowid);
    const scored = members.filter((member) => member.gate === 'scored' && member.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (scored !== undefined) {
      store.update('items', 'rowid', item.rowid, { gate: 'fallback', topic: scored.topic, score: scored.score });
      resolved++;
      continue;
    }
    const names = new Set([item, ...members].flatMap((member) => sourcesOf(registry, member).filter((source) => source.role === 'candidate').map((source) => source.name)));
    if (names.size >= WORLD_REFUSED_SOURCES) {
      store.update('items', 'rowid', item.rowid, { gate: 'fallback', topic: topics.find((topic) => topic.section === 'world')?.id ?? 'world.affairs', score: GATE_PASS });
      resolved++;
    } else store.update('items', 'rowid', item.rowid, { gate: 'unscored' });
  }
  return resolved;
}

/**
 * The hold-back at the cutoff of `date` (design §4): for an item, the title of the most similar item that ran in the
 * last HOLD_BACK_WINDOW_MS (the issue's own title for it, else the item's) at cosine ≥ HOLD_BACK_COSINE, or null.
 * Nothing is read until the first item is asked about, and nothing more when nothing ran.
 */
export function holdBack(store: Store, date: string): (rowid: number) => string | null {
  let ran: { title: string; vector: Float32Array }[] | null = null;
  return (rowid) => {
    ran ??= store
      .all<{ title: string; vec: ArrayBuffer }>(
        `SELECT coalesce(s.title, i.title) AS title, e.vec FROM items i JOIN embeddings e ON e.item = i.rowid LEFT JOIN sent_keys s ON s.key = i.key WHERE i.ran IS NOT NULL AND i.ran >= ?`,
        addDays(date, -Math.round(HOLD_BACK_WINDOW_MS / DAY)),
      )
      .map((row) => ({ title: row.title, vector: fromBlob(row.vec) }))
      .filter((row): row is { title: string; vector: Float32Array } => row.vector !== null);
    if (ran.length === 0) return null;
    const vector = fromBlob(store.one<{ vec: ArrayBuffer }>(`SELECT vec FROM embeddings WHERE item = ?`, rowid)?.vec ?? null);
    if (vector === null) return null;
    let best: { title: string; similarity: number } | null = null;
    for (const earlier of ran) {
      const similarity = cosine(earlier.vector, vector);
      if (similarity >= HOLD_BACK_COSINE && (best === null || similarity > best.similarity)) best = { title: earlier.title, similarity };
    }
    return best === null ? null : best.title.slice(0, TITLE_MAX);
  };
}

/** The title a world story ran under, when a member of its cluster ran (design §4), or null. */
function clusterRanTitle(store: Store, cluster: number | null): string | null {
  if (cluster === null) return null;
  return store.one<{ title: string }>(`SELECT s.title FROM items i JOIN sent_keys s ON s.key = i.key WHERE i.cluster = ? AND i.ran IS NOT NULL ORDER BY i.ran DESC LIMIT 1`, cluster)?.title ?? null;
}

/**
 * The `max` best of `sorted` (best first), every topic's best `floor(topic)` first, then the rest by order with at most
 * `cap` a topic; answered best first.
 */
export function fairTop<T extends { readonly topic: string }>(sorted: readonly T[], max: number, floor: (topic: string) => number, cap: number): T[] {
  const taken = new Set<T>();
  const counts = new Map<string, number>();
  const take = (card: T, limit: number): void => {
    const count = counts.get(card.topic) ?? 0;
    if (taken.size >= max || taken.has(card) || count >= limit) return;
    taken.add(card);
    counts.set(card.topic, count + 1);
  };
  for (const card of sorted) take(card, Math.min(cap, floor(card.topic)));
  for (const card of sorted) take(card, cap);
  return sorted.filter((card) => taken.has(card));
}

/** A topic's floor among the cards: the 专业 topics (the owner's own field) keep more. */
function floorOf(topics: readonly Topic[], professional: number, other: number): (topic: string) => number {
  const own = new Set(topics.filter((topic) => topic.format === 'professional').map((topic) => topic.id));
  return (topic) => (own.has(topic) ? professional : other);
}

function cardReview(registry: Registry, item: ItemRow): { venues: string[]; review: ReviewName } {
  const sources = sourcesOf(registry, item);
  const primary = primarySource(registry, item) ?? sources[0];
  return { venues: [...new Set(sources.map((source) => source.name))].slice(0, 3), review: primary === undefined ? 'news' : reviewOf(primary, item.doi) };
}

export interface CardOptions {
  /** The deep read's week: briefed items included, a wider window. */
  readonly deep?: boolean;
  /** Owner votes on items (by canonical key), in words, for the deep-read pick. */
  readonly votes?: ReadonlyMap<string, string>;
}

/** The research cards of the cutoff of `date` (design §5.2), best first. */
export function researchCards(store: Store, registry: Registry, weights: Weights, date: string, topics: readonly Topic[], options: CardOptions = {}): ResearchCard[] {
  const cutoff = cutoffOf(date);
  const rows = store.all<ItemRow>(
    `SELECT * FROM items WHERE fetched_ms >= ? AND fetched_ms < ? AND section = 'research' AND candidate = 1 AND gate IN ('scored', 'fallback') AND score >= ?`,
    cutoff - RESEARCH_ELIGIBLE_MS,
    cutoff,
    GATE_PASS,
  );
  const cards: ResearchCard[] = [];
  for (const item of rows) {
    if (!options.deep && item.ran !== null) continue;
    if (!options.deep && item.arxiv !== null && !arxivEligible(item.fetched_ms, date)) continue;
    const { order, corroboration } = researchOrder(item, registry, weights);
    const { venues, review } = cardReview(registry, item);
    cards.push({
      id: `r${String(item.rowid)}`,
      rowid: item.rowid,
      key: item.key,
      section: 'research',
      topic: item.topic ?? 'ml.other',
      venues,
      review,
      title: item.title,
      summary: item.summary.slice(0, CARD_SUMMARY_CHARS),
      corroboration,
      readable: readable(item),
      heldBack: null,
      order,
      sourceIds: parseJson<string[]>(item.sources, []),
      listed: item.listed !== null,
      ...(options.votes?.get(item.key) === undefined ? {} : { votes: options.votes.get(item.key) as string }),
    });
  }
  // Best first; on a tie the newer item (geo scores are integers without corroboration, and ties are common).
  cards.sort((a, b) => b.order - a.order || b.rowid - a.rowid);
  if (options.deep) return fairTop(cards, DEEP_CARDS, floorOf(topics, DEEP_CARDS_FLOOR_PROFESSIONAL, DEEP_CARDS_FLOOR), Infinity);
  const heldBackOf = holdBack(store, date);
  return fairTop(cards, RESEARCH_CARDS, floorOf(topics, CARDS_FLOOR_PROFESSIONAL, CARDS_FLOOR), RESEARCH_CARDS_PER_TOPIC).map((card) => ({ ...card, heldBack: heldBackOf(card.rowid) }));
}

/** The world cards of the cutoff of `date` (design §5.2): clusters (or single stories without one), best first. */
export function worldCards(store: Store, registry: Registry, weights: Weights, date: string, options: CardOptions = {}): WorldCard[] {
  const cutoff = cutoffOf(date);
  const window = options.deep ? RESEARCH_ELIGIBLE_MS : WORLD_ELIGIBLE_MS;
  const rows = store.all<ItemRow>(`SELECT * FROM items WHERE fetched_ms >= ? AND fetched_ms < ? AND section = 'world'`, cutoff - window, cutoff);
  const groups = new Map<string, ItemRow[]>();
  for (const item of rows) {
    // A member that ran (with its whole cluster, when its story ran) never makes a card again; later members may.
    if (!options.deep && item.ran !== null) continue;
    const key = item.cluster === null ? `i${String(item.rowid)}` : `c${String(item.cluster)}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [item]);
    else list.push(item);
  }
  const cards: WorldCard[] = [];
  for (const [key, members] of groups) {
    const scored = members.filter((member) => member.candidate === 1 && (member.gate === 'scored' || member.gate === 'fallback') && member.score !== null);
    if (scored.length === 0) continue;
    const best = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] as ItemRow;
    const score = best.score ?? 0;
    if (score < GATE_PASS) continue;
    const memberSources = members.flatMap((member) => sourcesOf(registry, member));
    const candidateNames = new Set(memberSources.filter((source) => source.role === 'candidate').map((source) => source.name));
    const signalNames = new Set(memberSources.filter((source) => source.role === 'signal_only').map((source) => source.name));
    if (candidateNames.size === 0) continue;
    const anyReadable = members.some((member) => member.candidate === 1 && readable(member));
    const order =
      score * sourceWeight(weights, memberSources) * (weights.topics.get(best.topic ?? '') ?? 1) +
      ORDER_WORLD_SOURCES * Math.log2(candidateNames.size + ORDER_WORLD_SIGNAL * signalNames.size) +
      ORDER_WORLD_READABLE * (anyReadable ? 1 : 0);
    const candidates = members
      .filter((member) => member.candidate === 1)
      .sort((a, b) => Number(readable(b)) - Number(readable(a)) || (b.score ?? 0) - (a.score ?? 0) || a.rowid - b.rowid);
    const signals = members.filter((member) => member.candidate === 0).map((member) => member.title);
    const { review } = cardReview(registry, best);
    const words = [`${String(candidateNames.size)} 个来源`];
    if (signalNames.size > 0) words.push(`${[...signalNames].join('、')} 标题`);
    cards.push({
      id: key.startsWith('c') ? `w${key.slice(1)}` : `s${key.slice(1)}`,
      section: 'world',
      topic: best.topic ?? 'world.affairs',
      venues: [...candidateNames].slice(0, 3),
      review,
      title: best.title,
      summary: best.summary.slice(0, CARD_SUMMARY_CHARS),
      corroboration: words.join('；'),
      readable: anyReadable,
      heldBack: null,
      order,
      cluster: best.cluster,
      members: candidates,
      signals,
      score,
      ...(options.votes?.get(best.key) === undefined ? {} : { votes: options.votes.get(best.key) as string }),
    });
  }
  cards.sort((a, b) => b.order - a.order || a.id.localeCompare(b.id));
  if (options.deep) return cards.slice(0, DEEP_CARDS);
  const heldBackOf = holdBack(store, date);
  return cards.slice(0, WORLD_CARDS).map((card) => ({
    ...card,
    heldBack: clusterRanTitle(store, card.cluster) ?? card.members.reduce<string | null>((found, member) => found ?? heldBackOf(member.rowid), null),
  }));
}

/**
 * The shortlist without a pick (design §6), in gate order: the 3 best clusters with score ≥ 7, then research cards up
 * to PICK_TOTAL_MAX items in all, each topic's best first and at most 2 per topic.
 */
export function fallbackShortlist(research: readonly ResearchCard[], world: readonly WorldCard[]): { research: Picked[]; world: Picked[] } {
  const w = world.filter((card) => card.score >= WORLD_FALLBACK_PASS).slice(0, PICK_WORLD_MAX).map((card) => ({ id: card.id, reason: '' }));
  const max = Math.min(PICK_RESEARCH_MAX, PICK_TOTAL_MAX - w.length);
  const r = fairTop(research, max, () => 1, PICK_PER_TOPIC).map((card) => ({ id: card.id, reason: '' }));
  return { research: r, world: w };
}

/** 还有 (design §6): up to 5 cards of the 专业 topics the pick did not take and no earlier 还有 listed, in gate order. */
export function moreItems(research: readonly ResearchCard[], picked: ReadonlySet<string>, topics: readonly Topic[]): ResearchCard[] {
  const professional = new Set(topics.filter((topic) => topic.format === 'professional').map((topic) => topic.id));
  return research.filter((card) => !picked.has(card.id) && !card.listed && professional.has(card.topic)).slice(0, MORE_ITEMS_MAX);
}

/**
 * The deep read's cards (design §9): the week's research and world cards by gate order, briefed ones included, every
 * topic's best 2 (a 专业 topic's 3) first.
 */
export function deepCards(store: Store, registry: Registry, weights: Weights, date: string, topics: readonly Topic[], votes: ReadonlyMap<string, string>): Card[] {
  const research = researchCards(store, registry, weights, date, topics, { deep: true, votes });
  const world = worldCards(store, registry, weights, date, { deep: true, votes });
  const merged = [...research, ...world].sort((a, b) => b.order - a.order);
  return fairTop(merged, DEEP_CARDS, floorOf(topics, DEEP_CARDS_FLOOR_PROFESSIONAL, DEEP_CARDS_FLOOR), Infinity);
}
