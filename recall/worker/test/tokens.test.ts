// The machine tokens (src/tokens.ts, src/machine.ts) in Node: a new token's shape (the extension's parser and the
// scrubber know it), only its digest kept, the grace of a replaced token and its revocation, and the Worker's check:
// Worker-secret digests first, RecallState's kept for a minute, a refused bearer asking again at most every 10 s.
import { createHash } from 'node:crypto';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { DocumentItemSchema, VisitItemSchema } from '@ziyixi/proto/recall/ingest/v1/ingest_pb';
import { CreateMachineTokenRequestSchema, RegenerateMachineTokenRequestSchema } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageIdOf } from '../../shared/url.ts';
import { handlers, type ApiContext } from '../src/api.ts';
import {
  archiveConfirmations,
  backupMessage,
  connected,
  finishConnect,
  readArchive,
  redirectUri,
  retentionPause,
  startConnect,
  syncedSeq,
  waitingSince,
  type BackupContext,
} from '../src/backup.ts';
import { contentDigest, documentIdOfPath, readBounded, sha256Hex, storedText, textBlobPath } from '../src/blobs.ts';
import { DROPBOX, DropboxError } from '../src/dropbox.ts';
import type { Env } from '../src/env.ts';
import { documentSkip, fromNewerBuild, planDocument, planVisit, skipKnownTexts, type DocumentPlan, type Outcome, type Planning } from '../src/ingest.ts';
import { DAY, HOUR, ITEM_CLOCK_LEEWAY_MS, MINUTE, SECOND, VISIT_MAX_MS } from '../src/limits.ts';
import { checkBearer, forgetHeldDigests } from '../src/machine.ts';
import { ownerPatterns, readDenylist } from '../src/settings.ts';
import { hostKey } from '../src/store.ts';
import { addNamedToken, deleteNamedToken, deleteToken, heldDigests, namedTokens, newToken, pruneTokens, secretDigests, storeToken, tokenDigest, tokenMessage, tokenRoute, type RouteDigests } from '../src/tokens.ts';
import { memoryStore } from './sqlite.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const T0 = Date.parse('2026-10-10T02:10:00Z');
const NOW = Date.parse('2026-10-12T02:00:00Z');

describe('tokens', () => {
  it("makes tokens in the extension's shape, and digests them as the Worker compares them", async () => {
    const token = newToken('ingest');
    expect(token).toMatch(/^recall_ingest_[A-Za-z0-9_-]{43}$/);
    expect(newToken('export')).toMatch(/^recall_export_[A-Za-z0-9_-]{43}$/);
    expect(newToken('ingest')).not.toBe(token);
    expect(await tokenDigest(token)).toBe(digest(token));
    expect(tokenRoute('machineTokens/ingest')).toBe('ingest');
    expect(tokenRoute('machineTokens/other')).toBeNull();
  });

  it('keeps only the digest; a regeneration keeps the old one 24 hours, a revocation not at all', () => {
    const store = memoryStore();
    storeToken(store, 'ingest', 'a'.repeat(64), T0, false);
    expect(store.getMeta('token_ingest')).toBe(JSON.stringify({ digest: 'a'.repeat(64), created_ms: T0, previous: null, previous_until_ms: null }));
    storeToken(store, 'ingest', 'b'.repeat(64), T0 + HOUR, false);
    expect(heldDigests(store, T0 + HOUR)).toEqual({ ingest: ['b'.repeat(64), 'a'.repeat(64)], export: [] });
    expect(tokenMessage(store, 'ingest', T0 + HOUR, false)).toMatchObject({ name: 'machineTokens/ingest', token: '', previousExpireTime: { seconds: BigInt((T0 + HOUR + DAY) / 1000) } });
    expect(heldDigests(store, T0 + HOUR + DAY)).toEqual({ ingest: ['b'.repeat(64)], export: [] });
    pruneTokens(store, T0 + HOUR + DAY);
    expect(store.getMeta('token_ingest')).not.toContain('a'.repeat(64));
    storeToken(store, 'ingest', 'c'.repeat(64), T0 + 2 * HOUR, false);
    storeToken(store, 'ingest', 'd'.repeat(64), T0 + 3 * HOUR, true);
    expect(heldDigests(store, T0 + 3 * HOUR)).toEqual({ ingest: ['d'.repeat(64)], export: [] });
    expect(deleteToken(store, 'ingest')).toBe(true);
    expect(deleteToken(store, 'ingest')).toBe(false);
    expect(heldDigests(store, T0)).toEqual({ ingest: [], export: [] });
  });

  it('reads the Worker-secret digests of a route, lower-case hex only', () => {
    expect(secretDigests({ INGEST_TOKEN_SHA256: ` ${'A'.repeat(64)} `, INGEST_TOKEN_SHA256_PREVIOUS: 'not-a-digest', EXPORT_TOKEN_SHA256: 'e'.repeat(64) }, 'ingest')).toEqual(['a'.repeat(64)]);
    expect(secretDigests({}, 'export')).toEqual([]);
  });
});

