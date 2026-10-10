/**
 * One mail's evidence and the model's two views of it (../../docs/design.md §4), shared by the alarm's drain
 * (pipeline.ts) and the replay evaluation (replay.ts), which decide the same way: the replay only writes nothing.
 *
 * The evidence, all masked as the model reads it (mask.ts): the subject, snippet and body, Gmail's category, whether
 * there is a list, whether the sender is authenticated (DMARC aligned with the From domain, dmarc.ts), the three nearest
 * examples (bge-m3, context only) and the sender history: what the sender's earlier mail of the last 180 days got,
 * by the From address's keyed hash, the owner's verdicts first.
 */
import { clefState, decide as askClef, embed, type ClefAnswer, type ClefOption } from './ai.ts';
import { decideViews, historyText, reviewQuota, secondViewLabels, type Decision, type HistoryEntry, type LabelFacts } from './decide.ts';
import { dmarcAligned } from './dmarc.ts';
import type { AiRunner } from './env.ts';
import { embeddedCount, nearest } from './examples.ts';
import { DAY, EXAMPLE_SUMMARY_CHARS, NEIGHBOURS, NONE, SENDER_HISTORY_MS, SENDER_HISTORY_ROWS } from './limits.ts';
import { features, senderHash, summaryOf, type Features } from './mask.ts';
import type { ReadMessage } from './mime.ts';
import { optionKeys, pathSlug } from './paths.ts';
import type { Budget } from './session.ts';
import { utcDay, type LabelRow, type Store } from './store.ts';

/** What the pipeline reads off one mail before the model. */
export interface Gathered {
  readonly features: Features;
  readonly authenticated: boolean;
  /** The From address's keyed hash ('' without a From address). */
  readonly senderHash: string;
  /** The masked summary an example keeps and the embedding reads. */
  readonly summary: string;
}

export async function gather(read: ReadMessage): Promise<Gathered> {
  const f = await features(read);
  return { features: f, authenticated: dmarcAligned(read.headers.authenticationResults, f.senderDomain), senderHash: await senderHash(f.senderAddress), summary: summaryOf(f, EXAMPLE_SUMMARY_CHARS) };
}

/**
 * What the sender's earlier mail got, per label: the owner's verdict when there is one (a label, or `none` for "none of
 * them"), else the automatic label of a confident decision. Only decisions before `asOf` count, and only verdicts given
 * before it (the replay decides a mail as of its own time); `exclude` is the mail itself.
 */
export function senderHistory(store: Store, hash: string, asOf: number, exclude: string): HistoryEntry[] {
  if (hash === '') return [];
  const rows = store.all<{ outcome: string; label_id: string | null; verdict: string | null; verdict_label: string | null; verdict_source: string | null; verdict_at: number | null }>(
    `SELECT outcome, label_id, verdict, verdict_label, verdict_source, verdict_at FROM decisions
     WHERE sender_hash = ? AND decided_at >= ? AND decided_at < ? AND message_id != ? ORDER BY decided_at DESC LIMIT ?`,
    hash,
    asOf - SENDER_HISTORY_MS,
    asOf,
    exclude,
    SENDER_HISTORY_ROWS,
  );
  const counts = new Map<string, { owner: number; auto: number }>();
  for (const row of rows) {
    const owner = (row.verdict === 'confirmed' || row.verdict === 'corrected') && (row.verdict_source === 'review' || row.verdict_source === 'gmail') && (row.verdict_at ?? asOf) < asOf;
    const label = owner ? (row.verdict_label ?? NONE) : row.outcome === 'applied' || row.outcome === 'suggested' ? row.label_id : null;
    if (label === null) continue;
    const entry = counts.get(label) ?? { owner: 0, auto: 0 };
    if (owner) entry.owner++;
    else entry.auto++;
    counts.set(label, entry);
  }
  return [...counts].map(([label, entry]) => ({ label, ...entry }));
}

/** The review queue's quota on the UTC day of `at` (decide.ts reviewQuota over the average of the 7 UTC days before). */
export function reviewQuotaOn(store: Store, at: number): number {
  const dayStart = Math.floor(at / DAY) * DAY;
  const week = store.one<{ n: number | null }>(`SELECT sum(decided) AS n FROM usage WHERE day >= ? AND day < ?`, utcDay(dayStart - 7 * DAY), utcDay(dayStart));
  return reviewQuota((week?.n ?? 0) / 7);
}

/** The mails decided on the UTC day of `at` that were shown in the review queue. */
export function shownOn(store: Store, at: number): number {
  const dayStart = Math.floor(at / DAY) * DAY;
  return store.count(`SELECT count(*) AS n FROM decisions WHERE shown = 1 AND decided_at >= ? AND decided_at < ?`, dayStart, dayStart + DAY);
}

