/**
 * Vector maths of the ranking (docs/design.md §4): L2 normalisation, Float32 BLOB encoding, spherical
 * k-means with a deterministic start, and the score `max_i cos(x, c_i) − λ·cos(x, n)`.
 */
import { EMBED_DIMENSIONS } from './models.ts';

export type Vector = Float32Array;

/** A unit vector, or null when the input is not a finite non-zero vector of EMBED_DIMENSIONS values. */
export function normalize(values: ArrayLike<number>, dimensions = EMBED_DIMENSIONS): Vector | null {
  if (values.length !== dimensions) return null;
  let sum = 0;
  for (let i = 0; i < dimensions; i++) {
    const v = values[i] ?? Number.NaN;
    if (!Number.isFinite(v)) return null;
    sum += v * v;
  }
  if (sum <= 0) return null;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) out[i] = (values[i] ?? 0) / norm;
  return out;
}

export function toBlob(vector: Vector): ArrayBuffer {
  return vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength) as ArrayBuffer;
}

export function fromBlob(blob: ArrayBuffer | Uint8Array, dimensions = EMBED_DIMENSIONS): Vector | null {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteLength !== dimensions * 4) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export function dot(a: Vector, b: Vector): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** The normalised mean of `vectors`, or null for none. */
export function centroid(vectors: readonly Vector[]): Vector | null {
  const first = vectors[0];
  if (first === undefined) return null;
  const sum = new Float64Array(first.length);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
  return normalize(sum, first.length);
}

export const MAX_CENTROIDS = 16;
export const KMEANS_ITERATIONS = 10;

/**
 * Positive centroids: each vector itself when there are at most k, else spherical k-means with a
 * deterministic farthest-point start (first vector, then repeatedly the one least similar to the chosen)
 * and at most KMEANS_ITERATIONS rounds. Same input order → same output.
 */
export function positiveCentroids(vectors: readonly Vector[], k = MAX_CENTROIDS): Vector[] {
  if (vectors.length <= k) return [...vectors];
  const first = vectors[0];
  if (first === undefined) return [];
  const centers: Vector[] = [first];
  const best = vectors.map((v) => dot(v, first));
  while (centers.length < k) {
    let pick = 0;
    for (let i = 1; i < vectors.length; i++) if ((best[i] ?? 1) < (best[pick] ?? 1)) pick = i;
    const chosen = vectors[pick];
    if (chosen === undefined) break;
    centers.push(chosen);
    for (let i = 0; i < vectors.length; i++) best[i] = Math.max(best[i] ?? -1, dot(vectors[i] ?? chosen, chosen));
  }
  let assignment = new Array<number>(vectors.length).fill(-1);
  for (let round = 0; round < KMEANS_ITERATIONS; round++) {
    const next = vectors.map((v) => {
      let index = 0;
      let top = -Infinity;
      centers.forEach((c, i) => {
        const s = dot(v, c);
        if (s > top) {
          top = s;
          index = i;
        }
      });
      return index;
    });
    const changed = next.some((value, i) => value !== assignment[i]);
    assignment = next;
    for (let c = 0; c < centers.length; c++) {
      const members = vectors.filter((_, i) => assignment[i] === c);
      const mean = centroid(members);
      if (mean !== null) centers[c] = mean;
    }
    if (!changed) break;
  }
  return centers;
}

export interface Scored {
  readonly paper_id: string;
  readonly score: number;
  /** The positive paper nearest to this one, or null. */
  readonly because_id: string | null;
}

export interface RankInput {
  readonly candidates: readonly { readonly paper_id: string; readonly vector: Vector }[];
  readonly positives: readonly { readonly paper_id: string; readonly vector: Vector }[];
  /** Normalised mean of the disliked vectors, or null without dislikes. */
  readonly negative: Vector | null;
  readonly lambda: number;
  readonly size: number;
}

/** The top `size` candidates by score, ties broken by paper id; requires at least one positive. */
export function rank(input: RankInput): Scored[] {
  const centers = positiveCentroids(input.positives.map((p) => p.vector));
  if (centers.length === 0) return [];
  const lambda = Math.min(1, Math.max(0, input.lambda));
  const scored = input.candidates.map(({ paper_id, vector }) => {
    let top = -Infinity;
    for (const c of centers) top = Math.max(top, dot(vector, c));
    const score = input.negative === null ? top : top - lambda * dot(vector, input.negative);
    return { paper_id, vector, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.paper_id < b.paper_id ? -1 : a.paper_id > b.paper_id ? 1 : 0));
  return scored.slice(0, input.size).map(({ paper_id, vector, score }) => {
    let because: string | null = null;
    let top = -Infinity;
    for (const p of input.positives) {
      const s = dot(vector, p.vector);
      if (s > top) {
        top = s;
        because = p.paper_id;
      }
    }
    return { paper_id, score: Math.round(score * 1e6) / 1e6, because_id: because };
  });
}

/**
 * The cold-start (explore) deck: `size` items taken round-robin over primary categories, each category's
 * items in feed order, categories in order of first appearance. Deterministic.
 */
export function explore<T extends { readonly paper_id: string; readonly primary_category: string }>(items: readonly T[], size: number): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.primary_category);
    if (group === undefined) groups.set(item.primary_category, [item]);
    else group.push(item);
  }
  const queues = [...groups.values()];
  const out: T[] = [];
  let index = 0;
  while (out.length < size && queues.some((q) => q.length > 0)) {
    const queue = queues[index % queues.length];
    const next = queue?.shift();
    if (next !== undefined) out.push(next);
    index++;
  }
  return out;
}
