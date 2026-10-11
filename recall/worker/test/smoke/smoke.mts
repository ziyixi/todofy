/**
 * recall's smoke run (../../../docs/design.md §10): the whole path on loopback, synthetic data only.
 *
 *   the owner API makes the machine tokens (设置 → 插件口令) → the extension's own code
 *   (../../../extension/test/smoke-upload.ts, under its fake chrome.*) uploads a short browsing session with the ingest
 *   token → the real `wrangler dev` (the pinned wrangler, ../../../wrangler.test.toml, local Durable Object and R2) →
 *   the change feed and the blob route, read with the export token → Dropbox connected through its OAuth flow (a
 *   loopback fake of Dropbox, ../runtime/fake-dropbox.ts, approving at once) → the archive's pass writes the
 *   contract's layout into the fake's app folder, checked against contracts/recall-archive-v1 with the generated codec.
 *
 * Along the way: the owner's two lists set through the owner API reach the extension in the upload's answer, and the
 * no-text one holds on the server for a text the extension sent before it knew it; hosts with an underscore or a
 * trailing dot are recorded (the archive's Site format carries them); each machine token opens its own route only; the
 * owner API answers the calls the UI makes (status, timeline, search with a snippet, page and text); a text read 400
 * days ago, past the retention window, leaves Cloudflare right after the pass that wrote it to Dropbox (the blob route's
 * 410, the page detail's archive path, the search by title only, the feed unchanged); and a page deleted in the owner
 * API adds its tombstone line to the archive while Dropbox keeps every file (the archive only grows).
 *
 * Run from worker/ after the UI's build (the dev server serves web/dist) and `npm ci` in ../extension:
 *
 *   npm run test:smoke
 */
import { deepStrictEqual } from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { ArchiveStateSchema, ChangePageSchema, ChangeSchema } from '@ziyixi/proto/recall/archive/v1/archive_pb';
import type { IngestBatch } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import { RecallUiService } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { fromWire } from '@ziyixi/proto/wire-json';
import { normalizeUrl, pageIdOf } from '../../../shared/url.ts';
import { FakeDropbox } from '../runtime/fake-dropbox.ts';

