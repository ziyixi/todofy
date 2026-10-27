/**
 * A fake Workers AI for bge-m3: deterministic 1,024-dimension vectors from a text's words (each word hashed to a few
 * dimensions), so texts that share most of their words are close and unrelated ones are not. It answers the binding's
 * one method, `run(model, input)`, as Workers AI does (`{ data: number[][] }`), and a quota refusal when told to.
 */

const DIMENSIONS = 1024;

function hash(text: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** The fake embedding of a text. */
export function fakeVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    for (let k = 0; k < 3; k++) {
      const h = hash(word, k);
      vector[h % DIMENSIONS] = (vector[h % DIMENSIONS] ?? 0) + (h & 1 ? 1 : -1) * (1 + (k === 0 ? 1 : 0));
    }
  }
  if (words.length === 0) vector[0] = 1;
  return vector;
}
