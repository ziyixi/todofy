import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = process.env.TEST_SRCDIR ? process.cwd() : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ORIGIN = 'http://127.0.0.1';
export const HASH = (bytes: Uint8Array): string => {
  const hash = createHash('sha256');
  for (let at = 0; at < bytes.byteLength; at += 4 * 1024 * 1024) hash.update(createHash('sha256').update(bytes.subarray(at, at + 4 * 1024 * 1024)).digest());
  return hash.digest('hex');
};

interface File { readonly bytes: Uint8Array; readonly revision: string }
interface MachineInit { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string | Uint8Array }
interface ProviderPage { readonly entries: readonly Record<string, unknown>[]; readonly has_more: boolean; readonly cursor: string }
interface Session { readonly bytes: Uint8Array; readonly closed: boolean }
interface AppendEntry { readonly cursor: { readonly session_id: string; readonly offset: number }; readonly length: number; readonly close: boolean }
interface FinishEntry { readonly cursor: { readonly session_id: string; readonly offset: number }; readonly commit: { readonly path: string; readonly mode: { readonly '.tag': string }; readonly autorename: boolean; readonly strict_conflict: boolean; readonly mute: boolean } }

export class FakeDropbox {
  readonly files = new Map<string, File>();
  readonly folders = new Set<string>();
  readonly calls: { readonly path: string; readonly argument: unknown }[] = [];
  refreshes = 0;
  listPages: readonly ProviderPage[] | null = null;
  batchFault: 'start_rate' | 'append_rate' | 'append_partial' | 'finish_rate' | 'finish_partial' | 'finish_unknown' | 'finish_metadata' | null = null;
  private readonly sessions = new Map<string, Session>();
  private sessionSequence = 0;
  private revision = 0;