const WORKER = decodeURIComponent(new URL('../../', import.meta.url).pathname);
const RECALL = join(WORKER, '..');
const DEVICE_LABEL = 'MacBook · 冒烟';
const DENIED_SITE = 'notes.example.net';
const SITE_ONLY = 'bank.example.net';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A page read 400 days ago (an old device's late upload), past the default retention window of 365 days. */
const OLD_URL = 'https://archive.example.org/2025/notes';
const OLD_TITLE = '旧笔记 Retention';
const OLD_TEXT = '一年多以前读过的合成正文 quokka-retention。';
/** The endpoints recall may call at Dropbox; anything else (a delete, a move) must never be called. */
const DROPBOX_ALLOWED = new Set(['/oauth2/authorize', '/oauth2/token', '/2/users/get_current_account', '/2/auth/token/revoke', '/2/files/upload', '/2/files/download']);

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

/** The fake Dropbox on loopback (its three hosts on one origin): each request handed to FakeDropbox.handle. */
async function serveDropbox(dropbox: FakeDropbox): Promise<{ readonly server: Server; readonly origin: string }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Uint8Array[] = [];
    request.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    request.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
      const body = chunks.length === 0 ? null : new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
      const asked = new Request(`http://127.0.0.1${request.url ?? '/'}`, { method: request.method ?? 'GET', headers, ...(body === null || request.method === 'GET' ? {} : { body }) });
      void dropbox.handle(asked).then(async (answer) => {
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(new Uint8Array(await answer.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${String(port)}` };
}

async function main(): Promise<void> {
  if (!existsSync(join(RECALL, 'web/dist/index.html'))) throw new Error('build the UI first: cd ../web && npm run build');
  if (!existsSync(join(RECALL, 'extension/node_modules'))) throw new Error('install the extension first: cd ../extension && npm ci');
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const persist = mkdtempSync(join(tmpdir(), 'recall-smoke-'));
  const dropbox = new FakeDropbox();
  const fake = await serveDropbox(dropbox);
  // No machine token digest: the owner API makes the tokens. DEV_DROPBOX_ORIGIN puts the fake in Dropbox's place.
  const vars: Record<string, string> = {
    BUILD_SHA: 'dev',
    DEV_AUTH_BYPASS: 'true',
    ACCESS_OWNER: 'owner@example.com',
    CSRF_SIGNING_KEY: 'ab'.repeat(32),
    DEV_DROPBOX_ORIGIN: fake.origin,
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
    const secrets = await run(origin, dropbox);
    // Logs hold IDs, counts and codes only (design §2): never a URL, host, title, text or token.
    const logged = output.replace(/--var \S+/g, '');
    for (const secret of ['news.example.org', DENIED_SITE, 'my_team.example.com', 'guides.example.com', 'archive.example.org', '中文分词', 'Durable Object storage', 'Private plan', 'quokka', '旧笔记', 'synthetic-refresh', 'sl.synthetic', ...secrets]) {
      if (logged.includes(secret)) throw new Error('smoke: the dev server logged a URL, title, text or token');
    }
    check(true, 'the dev server log holds no URL, title, text or token');
  } finally {
    await stopGroup(dev);
    await new Promise((resolve) => fake.server.close(resolve));
    rmSync(persist, { recursive: true, force: true });
  }
}

/** The whole path; answers the tokens it made, which the dev server's log must not hold. */
async function run(origin: string, dropbox: FakeDropbox): Promise<string[]> {
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
  // 设置 → 插件口令: the owner makes the extension's token, and the feed's (optional) export token. (The Worker keeps
  // the digests a minute and looks again for a refused token after 10 s, so the first machine call comes after both.)
  const ingest = await api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId: crypto.randomUUID() });
  const exported = await api.regenerateMachineToken({ name: 'machineTokens/export', requestId: crypto.randomUUID() });
  const INGEST_TOKEN = ingest.token;
  const EXPORT_TOKEN = exported.token;
  check(/^recall_ingest_[A-Za-z0-9_-]{43}$/.test(INGEST_TOKEN) && /^recall_export_[A-Za-z0-9_-]{43}$/.test(EXPORT_TOKEN), 'the owner API makes both machine tokens and shows each once');
  const shown = await (await fetch(`${origin}/api/v1/serviceStatus`)).text();
  check(!shown.includes(INGEST_TOKEN) && !shown.includes(EXPORT_TOKEN), 'the status never shows a token again');
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
  const report = await uploadAsTheExtension(origin, INGEST_TOKEN);
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

  // An old device's late upload: a page read 400 days ago with its text (nothing is refused for its age), past the
  // retention window (365 days until the owner changes it). It waits for Dropbox: nothing leaves Cloudflare before.
  const old = normalizeUrl(OLD_URL);
  if (old === null) throw new Error('smoke: the old URL does not normalize');
  const oldPage = await pageIdOf(old.url);
  const sentMs = Date.now();
  const readMs = sentMs - 400 * DAY;
  const oldVisit = crypto.randomUUID();
  const oldDocument = crypto.randomUUID();
  const oldBatch = {
    version: 'recall-ingest-v1',
    batch_id: crypto.randomUUID(),
    sent_time: new Date(sentMs).toISOString(),
    device: { ...batch.device, queued_count: 0 },
    items: [
      { kind: 'visit', visit: { id: oldVisit, revision: 1, page_id: oldPage, url: old.url, title: OLD_TITLE, focus_spans: [{ start_time: new Date(readMs).toISOString(), end_time: new Date(readMs + MINUTE).toISOString() }] } },
      { kind: 'document', document: { id: oldDocument, visit_id: oldVisit, page_id: oldPage, url: old.url, title: OLD_TITLE, description: '', capture_time: new Date(readMs + 15_000).toISOString(), text: OLD_TEXT } },
    ],
  };
  const oldUpload = await machine('batches', INGEST_TOKEN, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: gzipSync(JSON.stringify(oldBatch)) });
  check(oldUpload.status === 200 && (await oldUpload.json<{ accepted_count: number }>()).accepted_count === 2, 'a late upload of a page read 400 days ago is accepted');
  const beforeArchive = await feed();
  const oldBlob = beforeArchive.changes.find((change) => change.id === `documents/${oldDocument}`)?.blobs[0];
  if (oldBlob === undefined) throw new Error('smoke: the old text is not in the feed');
  const paused = await api.getServiceStatus({ name: 'serviceStatus' });
  check(paused.textRetentionDays === 365 && paused.textRetentionPausedReason === 'dropbox_not_connected' && paused.archivedTextCount === 0, 'before Dropbox is connected, retention waits and says why');
  check((await machine(`blobs/${oldBlob.path}`, EXPORT_TOKEN)).status === 200, 'the old text is still in Cloudflare');

  // 设置 → 备份到 Dropbox: the App key, 连接, Dropbox's page (the fake approves at once), back to the callback.
  const { authorizeUrl } = await api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: crypto.randomUUID() });
  const approved = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(approved.headers.get('location') ?? '');
  check(back.origin === 'https://recall.localhost' && back.pathname === '/api/dropbox/callback', "Dropbox sends the browser back to recall's callback");
  const connected = await fetch(`${origin}${back.pathname}${back.search}`, { redirect: 'manual' });
  check(connected.status === 303 && connected.headers.get('location') === '/settings?dropbox=connected', 'the callback exchanges the code (PKCE, the App key alone) and returns to 设置');
  const caughtUp = async (seq: number) => {
    const started = Date.now();
    for (;;) {
      const state = dropbox.files.get('/state.json');
      if (state !== undefined && (JSON.parse(new TextDecoder().decode(state)) as { synced_seq: number }).synced_seq === seq) return;
      if (Date.now() - started > 30_000) throw new Error('smoke: the archive did not reach Dropbox within 30 s');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  await caughtUp(beforeArchive.head_seq);
  check(true, "the alarm's first pass wrote the archive to Dropbox");
  checkArchive(dropbox, beforeArchive, null);
  const synced = (await api.getServiceStatus({ name: 'serviceStatus' })).dropboxBackup;
  check(synced?.connected === true && synced.syncedSeq === beforeArchive.head_seq && synced.pendingCount === 0, 'GetServiceStatus shows Dropbox connected and caught up');

  // The retention step right after that pass: the old text, now confirmed in Dropbox, leaves Cloudflare. Not a deletion.
  const started = Date.now();
  for (;;) {
    const answer = await machine(`blobs/${oldBlob.path}`, EXPORT_TOKEN);
    await answer.arrayBuffer();
    if (answer.status === 410) break;
    if (Date.now() - started > 30_000) throw new Error('smoke: the old text did not leave Cloudflare within 30 s of the pass');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check(true, 'after the pass that wrote it to Dropbox, the text past the window left Cloudflare: the blob route answers 410');
  const archivedBytes = dropbox.files.get(`/blobs/${oldBlob.path}`);
  check(archivedBytes !== undefined && sha256(archivedBytes) === oldBlob.sha256 && new TextDecoder().decode(gunzipSync(archivedBytes)) === OLD_TEXT, 'Dropbox holds the old text, byte for byte');
  const archivedDetail = await api.getDocument({ name: `pages/${oldPage}/documents/${oldDocument}` });
  check(archivedDetail.textArchived && archivedDetail.text === '' && archivedDetail.archivePath === `blobs/${oldBlob.path}`, 'GetDocument says the text is in the Dropbox archive, and where');
  check((await api.getPage({ name: `pages/${oldPage}` })).visitCount === 1, 'the page and its visit stay');
  const byTitle = await api.searchPages({ query: '旧笔记' });
  check((await api.searchPages({ query: 'quokka-retention' })).results.length === 0 && byTitle.results.some((result) => result.page === `pages/${oldPage}`), 'the old text is no longer searched; its page is found by its title');
  deepStrictEqual(await feed(), beforeArchive);
  check(true, 'retention changed nothing in the feed: no tombstone, no new seq');
  const retained = await api.getServiceStatus({ name: 'serviceStatus' });
  check(retained.archivedTextCount === 1 && retained.documentCount === 2 && retained.textRetentionPausedReason === '', 'GetServiceStatus counts one text in Cloudflare and one only in Dropbox');

  // The owner deletes the article's page: its records leave the feed, a tombstone takes their place, and the next pass
  // adds the tombstone line; Dropbox keeps every file it had (the archive only grows).
  const kept = new Map(dropbox.files);
  await api.deletePage({ name: `pages/${article.page_id}`, requestId: crypto.randomUUID() });
  const second = await feed();
  check(
    second.changes.every((change) => change.page_id !== article.page_id) && second.changes.some((change) => change.tombstone?.target === `pages/${article.page_id}`),
    "after DeletePage the feed holds the page's tombstone instead of its records",
  );
  await caughtUp(second.head_seq);
  checkArchive(dropbox, second, blob.path);
  check([...kept.keys()].every((path) => dropbox.files.has(path)), 'Dropbox kept every file it had');
  check(dropbox.calls.every((call) => DROPBOX_ALLOWED.has(call.endpoint)), 'recall never called a Dropbox endpoint that deletes or moves');
  const uploadsOf = (prefix: string) => dropbox.callsTo('/2/files/upload').filter((call) => call.path?.startsWith(prefix));
  check(uploadsOf('/blobs/').every((call) => call.mode === 'add') && new Set(uploadsOf('/blobs/').map((call) => call.path)).size === uploadsOf('/blobs/').length, 'each blob was added once, never overwritten');
  return [INGEST_TOKEN, EXPORT_TOKEN, new URL(authorizeUrl).searchParams.get('state') ?? ''];
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
async function uploadAsTheExtension(origin: string, token: string): Promise<UploadReport> {
  const env = { ...process.env, RECALL_SMOKE_ORIGIN: origin, RECALL_SMOKE_INGEST_TOKEN: token };
  const stdout = await runChild(process.execPath, ['test/smoke-upload.ts'], { cwd: join(RECALL, 'extension'), env });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as UploadReport;
}

/**
 * The archive in the fake's app folder against contracts/recall-archive-v1 §3, once recall caught up with `page` (the
 * whole feed, read from 0): VERSION; state.json (strictly an ArchiveState of this feed, kept by `dropbox`, its cursor at
 * the head); day files named by their UTC date, each line strictly a Change, in seq order, one line per record; read
 * by the contract's rules (per id the line with the highest seq, a tombstone's targets gone), the records are exactly
 * the feed's, compared as parsed JSON; every record's blob is there with its size and digest, and `deletedBlob` (a
 * deleted page's) stays, since Dropbox is never deleted from.
 */
function checkArchive(dropbox: FakeDropbox, page: WirePage, deletedBlob: string | null): void {
  const text = (path: string) => new TextDecoder().decode(dropbox.files.get(path));
  const paths = [...dropbox.files.keys()].sort();
  check(paths.every((path) => path === '/VERSION' || path === '/state.json' || /^\/changes\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\.jsonl$/.test(path) || path.startsWith('/blobs/')), 'the app folder holds only VERSION, state.json, changes/ and blobs/');
  check(text('/VERSION') === 'recall-archive-v1\n', 'VERSION is recall-archive-v1');
  const state = JSON.parse(text('/state.json')) as Record<string, unknown>;
  fromWire(ArchiveStateSchema, state, { strict: true });
  check(state['feed_id'] === page.feed_id && state['synced_seq'] === page.head_seq && state['source'] === 'https://recall.localhost' && state['consumer'] === 'dropbox', 'state.json follows the feed up to its head');

  const lines = new Map<string, WireChange>();
  for (const path of paths.filter((name) => name.startsWith('/changes/'))) {
    const split = text(path).split('\n');
    check(split.pop() === '' && split.every((line) => line !== ''), `${path}: one line per change, LF-terminated`);
    const changes = split.map((line) => JSON.parse(line) as WireChange);
    for (const change of changes) fromWire(ChangeSchema, change, { strict: true });
    check(changes.every((change, i) => i === 0 || (changes[i - 1]?.seq ?? 0) < change.seq), `${path}: sorted by seq`);
    check(new Set(changes.map((change) => change.id)).size === changes.length, `${path}: one line per record`);
    for (const change of changes) if ((lines.get(change.id)?.seq ?? 0) < change.seq) lines.set(change.id, change);
  }
  const deleted = [...lines.values()].flatMap((change) => (change.tombstone === undefined ? [] : [{ target: change.tombstone.target, seq: change.seq }]));
  const records = [...lines.values()].filter((change) => !deleted.some((tombstone) => tombstone.seq > change.seq && (tombstone.target === change.id || tombstone.target === `pages/${change.page_id ?? ''}`)));
  deepStrictEqual(
    records.sort((a, b) => a.seq - b.seq),
    [...page.changes].sort((a, b) => a.seq - b.seq),
  );
  check(true, `read by the contract's rules, the archive's ${String(records.length)} records are the feed's`);
  const blobs = records.flatMap((change) => change.blobs);
  for (const blob of blobs) {
    const bytes = dropbox.files.get(`/blobs/${blob.path}`);
    if (bytes === undefined || bytes.length !== blob.size_bytes || sha256(bytes) !== blob.sha256) throw new Error(`smoke: blobs/${blob.path} differs from its change`);
  }
  deepStrictEqual(paths.filter((path) => path.startsWith('/blobs/')).sort(), [...blobs.map((blob) => `/blobs/${blob.path}`), ...(deletedBlob === null ? [] : [`/blobs/${deletedBlob}`])].sort());
  check(true, `the archive's ${String(blobs.length)} blobs are the records' blobs, size and digest${deletedBlob === null ? '' : ", and the deleted page's blob stays"}`);
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
