/**
 * The captured texts in R2 (../../docs/design.md §5.2): one private bucket, recall-store (binding STORE). An object's
 * key is its archive path under `blobs/`: `blobs/2026/10/<document uuid>.txt.gz` (the capture's UTC month), the gzip
 * of the scrubbed UTF-8 text, written with R2's SHA-256 check. The archive layout and the store's layout are the same,
 * so a copy of the bucket is a copy of an archive's `blobs/`. Only RecallState writes and deletes; the Worker's blob
 * route reads.
 */

/** BlobPath of recall.archive.v1, for the texts recall writes. */
export const TEXT_BLOB_PATH = /^[0-9]{4}\/(0[1-9]|1[0-2])\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt\.gz$/;
/** BlobPath of recall.archive.v1 (any blob a newer recall may write: other extensions). */
export const BLOB_PATH = /^[0-9]{4}\/(0[1-9]|1[0-2])\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([.][a-z0-9]{1,16}){1,3}$/;
export const TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8';

/** The archive path of a document's text: the capture's UTC year and month, the document's UUID. */
export function textBlobPath(captureMs: number, documentId: string): string {
  const iso = new Date(captureMs).toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${documentId}.txt.gz`;
}

/** The R2 key of a blob path. */
export function blobKey(path: string): string {
  return `blobs/${path}`;
}

/** The document UUID a text blob path names, or null. */
export function documentIdOfPath(path: string): string | null {
  return (TEXT_BLOB_PATH.test(path) || /^[0-9]{4}\/(0[1-9]|1[0-2])\/[0-9a-f-]{36}\.webp$/.test(path)) ? (path.split('/')[2] ?? '').slice(0, 36) : null;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** The RFC 9530 Content-Digest value of a hex SHA-256: `sha-256=:<base64>:`. */
export function contentDigest(sha256: string): string {
  const bytes = sha256.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [];
  return `sha-256=:${btoa(String.fromCharCode(...bytes))}:`;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return readAll(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
}

/** A text as it is stored: its UTF-8, the gzip of it and both digests. */
export interface StoredText {
  readonly gzip: Uint8Array;
  readonly sha256: string;
  readonly textBytes: number;
  readonly textSha256: string;
}

export async function storedText(text: string): Promise<StoredText> {
  const utf8 = new TextEncoder().encode(text);
  const compressed = await gzip(utf8);
  return { gzip: compressed, sha256: await sha256Hex(compressed), textBytes: utf8.byteLength, textSha256: await sha256Hex(utf8) };
}

/** Writes a text at its path; R2 refuses the write unless the bytes it received have the given SHA-256. */
export async function putText(bucket: R2Bucket, path: string, stored: StoredText): Promise<void> {
  await bucket.put(blobKey(path), stored.gzip, { sha256: stored.sha256, httpMetadata: { contentType: 'application/gzip' } });
}

/** A stored text read back (gunzipped and decoded), or null when R2 has no such object. */
export async function readText(bucket: R2Bucket, path: string): Promise<string | null> {
  const object = await bucket.get(blobKey(path));
  if (object === null) return null;
  const plain = await readAll(object.body.pipeThrough(new DecompressionStream('gzip')));
  return new TextDecoder().decode(plain);
}

/** Deletes blobs by path, at most 1,000 per R2 call (deleting a missing object is not an error). */
export async function deleteBlobs(bucket: R2Bucket, paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 1000) await bucket.delete(paths.slice(i, i + 1000).map(blobKey));
}

/** Reads a bounded payload, cancelling before buffering a body larger than its recorded size. */
export async function readBounded(stream: ReadableStream<unknown>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error('invalid_content');
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('content_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
