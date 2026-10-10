/**
 * recall's smoke run (../../../docs/design.md §10): the whole path on loopback, synthetic data only.
 *
 *   the extension's own code (../../../extension/test/smoke-upload.ts, under its fake chrome.*) uploads a short
 *   browsing session → the real `wrangler dev` (the pinned wrangler, ../../../wrangler.test.toml, local Durable Object
 *   and R2) → the change feed and the blob route → the reference archive consumer (../../../sync/recall_sync.py) fills
 *   a fresh archive, which is checked against contracts/recall-archive-v1 with the generated codec.
 *
 * Along the way: the owner's two lists set through the owner API reach the extension in the upload's answer, and the
 * no-text one holds on the server for a text the extension sent before it knew it; hosts with an underscore or a
 * trailing dot are recorded (the archive's Site format carries them); each machine token opens its own route only; the
 * owner API answers the calls the UI makes (status, timeline, search with a snippet, page and text); a second pull
 * changes nothing; and a page deleted in the owner API leaves the archive with its lines and its blob.
 *
 * Run from worker/ after the UI's build (the dev server serves web/dist) and `npm ci` in ../extension. Python 3.12 or
 * newer runs the consumer (RECALL_SMOKE_PYTHON, default python3):
 *
 *   npm run test:smoke
 */
import { deepStrictEqual } from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { ArchiveStateSchema, ChangePageSchema, ChangeSchema } from '@ziyixi/proto/recall/archive/v1/archive_pb';
import type { IngestBatch } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { RecallUiService } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { fromWire } from '@ziyixi/proto/wire-json';

const WORKER = decodeURIComponent(new URL('../../', import.meta.url).pathname);
const RECALL = join(WORKER, '..');
// Synthetic machine tokens in mint-tokens.mjs's shape; the dev server gets their digests, as production does.
const INGEST_TOKEN = `recall_ingest_${'i'.repeat(43)}`;
const EXPORT_TOKEN = `recall_export_${'e'.repeat(43)}`;
const DEVICE_LABEL = 'MacBook · 冒烟';
const DENIED_SITE = 'notes.example.net';
const SITE_ONLY = 'bank.example.net';
const CONSUMER = 'nas';
const MINUTE = 60_000;

/** The parts of a feed answer and an archived line the checks read (the codec checks the rest). */
interface WireBlob {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}
interface WireChange {
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly page_id?: string;
  readonly blobs: readonly WireBlob[];
  readonly visit?: { readonly url: string; readonly url_truncated?: boolean; readonly title: string; readonly site: string; readonly device_label: string };
  readonly document?: { readonly visit: string; readonly device_label: string };
  readonly tombstone?: { readonly target: string };
}
interface WirePage {
  readonly feed_id: string;
  readonly changes: readonly WireChange[];
  readonly last_seq: number;
  readonly head_seq: number;
}

/** What ../../../extension/test/smoke-upload.ts prints. */
interface UploadReport {
  readonly outcomes: readonly { readonly kind: string; readonly items?: number; readonly status?: number | string }[];
  readonly sent: readonly IngestBatch[];
  readonly outbox: number;
  readonly upload: { readonly rejectedCount: number; readonly tokenRefused: boolean };
  readonly denylist: { readonly patterns: readonly string[]; readonly siteOnly: readonly string[]; readonly etag: string };
}

