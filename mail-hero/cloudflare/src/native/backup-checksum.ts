import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return bytesToHex(sha256(bytes));
}

/** Verify whole R2 objects with bounded memory; no object-sized buffer. */
export async function sha256Stream(stream: ReadableStream<Uint8Array>): Promise<{ sha256: string; bytes: number }> {
  const hash = sha256.create(), reader = stream.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (!Number.isSafeInteger(bytes)) throw new Error('native_backup_hash_size_invalid');
      hash.update(next.value);
    }
    return { sha256: bytesToHex(hash.digest()), bytes };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { hash.destroy(); reader.releaseLock(); }
}
