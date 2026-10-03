import type { Env } from './types.ts';

const SNAPSHOT_LIMIT = 8 * 1024 ** 3;
const STORE_LIMIT = 80 * 1024 ** 3;
const fail = (code: string): never => { throw new Error(code); };
const size = (value: unknown): number => {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > SNAPSHOT_LIMIT) fail('backup_capacity_inventory_invalid');
  return bytes;
};

/** Both archive generations share one private bucket and one capacity bound.
 * Include reservations even when ciphertext/verified markers are not yet present. */
export async function assertBackupArtifactCapacity(env: Env, requestedBytes: number): Promise<void> {
  const store = env.BACKUP_STORE ?? fail('backup_store_unconfigured');
  size(requestedBytes);
  const [legacy, native, uploads, pending] = await Promise.all([
    store.list({ prefix: 'snapshots/', limit: 100 }),
    store.list({ prefix: 'verified-v2/', limit: 100, include: ['customMetadata'] }),
    store.list({ prefix: 'uploads/', limit: 4 }),
    store.list({ prefix: 'pending-v2/', limit: 4, include: ['customMetadata'] }),
  ]);
  if (legacy.truncated || native.truncated || legacy.objects.length + native.objects.length >= 14) fail('backup_inventory_requires_review');
  if (uploads.truncated || pending.truncated || uploads.objects.length + pending.objects.length >= 4) fail('backup_upload_cleanup_required');
  let bytes = legacy.objects.reduce((sum, object) => sum + object.size, 0);
  for (const object of [...native.objects, ...pending.objects]) bytes += size(object.customMetadata?.size_bytes);
  for (const object of uploads.objects) {
    const record = await store.get(object.key);
    if (!record || record.size > 4096) fail('backup_upload_cleanup_required');
    const value = await record!.json<{ size_bytes: number }>();
    bytes += size(value.size_bytes);
  }
  if (bytes + requestedBytes > STORE_LIMIT) fail('backup_capacity_review_required');
}
