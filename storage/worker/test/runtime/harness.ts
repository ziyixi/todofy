import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ORIGIN = 'http://127.0.0.1';
export const HASH = (bytes: Uint8Array): string => {
  const hash = createHash('sha256');
  for (let at = 0; at < bytes.byteLength; at += 4 * 1024 * 1024) hash.update(createHash('sha256').update(bytes.subarray(at, at + 4 * 1024 * 1024)).digest());
  return hash.digest('hex');
};

interface File { readonly bytes: Uint8Array; readonly revision: string }
interface MachineInit { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string | Uint8Array }

export class FakeDropbox {
  readonly files = new Map<string, File>();
  readonly calls: { readonly path: string; readonly argument: unknown }[] = [];
  refreshes = 0;
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
    if (url.pathname === '/2/files/get_metadata') {
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

export async function harness(): Promise<{
  readonly provider: FakeDropbox;
  owner(path: string, method?: string, body?: unknown): Promise<Response>;
  machine(path: string, key: string | null, init?: MachineInit): Promise<Response>;
  connect(): Promise<void>;
  client(namespace: string, access?: 'read_only' | 'read_write'): Promise<{ readonly name: string; readonly api_key: string }>;
  dispose(): Promise<void>;
}> {
  const temporary = await mkdtemp(join(tmpdir(), 'storage-runtime-'));
  const provider = new FakeDropbox();
  const compiled = await build({
    ...(process.env.TEST_SRCDIR ? { nodePaths: [`${process.cwd()}/node_modules`] } : {}),
    entryPoints: [join(ROOT, 'src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2024',
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'import'], external: ['cloudflare:workers'], write: false, logLevel: 'silent',
  });
  const script = compiled.outputFiles[0]?.text;
  if (script === undefined) throw new Error('no synthetic Worker bundle');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: '2026-09-08', resourcePersistencePath: temporary, host: '127.0.0.1', port: 0,
    durableObjects: { STORAGE: { className: 'StorageState', useSQLite: true } },
    bindings: { PUBLIC_HOST: 'storage.example.test', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'a'.repeat(64), ACCESS_OWNER: 'owner@example.test', DEV_AUTH_BYPASS: 'true', BUILD_SHA: 'test' },
    outboundService: (request) => provider.fetch(request as unknown as Request),
  }));
  const owner = async (path: string, method = 'GET', body?: unknown): Promise<Response> => mf.dispatchFetch(ORIGIN + '/api/v1/' + path, {
    method, headers: { origin: ORIGIN, 'x-csrf-token': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Promise<Response>;
  return {
    provider, owner,
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
    async dispose() { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); },
  };
}
