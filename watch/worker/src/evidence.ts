/** Saved reading evidence. Rules keep their own small normalized snapshots. */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { SnapshotSchema, SnapshotImageSchema } from '@ziyixi/proto/watch/ui/v1/snapshot_pb';
import { sha256Hex } from './config.ts';
import { changeId } from './ids.ts';
import { SNAPSHOTS_KEPT } from './limits.ts';
import type { CaptureDocument } from './evidence-extract.ts';
import type { Store } from './store.ts';

interface EvidenceRow extends Record<string, SqlStorageValue> {
  id: string; watch_id: string; created_at: number; sha: string; object_key: string; image_key: string; ready: number;
}
type SavedDocument = Omit<CaptureDocument, 'screenshot'> & {
  contentHash: string; imageHash: string; imageWidth: number; imageHeight: number; imageError: string;
};
export interface EvidencePair { before: string; after: string }
const nameOf = (row: EvidenceRow) => `watches/${row.watch_id}/snapshots/${row.id}`;

function latest(store: Store, watch: string): EvidenceRow | undefined {
  return store.one<EvidenceRow>('SELECT * FROM evidence_snapshots WHERE watch_id=? AND ready=1 ORDER BY id DESC LIMIT 1', watch);
}

export function latestEvidence(store: Store, watch: string): string {
  const row = latest(store, watch);
  return row ? nameOf(row) : '';
}