describe("the Worker's check", () => {
  afterEach(() => {
    vi.useRealTimers();
    forgetHeldDigests();
  });

  function worker(held: () => RouteDigests, secrets: Partial<Env> = {}): { env: Env; calls: () => number } {
    let calls = 0;
    const stub = {
      machineDigests: () => {
        calls += 1;
        return Promise.resolve(held());
      },
    };
    const env = { RECALL: { idFromName: () => 'id', get: () => stub }, ...secrets } as unknown as Env;
    return { env, calls: () => calls };
  }
  const request = (token: string | null) => new Request('https://recall.example.com/api/machine/v1/changes', { headers: token === null ? {} : { authorization: `Bearer ${token}` } });

  it("accepts a Worker secret's token without asking RecallState", async () => {
    const { env, calls } = worker(() => ({ ingest: [], export: [] }), { EXPORT_TOKEN_SHA256: digest('recall_export_secret') });
    expect(await checkBearer(request('recall_export_secret'), env, 'export')).toBe('ok');
    expect(calls()).toBe(0);
    expect(await checkBearer(request('recall_export_other'), env, 'export')).toBe('refused');
  });

  it("keeps RecallState's digests a minute, and asks again for a refused bearer once they are 10 seconds old", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let digests: RouteDigests = { ingest: [digest('recall_ingest_old')], export: [] };
    const { env, calls } = worker(() => digests);
    expect(await checkBearer(request('recall_ingest_old'), env, 'ingest')).toBe('ok');
    expect(await checkBearer(request('recall_ingest_old'), env, 'ingest')).toBe('ok');
    expect(calls()).toBe(1);
    // A new token (the old one revoked): refused at once from memory, accepted once the kept digests are 10 s old.
    digests = { ingest: [digest('recall_ingest_new')], export: [] };
    expect(await checkBearer(request('recall_ingest_new'), env, 'ingest')).toBe('refused');
    expect(calls()).toBe(1);
    vi.setSystemTime(T0 + 10 * SECOND);
    expect(await checkBearer(request('recall_ingest_new'), env, 'ingest')).toBe('ok');
    expect(calls()).toBe(2);
    // A flood of wrong tokens asks RecallState at most once per 10 seconds.
    for (let i = 0; i < 50; i++) expect(await checkBearer(request(`recall_ingest_wrong${String(i)}`), env, 'ingest')).toBe('refused');
    expect(calls()).toBe(2);
    // The revoked token works at most a minute in an isolate that kept it.
    vi.setSystemTime(T0 + 10 * SECOND + MINUTE);
    expect(await checkBearer(request('recall_ingest_old'), env, 'ingest')).toBe('refused');
  });

  it('expires a revoked named credential from the cache without stopping the other device or legacy token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = memoryStore();
    storeToken(store, 'ingest', digest('recall_ingest_legacy'), T0, false);
    const phone = addNamedToken(store, 'Phone', digest('recall_ingest_phone'), T0);
    addNamedToken(store, 'Desktop', digest('recall_ingest_desktop'), T0);
    const { env } = worker(() => heldDigests(store, Date.now()));
    expect(await checkBearer(request('recall_ingest_phone'), env, 'ingest')).toBe('ok');
    expect(deleteNamedToken(store, phone?.name.split('/')[1] ?? '')).toBe(true);
    // Existing isolate cache has the documented one-minute revocation window.
    expect(await checkBearer(request('recall_ingest_phone'), env, 'ingest')).toBe('ok');
    vi.setSystemTime(T0 + MINUTE);
    expect(await checkBearer(request('recall_ingest_phone'), env, 'ingest')).toBe('refused');
    expect(await checkBearer(request('recall_ingest_desktop'), env, 'ingest')).toBe('ok');
    expect(await checkBearer(request('recall_ingest_legacy'), env, 'ingest')).toBe('ok');
  });

  it('answers none (503) when no digest exists anywhere, also without a bearer', async () => {
    const { env } = worker(() => ({ ingest: [], export: [] }));
    expect(await checkBearer(request(null), env, 'export')).toBe('none');
    expect(await checkBearer(request('recall_export_x'), env, 'export')).toBe('none');
  });
});

