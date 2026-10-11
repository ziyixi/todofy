/**
 * CPU inside workerd against Workers Free (../../../docs/design.md §5.3, §10), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts). RecallState runs in a Worker of its own (HarnessOptions.splitObject), as on
 * Cloudflare, so the two limits are measured apart:
 *
 * - the fetch handler (10 ms per request): Access (an RS256 verification) or a machine token's SHA-256, CSRF, one call
 *   to the object and its answer passed through; for the heaviest upload (1 MiB on the wire at most, read and
 *   forwarded unparsed), both search paths, a timeline day of 500 visits, a feed page of 500 changes, a blob read from
 *   R2 without the object, the status and a settings update;
 * - RecallState (30 s per invocation): those calls, the heaviest upload above all (50 items with 10 texts of 64 KiB,
 *   gzip, scrub, R2 and the index), an alarm pass at its bounds (a purge of 500 rows and 2,000 pages moved out of the
 *   text index), and the archive's passes to a fake Dropbox (a scan of 10,000 changes a table, then days of about 300
 *   visits and the texts of 64 KiB, each pass at its subrequests).
 *
 * No dev bypass: Access is verified as in production. Bounds are milliseconds of the reference machine.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  COLD_ISOLATES,
  connectCpuMeter,
  CPU_TEST_TIMEOUT_MS,
  FREE_CPU_MS,
  INSPECTOR_TIMEOUT_MS,
  measureInIsolates,
  summarize,
  type CpuMeter,
  type Isolate,
  type Measurement,
} from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { ARCHIVE_SCAN_ROWS, DEMOTE_BATCH, PURGE_BATCH } from '../../src/limits.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { batch, document, iso, text, uuid, visit } from './data.ts';
import { FakeDropbox } from './fake-dropbox.ts';
import { DAY, MINUTE, OBJECT_WORKER, PUBLIC_HOST, startHarness, SYNTHETIC_BINDINGS, T0, type Harness } from './harness.ts';

const FREE_OBJECT_CPU_MS = 30_000;
/** The fetch handler: a JWT or a token digest, CSRF, the object's answer passed on (mailsort's bounds). */
const WORKER_COLD_BOUND_MS = 0.6 * FREE_CPU_MS;
const WORKER_BOUND_MS = 0.25 * FREE_CPU_MS;
/** RecallState: its API calls and feed pages; the heaviest upload (expected well under a second); an alarm pass. */
const OBJECT_API_BOUND_MS = 0.01 * FREE_OBJECT_CPU_MS;
const OBJECT_UPLOAD_BOUND_MS = 0.03 * FREE_OBJECT_CPU_MS;
const OBJECT_ALARM_BOUND_MS = 0.05 * FREE_OBJECT_CPU_MS;
const RUNS = 5;
const HANDLER = 'fetch handler';
const OBJECT = 'RecallState';
const UPLOAD = 'POST batches (50 items, 10 texts of 64 KiB)';
const ALARM = `alarm pass: a purge of ${String(PURGE_BATCH)} rows, ${String(DEMOTE_BATCH)} pages out of the text index`;
const ARCHIVE = `archive pass: a scan of ${String(ARCHIVE_SCAN_ROWS)} changes a table, or a pass of days and texts to Dropbox`;
const COLD_LABEL = "GET /api/csrf as the fetch handler's very first request";
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';
const DAY0 = Date.parse('2026-10-09T00:00:00Z');

interface RecallIsolate extends Isolate {
  readonly h: Harness;
  readonly object: CpuMeter;
  readonly dropbox: FakeDropbox;
}

let token = '';
let jwks: unknown;