  metadata(path: string, file: File): Record<string, unknown> {
    return { name: path.split('/').pop(), path_display: path, rev: file.revision, size: file.bytes.byteLength, content_hash: HASH(file.bytes) };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!['api.dropboxapi.com', 'content.dropboxapi.com'].includes(url.hostname)) throw new Error('unexpected external host in synthetic test');
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(await request.text());
      if (form.has('client_secret')) throw new Error('PKCE must not use an app secret');
      if (form.get('grant_type') === 'authorization_code') return Response.json({ refresh_token: 'synthetic-private-refresh', access_token: 'synthetic-private-access', expires_in: 3600 });
      this.refreshes++;
      if (form.get('refresh_token') !== 'synthetic-private-refresh') throw new Error('wrong synthetic refresh token');
      return Response.json({ access_token: 'synthetic-private-access', expires_in: 3600 });
    }
    if (request.headers.get('authorization') !== 'Bearer synthetic-private-access') return new Response(null, { status: 401 });
    if (url.pathname === '/2/auth/token/revoke') return new Response('null');
    if (url.pathname === '/2/files/upload_session/start_batch') {
      const argument = await request.json<{ num_sessions: number }>();
      this.calls.push({ path: url.pathname, argument });
      if (this.batchFault === 'start_rate') return Response.json({}, { status: 429, headers: { 'retry-after': '3' } });
      const session_ids = Array.from({ length: argument.num_sessions }, () => 'synthetic-session-' + String(++this.sessionSequence));
      for (const id of session_ids) this.sessions.set(id, { bytes: new Uint8Array(), closed: false });
      return Response.json({ session_ids });
    }
    if (url.pathname === '/2/files/upload_session/append_batch') {
      const argument = JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as { entries: AppendEntry[]; content_hash: string };
      this.calls.push({ path: url.pathname, argument });
      if (this.batchFault === 'append_rate') return Response.json({}, { status: 429, headers: { 'retry-after': '3' } });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (HASH(bytes) !== argument.content_hash || argument.entries.reduce((total, entry) => total + entry.length, 0) !== bytes.byteLength) return Response.json({}, { status: 400 });
      let offset = 0;
      const entries = argument.entries.map((entry, index) => {
        const content = bytes.slice(offset, offset + entry.length);
        offset += entry.length;
        if (entry.cursor.offset !== 0 || !entry.close || !this.sessions.has(entry.cursor.session_id)) throw new Error('invalid synthetic session append');
        if (this.batchFault === 'append_partial' && index === 1) return { '.tag': 'failure', failure: { '.tag': 'incorrect_offset', correct_offset: 1 } };
        this.sessions.set(entry.cursor.session_id, { bytes: content, closed: true });
        return { '.tag': 'success' };
      });
      return Response.json({ entries });
    }
    if (url.pathname === '/2/files/upload_session/finish_batch_v2') {
      const argument = await request.json<{ entries: FinishEntry[] }>();
      this.calls.push({ path: url.pathname, argument });
      if (this.batchFault === 'finish_rate') return Response.json({}, { status: 429, headers: { 'retry-after': '3' } });
      const entries = argument.entries.map((entry, index) => {
        if (entry.commit.mode['.tag'] !== 'add' || entry.commit.autorename || !entry.commit.strict_conflict || !entry.commit.mute) throw new Error('batch lost create-only commit');
        if (this.batchFault === 'finish_partial' && index === 1) return { '.tag': 'failure', failure: { '.tag': 'path', path: { '.tag': 'insufficient_space' } } };
        if (this.files.has(entry.commit.path) || this.folders.has(entry.commit.path)) return { '.tag': 'failure', failure: { '.tag': 'path', path: { '.tag': 'conflict', conflict: { '.tag': this.files.has(entry.commit.path) ? 'file' : 'folder' } } } };
        const session = this.sessions.get(entry.cursor.session_id);
        if (!session?.closed || session.bytes.byteLength !== entry.cursor.offset) throw new Error('invalid synthetic finish cursor');
        const file = { bytes: session.bytes, revision: 'rev' + String(++this.revision) };
        this.files.set(entry.commit.path, file);
        return { ...this.metadata(entry.commit.path, file), '.tag': 'success', ...(this.batchFault === 'finish_metadata' && index === 1 ? { content_hash: 'f'.repeat(64) } : {}) };
      });
      if (this.batchFault === 'finish_unknown') throw new Error('synthetic unknown commit outcome');
      return Response.json({ entries });
    }
    if (url.pathname === '/2/files/upload') {
      const argument = JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as { path: string; mode: { '.tag': string; update?: string }; strict_conflict: boolean; autorename: boolean; content_hash?: string };
      this.calls.push({ path: url.pathname, argument });
      const existing = this.files.get(argument.path);
      if (!argument.strict_conflict || argument.autorename) throw new Error('upload lost strict CAS');
      if ((argument.mode['.tag'] === 'add' && existing !== undefined) || (argument.mode['.tag'] === 'update' && existing?.revision !== argument.mode.update)) {
        await request.body?.cancel();
        return Response.json({ error_summary: 'path/conflict/file/' }, { status: 409 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (argument.content_hash !== undefined && HASH(bytes) !== argument.content_hash) return new Response(null, { status: 400 });
      const file = { bytes, revision: 'rev' + String(++this.revision) };
      this.files.set(argument.path, file);
      return Response.json(this.metadata(argument.path, file));
    }
    if (url.pathname === '/2/files/download') {
      const argument = JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as { path: string };
      this.calls.push({ path: url.pathname, argument });
      const file = this.files.get(argument.path);
      if (file === undefined) return Response.json({ error_summary: 'path/not_found/' }, { status: 409 });
      const headers = new Headers({ 'dropbox-api-result': JSON.stringify(this.metadata(argument.path, file)), 'accept-ranges': 'bytes' });
      const range = request.headers.get('range');
      if (range !== null) {
        const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(range);
        if (match !== null) {
          const start = Number(match[1]);
          const end = Math.min(match[2] === '' ? file.bytes.byteLength - 1 : Number(match[2]), file.bytes.byteLength - 1);
          if (start >= file.bytes.byteLength || start > end) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + String(file.bytes.byteLength) } });
          headers.set('content-range', `bytes ${String(start)}-${String(end)}/${String(file.bytes.byteLength)}`);
          headers.set('content-length', String(end - start + 1));
          return new Response(file.bytes.slice(start, end + 1), { status: 206, headers });
        }
      }
      headers.set('content-length', String(file.bytes.byteLength));
      return new Response(file.bytes.slice(), { headers });
    }
    const argument = await request.json<{ path?: string; cursor?: string; limit?: number }>();
    this.calls.push({ path: url.pathname, argument });
    if (this.listPages !== null && (url.pathname === '/2/files/list_folder' || url.pathname === '/2/files/list_folder/continue')) {
      const index = url.pathname === '/2/files/list_folder' ? 0 : this.listPages.findIndex((page) => page.cursor === argument.cursor) + 1;
      const page = url.pathname.endsWith('/continue') && index === 0 ? undefined : this.listPages[index];
      return page === undefined ? Response.json({ error_summary: 'path/not_found/' }, { status: 409 }) : Response.json(page);
    }
    if (url.pathname === '/2/files/get_metadata') {
      if (this.folders.has(argument.path ?? '')) return Response.json({ '.tag': 'folder', path_display: argument.path, name: 'synthetic-folder' });
      const file = this.files.get(argument.path ?? '');
      return file === undefined ? Response.json({ error_summary: 'path/not_found/' }, { status: 409 }) : Response.json({ '.tag': 'file', ...this.metadata(argument.path ?? '', file) });
    }
    if (url.pathname === '/2/files/list_folder') {
      const entries = [...this.files].filter(([path]) => path.startsWith((argument.path ?? '') + '/'))
        .slice(0, argument.limit ?? 100).map(([path, file]) => ({ '.tag': 'file', ...this.metadata(path, file) }));
      return Response.json({ entries, has_more: false, cursor: 'synthetic-provider-cursor' });
    }
    throw new Error('unexpected synthetic Dropbox method');
  }
}