// Two matching requests can overlap while WebCrypto hashes their independently generated tokens.
describe('overlapping token requests', () => {
  it.each(['named', 'legacy'] as const)('shows only the stored %s token when the same request overlaps', async (kind) => {
    const store = memoryStore();
    const context = { store, now: NOW, transact: <T>(run: () => T): T => run(), secretTokens: { ingest: false, export: false } } as ApiContext;
    const release: (() => void)[] = [];
    const hashing = vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, bytes) => {
      const input = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
      const hashed = Uint8Array.from(createHash('sha256').update(input).digest()).buffer;
      return new Promise<ArrayBuffer>((resolve) => { release.push(() => { resolve(hashed); }); });
    });
    const requestId = crypto.randomUUID();
    const start = kind === 'named'
      ? () => handlers.createMachineToken(create(CreateMachineTokenRequestSchema, { machineToken: { label: 'Phone' }, requestId }), context)
      : () => handlers.regenerateMachineToken(create(RegenerateMachineTokenRequestSchema, { name: 'machineTokens/ingest', requestId }), context);
    const first = start();
    const second = start();
    expect(release).toHaveLength(2);
    release.shift()?.();
    const winner = await first;
    release.shift()?.();
    const replay = await second;
    hashing.mockRestore();
    if (!('token' in winner)) throw new Error('expected a token resource');
    expect(winner.token).toMatch(/^recall_ingest_[A-Za-z0-9_-]{43}$/);
    expect(replay).toMatchObject({ name: winner.name, token: '' });
    expect(heldDigests(store, NOW).ingest).toContain(await tokenDigest(winner.token));
    expect(namedTokens(store)).toHaveLength(kind === 'named' ? 1 : 0);
    expect(JSON.stringify(store.all(`SELECT * FROM requests`))).not.toContain(winner.token);
  });
});

