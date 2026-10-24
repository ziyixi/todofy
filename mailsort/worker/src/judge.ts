/** Shared priority judgement and time-bounded learning for live mail and replay. */
import { clefState, decide as askClef, embed, type ClefAnswer, type ClefOption } from './ai.ts';
import { decideViews, historyText, secondViewLabels, type Decision, type HistoryEntry, type LabelFacts } from './decide.ts';
import { dmarcAligned } from './dmarc.ts';
import type { AiRunner } from './env.ts';
import { embeddedCount, nearest } from './examples.ts';
import { EXAMPLE_SUMMARY_CHARS, NEIGHBOURS, NONE, RETRY_BASE_MS, RETRY_MAX_MS, SENDER_HISTORY_MS, SENDER_HISTORY_ROWS } from './limits.ts';
import { features, senderHash, summaryOf, type Features } from './mask.ts';
import type { ReadMessage } from './mime.ts';
import { optionKeys, pathSlug } from './paths.ts';
import { P1_ID, PRIORITY_IDS, priorityStartedAt } from './priority.ts';
import type { Budget } from './session.ts';
import { utcDay, type LabelRow, type Store } from './store.ts';

/** What the pipeline reads off one mail before the model. */
export interface Gathered {
  readonly features: Features;
  readonly authenticated: boolean;
  readonly receivedAt: number;
  /** The From address's salted hash ('' without a From address). */
  readonly senderHash: string;
  /** The masked summary an example keeps and the embedding reads. */
  readonly summary: string;
}

export async function gather(read: ReadMessage): Promise<Gathered> {
  const f = await features(read);
  return { features: f, receivedAt: read.receivedAt, authenticated: dmarcAligned(read.headers.authenticationResults, f.senderDomain), senderHash: await senderHash(f.senderAddress), summary: summaryOf(f, EXAMPLE_SUMMARY_CHARS) };
}

/**
 * What the sender's earlier mail got, per label: the owner's verdict when there is one (a label, or `none` for "none of
 * them"), else the automatic label of a confident decision. Only decisions before `asOf` count, and only verdicts given
 * before it (the replay decides a mail as of its own time); `exclude` is the mail itself.
 */
export function senderHistory(store: Store, hash: string, asOf: number, exclude: string): HistoryEntry[] {
  if (hash === '' || priorityStartedAt(store) === 0) return [];
  const rows = store.all<{ outcome: string; label_id: string | null; unsure_reason: string; verdict: string | null; verdict_label: string | null; verdict_source: string | null; verdict_at: number | null }>(
    `SELECT outcome, label_id, unsure_reason, verdict, verdict_label, verdict_source, verdict_at FROM decisions
     WHERE sender_hash = ? AND decided_at >= ? AND decided_at < ? AND message_id != ? ORDER BY decided_at DESC LIMIT ?`,
    hash,
    Math.max(asOf - SENDER_HISTORY_MS, priorityStartedAt(store)),
    asOf,
    exclude,
    SENDER_HISTORY_ROWS,
  );
  const counts = new Map<string, { owner: number; auto: number }>();
  for (const row of rows) {
    const owner = (row.verdict === 'confirmed' || row.verdict === 'corrected') && (row.verdict_source === 'review' || row.verdict_source === 'gmail') && (row.verdict_at ?? asOf) < asOf;
    const original = owner ? (row.verdict_label ?? NONE) : row.unsure_reason === '' && (row.outcome === 'applied' || row.outcome === 'suggested') ? row.label_id : null;
    if (original === null || !PRIORITY_IDS.has(original)) continue;
    const label = store.canonicalLabelId(original);
    if (!PRIORITY_IDS.has(label)) continue;
    const entry = counts.get(label) ?? { owner: 0, auto: 0 };
    if (owner) entry.owner++;
    else entry.auto++;
    counts.set(label, entry);
  }
  return [...counts].map(([label, entry]) => ({ label, ...entry }));
}

export function labelFacts(labels: readonly LabelRow[]): Map<string, LabelFacts> {
  return new Map(labels.map((label) => [label.id, { id: label.id, enabled: label.enabled === 1 && label.problem === '' }]));
}