export async function harness(inspect = false): Promise<{
  readonly provider: FakeDropbox;
  readonly runtime: Miniflare;
  owner(path: string, method?: string, body?: unknown): Promise<Response>;
  machine(path: string, key: string | null, init?: MachineInit): Promise<Response>;
  connect(): Promise<void>;
  client(namespace: string, access?: 'read_only' | 'read_write'): Promise<{ readonly name: string; readonly api_key: string }>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}> {
  const temporary = await mkdtemp(join(tmpdir(), 'storage-runtime-'));
  const provider = new FakeDropbox();
  const compiled = await build({
    ...(process.env.TEST_SRCDIR ? { nodePaths: [`${process.cwd()}/node_modules`], preserveSymlinks: true } : {}),
    entryPoints: [join(ROOT, 'src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2024',
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'import'], external: ['cloudflare:workers'], write: false, logLevel: 'silent',
  });
  const script = compiled.outputFiles[0]?.text;
  if (script === undefined) throw new Error('no synthetic Worker bundle');
  const start = (): Miniflare => new Miniflare(convertV4MiniflareOptions({
    ...(inspect ? { name: 'storage', inspectorPort: 0 } : {}),
    modules: true, script, compatibilityDate: '2026-09-08', resourcePersistencePath: temporary, host: '127.0.0.1', port: 0,
    durableObjects: { STORAGE: { className: 'StorageState', useSQLite: true } },
    bindings: { PUBLIC_HOST: 'storage.example.test', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'a'.repeat(64), ACCESS_OWNER: 'owner@example.test', DEV_AUTH_BYPASS: 'true', BUILD_SHA: 'test' },
    outboundService: (request) => provider.fetch(request as unknown as Request),
  }));
  let mf = start();
  const owner = async (path: string, method = 'GET', body?: unknown): Promise<Response> => mf.dispatchFetch(ORIGIN + '/api/v1/' + path, {
    method, headers: { origin: ORIGIN, 'x-csrf-token': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Promise<Response>;
  return {
    provider, owner,
    get runtime() { return mf; },
    async machine(path, key, init = {}) {
      const headers = new Headers(init.headers);
      if (key !== null) headers.set('authorization', 'Bearer ' + key);
      const body = typeof init.body === 'string' ? init.body : init.body === undefined ? undefined : new Uint8Array(init.body).buffer;
      return mf.dispatchFetch(ORIGIN + '/api/storage/v1/' + path, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(body === undefined ? {} : { body }), headers: Object.fromEntries(headers.entries()),
      }) as unknown as Promise<Response>;
    },
    async connect() {
      const response = await owner('dropbox:connect', 'POST', { app_key: 'syntheticappkey' });
      if (!response.ok) throw new Error('synthetic owner connect failed: ' + await response.text());
      const value = await response.json<{ authorize_url: string }>();
      const state = new URL(value.authorize_url).searchParams.get('state') ?? '';
      const callback = await mf.dispatchFetch(ORIGIN + '/api/dropbox/callback?state=' + state + '&code=synthetic-code', { redirect: 'manual' });
      if (callback.status !== 303) throw new Error('synthetic callback failed: ' + await callback.text());
    },
    async client(namespace, access = 'read_write') {
      const response = await owner('clients?request_id=' + crypto.randomUUID(), 'POST', { label: 'Synthetic ' + namespace, namespace, access });
      if (!response.ok) throw new Error('synthetic key create failed: ' + await response.text());
      return await response.json<{ name: string; api_key: string }>();
    },
    async restart() { await mf.dispose(); mf = start(); },
    async dispose() { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); },
  };
}
