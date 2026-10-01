/**
 * Snapshots (../../docs/design.md §6): a Content as gzipped JSON of at most SNAPSHOT_MAX_GZIP bytes. A page whose
 * compressed text is larger keeps its first lines only (halving until it fits): the diff then sees the rest of the
 * page as removed once, which the owner sees in the change; it never fails the check. Keys are stored only when they
 * are not the lines themselves (feeds and JSON).
 */
import type { Content } from './content.ts';
import { SNAPSHOT_MAX_GZIP } from './limits.ts';

interface Stored {
  readonly l: readonly string[];
  readonly k: readonly string[] | null;
  readonly n: string | null;
  readonly a: string | null;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('gzip'));
}

export function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('gzip'));
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** The stored bytes of `content`, and how many lines they keep. */
export async function encodeSnapshot(content: Content): Promise<{ readonly bytes: Uint8Array; readonly lines: number }> {
  const keysAreLines = sameLines(content.lines, content.keys);
  let lines = content.lines.length;
  for (;;) {
    const stored: Stored = {
      l: content.lines.slice(0, lines),
      k: keysAreLines ? null : content.keys.slice(0, lines === content.lines.length ? content.keys.length : lines),
      n: content.number,
      a: content.availability,
    };
    const bytes = await gzip(new TextEncoder().encode(JSON.stringify(stored)));
    if (bytes.byteLength <= SNAPSHOT_MAX_GZIP || lines === 0) return { bytes, lines };
    lines = Math.floor(lines / 2);
  }
}

/** The Content of stored bytes. */
export async function decodeSnapshot(body: ArrayBuffer | Uint8Array): Promise<Content> {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const stored = JSON.parse(new TextDecoder().decode(await gunzip(bytes))) as Stored;
  return { lines: stored.l, keys: stored.k ?? stored.l, number: stored.n, availability: stored.a };
}
