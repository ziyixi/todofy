import type { Env } from './types.ts';
import { retainedBackupKeys } from './backup-retention.ts';
export { isNativeBackupKey } from './backup-retention.ts';
import type { NativeBackupMarker } from './native-backup-format.ts';
export type { NativeBackupMarker as NativeVerifiedMarker } from './native-backup-format.ts';
import { assertBackupArtifactCapacity } from './backup-artifact-capacity.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SNAPSHOT_BYTES = 8 * 1024 ** 3;
const NATIVE_MANIFEST = /^snapshots-v2\/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36})\/manifest\.json$/;
const LEGACY_ARCHIVE = /^snapshots\/\d{4}-\d{2}-\d{2}\/([0-9a-f-]{36})\.tar\.gz\.gpg$/;

interface Target { id: string; key: string; version: 1 | 2 }
interface RotationCursor { version: 1; targets: Target[]; index: number }
const fail = (code: string): never => { throw new Error(code); };
const bucket = (env: Env): R2Bucket => env.BACKUP_STORE ?? fail('backup_store_unconfigured');

export function nativeSnapshotPrefix(id: string, date: string): string {
  if (!UUID.test(id) || !DATE.test(date)) fail('invalid_native_backup_identity');
  return `snapshots-v2/${date}/${id}/`;
}
export function validNativeMarker(value: NativeBackupMarker): boolean {
  const match = NATIVE_MANIFEST.exec(value.key ?? '');
  return value.version === 2 && UUID.test(value.backup_id ?? '') && !!match && match[2] === value.backup_id &&
    HASH.test(value.sha256 ?? '') && HASH.test(value.manifest_sha256 ?? '') && value.proof === 'native_readback_verified' &&
    Number.isFinite(Date.parse(value.created_at)) && Number.isFinite(Date.parse(value.verified_at)) &&
    Date.parse(value.verified_at) >= Date.parse(value.created_at) &&
    Number.isSafeInteger(value.size_bytes) && value.size_bytes > 0 && value.size_bytes <= MAX_SNAPSHOT_BYTES &&
    Number.isSafeInteger(value.object_count) && value.object_count >= 1 && value.object_count <= 50_000;
}

/** Reserve a known bounded copy size before writing any objects. */
export async function reserveNativeBackup(env: Env, id: string, date: string, estimatedBytes: number): Promise<void> {
  nativeSnapshotPrefix(id, date);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 1 || estimatedBytes > MAX_SNAPSHOT_BYTES) fail('native_backup_capacity_limit');
  const store = bucket(env), name = `pending-v2/${id}.json`;
  const existing = await store.get(name);
  if (existing) {
    if (existing.size > 4096) fail('native_backup_reservation_invalid');
    const saved = await existing.json<{ date: string; size_bytes: number }>();
    if (saved.date !== date || saved.size_bytes !== estimatedBytes) fail('native_backup_reservation_conflict');
    return;
  }
  await assertBackupArtifactCapacity(env, estimatedBytes);
  await store.put(name, JSON.stringify({ version: 2, backup_id: id, date, size_bytes: estimatedBytes }), {
    customMetadata: { size_bytes: String(estimatedBytes), backup_id: id }, httpMetadata: { contentType: 'application/json' },
  });
}

/** Only the native runner calls this after its durable lease commit. This is a
 * completion index for listing and rotation. */
export async function writeNativeVerifiedMarker(env: Env, marker: NativeBackupMarker): Promise<void> {
  if (!validNativeMarker(marker)) fail('native_backup_marker_invalid');
  const store = bucket(env), manifest = await store.head(marker.key);
  if (!manifest || manifest.customMetadata?.sha256 !== marker.sha256 ||
    manifest.customMetadata?.manifest_sha256 !== marker.manifest_sha256 ||
    manifest.customMetadata?.backup_id !== marker.backup_id) fail('native_backup_manifest_mismatch');
  await store.put(`verified-v2/${marker.backup_id}.json`, JSON.stringify(marker), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { key: marker.key, backup_id: marker.backup_id, sha256: marker.sha256,
      manifest_sha256: marker.manifest_sha256, size_bytes: String(marker.size_bytes),
      created_at: marker.created_at, verified_at: marker.verified_at, object_count: String(marker.object_count), proof: marker.proof },
  });
  await store.delete(`pending-v2/${marker.backup_id}.json`);
}

