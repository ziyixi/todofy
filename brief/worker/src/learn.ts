/**
 * Votes into weights (../../docs/design.md §10): once a week (Sunday 12:00; Home's guard may defer it), for each source
 * and each topic, over the last 8 weeks of votes after the last reset, with `n` its items that ran and
 * `s = up + 2 × more − 2 × down`: `w = clamp(1 + s / (n + 10), 0.6, 1.4)`. The prior of 10 means a few votes move a
 * weight a little. It never rewrites profile.md and never puts a voted title into a prompt: the weights order the gate
 * and the cards, and the pick reads each topic's weight as a number. ResetProfile puts every weight back to 1 and
 * ignores the votes before it.
 */
import { LEARN_PRIOR, LEARN_WINDOW_MS, WEIGHT_MAX, WEIGHT_MIN } from './limits.ts';
import type { Registry, Topic } from './registry.ts';
import { localDate } from './schedule.ts';
import { parseJson, type Store } from './store.ts';

export interface Tally {
  shown: number;
  up: number;
  down: number;
  more: number;
}

/** The weight of a tally. */
export function weightOf(tally: Tally): number {
  const s = tally.up + 2 * tally.more - 2 * tally.down;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, 1 + s / (tally.shown + LEARN_PRIOR)));
}

/** The tallies of the window: per source and per topic, items that ran and their votes (the owner's latest each). */
export function tallies(store: Store, now: number): { sources: Map<string, Tally>; topics: Map<string, Tally> } {
  const reset = Number(store.getMeta('reset_ms') ?? '0');
  const since = Math.max(reset, now - LEARN_WINDOW_MS);
  const sinceDate = localDate(since);
  const items = store.all<{ issue: string; id: string; topic: string; sources: string }>(`SELECT issue, id, topic, sources FROM issue_items WHERE issue >= ?`, sinceDate);
  const votes = new Map(
    store
      .all<{ issue: string; item: string; vote: string; origin: string }>(`SELECT issue, item, vote, origin FROM votes WHERE ms >= ?`, since)
      .map((row) => [`${row.issue}/${row.item}/${row.origin}`, row.vote]),
  );
  const sources = new Map<string, Tally>();
  const topics = new Map<string, Tally>();
  const bump = (map: Map<string, Tally>, id: string, vote: string | undefined, weight: number): void => {
    const tally = map.get(id) ?? { shown: 0, up: 0, down: 0, more: 0 };
    tally.shown += 1;
    if (vote === 'up') tally.up += weight;
    else if (vote === 'down') tally.down += weight;
    else if (vote === 'more') tally.more += weight;
    map.set(id, tally);
  };
  for (const item of items) {
    const owner = votes.get(`${item.issue}/${item.id}/owner`);
    // A read in recall counts as half a 👍 (the Signals hook, design §10; nothing writes origin `recall` yet).
    const recall = votes.get(`${item.issue}/${item.id}/recall`);
    const vote = owner ?? (recall === undefined ? undefined : 'up');
    const weight = owner === undefined && recall !== undefined ? 0.5 : 1;
    bump(topics, item.topic, vote, weight);
    for (const source of new Set(parseJson<string[]>(item.sources, []))) bump(sources, source, vote, weight);
  }
  return { sources, topics };
}

/** The weekly update: every source's and topic's weight from its tally (1 without one). */
export function learn(store: Store, registry: Registry, topics: readonly Topic[], now: number): { sources: number; topics: number } {
  const { sources, topics: topicTallies } = tallies(store, now);
  const save = (kind: 'source' | 'topic', id: string, tally: Tally | undefined): void => {
    const t = tally ?? { shown: 0, up: 0, down: 0, more: 0 };
    store.run(
      `INSERT INTO weights (kind, id, weight, shown, up, down, more) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET weight = excluded.weight, shown = excluded.shown, up = excluded.up, down = excluded.down, more = excluded.more`,
      kind,
      id,
      weightOf(t),
      t.shown,
      t.up,
      t.down,
      t.more,
    );
  };
  for (const source of registry.sources) save('source', source.id, sources.get(source.id));
  for (const topic of topics) save('topic', topic.id, topicTallies.get(topic.id));
  store.setMeta('learn_ms', String(now));
  return { sources: sources.size, topics: topicTallies.size };
}

/** ResetProfile: every weight back to 1, the votes before now ignored (they stay on their items). */
export function resetProfile(store: Store, now: number): void {
  store.run(`UPDATE weights SET weight = 1, shown = 0, up = 0, down = 0, more = 0`);
  store.setMeta('reset_ms', String(now));
}