/** Insert the object addresses before uploading so interruption never leaves an unindexed object. */
export async function saveEvidence(store: Store, bucket: R2Bucket, watch: string, readHash: string, now: number, document: CaptureDocument): Promise<EvidencePair | null> {
  const previous = latest(store, watch);
  const { screenshot, ...text } = document;
  const contentHash = await sha256Hex(JSON.stringify(text));
  const imageHash = screenshot ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', screenshot.bytes)), b => b.toString(16).padStart(2, '0')).join('') : '';
  const hash = await sha256Hex(`${readHash}:${contentHash}:${imageHash}`);
  if (previous?.ready && previous.sha === hash) return { before: nameOf(previous), after: nameOf(previous) };
  const id = changeId(now);
  const objectKey = `captures/${watch}/${id}.json`;
  const imageKey = imageHash ? `images/${imageHash}.jpg` : '';
  const row: EvidenceRow = { id, watch_id: watch, created_at: now, sha: hash, object_key: objectKey, image_key: imageKey, ready: 0 };
  store.run('INSERT INTO evidence_snapshots VALUES (?,?,?,?,?,?,0)', id, watch, now, hash, objectKey, imageKey);
  const saved: SavedDocument = { ...text, contentHash, imageHash, imageWidth: screenshot?.width ?? 0,
    imageHeight: screenshot?.height ?? 0, imageError: screenshot ? '' : document.errors.find(e => e === 'screenshot_failed' || e === 'too_large') ?? 'not_recorded' };
  const sharedImage = imageKey && store.one('SELECT 1 AS found FROM evidence_snapshots WHERE image_key=? AND ready=1 LIMIT 1', imageKey);
  if (screenshot && !sharedImage) await bucket.put(imageKey, screenshot.bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await bucket.put(objectKey, JSON.stringify(saved), { httpMetadata: { contentType: 'application/json' } });
  // An owner edit or delete while uploading wins. The rows remain indexed for normal cleanup.
  if (store.watch(watch)?.read_hash !== readHash) return null;
  store.run('UPDATE evidence_snapshots SET ready=1 WHERE id=?', id);
  const before = previous?.ready ? nameOf(previous) : '';
  const after = nameOf(row);
  if (before) store.enqueueEvidence(watch, before, after, now);
  pruneEvidence(store, watch);
  return { before, after };
}

function queueRow(store: Store, row: EvidenceRow): void {
  store.run('INSERT OR IGNORE INTO evidence_deletions VALUES (?)', row.object_key);
  if (row.image_key) store.run('INSERT OR IGNORE INTO evidence_deletions VALUES (?)', row.image_key);
  store.run('DELETE FROM evidence_snapshots WHERE id=?', row.id);
}

function pruneEvidence(store: Store, watch: string): void {
  const current = store.watch(watch);
  const pending = current?.pending_change ? store.change(watch, current.pending_change) : undefined;
  const pinned = new Set<string>();
  for (const id of [current?.baseline_id, current?.seen_snapshot_id, pending?.snapshot_id, pending?.before_snapshot_id]) {
    const reference = id ? store.snapshot(id)?.evidence_ref : undefined;
    if (reference) pinned.add(reference);
  }
  for (const row of store.all<EvidenceRow>('SELECT * FROM evidence_snapshots WHERE watch_id=? ORDER BY id DESC LIMIT 100 OFFSET ?', watch, SNAPSHOTS_KEPT)) {
    if (!pinned.has(nameOf(row))) queueRow(store, row);
  }
}

/** Called before a scheduler pass, never concurrently with capture uploads. Failed deletion remains queued. */
export async function cleanEvidence(store: Store, bucket: R2Bucket): Promise<void> {
  for (const row of store.all<EvidenceRow>('SELECT * FROM evidence_snapshots WHERE ready=0 LIMIT 20')) queueRow(store, row);
  const rows = store.all<{key: string}>('SELECT key FROM evidence_deletions LIMIT 20');
  if (!rows.length) return;
  const unused = rows.filter(row => !store.one('SELECT 1 AS found FROM evidence_snapshots WHERE image_key=? LIMIT 1', row.key));
  if (unused.length) await bucket.delete(unused.map(row => row.key));
  for (const row of rows) store.run('DELETE FROM evidence_deletions WHERE key=?', row.key);
}

export function evidenceAddress(name: string, image = false): { watch: string; id: string } | null {
  const match = (image ? /^watches\/([a-z][a-z0-9-]{0,39})\/snapshots\/([a-z0-9]{16})\/image$/ : /^watches\/([a-z][a-z0-9-]{0,39})\/snapshots\/([a-z0-9]{16})$/).exec(name);
  return match ? { watch: match[1] ?? '', id: match[2] ?? '' } : null;
}

async function documentOf(store: Store, bucket: R2Bucket | undefined, name: string, image = false) {
  const address = evidenceAddress(name, image);
  const row = address ? store.one<EvidenceRow>('SELECT * FROM evidence_snapshots WHERE watch_id=? AND id=?', address.watch, address.id) : undefined;
  if (!row) return { row, document: null, error: 'expired' };
  if (!bucket || !row.ready) return { row, document: null, error: 'unavailable' };
  try {
    const object = await bucket.get(row.object_key);
    return { row, document: object ? await object.json<SavedDocument>() : null, error: object ? '' : 'unavailable' };
  } catch { return { row, document: null, error: 'unavailable' }; }
}

export async function readEvidence(store: Store, bucket: R2Bucket | undefined, name: string) {
  const { row, document, error } = await documentOf(store, bucket, name);
  return create(SnapshotSchema, { name, createTime: row ? timestampFromMs(row.created_at) : undefined,
    uri: document?.finalUrl ?? '', title: document?.title ?? '', markdown: document?.markdown ?? '',
    structureJson: document?.accessibilityJson ?? '', links: [...(document?.links ?? [])], metadata: [...(document?.metadata ?? [])],
    contentAvailable: !!document && !document.errors.some(e => e.startsWith('EVIDENCE_') && !document.markdown), contentTruncated: document?.truncated ?? false, contentError: error || document?.errors.filter(e => !['screenshot_failed', 'too_large'].includes(e)).join(',') || '',
    imageAvailable: !!document?.imageHash, imageError: document?.imageError ?? error,
    imageWidth: document?.imageWidth ?? 0, imageHeight: document?.imageHeight ?? 0,
    imageMimeType: document?.imageHash ? 'image/jpeg' : '', contentSha256: document?.contentHash ?? '', imageSha256: document?.imageHash ?? '' });
}

export async function readEvidenceImage(store: Store, bucket: R2Bucket | undefined, name: string) {
  const { row, document, error } = await documentOf(store, bucket, name, true);
  let jpegBase64 = '';
  let imageError = error || document?.imageError || '';
  if (row?.image_key && bucket && document) {
    try {
      const object = await bucket.get(row.image_key);
      if (object) {
        const bytes = new Uint8Array(await object.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        jpegBase64 = btoa(binary);
      } else imageError = 'unavailable';
    } catch { imageError = 'unavailable'; }
  }
  return create(SnapshotImageSchema, { name, jpegBase64, available: jpegBase64 !== '', error: imageError,
    width: document?.imageWidth ?? 0, height: document?.imageHeight ?? 0 });
}
