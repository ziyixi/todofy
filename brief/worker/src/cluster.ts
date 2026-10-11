/**
 * Embeddings and world clusters (../../docs/design.md §4): Workers AI `@cf/baai/bge-m3` (1,024 dimensions) of each
 * item's title and the start of its summary, 50 texts a call, within the brief's own daily neuron cap. They serve three
 * things only: the world clusters (a new world item joins the most similar cluster of the last 72 hours at cosine
 * ≥ 0.86, else starts one; a cluster's vector is the sum of its members' unit vectors, so its cosine is the normalized
 * mean's), the hold-back of items close to one that ran in the last 7 days (已报道), and the score of a research
 * candidate Haiku refused (its nearest topic by the profile's embedded topic descriptions, and the score at its
 * similarity's percentile among the day's Haiku-scored candidates).
 *
 * Without embeddings (the quota, the cap, Home's guard) items deduplicate by key only, each world story is its own
 * cluster, the hold-back is by key only, and a refused research candidate stays unscored. Pure but for `embed`.
 */
import type { AiRunner } from './env.ts';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, NEURONS_PER_M_TOKENS } from './limits.ts';
import { estimateTokens } from './prices.ts';

/** The account's daily Workers AI allocation is used up: retry after 00:00 UTC. */
export class AiQuotaError extends Error {
  constructor() {
    super('ai_quota_exhausted');
    this.name = 'AiQuotaError';
  }
}

export class AiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'AiError';
  }
}

export function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /\b4006\b|daily free allocation|neurons|quota/i.test(message);
}

/** The neurons an embedding call of `texts` is estimated to cost (from the input's length). */
export function embeddingNeurons(texts: readonly string[]): number {
  const tokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  return (tokens * NEURONS_PER_M_TOKENS) / 1_000_000;
}

/** Unit vectors of `texts` (one batched bge-m3 call) and the estimated neurons. */
export async function embed(ai: AiRunner, texts: readonly string[]): Promise<{ vectors: Float32Array[]; neurons: number }> {
  let answer: unknown;
  try {
    answer = await ai.run(EMBEDDING_MODEL, { text: [...texts] });
  } catch (error) {
    if (isQuotaError(error)) throw new AiQuotaError();
    throw new AiError('embedding_unavailable');
  }
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new AiError('embedding_bad_answer');
  const vectors = data.map((row) => {
    if (!Array.isArray(row) || row.length !== EMBEDDING_DIMENSIONS || !row.every((value) => typeof value === 'number' && Number.isFinite(value))) throw new AiError('embedding_bad_answer');
    return unit(Float32Array.from(row as number[]));
  });
  return { vectors, neurons: embeddingNeurons(texts) };
}

/** `vector` scaled to length 1 (a zero vector stays zero). */
export function unit(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] ?? 0) / norm;
  return out;
}

/** Cosine similarity of two vectors of the same length (scale-invariant: a cluster's sum works as its mean). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A cluster's vector after a new member joins: the sum of its members' unit vectors. */
export function addToCentroid(centroid: Float32Array, member: Float32Array): Float32Array {
  const out = new Float32Array(centroid.length);
  for (let i = 0; i < centroid.length; i++) out[i] = (centroid[i] ?? 0) + (member[i] ?? 0);
  return out;
}

/** The best match among `candidates` (id and vector) for `vector`, or null. */
export function nearest(vector: Float32Array, candidates: readonly { readonly id: number; readonly vector: Float32Array }[]): { id: number; cosine: number } | null {
  let best: { id: number; cosine: number } | null = null;
  for (const candidate of candidates) {
    const similarity = cosine(vector, candidate.vector);
    if (best === null || similarity > best.cosine) best = { id: candidate.id, cosine: similarity };
  }
  return best;
}

/**
 * The fallback score of a refused research candidate (design §5.1): the percentile of its similarity among the day's
 * Haiku-scored candidates' similarities gives the score at the same percentile of their scores, so there is no
 * constant to calibrate. Null with nothing scored to compare with.
 */
export function percentileScore(similarity: number, scored: readonly { readonly similarity: number; readonly score: number }[]): number | null {
  if (scored.length === 0) return null;
  const below = scored.filter((entry) => entry.similarity < similarity).length;
  const equal = scored.filter((entry) => entry.similarity === similarity).length;
  const percentile = (below + equal / 2) / scored.length;
  const scores = scored.map((entry) => entry.score).sort((a, b) => a - b);
  const index = Math.min(scores.length - 1, Math.max(0, Math.round(percentile * (scores.length - 1))));
  return scores[index] ?? null;
}

/** The text an item is embedded from: its title and the start of its summary. */
export function embeddingText(title: string, summary: string, chars: number): string {
  return `${title}\n${summary.slice(0, chars)}`.trim();
}