async function startIsolate(): Promise<RecallIsolate> {
  if (token === '') {
    const issuer = await testIssuer();
    token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
    jwks = issuer.jwks;
  }
  const dropbox = new FakeDropbox();
  const h = await startHarness({
    inspectorPort: 0,
    splitObject: true,
    bindings: { DEV_AUTH_BYPASS: undefined },
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(jwks)]]),
    outbound: (request) => dropbox.handle(request),
  });
  try {
    const meter = await connectCpuMeter(h.mf, 'recall');
    const object = await connectCpuMeter(h.mf, OBJECT_WORKER, 2 * INSPECTOR_TIMEOUT_MS);
    return {
      h,
      meter,
      object,
      dropbox,
      async dispose() {
        meter.close();
        object.close();
        await h.dispose();
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

/** A store of about two months: 5,000 pages (a third with an indexed Chinese and English text), 18,000 visits, a day of 500. */
async function seed(h: Harness): Promise<void> {
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
     INSERT INTO pages (id, url, title, host_key, first_visit_ms, last_visit_ms, visit_count, focus_seconds, document_count, latest_capture_ms, text_indexed)
     SELECT printf('%032x', i), 'https://site' || (i % 50) || '.example.com/articles/' || i, '文章 ' || i || ' · Example', 'com.example.site' || (i % 50) || '.',
            0, 0, 0, 0, CASE WHEN i % 3 = 0 THEN 1 ELSE 0 END, CASE WHEN i % 3 = 0 THEN ? + i ELSE NULL END, CASE WHEN i % 3 = 0 THEN 30000 ELSE 0 END FROM n`,
    T0 - 60 * DAY,
  );
  await h.sql(`INSERT INTO sites (host, host_key, visit_count, focus_seconds) SELECT DISTINCT substr(url, 9, instr(substr(url, 9), '/') - 1), host_key, 0, 0 FROM pages`);
  await h.sql(
    `INSERT INTO fts (rowid, title, url, body) SELECT rowid, '文章 ' || rowid || ' example', 'site example com articles',
       CASE WHEN document_count > 0 THEN '持久 久对 对象 象是 durable storage 数据 据库 的索 索引 alarms and weekly notes' ELSE '' END FROM pages`,
  );
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 17499)
     INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision)
     SELECT printf('eeeeeeee-0000-4000-8000-%012x', i), 1 + i, ? + i * 288000, 1 + (i * 7919) % 5000, '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'MacBook', 'https://site.example.com/a', '文章',
            ? + i * 288000, ? + i * 288000 + 120000, 120, '[[0,1]]', 1 FROM n`,
    DAY0 - 59 * DAY,
    DAY0 - 59 * DAY,
    DAY0 - 59 * DAY,
  );
  // One busy day: 500 visits on DAY0.
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 499)
     INSERT INTO visits (id, seq, seq_ms, page_rowid, device_id, device_label, url, title, start_ms, end_ms, focus_seconds, spans, revision)
     SELECT printf('dddddddd-0000-4000-8000-%012x', i), 20000 + i, ?, 1 + (i * 31) % 5000, '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'MacBook · 工作',
            'https://site' || (i % 50) || '.example.com/articles/' || i, '今天读的文章 ' || i, ? + i * 170000, ? + i * 170000 + 90000, 90,
            '[[' || (? + i * 170000) || ',' || (? + i * 170000 + 90000) || ']]', 1 FROM n`,
    T0,
    DAY0,
    DAY0,
    DAY0,
    DAY0,
  );
  await h.sql(`UPDATE pages SET last_visit_ms = (SELECT max(end_ms) FROM visits WHERE page_rowid = pages.rowid), visit_count = (SELECT count(*) FROM visits WHERE page_rowid = pages.rowid)`);
  await h.sql(`UPDATE meta SET value = '20500' WHERE key = 'seq'`);
}

/** The heaviest upload: 40 visits and 10 texts of 64 KiB (UTF-8, Chinese and English), on new pages each run. */
async function heaviestUpload(run: number): Promise<Uint8Array> {
  const items: unknown[] = [];
  for (let i = 0; i < 50; i++) {
    const n = run * 100 + i;
    const url = `https://heavy${String(run)}.example.org/articles/${String(i)}`;
    if (i < 40) items.push(await visit({ id: uuid(n), url, title: `文章 ${String(i)} · Example`, spans: [[T0 - 30 * MINUTE + i * 1000, T0 - 20 * MINUTE + i * 1000]] }));
    else items.push(await document({ id: uuid(n, 2), visitId: uuid(n), url, title: `长文 ${String(i)}`, captureMs: T0 - 25 * MINUTE, text: text(64 * 1024 - 100, n) }));
  }
  const bytes = gzipSync(JSON.stringify(batch(items, { sentMs: T0 })));
  expect(bytes.byteLength).toBeLessThan(1024 * 1024);
  return bytes;
}