function check(condition: unknown, what: string): void {
  if (!condition) throw new Error(`smoke: ${what}`);
  console.log(`ok - ${what}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main(): Promise<void> {
  if (!existsSync(join(RECALL, 'web/dist/index.html'))) throw new Error('build the UI first: cd ../web && npm run build');
  if (!existsSync(join(RECALL, 'extension/node_modules'))) throw new Error('install the extension first: cd ../extension && npm ci');
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const persist = mkdtempSync(join(tmpdir(), 'recall-smoke-'));
  const archive = mkdtempSync(join(tmpdir(), 'recall-smoke-archive-'));
  const vars: Record<string, string> = {
    BUILD_SHA: 'dev',
    DEV_AUTH_BYPASS: 'true',
    ACCESS_OWNER: 'owner@example.com',
    CSRF_SIGNING_KEY: 'ab'.repeat(32),
    INGEST_TOKEN_SHA256: sha256(new TextEncoder().encode(INGEST_TOKEN)),
    EXPORT_TOKEN_SHA256: sha256(new TextEncoder().encode(EXPORT_TOKEN)),
  };
  const args = ['--no-install', 'wrangler', 'dev', '--config', '../wrangler.test.toml', '--ip', '127.0.0.1', '--port', String(port), '--local-upstream', `127.0.0.1:${String(port)}`, '--persist-to', persist, '--inspector-port', '0', '--show-interactive-dev-session=false'];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);
  // Its own process group: npx, wrangler and workerd stop together, or the survivors hold the pipes and this never exits.
  const dev: ChildProcess = spawn('npx', args, { cwd: WORKER, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  dev.stdout?.on('data', (chunk: Uint8Array) => {
    output += new TextDecoder().decode(chunk);
  });
  dev.stderr?.on('data', (chunk: Uint8Array) => {
    output += new TextDecoder().decode(chunk);
  });
  try {
    const started = Date.now();
    for (;;) {
      if (/Ready on/.test(output)) break;
      if (dev.exitCode !== null || Date.now() - started > 90_000) throw new Error(`wrangler dev did not start:\n${output.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await run(origin, archive);
    // Logs hold IDs, counts and codes only (design §2): never a URL, host, title, text or token.
    const logged = output.replace(/--var \S+/g, '');
    for (const secret of ['news.example.org', DENIED_SITE, 'my_team.example.com', 'guides.example.com', '中文分词', 'Durable Object storage', 'Private plan', INGEST_TOKEN, EXPORT_TOKEN]) {
      if (logged.includes(secret)) throw new Error('smoke: the dev server logged a URL, title, text or token');
    }
    check(true, 'the dev server log holds no URL, title, text or token');
  } finally {
    await stopGroup(dev);
    rmSync(persist, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
}

async function run(origin: string, archive: string): Promise<void> {
  let csrf: { token: string; cookie: string } | undefined;
  const send = async (call: HttpCall): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    if (call.httpMethod !== 'GET') {
      if (csrf === undefined) {
        const response = await fetch(`${origin}/api/csrf`);
        csrf = { token: (await response.json<{ token: string }>()).token, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
      }
      Object.assign(headers, { origin, 'x-csrf-token': csrf.token, cookie: csrf.cookie });
    }
    return fetch(`${origin}${call.url}`, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) });
  };
  // The owner API through the shared client the UI uses (web/src/api.ts), the dev server's loopback login standing in
  // for Access.
  const api = createHttpClient(RecallUiService, send);
  const machine = (path: string, token: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {}) =>
    fetch(`${origin}/api/machine/v1/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const feed = async (): Promise<WirePage> => {
    const response = await machine('changes?after=0&limit=500', EXPORT_TOKEN);
    check(response.status === 200, 'the feed answers the export token');
    const json = await response.json<WirePage>();
    fromWire(ChangePageSchema, json, { strict: true });
    return json;
  };

  const health = await fetch(`${origin}/health`);
  check(health.status === 200 && (await health.json<{ service: string }>()).service === 'recall', 'GET /health answers');
  check((await machine('changes', INGEST_TOKEN)).status === 401, 'the ingest token does not open the feed');
  check((await machine('batches', EXPORT_TOKEN, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: new Uint8Array() })).status === 401, 'the export token does not open the upload');
  check((await machine('other', EXPORT_TOKEN)).status === 404, 'any other machine path is 404');

  // The owner keeps a site's texts out and another site to its name (设置 → 网站名单), before the extension has heard.
  const settings = await api.getSettings({ name: 'settings' });
  const updated = await api.updateSettings({
    settings: { name: 'settings', denylistPatterns: [DENIED_SITE], siteOnlyPatterns: [SITE_ONLY], etag: settings.etag },
    updateMask: { paths: ['denylist_patterns', 'site_only_patterns', 'etag'] },
    requestId: crypto.randomUUID(),
  });
  check(updated.denylistPatterns.join() === DENIED_SITE && updated.siteOnlyPatterns.join() === SITE_ONLY && updated.etag !== settings.etag, "the owner API takes the owner's two lists with the etag");

  // The extension uploads its session, then sends the heartbeat.
  const report = await uploadAsTheExtension(origin);
  const batch = report.sent[0];
  if (batch === undefined) throw new Error('smoke: the extension sent nothing');
  check(report.outcomes[0]?.status === 200 && report.outcomes[0].items === 8, 'the extension uploaded its 8 items (6 visits, 2 texts): 200');
  check(report.outcomes[1]?.status === 200 && report.outcomes[1].items === 0, "the extension's heartbeat (an empty batch): 200");
  check(report.outbox === 0 && report.upload.rejectedCount === 0 && !report.upload.tokenRefused, "the extension's outbox is empty and nothing was refused");
  check(
    report.denylist.patterns.join() === DENIED_SITE && report.denylist.siteOnly.join() === SITE_ONLY && report.denylist.etag === updated.etag,
    "the upload's answer brought the owner's two lists and their etag to the extension",
  );
  const visits = batch.items.flatMap((item) => (item.kind === 'visit' ? [item.visit] : []));
  const documents = batch.items.flatMap((item) => (item.kind === 'document' ? [item.document] : []));
  const [article, denied, map, mail, team, dotted] = visits;
  const text = documents.find((document) => document.visit_id === article?.id);
  if (article === undefined || denied === undefined || map === undefined || mail === undefined || team === undefined || dotted === undefined || text === undefined) {
    throw new Error('smoke: the session is not what the extension should record');
  }

  // The change feed: each record as the extension sent it, after the server's own denylist.
  const first = await feed();
  const byId = new Map(first.changes.map((change) => [change.id, change]));
  check(
    visits.every((visit) => byId.get(`visits/${visit.id}`)?.page_id === visit.page_id && byId.get(`visits/${visit.id}`)?.visit?.device_label === DEVICE_LABEL),
    'every uploaded visit is in the feed with its page and the device label',
  );
  check(byId.get(`visits/${mail.id}`)?.visit?.url === 'https://mail.google.com/' && byId.get(`visits/${mail.id}`)?.visit?.title === '', 'the mail page is kept by its site alone');
  check(byId.get(`visits/${map.id}`)?.visit?.url_truncated === true && byId.get(`visits/${map.id}`)?.visit?.url.length === 8192, 'the long URL is cut to 8192 characters and flagged');
  check(byId.get(`visits/${team.id}`)?.visit?.site === 'my_team.example.com', 'a host with an underscore is recorded under its site');
  check(byId.get(`visits/${dotted.id}`)?.visit?.url === 'https://guides.example.com/alarms' && byId.get(`visits/${dotted.id}`)?.visit?.site === 'guides.example.com', 'a host written with a trailing dot is recorded without it');
  const documentChange = byId.get(`documents/${text.id}`);
  check(documentChange?.page_id === article.page_id && documentChange.document?.visit === `visits/${article.id}`, "the article's text is in the feed, joined to its visit");
  check(first.changes.filter((change) => change.kind === 'document').length === 1, "the denylisted site's text, uploaded before the extension knew the list, was dropped by the server");
  check(first.last_seq === first.head_seq && first.changes.length === 7, 'a short page: last_seq is head_seq');

  // The blob route: the stored bytes, their digest, the text the extension sent (already scrubbed).
  const blob = documentChange?.blobs[0];
  if (blob === undefined) throw new Error('smoke: the document change has no blob');
  const blobResponse = await machine(`blobs/${blob.path}`, EXPORT_TOKEN);
  const bytes = new Uint8Array(await blobResponse.arrayBuffer());
  check(blobResponse.status === 200 && bytes.length === blob.size_bytes && sha256(bytes) === blob.sha256, "the blob route answers the change's bytes");
  check(blobResponse.headers.get('content-digest') === `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`, 'the blob carries its RFC 9530 digest');
  check(new TextDecoder().decode(gunzipSync(bytes)) === text.text && text.text.includes('api_key=[redacted]'), 'the stored text is the scrubbed text the extension sent');

  // The owner API, as the UI calls it.
  const status = await api.getServiceStatus({ name: 'serviceStatus' });
  check(status.devices[0]?.deviceId === batch.device.device_id && status.devices[0].label === DEVICE_LABEL && status.headSeq === first.head_seq, 'GetServiceStatus shows the device and the feed head');
  const now = Date.now();
  const timeline = await api.listVisits({ parent: 'pages/-', startTime: timestampFromMs(now - 10 * MINUTE), endTime: timestampFromMs(now + MINUTE), orderBy: 'start_time', pageSize: 500 });
  check(timeline.visits.map((visit) => visit.name.split('/')[3]).join() === visits.map((visit) => visit.id).join(), "ListVisits (the timeline) gives the session's visits in order");
  const found = await api.searchPages({ query: '中文分词' });
  check(found.results[0]?.page === `pages/${article.page_id}` && found.results[0].hasText && found.results[0].snippet.some((segment) => segment.highlighted), 'SearchPages finds the article by a Chinese phrase, with a marked snippet');
  const page = await api.getPage({ name: `pages/${article.page_id}` });
  const latest = await api.getDocument({ name: page.latestDocument });
  check(latest.text === text.text, "GetDocument (the page detail) gives the article's text");

  // The reference consumer fills a fresh archive, which follows the contract; a second pull changes nothing.
  await pull(origin, archive);
  checkArchive(archive, origin, first);
  const before = snapshot(archive);
  await pull(origin, archive);
  deepStrictEqual(snapshot(archive), before);
  check(true, 'a second pull changes nothing in the archive');
  const synced = await api.getServiceStatus({ name: 'serviceStatus' });
  const consumer = synced.archiveConsumers.find((entry) => entry.consumer === CONSUMER);
  check(consumer?.syncedSeq === first.head_seq && consumer.behindCount === 0, "GetServiceStatus shows the archive caught up");

  // The owner deletes the article's page: its records leave the feed, a tombstone takes their place, and the next pull
  // removes the page's lines and its blob from the archive.
  await api.deletePage({ name: `pages/${article.page_id}`, requestId: crypto.randomUUID() });
  const second = await feed();
  check(
    second.changes.every((change) => change.page_id !== article.page_id) && second.changes.some((change) => change.tombstone?.target === `pages/${article.page_id}`),
    "after DeletePage the feed holds the page's tombstone instead of its records",
  );
  await pull(origin, archive);
  checkArchive(archive, origin, second);
  check(!existsSync(join(archive, 'blobs', blob.path)), "the deleted page's blob left the archive");
}

/**
 * A child process to its end, its output kept. Never a synchronous spawn: the dev server's output pipes must keep
 * draining meanwhile, or a full pipe would stall workerd mid-request.
 */
async function runChild(file: string, args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(file, args, { ...options, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    throw new Error(`smoke: ${file} ${args.join(' ')} failed:\n${stdout.slice(-2000)}${stderr.slice(-2000)}`, { cause: error });
  }
}

/** ../../../extension/test/smoke-upload.ts, run by Node against the dev server; its one JSON line. */
async function uploadAsTheExtension(origin: string): Promise<UploadReport> {
  const env = { ...process.env, RECALL_SMOKE_ORIGIN: origin, RECALL_SMOKE_INGEST_TOKEN: INGEST_TOKEN };
  const stdout = await runChild(process.execPath, ['test/smoke-upload.ts'], { cwd: join(RECALL, 'extension'), env });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as UploadReport;
}

/** One catch-up of the reference consumer (`--once`, exit 0) into `archive`. */
async function pull(origin: string, archive: string): Promise<void> {
  const env = { PATH: process.env['PATH'] ?? '', RECALL_BASE_URL: origin, RECALL_EXPORT_TOKEN: EXPORT_TOKEN, RECALL_ARCHIVE_DIR: archive, RECALL_CONSUMER: CONSUMER };
  await runChild(process.env['RECALL_SMOKE_PYTHON'] ?? 'python3', ['-I', join(RECALL, 'sync/recall_sync.py'), '--once'], { env });
  check(true, 'the reference consumer caught up (--once, exit 0)');
}

/** Every file under `dir`, by its path relative to `root`. */
function files(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(root, path) : [relative(root, path)];
  });
}

/** The archive's bytes by path, state.json without its update_time (a pull writes it every time). */
function snapshot(archive: string): Record<string, string> {
  return Object.fromEntries(
    files(archive).map((path) => {
      const bytes = readFileSync(join(archive, path));
      if (path !== 'state.json') return [path, sha256(bytes)];
      const state = Object.entries(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>).filter(([key]) => key !== 'update_time');
      return [path, JSON.stringify(state)];
    }),
  );
}

/**
 * The archive against contracts/recall-archive-v1 §3 after a pull caught up with `page` (the whole feed, read from 0):
 * VERSION; state.json (strictly an ArchiveState of this feed, its cursor at the head); day files named by their UTC
 * date, each line strictly a Change, in seq order, one line per record; the records are exactly the feed's (per id the
 * line with the highest seq, compared as parsed JSON); and the blobs are exactly the records' blobs, each with its size
 * and digest.
 */
function checkArchive(archive: string, origin: string, page: WirePage): void {
  const paths = files(archive);
  check(paths.every((path) => path === 'VERSION' || path === 'state.json' || /^changes\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\.jsonl$/.test(path) || path.startsWith('blobs/')), 'the archive holds only VERSION, state.json, changes/ and blobs/');
  check(readFileSync(join(archive, 'VERSION'), 'utf8') === 'recall-archive-v1\n', 'VERSION is recall-archive-v1');
  const state = JSON.parse(readFileSync(join(archive, 'state.json'), 'utf8')) as Record<string, unknown>;
  fromWire(ArchiveStateSchema, state, { strict: true });
  check(state['feed_id'] === page.feed_id && state['synced_seq'] === page.head_seq && state['source'] === origin && state['consumer'] === CONSUMER, "state.json follows the feed up to its head");

  const records = new Map<string, WireChange>();
  for (const path of paths.filter((name) => name.startsWith('changes/')).sort()) {
    const lines = readFileSync(join(archive, path), 'utf8').split('\n');
    check(lines.pop() === '' && lines.every((line) => line !== ''), `${path}: one line per change, LF-terminated`);
    const changes = lines.map((line) => JSON.parse(line) as WireChange);
    for (const change of changes) fromWire(ChangeSchema, change, { strict: true });
    check(changes.every((change, i) => i === 0 || (changes[i - 1]?.seq ?? 0) < change.seq), `${path}: sorted by seq`);
    check(new Set(changes.map((change) => change.id)).size === changes.length, `${path}: one line per record`);
    for (const change of changes) if ((records.get(change.id)?.seq ?? 0) < change.seq) records.set(change.id, change);
  }
  deepStrictEqual(
    [...records.values()].sort((a, b) => a.seq - b.seq),
    [...page.changes].sort((a, b) => a.seq - b.seq),
  );
  check(true, `the archive's ${String(records.size)} records are the feed's, line for line`);
  const blobs = [...records.values()].flatMap((change) => change.blobs);
  deepStrictEqual(paths.filter((path) => path.startsWith('blobs/')).sort(), blobs.map((blob) => `blobs/${blob.path}`).sort());
  for (const blob of blobs) {
    const bytes = readFileSync(join(archive, 'blobs', blob.path));
    if (bytes.length !== blob.size_bytes || sha256(bytes) !== blob.sha256) throw new Error(`smoke: blobs/${blob.path} differs from its change`);
  }
  check(true, `the archive's ${String(blobs.length)} blobs are the records' blobs, size and digest`);
}

/** Stops the whole process group: SIGINT for a clean wrangler shutdown, SIGKILL for whatever is left after 5 s. */
async function stopGroup(child: ChildProcess): Promise<void> {
  const group = child.pid;
  if (group === undefined) return;
  // Signal 0 only asks whether the group still exists.
  const send = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-group, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!send('SIGINT')) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && send(0)) await new Promise((resolve) => setTimeout(resolve, 100));
  send('SIGKILL');
}

main().then(
  () => {
    console.log('smoke: passed');
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