// Upgrade the actual preceding layout, preserving its legacy credentials, device and feed identity.
describe('schema 6 device upgrade', () => {
  it('adds mobile status and its timeline index without changing existing state', () => {
    const store = memoryStore();
    store.run(`ALTER TABLE devices DROP COLUMN mobile`);
    store.run(`DROP INDEX visits_device`);
    store.run(`DROP INDEX documents_device`);
    store.setMeta('schema_version', '4');
    store.setMeta('token_ingest', 'synthetic-existing-digest');
    store.run(`INSERT INTO devices (id, label, extension_version, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)`,
      '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'Desktop', '2026.1011.900', 10, 20);
    const feedId = store.getMeta('feed_id');
    store.migrate();
    store.migrate();
    expect(store.getMeta('schema_version')).toBe('6');
    expect(store.getMeta('feed_id')).toBe(feedId);
    expect(store.getMeta('token_ingest')).toBe('synthetic-existing-digest');
    expect(store.one(`SELECT label, mobile, first_seen_ms, last_seen_ms FROM devices`)).toEqual({ label: 'Desktop', mobile: 0, first_seen_ms: 10, last_seen_ms: 20 });
    expect(store.one(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'visits_device'`)).toEqual({ name: 'visits_device' });
    expect(store.one(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'documents_device'`)).toEqual({ name: 'documents_device' });
  });
});

describe('blobs stream bounds and paths', () => {
  it('reads chunks up to the limit, cancels oversized streams, and rejects non-Uint8Array chunks', async () => {
    const okStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    expect(Array.from(await readBounded(okStream, 5))).toEqual([1, 2, 3, 4, 5]);

    let cancelled = false;
    const tooLarge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBounded(tooLarge, 5)).rejects.toThrow('content_too_large');
    expect(cancelled).toBe(true);

    const badChunk = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('not-bytes');
      },
    });
    await expect(readBounded(badChunk, 10)).rejects.toThrow('invalid_content');
  });

  it('extracts document IDs from text and screenshot blob paths and formats RFC 9530 digests', async () => {
    const id = '7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01';
    expect(documentIdOfPath(`2026/10/${id}.txt.gz`)).toBe(id);
    expect(documentIdOfPath(`2026/10/${id}.webp`)).toBe(id);
    expect(documentIdOfPath(`2026/10/${id}.jpg`)).toBe(id);
    expect(documentIdOfPath(`2026/13/${id}.txt.gz`)).toBeNull();
    expect(documentIdOfPath('invalid/path')).toBeNull();
    const sha = await sha256Hex(new TextEncoder().encode('synthetic'));
    expect(contentDigest(sha)).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
  });
});

describe('backup helpers', () => {
  it('tracks connection, retention pause, confirmations, waiting lag, and cold-read guards', async () => {
    const store = memoryStore();
    expect(connected(store)).toBe(false);
    expect(syncedSeq(store)).toBe(0);
    expect(retentionPause(store)).toBe('dropbox_not_connected');
    expect(archiveConfirmations(store)).toBeNull();
    expect(waitingSince(store)).toBeNull();
    expect(redirectUri('recall.example.com')).toBe('https://recall.example.com/api/dropbox/callback');

    const state = 'synthetic-state-token';
    const stateSha256 = await sha256Hex(new TextEncoder().encode(state));
    const url = startConnect(store, DROPBOX, 'recall.example.com', {
      appKey: 'syntheticappkey1',
      state,
      stateSha256,
      verifier: 'v'.repeat(43),
      challenge: 'c'.repeat(43),
      expiresMs: T0 + MINUTE,
    });
    expect(url).toContain('client_id=syntheticappkey1');

    const baseCtx: BackupContext = {
      store,
      bucket: {} as unknown as R2Bucket,
      fetch: () => Promise.resolve(new Response('{}')),
      endpoints: DROPBOX,
      now: T0,
      transact: (fn) => fn(),
      host: 'recall.example.com',
      session: { token: null, expiresAt: 0 },
    };
    expect(await finishConnect({ ...baseCtx, now: T0 + 2 * MINUTE }, `?state=${state}&code=abc`)).toBe('expired');
    expect(await finishConnect(baseCtx, '?state=wrong&code=abc')).toBe('expired');
    expect(await finishConnect(baseCtx, `?state=${state}&error=access_denied`)).toBe('denied');

    store.setMeta('dropbox_app_key', 'syntheticappkey1');
    store.setMeta('dropbox_refresh_token', 'refresh-1');
    store.setMeta('archive_target', 'acct syntheticappkey1');
    store.setMeta('dropbox_connected_ms', String(T0));
    expect(connected(store)).toBe(true);
    expect(retentionPause(store)).toBe('');
    expect(archiveConfirmations(store)).toBeNull();

    store.setMeta('archive_seq', '5');
    expect(archiveConfirmations(store)).toEqual({ target: 'acct syntheticappkey1', syncedSeq: 5 });
    store.setMeta('archive_failures', '2');
    expect(retentionPause(store)).toBe('dropbox_failing');
    expect(archiveConfirmations(store)).toBeNull();
    store.deleteMeta('archive_failures');

    expect(backupMessage(store)).toMatchObject({
      name: 'dropboxBackup',
      appKey: 'syntheticappkey1',
      connected: true,
      syncedSeq: 5,
      pendingCount: 0,
    });

    const blob = { path: '2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz', sha256: 'a'.repeat(64), size: 10 };
    await expect(readArchive(baseCtx, blob)).rejects.toThrow(DropboxError);
    store.run(`INSERT INTO archive_blobs (path, target, content_hash) VALUES (?, ?, ?)`, blob.path, 'other-target', 'h'.repeat(64));
    await expect(readArchive(baseCtx, blob)).rejects.toMatchObject({ code: 'archive_other_target' });
  });
});

