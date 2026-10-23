/** Saved captures use real SQLite/R2; the normal pipeline still owns business rules. All pages are synthetic. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { fromWire } from '@ziyixi/proto/wire-json';
import { SnapshotSchema, SnapshotImageSchema } from '@ziyixi/proto/watch/ui/v1/snapshot_pb';
import { WatchUiService, WatchEvent_Kind } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { Change_State } from '@ziyixi/proto/watch/ui/v1/change_pb';
import { Watch_NotifyPolicy, WatchHealth_Outcome } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { page } from '../fake-sites.ts';
import { HOUR, MINUTE, op, startHarness, T0, type Harness } from './harness.ts';

let mf: Miniflare;
let persistence: string;
let h: Harness;
const JPEG = [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9];
const HTML = '<html><head><title>Synthetic evidence</title><meta name="description" content="Synthetic metadata"></head><body><h1>Version 123</h1><a href="/details">Details</a></body></html>';

beforeAll(async () => {
  persistence = await mkdtemp(join(tmpdir(), 'watch-evidence-'));
  // The single race hook changes the Watch setting after an actual R2 put, without a production test hook.
  const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { Store } from './src/store.ts';
    import { saveEvidence, latestEvidence, readEvidence, readEvidenceImage, cleanEvidence } from './src/evidence.ts';
    import { extractCapture } from './src/evidence-extract.ts';
    import { encodeSnapshot } from './src/snapshot.ts';
    import { SnapshotSchema, SnapshotImageSchema } from '@ziyixi/proto/watch/ui/v1/snapshot_pb';
    import { toWire } from '@ziyixi/proto/wire-json';
    export class EvidenceProbe extends DurableObject {
      constructor(ctx, env) {
        super(ctx, env);
        this.store = new Store(ctx.storage.sql);
        ctx.blockConcurrencyWhile(async () => {
          this.store.migrate();
          this.store.run("INSERT OR IGNORE INTO watches (id,settings,host,read_hash,check_hash,state,etag,create_time,update_time) VALUES ('synthetic','{}','synthetic.example.com','read-one','check-one','active','1',0,0)");
        });
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/read') return Response.json(toWire(SnapshotSchema, await readEvidence(this.store, this.env.EVIDENCE_STORE, url.searchParams.get('name'))));
        if (url.pathname === '/image') return Response.json(toWire(SnapshotImageSchema, await readEvidenceImage(this.store, this.env.EVIDENCE_STORE, url.searchParams.get('name'))));
        if (url.pathname !== '/capture') return new Response(null, {status:404});
        const input = await request.json();
        const extracted = await extractCapture({ body:new TextEncoder().encode(input.html), contentType:'text/html', finalUrl:'https://synthetic.example.com/page' });
        const document = { ...extracted, accessibilityJson:JSON.stringify({role:'RootWebArea',name:'Synthetic evidence'}),
          errors:input.imageError ? [...extracted.errors,input.imageError] : extracted.errors,
          screenshot:input.image ? {bytes:Uint8Array.from(input.image),width:3,height:2,mimeType:'image/jpeg'} : null };
        let edited = false;
        const bucket = input.editDuringPut || input.pauseDuringPut ? { put:async (...args) => {
          const object = await this.env.EVIDENCE_STORE.put(...args);
          if (!edited) {
            edited = true;
            this.store.run(input.pauseDuringPut ? "UPDATE watches SET state='paused',pause_reason='owner',next_check_at=NULL WHERE id='synthetic'" : "UPDATE watches SET read_hash='read-two' WHERE id='synthetic'");
          }
          return object;
        }} : this.env.EVIDENCE_STORE;
        const pair = await saveEvidence(this.store, bucket, 'synthetic', 'read-one', input.now, document);
        if (input.pinBaseline && pair) {
          const normalized = await encodeSnapshot({lines:['Synthetic baseline'],keys:['Synthetic baseline'],number:null,availability:null,truncated:false});
          const id = this.store.insertSnapshot('synthetic',input.now,'synthetic',normalized.lines,normalized.bytes,pair.after);
          this.store.updateWatch('synthetic',{baseline_id:id});
        }
        await cleanEvidence(this.store, this.env.EVIDENCE_STORE);
        const counts = this.store.one('SELECT count(*) AS captures FROM evidence_snapshots');
        return Response.json({ pair, latest:latestEvidence(this.store,'synthetic'), state:this.store.watch('synthetic').state, ...counts,
          evidenceEvents:this.store.watchEvents(0,100,true).length, legacyEvents:this.store.watchEvents(0,100,false).length });
      }
    }
    export default {fetch(request,env) { return env.PROBE.getByName(new URL(request.url).searchParams.get('fixture')).fetch(request); }};
  ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2024', write: false,
  external: ['cloudflare:workers'], logLevel: 'silent' });
  const script = bundle.outputFiles[0]?.text;
  if (!script) throw new Error('Missing evidence persistence probe bundle');
  mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: persistence, workers: [{
    name: 'evidence-probe', modules: true, script, compatibilityDate: '2026-09-08',
    durableObjects: { PROBE: { className: 'EvidenceProbe', useSQLite: true } }, r2Buckets: ['EVIDENCE_STORE'],
    outboundService: () => new Response('synthetic_only', { status: 502 }),
  }] }));
  await mf.ready;
  h = await startHarness({ evidence: true });
});
afterAll(async () => {
  await Promise.all([mf.dispose(), h.dispose()]);
  await rm(persistence, { recursive: true, force: true });
});

interface CaptureResult {
  pair: { before: string; after: string } | null;
  latest: string;
  state: string;
  captures: number;
  evidenceEvents: number;
  legacyEvents: number;
}
async function capture(fixture: string, now: number, input: { html?: string; image?: number[]; imageError?: string; editDuringPut?: boolean; pauseDuringPut?: boolean; pinBaseline?: boolean } = {}) {
  const response = await mf.dispatchFetch(`https://probe.invalid/capture?fixture=${fixture}`, {
    method: 'POST', body: JSON.stringify({ html: HTML, now, ...input }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as CaptureResult;
}
async function read(fixture: string, name: string) {
  const response = await mf.dispatchFetch(`https://probe.invalid/read?fixture=${fixture}&name=${encodeURIComponent(name)}`);
  expect(response.status).toBe(200);
  return fromWire(SnapshotSchema, await response.json() as Record<string, unknown>, { strict: true }).message;
}
async function image(fixture: string, name: string) {
  const response = await mf.dispatchFetch(`https://probe.invalid/image?fixture=${fixture}&name=${encodeURIComponent(`${name}/image`)}`);
  expect(response.status).toBe(200);
  return fromWire(SnapshotImageSchema, await response.json() as Record<string, unknown>, { strict: true }).message;
}

describe('real SQLite and R2 capture storage', () => {
  it('reads captured Markdown, metadata and exact JPEG bytes, and reuses unchanged content', async () => {
    const saved = await capture('reuse', T0, { image: JPEG });
    const snapshot = await read('reuse', saved.latest);
    expect(snapshot).toMatchObject({ title: 'Synthetic evidence', contentAvailable: true, contentTruncated: false,
      imageAvailable: true, imageWidth: 3, imageHeight: 2, imageMimeType: 'image/jpeg' });
    expect(snapshot.markdown).toContain('# Version 123');
    expect(snapshot.links).toContainEqual(expect.objectContaining({ text: 'Details', url: 'https://synthetic.example.com/details' }));
    expect(snapshot.metadata).toContainEqual(expect.objectContaining({ name: 'description', content: 'Synthetic metadata' }));
    expect(snapshot.structureJson).toContain('RootWebArea');
    const screenshot = await image('reuse', saved.latest);
    expect(screenshot.available).toBe(true);
    expect(Array.from(atob(screenshot.jpegBase64), char => char.charCodeAt(0))).toEqual(JPEG);
    const bucket = await mf.getR2Bucket('EVIDENCE_STORE');
    const objects = (await bucket.list()).objects.map(object => object.key).sort();
    const repeated = await capture('reuse', T0 + HOUR, { image: JPEG });
    expect(repeated).toMatchObject({ pair: { before: saved.latest, after: saved.latest }, captures: 1, evidenceEvents: 0 });
    expect((await bucket.list()).objects.map(object => object.key).sort()).toEqual(objects);
  });

  it('keeps an image-only change as a distinct capture and evidence event outside the legacy feed', async () => {
    const before = await capture('image-change', T0, { image: JPEG });
    const changedImage = [...JPEG];
    changedImage[25] = 1;
    const after = await capture('image-change', T0 + HOUR, { image: changedImage });
    expect(after).toMatchObject({ pair: { before: before.latest, after: after.latest }, captures: 2, evidenceEvents: 1, legacyEvents: 0 });
    expect(after.latest).not.toBe(before.latest);
    const first = await read('image-change', before.latest);
    const second = await read('image-change', after.latest);
    expect(second.markdown).toBe(first.markdown);
    expect(second.contentSha256).toBe(first.contentSha256);
    expect(second.imageSha256).not.toBe(first.imageSha256);
    expect(Array.from(atob((await image('image-change', after.latest)).jpegBase64), char => char.charCodeAt(0))).toEqual(changedImage);
  });

  it('keeps valid text readable when no screenshot was recorded or a screenshot failed', async () => {
    for (const imageError of ['', 'screenshot_failed']) {
      const fixture = imageError || 'text-only';
      const saved = await capture(fixture, T0, imageError ? { imageError } : {});
      const snapshot = await read(fixture, saved.latest);
      expect(snapshot.contentAvailable).toBe(true);
      expect(snapshot.markdown).toContain('Version 123');
      expect(snapshot.imageAvailable).toBe(false);
      expect(snapshot.imageError).toBe(imageError || 'not_recorded');
      expect(await image(fixture, saved.latest)).toMatchObject({ available: false, error: imageError || 'not_recorded', jpegBase64: '' });
    }
  });

  it('keeps a missing image explicit while its stored text remains readable', async () => {
    const old = await capture('missing-image', T0, { image: JPEG });
    const snapshot = await read('missing-image', old.latest);
    const bucket = await mf.getR2Bucket('EVIDENCE_STORE');
    await bucket.delete(`images/${snapshot.imageSha256}.jpg`);
    expect(await image('missing-image', old.latest)).toMatchObject({ available: false, error: 'unavailable', jpegBase64: '' });
    expect((await read('missing-image', old.latest)).contentAvailable).toBe(true);
  });

  it('physically removes expired documents and unshared JPEGs while keeping the latest shared image', async () => {
    const uniqueImage = [...JPEG];
    uniqueImage[25] = 2;
    const oldest = await capture('retention', T0, { image: uniqueImage });
    const oldestSnapshot = await read('retention', oldest.latest);
    const firstShared = await capture('retention', T0 + HOUR, {
      html: HTML.replace('Version 123', 'Version 1'), image: JPEG,
    });
    let latest = firstShared;
    for (let version = 2; version <= 21; version++) latest = await capture('retention', T0 + version * HOUR, {
      html: HTML.replace('Version 123', `Version ${String(version)}`), image: JPEG,
    });
    // Each capture finishes cleanEvidence after saveEvidence returns, at a serialized storage boundary.
    expect(latest.captures).toBe(20);
    expect(await read('retention', oldest.latest)).toMatchObject({ contentAvailable: false, contentError: 'expired' });
    expect(await image('retention', oldest.latest)).toMatchObject({ available: false, error: 'expired', jpegBase64: '' });
    const bucket = await mf.getR2Bucket('EVIDENCE_STORE');
    const documentKey = (name: string) => `captures/synthetic/${name.split('/').at(-1) ?? ''}.json`;
    expect(await bucket.get(documentKey(oldest.latest))).toBeNull();
    expect(await bucket.get(documentKey(firstShared.latest))).toBeNull();
    expect(await bucket.get(`images/${oldestSnapshot.imageSha256}.jpg`)).toBeNull();
    const current = await read('retention', latest.latest);
    expect(current.contentAvailable).toBe(true);
    expect(current.markdown).toContain('Version 21');
    expect(await bucket.get(documentKey(latest.latest))).not.toBeNull();
    expect(await bucket.get(`images/${current.imageSha256}.jpg`)).not.toBeNull();
    expect((await image('retention', latest.latest)).available).toBe(true);
  });

  it('pins a referenced rule baseline beyond the capture window while collecting unreferenced evidence', async () => {
    const pinnedImage = [...JPEG];
    pinnedImage[25] = 3;
    const unusedImage = [...JPEG];
    unusedImage[25] = 4;
    const pinned = await capture('pinned-baseline', T0, { image: pinnedImage, pinBaseline: true });
    const pinnedSnapshot = await read('pinned-baseline', pinned.latest);
    const unused = await capture('pinned-baseline', T0 + HOUR, {
      html: HTML.replace('Version 123', 'Version 1'), image: unusedImage,
    });
    const unusedSnapshot = await read('pinned-baseline', unused.latest);
    let latest = unused;
    for (let version = 2; version <= 22; version++) latest = await capture('pinned-baseline', T0 + version * HOUR, {
      html: HTML.replace('Version 123', `Version ${String(version)}`), image: JPEG,
    });
    expect(latest.captures).toBe(21);
    expect(await read('pinned-baseline', pinned.latest)).toMatchObject({ contentAvailable: true, markdown: pinnedSnapshot.markdown });
    expect((await image('pinned-baseline', pinned.latest)).available).toBe(true);
    expect(await read('pinned-baseline', unused.latest)).toMatchObject({ contentAvailable: false, contentError: 'expired' });
    const bucket = await mf.getR2Bucket('EVIDENCE_STORE');
    const documentKey = (name: string) => `captures/synthetic/${name.split('/').at(-1) ?? ''}.json`;
    expect(await bucket.get(documentKey(pinned.latest))).not.toBeNull();
    expect(await bucket.get(`images/${pinnedSnapshot.imageSha256}.jpg`)).not.toBeNull();
    expect(await bucket.get(documentKey(unused.latest))).toBeNull();
    expect(await bucket.get(`images/${unusedSnapshot.imageSha256}.jpg`)).toBeNull();
  });

  it('keeps an owner settings edit during R2 upload from accepting a stale capture', async () => {
    const before = await capture('edit-during-put', T0, { image: JPEG });
    const rejected = await capture('edit-during-put', T0 + HOUR, {
      html: HTML.replace('Version 123', 'Version 124'), image: JPEG, editDuringPut: true,
    });
    expect(rejected).toMatchObject({ pair: null, latest: before.latest, evidenceEvents: 0 });
    expect((await read('edit-during-put', before.latest)).markdown).toContain('Version 123');
  });

  it('preserves an owner pause made during an evidence upload', async () => {
    await capture('pause-during-put', T0, { image: JPEG });
    const paused = await capture('pause-during-put', T0 + HOUR, {
      html: HTML.replace('Version 123', 'Version 124'), image: JPEG, pauseDuringPut: true,
    });
    expect(paused.state).toBe('paused');
  });
});

describe('normal Watch pipeline evidence feed', () => {
  it('retains page evidence even when a typed business rule suppresses a change', async () => {
    const client = createHttpClient(WatchUiService, call => h.serviceFetch(call.url, {
      method: call.httpMethod, ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }),
    }));
    const uri = 'https://suppressed-evidence.example.com/page';
    h.sites.html(uri, page('Synthetic release', '<h1>Version 1</h1><p>Registration is closed.</p>'));
    await client.createWatch({ requestId: op(), watchId: 'suppressed-evidence', watch: {
      displayName: 'Synthetic release', uri, notifyPolicy: Watch_NotifyPolicy.NONE, checkIntervalMinutes: 60,
      source: { html: { includeSelectors: ['main'] } }, trigger: { textAppears: { text: 'Registration is open' } },
      stability: { skipConfirmation: true },
    } });
    await h.run(T0);
    const first = await client.getWatch({ name: 'watches/suppressed-evidence' });
    expect(first.latestSnapshot).toMatch(/^watches\/suppressed-evidence\/snapshots\/[a-z0-9]{16}$/);
    const baseline = await client.pollWatchEvents({ baseline: true, filter: 'evidence' });
    h.sites.html(uri, page('Synthetic release', '<h1>Version 2</h1><p>Registration is closed.</p>'));
    await h.clock(T0 + 2 * HOUR);
    await h.run(T0 + 2 * HOUR);
    const evidence = await client.pollWatchEvents({ cursor: baseline.cursor, filter: 'evidence' });
    expect(evidence.events).toHaveLength(1);
    const event = evidence.events[0];
    expect(event).toMatchObject({ kind: WatchEvent_Kind.EVIDENCE_CHANGED, beforeSnapshot: first.latestSnapshot });
    expect(event?.afterSnapshot).not.toBe(first.latestSnapshot);
    expect((await client.pollWatchEvents({ cursor: baseline.cursor })).events).toEqual([]);
    const changes = await client.listChanges({ parent: first.name });
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]?.state).toBe(Change_State.SUPPRESSED);
    expect(changes.changes[0]?.beforeSnapshot).toBe(first.latestSnapshot);
    expect(changes.changes[0]?.afterSnapshot).toBe(event?.afterSnapshot);
    const captured = await client.getSnapshot({ name: event?.afterSnapshot ?? '' });
    expect(captured.contentAvailable).toBe(true);
    expect(captured.markdown).toContain('# Version 2');
    expect(captured.imageAvailable).toBe(false);
    expect(captured.imageError).toBe('not_recorded');
    await client.pauseWatch({ name: first.name, requestId: op() });
  });

  it('keeps a capture and its cleanup bounded with 1,000 other-watch evidence rows present', async () => {
    const now = T0 + 4 * HOUR;
    await h.clock(now);
    const uri = 'https://cleanup-evidence.example.com/page';
    h.sites.html(uri, page('Synthetic cleanup', '<p>Version 1 is available.</p>'));
    await h.api.createWatch({ watchId: 'cleanup-rows', requestId: op(), watch: {
      displayName: 'Synthetic cleanup', uri, notifyPolicy: Watch_NotifyPolicy.NONE,
      checkIntervalMinutes: 60, stability: { skipConfirmation: true },
    } });
    await h.run(now);
    await h.sql(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<999)
      INSERT INTO evidence_snapshots (id,watch_id,created_at,sha,object_key,image_key,ready)
      SELECT printf('other%011d',i),printf('unrelated-%d',i/20),?,'synthetic',printf('captures/unrelated/%d.json',i),'',1 FROM n`, now);
    await h.sql(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<18)
      INSERT INTO evidence_snapshots (id,watch_id,created_at,sha,object_key,image_key,ready)
      SELECT printf('%016d',i),'cleanup-rows',?,'synthetic',printf('captures/cleanup-rows/seed-%d.json',i),'',1 FROM n`, now - HOUR);
    h.sites.html(uri, page('Synthetic cleanup', '<p>Version 2 is available.</p>'));
    await h.rows();
    const checked = await h.step(now + 2 * HOUR);
    await h.step(now + 2 * HOUR + 1000);
    const rows = await h.rows();
    console.log(`evidence rows: read ${String(rows.read)}, wrote ${String(rows.written)} with 1000 unrelated snapshots`);
    expect(checked.outcomes?.['changed']).toBe(1);
    expect(rows.read).toBeLessThan(500);
    expect(rows.written).toBeLessThan(80);
    expect(await h.sql('SELECT count(*) AS n FROM evidence_snapshots WHERE watch_id=?', 'cleanup-rows')).toEqual([{ n: 20 }]);
    expect(await h.sql("SELECT count(*) AS n FROM evidence_snapshots WHERE watch_id LIKE 'unrelated-%'"))
      .toEqual([{ n: 1000 }]);
  });
  it('captures an existing HTTP watch once before reusing its legacy validators', async () => {
    const now = T0 + 8 * HOUR;
    await h.clock(now);
    const id = 'legacy-validators';
    const name = `watches/${id}`;
    const uri = 'https://legacy-validators.example.com/page';
    const modified = 'Thu, 01 Oct 2026 00:00:00 GMT';
    h.sites.set(uri, request => request.headers.get('if-none-match') === '"stable"' || request.headers.get('if-modified-since') === modified
      ? { status: 304 }
      : { headers: { 'content-type': 'text/html', etag: '"stable"', 'last-modified': modified },
        body: page('Synthetic legacy page', '<h1>Stable release</h1><p>Registration is closed.</p>') });
    await h.api.createWatch({ watchId: id, requestId: op(), watch: {
      displayName: 'Synthetic legacy page', uri, notifyPolicy: Watch_NotifyPolicy.NONE,
      checkIntervalMinutes: 60, stability: { skipConfirmation: true },
    } });
    await h.run(now);
    // Keep the old normalized baseline/validators, with the empty evidence references of a pre-upgrade watch.
    await h.sql('DELETE FROM evidence_snapshots WHERE watch_id=?', id);
    await h.sql("UPDATE snapshots SET evidence_ref='' WHERE watch_id=?", id);
    const [original] = await h.sql<{ baseline_id: number }>('SELECT baseline_id FROM watches WHERE id=?', id);
    expect((await h.api.getWatch({ name })).latestSnapshot).toBe('');
    const client = createHttpClient(WatchUiService, call => h.serviceFetch(call.url, {
      method: call.httpMethod, ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }),
    }));
    const baseline = await client.pollWatchEvents({ baseline: true, filter: 'evidence' });

    // Enrichment does not bypass the existing minimum spacing, even for an owner-requested check.
    await h.clock(now + 10 * MINUTE);
    await h.api.checkWatch({ name, requestId: op() });
    await h.step(now + 10 * MINUTE);
    expect(h.sites.requestsTo(uri)).toHaveLength(1);
    await h.clock(now + 2 * HOUR);
    await h.run(now + 2 * HOUR);
    const enriched = await h.api.getWatch({ name });
    expect(h.sites.requestsTo(uri).at(-1)?.headers['if-none-match']).toBeUndefined();
    expect(h.sites.requestsTo(uri).at(-1)?.headers['if-modified-since']).toBeUndefined();
    expect(enriched.latestSnapshot).toMatch(/^watches\/legacy-validators\/snapshots\/[a-z0-9]{16}$/);
    expect((await client.getSnapshot({ name: enriched.latestSnapshot })).markdown).toContain('# Stable release');
    expect(await h.sql('SELECT baseline_id FROM watches WHERE id=?', id)).toEqual([original]);
    expect((await client.pollWatchEvents({ cursor: baseline.cursor, filter: 'evidence' })).events.filter(event => event.watch === name)).toEqual([]);

    await h.clock(now + 4 * HOUR);
    await h.run(now + 4 * HOUR);
    expect(h.sites.requestsTo(uri).at(-1)?.headers['if-none-match']).toBe('"stable"');
    expect(h.sites.requestsTo(uri).at(-1)?.headers['if-modified-since']).toBe(modified);
    const unchanged = await h.api.getWatch({ name });
    expect(unchanged.latestSnapshot).toBe(enriched.latestSnapshot);
    expect(unchanged.health?.lastOutcome).toBe(WatchHealth_Outcome.NOT_MODIFIED);
    expect((await h.api.listChanges({ parent: name })).changes).toEqual([]);

    h.sites.html(uri, page('Synthetic legacy page', '<h1>New release</h1><p>Registration is closed.</p>'), { etag: '"updated"' });
    await h.clock(now + 6 * HOUR);
    await h.run(now + 6 * HOUR);
    const changed = await h.api.getWatch({ name });
    expect(changed.latestSnapshot).not.toBe(enriched.latestSnapshot);
    const changes = (await h.api.listChanges({ parent: name })).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ beforeSnapshot: '', afterSnapshot: changed.latestSnapshot });
    expect((await client.getSnapshot({ name: changed.latestSnapshot })).markdown).toContain('# New release');
    await h.api.pauseWatch({ name, requestId: op() });
  });

});