export interface ModelContext {
  readonly store: Store;
  readonly ai: AiRunner;
  readonly budget: Budget;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
}

export interface Judgement {
  /** The model result before valid uncertainty becomes the applied P1 policy. */
  readonly modelDecision: Decision;
  readonly decision: Decision;
  /** The views' answers (null when not asked: no label to offer, or view 2 did not run). */
  readonly view1: ClefAnswer | null;
  readonly view2: ClefAnswer | null;
  /** The description version of every enabled label, which every decision records. */
  readonly versions: Readonly<Record<string, number>>;
}

/**
 * The wait after a mail's `attempts`-th failure (a failed read, a model outage), in the drain and in the replay
 * evaluation alike: RETRY_BASE_MS doubling, at most RETRY_MAX_MS.
 */
export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/** The judgement of a mail the model could not decide (no Workers AI, or every retry failed): uncertain. */
export function modelUnavailable(): Judgement {
  const decision: Decision = { kind: 'unsure', reason: 'model_unavailable', top: null, confidence: 0, candidates: [] };
  return { decision, modelDecision: decision, view1: null, view2: null, versions: {} };
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
 * Decides one mail with `model`, as of `asOf` (the sender history, the examples of then; the
 * mail `exclude` left out of the first two): the neighbours (an embedding, when examples exist), view 1, view 2 when
 * it runs, then decide.ts. Throws AiQuotaError or AiError, after the calls that answered were counted. A store without
 * an enabled label with a description has nothing to offer the model: uncertain, `no_labels`, without a call.
 */
export async function judge(ctx: ModelContext, model: string, g: Gathered, asOf: number, exclude: string): Promise<Judgement> {
  const { store } = ctx;
  const labels = store.labels();
  const enabled = labels.filter((label) => PRIORITY_IDS.has(label.id) && label.enabled === 1 && label.problem === '');
  const versions = Object.fromEntries(enabled.map((item) => [item.id, item.desc_version]));
  // The model is offered only labels with a description: a bare name is too little to decide by. Their keys come from
  // their paths (paths.ts optionKeys), stable per path.
  const offered = enabled.filter((label) => label.description !== '');
  if (offered.length === 0) {
    const decision: Decision = { kind: 'unsure', reason: 'no_labels', top: null, confidence: 0, candidates: [] };
    return { decision, modelDecision: decision, view1: null, view2: null, versions };
  }
  const keys = optionKeys(offered.map((label) => ({ id: label.id, path: label.display_name })));
  const pathOf = new Map(labels.map((label) => [label.id, label.display_name]));
  // A label by the name the model knows it by: an offered label's key, another's slug; none for a deleted one.
  const keyOf = (id: string): string | null => (id === NONE ? NONE : (keys.get(id) ?? (pathOf.has(id) ? pathSlug(pathOf.get(id) ?? id) : null)));

  let neighbours: { label: string; summary: string }[] = [];
  if (embeddedCount(store) > 0) {
    const { vectors, neurons } = await embed(ctx.ai, [g.summary]);
    countCall(ctx, neurons);
    const vector = vectors[0];
    if (vector !== undefined) neighbours = nearest(store, vector, NEIGHBOURS, new Set(enabled.map((label) => label.id)), asOf, exclude).flatMap((n) => {
      const key = keyOf(n.label);
      return key === null ? [] : [{ label: key, summary: n.summary }];
    });
  }
  const history = historyText(senderHistory(store, g.senderHash, asOf, exclude), keyOf);
  const state = clefState(g.features, neighbours, { history, receivedAt: g.receivedAt, now: asOf });
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
  const modelDecision = decideViews(view1, view2, labelFacts(enabled));
  // A valid but uncertain answer stays visible. AI failures and exhausted budgets never reach this fallback.
  const decision: Decision = modelDecision.kind === 'label' ? modelDecision : {
    kind: 'label', label: P1_ID, confidence: modelDecision.confidence, candidates: modelDecision.candidates,
  };
  return { decision, modelDecision, view1, view2, versions };
}
