import { base64UrlEncode } from '@ziyixi/edge-auth';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { failure, readJson } from './errors.ts';
import { randomText } from './keys.ts';
import type { Connection, PendingConnection, Store } from './store.ts';

const DROPBOX = { authorize: 'https://www.dropbox.com', api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com' } as const;
const SCOPES = 'files.metadata.read files.content.read files.content.write';
const PROVIDER_TIMEOUT = 30_000;

export function endpoints(env: Pick<Env, 'DEV_AUTH_BYPASS' | 'DEV_DROPBOX_ORIGIN'>): { readonly authorize: string; readonly api: string; readonly content: string } {
  const origin = env.DEV_DROPBOX_ORIGIN ?? '';
  if (env.DEV_AUTH_BYPASS === 'true' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(origin)) {
    return { authorize: origin, api: origin, content: origin };
  }
  return DROPBOX;
}

export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

function retryAfter(response: Response, error: Record<string, unknown> | null): string {
  const header = response.headers.get('retry-after');
  if (header !== null && /^[0-9]{1,6}$/.test(header)) return header;
  const seconds = error?.retry_after;
  if (typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 999999) return String(seconds);
  return '1';
}

async function providerFailure(response: Response, upload = false): Promise<never> {
  let summary = '';
  let body: Record<string, unknown> = {};
  try {
    body = record(await readJson(response));
    summary = typeof body.error_summary === 'string' ? body.error_summary : '';
  } catch { /* A provider failure never exposes its response body. */ }
  const tagged = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const error = tagged(body.error);
  const path = error?.['.tag'] === 'path' ? tagged(error.path) : null;
  const reason = tagged(path?.reason) ?? path;
  const locked = error?.['.tag'] === 'too_many_write_operations' || reason?.['.tag'] === 'too_many_write_operations'
    || /^path\/(?:reason\/)?too_many_write_operations(?:\/|$)/.test(summary);
  if (response.status === 429 || (response.status === 409 && locked)) {
    throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Storage provider is temporarily unavailable.', { httpStatus: 429, headers: { 'retry-after': retryAfter(response, error) } });
  }
  if (response.status === 409 && /^path(?:_lookup)?\/not_found(?:\/|$)/.test(summary)) throw failure(Code.NOT_FOUND, 'NOT_FOUND');
  if (response.status === 409 && upload && (reason?.['.tag'] === 'conflict' || /^path\/(?:reason\/)?conflict(?:\/|$)/.test(summary))) throw failure(Code.ABORTED, 'REVISION_CONFLICT');
  if (response.status === 400 || error?.['.tag'] === 'content_hash_mismatch') throw failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST');
  if (response.status === 401 || response.status === 403) throw failure(Code.FAILED_PRECONDITION, 'CONNECTION_INVALID');
  throw failure(Code.UNAVAILABLE, 'UNAVAILABLE');
}

export interface Download {
  readonly response: Response;
  readonly metadata: Record<string, unknown>;
}

/** The native API transport and its one in-memory, generation-bound access token. */
export class Dropbox {
  private readonly store: Pick<Store, 'get' | 'set' | 'delete' | 'connection'>;
  private readonly origins: ReturnType<typeof endpoints>;
  private access: { readonly token: string; readonly expires: number; readonly generation: string } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(store: Pick<Store, 'get' | 'set' | 'delete' | 'connection'>, env: Pick<Env, 'DEV_AUTH_BYPASS' | 'DEV_DROPBOX_ORIGIN'>) { this.store = store; this.origins = endpoints(env); }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, PROVIDER_TIMEOUT);
    try {
      return await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    } catch {
      throw failure(Code.UNAVAILABLE, 'UNAVAILABLE');
    } finally { clearTimeout(timeout); }
  }

  private async oauth(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetch(this.origins.api + '/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
    });
    if (!response.ok) {
      if (response.status === 429) return providerFailure(response);
      await response.body?.cancel();
      throw failure(response.status >= 500 || response.status === 429 ? Code.UNAVAILABLE : Code.FAILED_PRECONDITION,
        response.status >= 500 || response.status === 429 ? 'UNAVAILABLE' : 'CONNECTION_INVALID');
    }
    return record(await readJson(response));
  }

  async connect(appKey: string, redirectUri: string): Promise<string> {
    if (!/^[a-z0-9]{8,32}$/.test(appKey)) throw failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST');
    if (this.store.connection() !== null) throw failure(Code.ALREADY_EXISTS, 'CONNECTION_INVALID');
    const pending: PendingConnection = { appKey, redirectUri, state: randomText(), verifier: randomText(48), expires: Date.now() + 15 * 60_000 };
    const challenge = base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier))));
    this.store.set('pending', pending);
    this.store.set('app_key', appKey);
    return this.origins.authorize + '/oauth2/authorize?' + new URLSearchParams({
      client_id: appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
      token_access_type: 'offline', redirect_uri: redirectUri, state: pending.state, scope: SCOPES,
    }).toString();
  }

  async callback(search: URLSearchParams): Promise<void> {
    const pending = this.store.get('pending') as PendingConnection | null;
    const code = search.get('code');
    if (pending === null || pending.exchanging === true || pending.expires <= Date.now() || search.get('state') !== pending.state || code === null || code.length > 2048) {
      throw failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST');
    }
    // Consume before the exchange: a callback cannot replay or race a second connection.
    this.store.set('pending', { ...pending, exchanging: true });
    const response = await this.oauth({ grant_type: 'authorization_code', client_id: pending.appKey, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
    if (typeof response.refresh_token !== 'string' || response.refresh_token.length < 8 || response.refresh_token.length > 4096) {
      throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
    }
    const current = this.store.get('pending') as PendingConnection | null;
    if (current?.state !== pending.state || current.exchanging !== true) throw failure(Code.ABORTED, 'REVISION_CONFLICT');
    this.store.delete('pending');
    const connection: Connection = { appKey: pending.appKey, refreshToken: response.refresh_token, generation: crypto.randomUUID() };
    this.store.set('connection', connection);
    this.access = null;
  }

  async token(): Promise<string> {
    const connection = this.store.connection();
    if (connection === null) throw failure(Code.FAILED_PRECONDITION, 'NOT_CONFIGURED');
    if (this.access?.generation === connection.generation && this.access.expires > Date.now() + 30_000) return this.access.token;
    if (this.refreshing !== null) return this.refreshing;
    const refresh = async (): Promise<string> => {
      const response = await this.oauth({ grant_type: 'refresh_token', client_id: connection.appKey, refresh_token: connection.refreshToken });
      if (typeof response.access_token !== 'string' || response.access_token.length < 8 || response.access_token.length > 16384
        || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in) || response.expires_in <= 0) {
        throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
      }
      if (this.store.connection()?.generation !== connection.generation) throw failure(Code.FAILED_PRECONDITION, 'NOT_CONFIGURED');
      if (typeof response.refresh_token === 'string' && response.refresh_token.length >= 8 && response.refresh_token.length <= 4096) {
        this.store.set('connection', { ...connection, refreshToken: response.refresh_token });
      }
      this.access = { token: response.access_token, expires: Date.now() + response.expires_in * 1000, generation: connection.generation };
      return response.access_token;
    };
    this.refreshing = refresh();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }

  async disconnect(): Promise<void> {
    const connection = this.store.connection();
    this.store.delete('pending');
    if (connection === null) return;
    const token = await this.token();
    const response = await this.fetch(this.origins.api + '/2/auth/token/revoke', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: 'null',
    });
    if (!response.ok) await providerFailure(response);
    await response.body?.cancel();
    if (this.store.connection()?.generation === connection.generation) this.store.delete('connection');
    this.access = null;
  }

  async json(method: 'files/get_metadata' | 'files/list_folder' | 'files/list_folder/continue', args: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetch(this.origins.api + '/2/' + method, {
      method: 'POST', headers: { authorization: 'Bearer ' + await this.token(), 'content-type': 'application/json' }, body: JSON.stringify(args),
    });
    if (!response.ok) return providerFailure(response);
    return record(await readJson(response, 512 * 1024));
  }

  async download(path: string, range: string | null): Promise<Download> {
    const headers = new Headers({ authorization: 'Bearer ' + await this.token(), 'dropbox-api-arg': apiArg({ path }) });
    if (range !== null) headers.set('range', range);
    const response = await this.fetch(this.origins.content + '/2/files/download', { method: 'GET', headers });
    if (response.status === 416) return { response, metadata: {} };
    if (!response.ok) return providerFailure(response);
    let metadata: Record<string, unknown>;
    try {
      const value = response.headers.get('dropbox-api-result');
      if (value === null || value.length > 8192) throw new Error();
      metadata = record(JSON.parse(value));
    } catch {
      await response.body?.cancel();
      throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
    }
    return { response, metadata };
  }

  async upload(args: unknown, body: ReadableStream): Promise<Record<string, unknown>> {
    const response = await this.fetch(this.origins.content + '/2/files/upload', {
      method: 'POST', headers: {
        authorization: 'Bearer ' + await this.token(), 'content-type': 'application/octet-stream', 'dropbox-api-arg': apiArg(args),
      }, body,
    });
    if (!response.ok) return providerFailure(response, true);
    return record(await readJson(response));
  }
}
