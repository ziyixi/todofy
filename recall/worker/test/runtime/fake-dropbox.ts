/**
 * A fake of the part of Dropbox's API v2 recall uses (../../src/dropbox.ts), in Node: the authorization page (which
 * approves at once), the OAuth token endpoint (a code with PKCE, a refresh token), the current account, token
 * revocation, files/upload (modes add and overwrite, the content hash checked) and files/download, for one App-folder
 * app. It keeps the files by path and every call, so tests can compare the folder with the contract's archive, count
 * the calls of a pass, see that nothing was ever deleted, and make the next calls fail (429, 401, 503). The workerd
 * suite routes the Worker's outbound requests to `handle`; the smoke run serves it on loopback. Synthetic only.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface DropboxCall {
  readonly endpoint: string;
  /** The file's path for files/upload and files/download. */
  readonly path?: string;
  readonly mode?: string;
}

interface Code {
  readonly clientId: string;
  readonly challenge: string;
  readonly redirectUri: string;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
/** `bytes` random bytes in hex: codes, tokens and revisions, opaque to recall. */
const random = (bytes: number) => Array.from(randomBytes(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Dropbox's content hash (4 MiB blocks). */
export function dropboxHash(bytes: Uint8Array): string {
  const block = 4 * 1024 * 1024;
  const all = createHash('sha256');
  for (let at = 0; at < bytes.byteLength; at += block) all.update(fromHex(sha(bytes.subarray(at, at + block))));
  return all.digest('hex');
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeDropbox {
  readonly appKey: string;
  readonly accountId = 'dbid:AASyntheticAccount0000000000000000';
  displayName = '合成 Dropbox';
  /** The app folder: path (with its leading /) to bytes. */
  readonly files = new Map<string, Uint8Array>();
  readonly calls: DropboxCall[] = [];
  /** Answers for the next calls to an endpoint, first in first out (then the real answer again). */
  readonly failures: { endpoint: string; answer: () => Response }[] = [];
  private readonly codes = new Map<string, Code>();
  private readonly refreshTokens = new Set<string>();
  private readonly accessTokens = new Map<string, string>();

  constructor(appKey = 'syntheticappkey1') {
    this.appKey = appKey;
  }

  /** The calls to one endpoint (`/2/files/upload`). */
  callsTo(endpoint: string): DropboxCall[] {
    return this.calls.filter((call) => call.endpoint === endpoint);
  }

  /** Makes the next call to `endpoint` answer `answer` (once). */
  failNext(endpoint: string, answer: () => Response): void {
    this.failures.push({ endpoint, answer });
  }

  /** Every access token stops working (as when they expire). */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  /** The refresh tokens stop working (the owner removed the app at Dropbox). */
  revokeEverything(): void {
    this.refreshTokens.clear();
    this.accessTokens.clear();
  }

  /** The owner approves on the authorization page: the query the browser brings back to the redirect URI. */
  approve(authorizeUrl: string): { readonly redirectUri: string; readonly query: string } {
    const url = new URL(authorizeUrl);
    const params = url.searchParams;
    if (url.pathname !== '/oauth2/authorize') throw new Error('fake dropbox: not the authorization page');
    if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || params.get('token_access_type') !== 'offline') throw new Error('fake dropbox: not a PKCE offline request');
    if (params.get('client_id') !== this.appKey) throw new Error('fake dropbox: unknown app');
    const code = random(24);
    const redirectUri = params.get('redirect_uri') ?? '';
    this.codes.set(code, { clientId: params.get('client_id') ?? '', challenge: params.get('code_challenge') ?? '', redirectUri });
    return { redirectUri, query: `?code=${code}&state=${encodeURIComponent(params.get('state') ?? '')}` };
  }

  private issue(refresh: string): Record<string, unknown> {
    const access = `sl.synthetic-${random(12)}`;
    this.accessTokens.set(access, refresh);
    return { access_token: access, token_type: 'bearer', expires_in: 14400, scope: 'account_info.read files.content.write files.content.read' };
  }

  private bearer(request: Request): string | null {
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    return token !== undefined && this.accessTokens.has(token) ? token : null;
  }

  private async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    if (form.get('client_id') !== this.appKey) return json(400, { error: 'invalid_client' });
    if (form.has('client_secret')) return json(400, { error: 'invalid_request', error_description: 'no secret with PKCE' });
    if (form.get('grant_type') === 'authorization_code') {
      const code = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (code === undefined || code.challenge !== challenge || code.redirectUri !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant', error_description: 'code doesn\'t exist or has expired' });
      const refresh = `synthetic-refresh-${random(12)}`;
      this.refreshTokens.add(refresh);
      return json(200, { ...this.issue(refresh), refresh_token: refresh, account_id: this.accountId, uid: '12345' });
    }
    if (form.get('grant_type') === 'refresh_token') {
      const refresh = form.get('refresh_token') ?? '';
      if (!this.refreshTokens.has(refresh)) return json(400, { error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' });
      return json(200, this.issue(refresh));
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private async upload(request: Request): Promise<Response> {
    const arg = JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as { path?: string; mode?: string; content_hash?: string; autorename?: boolean; mute?: boolean };
    const bytes = new Uint8Array(await request.arrayBuffer());
    const path = arg.path ?? '';
    this.calls.push({ endpoint: '/2/files/upload', path, mode: arg.mode ?? 'add' });
    if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) return json(400, { error_summary: 'path/malformed_path/' });
    const hash = dropboxHash(bytes);
    if (arg.content_hash !== undefined && arg.content_hash !== hash) return json(400, { error_summary: 'content_hash_mismatch/' });
    const existing = this.files.get(path);
    if (arg.mode === 'add' && existing !== undefined && dropboxHash(existing) !== hash) return json(409, { error_summary: 'path/conflict/file/', error: { '.tag': 'path', reason: { '.tag': 'conflict' } } });
    this.files.set(path, bytes);
    return json(200, { name: path.split('/').pop(), path_display: path, path_lower: path.toLowerCase(), size: bytes.byteLength, content_hash: hash, rev: random(5) });
  }

  private download(request: Request): Response {
    const path = (JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as { path?: string }).path ?? '';
    this.calls.push({ endpoint: '/2/files/download', path });
    const bytes = this.files.get(path);
    if (bytes === undefined) return json(409, { error_summary: 'path/not_found/..', error: { '.tag': 'path', path: { '.tag': 'not_found' } } });
    return new Response(bytes, { status: 200, headers: { 'dropbox-api-result': JSON.stringify({ path_display: path, size: bytes.byteLength }) } });
  }

  /** One request to any of Dropbox's hosts. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = url.pathname;
    if (endpoint === '/oauth2/authorize') {
      // The smoke run's browser: approved at once, back to the redirect URI.
      this.calls.push({ endpoint });
      const { redirectUri, query } = this.approve(request.url);
      return new Response(null, { status: 302, headers: { location: `${redirectUri}${query}` } });
    }
    const failure = this.failures.findIndex((item) => item.endpoint === endpoint);
    if (failure !== -1) {
      const [item] = this.failures.splice(failure, 1);
      if (endpoint !== '/2/files/upload' && endpoint !== '/2/files/download') this.calls.push({ endpoint });
      else this.calls.push({ endpoint, path: (JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as { path?: string }).path ?? '' });
      return item?.answer() ?? json(500, {});
    }
    if (request.method !== 'POST') return json(405, {});
    if (endpoint === '/oauth2/token') {
      this.calls.push({ endpoint });
      return this.token(request);
    }
    if (endpoint === '/2/files/upload' || endpoint === '/2/files/download' || endpoint === '/2/users/get_current_account' || endpoint === '/2/auth/token/revoke') {
      const token = this.bearer(request);
      if (token === null) {
        this.calls.push({ endpoint });
        return json(401, { error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } });
      }
      if (endpoint === '/2/files/upload') return this.upload(request);
      if (endpoint === '/2/files/download') return this.download(request);
      this.calls.push({ endpoint });
      if (endpoint === '/2/auth/token/revoke') {
        const refresh = this.accessTokens.get(token) ?? '';
        this.refreshTokens.delete(refresh);
        for (const [access, owner] of this.accessTokens) if (owner === refresh) this.accessTokens.delete(access);
        return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return json(200, { account_id: this.accountId, name: { given_name: '合成', surname: 'Dropbox', display_name: this.displayName }, email: 'owner@example.com' });
    }
    // Anything else (a delete, a move) is a call recall must never make.
    this.calls.push({ endpoint });
    return json(400, { error_summary: 'unexpected_endpoint/' });
  }
}