async function rotationPlan(env: Env, currentID: string): Promise<RotationCursor> {
  const store = bucket(env), [legacy, native] = await Promise.all([
    store.list({ prefix: 'verified/', limit: 100, include: ['customMetadata'] }),
    store.list({ prefix: 'verified-v2/', limit: 100, include: ['customMetadata'] }),
  ]);
  if (legacy.truncated || native.truncated) fail('backup_inventory_requires_review');
  const confirmed: Array<Target & { uploaded: Date; customMetadata: Record<string, string> }> = [];
  for (const receipt of [...legacy.objects, ...native.objects]) {
    const meta = receipt.customMetadata, id = meta?.backup_id, key = meta?.key;
    if (!id || !UUID.test(id) || !key || !HASH.test(meta.sha256 ?? '') || !HASH.test(meta.manifest_sha256 ?? '')) continue;
    const match = NATIVE_MANIFEST.exec(key), version = match ? 2 : 1;
    if (version === 2 ? match![2] !== id || receipt.key !== `verified-v2/${id}.json` || meta.proof !== 'native_readback_verified'
      : LEGACY_ARCHIVE.exec(key)?.[1] !== id || receipt.key !== `verified/${id}.json`) continue;
    const artifact = await store.head(key);
    if (!artifact || artifact.customMetadata?.backup_id !== id || artifact.customMetadata?.sha256 !== meta.sha256 || artifact.customMetadata?.manifest_sha256 !== meta.manifest_sha256) continue;
    const capturedAt = version === 2 ? new Date(meta.created_at ?? '') : artifact.uploaded;
    if (!Number.isFinite(capturedAt.getTime())) continue;
    confirmed.push({ version, id, key, uploaded: capturedAt, customMetadata: meta });
  }
  const current = confirmed.find(item => item.id === currentID && item.version === 2);
  const currentKey = current?.key ?? fail('verified_native_backup_required');
  const retained = retainedBackupKeys(confirmed); retained.add(currentKey);
  return { version: 1, targets: confirmed.filter(item => !retained.has(item.key)).map(({ id, key, version }) => ({ id, key, version })), index: 0 };
}
function checkedCursor(value: unknown): RotationCursor {
  const cursor = value as RotationCursor;
  if (!cursor || cursor.version !== 1 || !Array.isArray(cursor.targets) || cursor.targets.length > 200 ||
    !Number.isSafeInteger(cursor.index) || cursor.index < 0 || cursor.index > cursor.targets.length ||
    cursor.targets.some(target => !target || !UUID.test(target.id) || (target.version === 2
      ? NATIVE_MANIFEST.exec(target.key)?.[2] !== target.id : target.version !== 1 || LEGACY_ARCHIVE.exec(target.key)?.[1] !== target.id))) fail('native_backup_rotation_invalid');
  return cursor;
}

/** Persist the returned plan before the next call. Subsequent calls delete at
 * most one page; repeating a step after a crash cannot delete the new snapshot. */
export async function pruneNativeBackupsStep(env: Env, currentID: string, value?: unknown): Promise<{ done: boolean; cursor?: unknown }> {
  if (!UUID.test(currentID)) fail('invalid_native_backup_identity');
  if (value === undefined) {
    const cursor = await rotationPlan(env, currentID);
    return cursor.targets.length ? { done: false, cursor } : { done: true };
  }
  const cursor = checkedCursor(value), target = cursor.targets[cursor.index];
  if (!target) return { done: true };
  if (target.id === currentID) fail('native_backup_rotation_current');
  const store = bucket(env);
  if (target.version === 1) {
    await store.delete(target.key); await store.delete(`verified/${target.id}.json`);
    cursor.index++;
  } else {
    // Removing the index first prevents advertising a partially pruned copy.
    await store.delete(`verified-v2/${target.id}.json`);
    const prefix = target.key.slice(0, -'manifest.json'.length);
    const page = await store.list({ prefix, limit: 100 });
    if (page.objects.length) await store.delete(page.objects.map(item => item.key));
    if (!page.truncated) cursor.index++;
  }
  return cursor.index === cursor.targets.length ? { done: true } : { done: false, cursor };
}

/** Cleanup only this runner's failed prefix; independent deletion records and
 * every other snapshot remain untouched. No success marker may be present. */
export async function abandonNativeBackupStep(env: Env, id: string, date: string): Promise<boolean> {
  const prefix = nativeSnapshotPrefix(id, date), store = bucket(env);
  if (await store.head(`verified-v2/${id}.json`)) fail('verified_native_backup_cleanup_refused');
  const page = await store.list({ prefix, limit: 100 });
  if (page.objects.length) await store.delete(page.objects.map(item => item.key));
  if (page.truncated) return false;
  await store.delete(`pending-v2/${id}.json`);
  return true;
}