async function session({ h, meter: worker, object, dropbox }: RecallIsolate, index: number): Promise<Measurement[]> {
  const headers = { 'cf-access-jwt-assertion': token };
  let csrf = new Response();
  const cold = await worker.measure(COLD_LABEL, async () => {
    csrf = await h.fetch('/api/csrf', { headers });
  }, 1);
  const csrfToken = (await csrf.json<{ token: string }>()).token;
  if (index !== COLD_ISOLATES - 1) return [cold];
  const mutationHeaders = { ...headers, 'content-type': 'application/json', origin: `https://${PUBLIC_HOST}`, 'x-csrf-token': csrfToken, cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  await seed(h);

  async function expectOk(path: string, init: RequestInit = {}): Promise<void> {
    const response = await h.fetch(path, { headers, ...init });
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`${path}: ${String(response.status)}`);
  }

  async function both(label: string, run: (i: number) => Promise<void>, workerOnly = false): Promise<Measurement[]> {
    const workerSamples: number[] = [];
    const objectSamples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      let inner = 0;
      workerSamples.push(
        await worker.cpu(async () => {
          inner = await object.cpu(() => run(i));
        }),
      );
      objectSamples.push(inner);
    }
    const result = [summarize(`${label}: ${HANDLER}`, workerSamples)];
    if (!workerOnly) result.push(summarize(`${label}: ${OBJECT}`, objectSamples));
    return result;
  }

  // The uploads first: each a fresh batch on new pages (built before the meters run).
  const uploads = await Promise.all(Array.from({ length: RUNS }, (_, run) => heaviestUpload(run)));
  const measured = [
    ...(await both(UPLOAD, async (i) => {
      const response = await h.upload(uploads[i] ?? new Uint8Array());
      const answer = await response.json<{ accepted_count?: number }>();
      if (response.status !== 200 || answer.accepted_count !== 50) throw new Error(`upload: ${String(response.status)}`);
    })),
    ...(await both('GET pages:search, words and a week', () => expectOk(`/api/v1/pages:search?query=${encodeURIComponent('数据库 durable')}&start_time=${iso(DAY0 - 7 * DAY)}&end_time=${iso(DAY0 + DAY)}`))),
    ...(await both('GET pages:search, words and no range', () => expectOk(`/api/v1/pages:search?query=${encodeURIComponent('持久对象')}`))),
    ...(await both('GET pages:search, 读过 of all time', () => expectOk('/api/v1/pages:search?page_type=read'))),
    ...(await both('GET visits, a day of 500', () => expectOk(`/api/v1/pages/-/visits?page_size=500&start_time=${iso(DAY0)}&end_time=${iso(DAY0 + DAY)}`))),
    ...(await both('GET changes (500)', () => h.changes('?after=0&limit=500&consumer=nas').then(async (response) => {
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`changes: ${String(response.status)}`);
    }))),
    ...(await both('GET serviceStatus', () => expectOk('/api/v1/serviceStatus'))),
    ...(await both('PATCH settings (mask)', (i) =>
      expectOk(`/api/v1/settings?update_mask=denylist_patterns&request_id=${crypto.randomUUID()}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ name: 'settings', denylist_patterns: [`bank${String(i)}.example.com`] }) }),
    )),
  ];
  const blobPath = `2026/10/${uuid(40, 2)}.txt.gz`;
  measured.push(
    ...(await both('GET blobs/<path> (64 KiB of text)', () => h.blob(blobPath).then(async (response) => {
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`blob: ${String(response.status)}`);
    }), true)),
  );

  // The alarm path at its bounds: a deleted page with PURGE_BATCH visits, and the index over its budget.
  const [{ rowid } = { rowid: 0 }] = await h.sql<{ rowid: number }>(`SELECT rowid FROM pages WHERE id = ?`, (1).toString(16).padStart(32, '0'));
  await h.sql(`UPDATE visits SET page_rowid = ? WHERE seq <= ?`, rowid, PURGE_BATCH);
  await h.fetch(`/api/v1/pages/${(1).toString(16).padStart(32, '0')}?request_id=${crypto.randomUUID()}`, { method: 'DELETE', headers: mutationHeaders });
  await h.sql(`UPDATE meta SET value = ? WHERE key = 'indexed_text_bytes'`, String(600 * 1024 * 1024));
  let pass = { purging: false, demoting: false };
  const alarm = summarize(ALARM, [
    await object.cpu(async () => {
      pass = await h.step(T0 + MINUTE);
    }),
  ]);
  expect(pass.demoting).toBe(true);

  // The archive's passes once Dropbox is connected: the scan of the whole store, then days and texts at the
  // subrequests a pass may make. The heaviest pass of them is held to the alarm's bound.
  const connect = await h.fetch('/api/v1/dropboxBackup:connect', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ app_key: dropbox.appKey }) });
  const { authorize_url: authorizeUrl } = await connect.json<{ authorize_url: string }>();
  const back = await h.fetch(`/api/dropbox/callback${dropbox.approve(authorizeUrl).query}`, { headers });
  if (back.headers.get('location') !== '/settings?dropbox=connected') throw new Error('dropbox: not connected');
  const samples: number[] = [];
  for (let run = 0; run < 12 && dropbox.callsTo('/2/files/upload').length < 60; run++) {
    samples.push(
      await object.cpu(async () => {
        await h.step(T0 + (run + 2) * MINUTE);
      }),
    );
  }
  expect(dropbox.callsTo('/2/files/upload').length).toBeGreaterThan(30);
  const archive = summarize(ARCHIVE, [Math.max(...samples)]);
  return [cold, ...measured, alarm, archive];
}

describe('CPU (Workers Free: 10 ms per request, 30 s per Durable Object invocation)', () => {
  it('the fetch handler stays far below 10 ms and RecallState far below 30 s, the heaviest upload and the alarm too', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    const get = (label: string): Measurement => {
      const measurement = reference.get(label);
      if (measurement === undefined) throw new Error(`not measured: ${label}`);
      return measurement;
    };
    console.log(
      `cpu bounds (reference ms): fetch handler first < ${WORKER_COLD_BOUND_MS.toFixed(1)}, median < ${WORKER_BOUND_MS.toFixed(1)}; ` +
        `${OBJECT} API < ${OBJECT_API_BOUND_MS.toFixed(0)}, upload < ${OBJECT_UPLOAD_BOUND_MS.toFixed(0)}, alarm < ${OBJECT_ALARM_BOUND_MS.toFixed(0)}`,
    );
    expect(get(COLD_LABEL).first, COLD_LABEL).toBeLessThan(WORKER_COLD_BOUND_MS);
    for (const { label, first, median } of reference.values()) {
      if (label.endsWith(`: ${HANDLER}`)) {
        expect(first, `${label}, first run`).toBeLessThan(WORKER_COLD_BOUND_MS);
        expect(median, `${label}, warm median`).toBeLessThan(WORKER_BOUND_MS);
      } else if (label === `${UPLOAD}: ${OBJECT}`) {
        expect(first, label).toBeLessThan(OBJECT_UPLOAD_BOUND_MS);
      } else if (label.endsWith(`: ${OBJECT}`)) {
        expect(first, label).toBeLessThan(OBJECT_API_BOUND_MS);
      }
    }
    expect(get(ALARM).first, ALARM).toBeLessThan(OBJECT_ALARM_BOUND_MS);
    expect(get(ARCHIVE).first, ARCHIVE).toBeLessThan(OBJECT_ALARM_BOUND_MS);
    expect(reference.size).toBe(1 + 1 + 2 * 8 + 1 + 1);
  });
});