describe('ingest planning and deduplication helpers', () => {
  const V1 = '11111111-1111-4111-8111-111111111111';
  const D1 = '22222222-2222-4222-8222-222222222222';
  const D2 = '33333333-3333-4333-8333-333333333333';

  function planning(): Planning {
    const store = memoryStore();
    return {
      envelope: {
        batchId: '44444444-4444-4444-8444-444444444444',
        sentMs: T0,
        device: { id: '55555555-5555-4555-8555-555555555555', label: 'MacBook', version: '2026.1010.900', queued: 0, lastError: '', mobile: false },
        items: [],
        diagnostic: undefined,
      },
      patterns: ownerPatterns(readDenylist(store)),
      ownHosts: ['recall.example.com'],
      skewMs: 0,
    };
  }

  it('detects items from a newer extension build via unrecognized fields', () => {
    expect(fromNewerBuild({ kind: 'visit', future_field: true })).toBe(true);
    expect(fromNewerBuild({ kind: 'visit' })).toBe(false);
    expect(fromNewerBuild('not-an-object')).toBe(false);
  });

  it('validates visit spans, leeway, duration, own-host skip, and site-only root reduction in planVisit', async () => {
    const ctx = planning();
    const url = 'https://docs.example.com/guide?token=secret';
    const pageId = await pageIdOf('https://docs.example.com/guide?token=[redacted]');

    const validVisit = create(VisitItemSchema, {
      id: V1,
      pageId,
      url,
      title: 'Guide',
      focusSpans: [{ startTime: timestampFromMs(T0 - 5000), endTime: timestampFromMs(T0) }],
      revision: 1,
    });
    const planned = await planVisit(validVisit, ctx);
    expect(planned).toMatchObject({ kind: 'plan', plan: { kind: 'visit', id: V1, focusSeconds: 5, site: 'docs.example.com' } });

    // Own host is skipped ('never').
    const ownVisit = create(VisitItemSchema, { ...validVisit, url: 'https://recall.example.com/settings' });
    expect(await planVisit(ownVisit, ctx)).toEqual({ kind: 'skip' });

    // Built-in site-only host reduces to root URL without title.
    const siteOnlyVisit = create(VisitItemSchema, { ...validVisit, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' });
    const siteOnlyPlan = await planVisit(siteOnlyVisit, ctx);
    expect(siteOnlyPlan).toMatchObject({ kind: 'plan', plan: { kind: 'visit', level: 'site_only', url: 'https://mail.google.com/', title: '' } });

    // Out-of-order spans, future beyond leeway, or excessive span duration are rejected.
    const reversed = create(VisitItemSchema, {
      ...validVisit,
      focusSpans: [{ startTime: timestampFromMs(T0), endTime: timestampFromMs(T0 - 1000) }],
    });
    expect(await planVisit(reversed, ctx)).toEqual({ kind: 'reject', reason: 'invalid_item' });

    const future = create(VisitItemSchema, {
      ...validVisit,
      focusSpans: [{ startTime: timestampFromMs(T0), endTime: timestampFromMs(T0 + ITEM_CLOCK_LEEWAY_MS + 1000) }],
    });
    expect(await planVisit(future, ctx)).toEqual({ kind: 'reject', reason: 'invalid_item' });

    const tooLong = create(VisitItemSchema, {
      ...validVisit,
      focusSpans: [{ startTime: timestampFromMs(T0 - VISIT_MAX_MS - 1000), endTime: timestampFromMs(T0) }],
    });
    expect(await planVisit(tooLong, ctx)).toEqual({ kind: 'reject', reason: 'invalid_item' });
  });

  it('validates document capture bounds and deduplicates batch and stored documents via skipKnownTexts and documentSkip', async () => {
    const ctx = planning();
    const url = 'https://docs.example.com/guide';
    const pageId = await pageIdOf(url);

    const validDoc = create(DocumentItemSchema, {
      id: D1,
      visitId: V1,
      pageId,
      url,
      title: 'Guide',
      description: 'Desc',
      captureTime: timestampFromMs(T0 - 1000),
      text: 'Captured body text.',
    });
    const outcome = await planDocument(validDoc, ctx);
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan' || outcome.plan.kind !== 'document') throw new Error('expected document plan');

    // Empty text without screenshot or with both webp and jpeg is rejected.
    expect(await planDocument(create(DocumentItemSchema, { ...validDoc, text: '   ' }), ctx)).toEqual({ kind: 'reject', reason: 'invalid_item' });
    expect(await planDocument(create(DocumentItemSchema, { ...validDoc, screenshotWebpBase64: 'aa==', screenshotJpegBase64: 'bb==' }), ctx)).toEqual({
      kind: 'reject',
      reason: 'invalid_item',
    });
    // Non-record host skips capture.
    expect(await planDocument(create(DocumentItemSchema, { ...validDoc, url: 'https://mail.google.com/mail' }), ctx)).toEqual({ kind: 'skip' });

    // Duplicate IDs in the same batch: identical skips as captured, differing content rejects as id_conflict.
    const store = memoryStore();
    const sameEntry: { outcome: Outcome } = { outcome: { kind: 'plan', plan: outcome.plan } };
    const dupIdentical: { outcome: Outcome } = { outcome: { kind: 'plan', plan: { ...outcome.plan } } };
    const otherStored = await storedText('Different text');
    const dupConflict: { outcome: Outcome } = { outcome: { kind: 'plan', plan: { ...outcome.plan, stored: otherStored } } };
    skipKnownTexts(store, [sameEntry, dupIdentical, dupConflict]);
    expect(sameEntry.outcome.kind).toBe('plan');
    expect(dupIdentical.outcome).toEqual({ kind: 'skip', captured: true });
    expect(dupConflict.outcome).toEqual({ kind: 'reject', reason: 'id_conflict' });

    // Stored document in SQLite: identical ID+content skips, different content conflicts, consecutive identical visit capture skips.
    const pageRow = store.one<{ rowid: number }>(
      `INSERT INTO pages (id, url, url_truncated, title, host_key, first_visit_ms, last_visit_ms, visit_count, focus_seconds) VALUES (?, ?, 0, 'Guide', ?, ?, ?, 1, 10) RETURNING rowid`,
      pageId,
      url,
      hostKey('docs.example.com'),
      T0 - 2000,
      T0,
    )!;
    const plan: DocumentPlan = outcome.plan;
    store.insert('documents', {
      id: D1,
      seq: 1,
      seq_ms: T0,
      page_rowid: pageRow.rowid,
      visit: V1,
      device_id: ctx.envelope.device.id,
      device_label: ctx.envelope.device.label,
      capture_ms: plan.captureMs,
      url: plan.url,
      url_truncated: 0,
      title: plan.title,
      description: plan.description,
      blob_path: textBlobPath(plan.captureMs, D1),
      sha256: plan.stored.sha256,
      stored_bytes: plan.stored.gzip.byteLength,
      text_bytes: plan.stored.textBytes,
      text_sha256: plan.stored.textSha256,
      truncated: 0,
      archived_ms: null,
      screenshot_path: '',
      screenshot_sha256: '',
      screenshot_bytes: 0,
      screenshot_width: 0,
      screenshot_height: 0,
    });
    expect(documentSkip(store, plan)).toEqual({ outcome: 'skip' });
    expect(documentSkip(store, { ...plan, stored: otherStored })).toEqual({ outcome: 'id_conflict' });
    expect(documentSkip(store, { ...plan, id: D2 }, true)).toEqual({ outcome: 'skip', captured: true });
    expect(documentSkip(store, { ...plan, id: D2 }, false)).toBeNull();
  });
});