export function labelFacts(labels: readonly LabelRow[]): Map<string, LabelFacts> {
  return new Map(labels.map((label) => [label.id, { id: label.id, enabled: label.enabled === 1, trust: label.trust === 1 }]));
}

export interface ModelContext {
  readonly store: Store;
  readonly ai: AiRunner;
  readonly budget: Budget;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
}

export interface Judgement {
  readonly decision: Decision;
  /** The views' answers (null when not asked: no label to offer, or view 2 did not run). */
  readonly view1: ClefAnswer | null;
  readonly view2: ClefAnswer | null;
  /** The description version of every enabled label, which every decision records. */
  readonly versions: Readonly<Record<string, number>>;
}

/** The judgement of a mail the model could not decide (no Workers AI, or every retry failed): uncertain. */
export function modelUnavailable(): Judgement {
  return { decision: { kind: 'unsure', reason: 'model_unavailable', top: null, confidence: 0, candidates: [] }, view1: null, view2: null, versions: {} };
}

/** Counts one Workers AI call against the pass and the day. */
function countCall(ctx: ModelContext, neurons: number): void {
  ctx.budget.left -= 1;
  const day = utcDay(ctx.now());
  ctx.transact(() => {
    ctx.store.addUsage(day, 'ai_calls', 1);
    ctx.store.addUsage(day, 'neurons', neurons);
  });
}

/**
 * Decides one mail with `model`, as of `asOf` (the sender history before it; the mail `exclude` left out): the
 * neighbours (an embedding, when examples exist), view 1, view 2 when it runs, then decide.ts. Throws AiQuotaError or
 * AiError, after the calls that answered were counted. A store without an enabled label with a description has
 * nothing to offer the model: uncertain, `no_labels`, without a call.
 */
export async function judge(ctx: ModelContext, model: string, g: Gathered, asOf: number, exclude: string): Promise<Judgement> {
  const { store } = ctx;
  const labels = store.labels();
  const enabled = labels.filter((label) => label.enabled === 1);
  const versions = Object.fromEntries(enabled.map((item) => [item.id, item.desc_version]));
  // The model is offered only labels with a description: a bare name is too little to decide by. Their keys come from
  // their paths (paths.ts optionKeys), stable per path.
  const offered = enabled.filter((label) => label.description !== '');
  if (offered.length === 0) return { decision: { kind: 'unsure', reason: 'no_labels', top: null, confidence: 0, candidates: [] }, view1: null, view2: null, versions };
  const keys = optionKeys(offered.map((label) => ({ id: label.id, path: label.display_name })));
  const pathOf = new Map(labels.map((label) => [label.id, label.display_name]));
  // A label by the name the model knows it by: an offered label's key, another's slug; none for a deleted one.
  const keyOf = (id: string): string | null => (id === NONE ? NONE : (keys.get(id) ?? (pathOf.has(id) ? pathSlug(pathOf.get(id) ?? id) : null)));

  let neighbours: { label: string; summary: string }[] = [];
  if (embeddedCount(store) > 0) {
    const { vectors, neurons } = await embed(ctx.ai, [g.summary]);
    countCall(ctx, neurons);
    const vector = vectors[0];
    if (vector !== undefined) neighbours = nearest(store, vector, NEIGHBOURS, new Set(enabled.map((label) => label.id))).flatMap((n) => {
      const key = keyOf(n.label);
      return key === null ? [] : [{ label: key, summary: n.summary }];
    });
  }
  const history = historyText(senderHistory(store, g.senderHash, asOf, exclude), keyOf);
  const state = clefState(g.features, neighbours, { authenticated: g.authenticated, history });
  const option = (label: LabelRow): ClefOption => ({ id: label.id, key: keys.get(label.id) ?? pathSlug(label.display_name), name: label.display_name, description: label.description });

  const view1 = await askClef(ctx.ai, model, state, offered.map(option));
  countCall(ctx, view1.neurons);
  const second = secondViewLabels(view1);
  let view2: ClefAnswer | null = null;
  if (second !== null) {
    const byId = new Map(offered.map((label) => [label.id, label]));
    // The same state and questions over view 1's most likely labels, in reverse order: an answer that only follows the
    // options' order cannot agree with itself.
    const options = second.flatMap((id) => {
      const label = byId.get(id);
      return label === undefined ? [] : [option(label)];
    });
    view2 = await askClef(ctx.ai, model, state, options.reverse());
    countCall(ctx, view2.neurons);
  }
  const decision = decideViews(view1, view2, labelFacts(labels), { authenticated: g.authenticated, trusted: (id) => store.isTrusted(id, g.features.senderDomain) });
  return { decision, view1, view2, versions };
}
