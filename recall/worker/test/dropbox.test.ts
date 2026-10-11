// The Dropbox client (src/dropbox.ts) in Node: PKCE (RFC 7636's own example), the authorization URL, Dropbox's content
// hash, the ASCII-only Dropbox-API-Arg, which endpoints the smoke run's fake may stand in for, every failure's code
// and Retry-After, and that an upload sends the content hash and checks Dropbox's answer.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiArg, authorizeUrl, contentHash, DROPBOX, dropboxEndpoints, DropboxError, exchangeCode, pkceChallenge, refreshAccess, uploadFile, type Fetcher } from '../src/dropbox.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

async function failure(answer: Response): Promise<DropboxError> {
  const fetcher: Fetcher = () => Promise.resolve(answer);
  try {
    await refreshAccess(fetcher, DROPBOX, { appKey: 'syntheticappkey1', refreshToken: 'synthetic' });
  } catch (error) {
    if (error instanceof DropboxError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('OAuth with PKCE', () => {
  it("derives the S256 challenge of RFC 7636's example verifier", async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('asks for a code, S256 and an offline token, with the redirect URI and the state', () => {
    const url = new URL(authorizeUrl(DROPBOX, { appKey: 'syntheticappkey1', challenge: 'challenge', redirectUri: 'https://recall.example.com/api/dropbox/callback', state: 'state' }));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'syntheticappkey1',
      response_type: 'code',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      redirect_uri: 'https://recall.example.com/api/dropbox/callback',
      state: 'state',
    });
  });

  it('exchanges a code with the verifier and the App key alone (no secret), and keeps the refresh token', async () => {
    let sent: URLSearchParams | undefined;
    const fetcher: Fetcher = (url, init) => {
      expect(url).toBe('https://api.dropboxapi.com/oauth2/token');
      sent = new URLSearchParams(init.body as string);
      return Promise.resolve(json(200, { access_token: 'sl.synthetic', expires_in: 14400, token_type: 'bearer', refresh_token: 'synthetic-refresh', account_id: 'dbid:synthetic' }));
    };
    const answer = await exchangeCode(fetcher, DROPBOX, { appKey: 'syntheticappkey1', code: 'code', verifier: 'verifier', redirectUri: 'https://recall.example.com/api/dropbox/callback' });
    expect(answer).toEqual({ refreshToken: 'synthetic-refresh', accountId: 'dbid:synthetic', access: { token: 'sl.synthetic', expiresInMs: 14_400_000 } });
    expect(Object.fromEntries(sent ?? [])).toEqual({ grant_type: 'authorization_code', code: 'code', client_id: 'syntheticappkey1', code_verifier: 'verifier', redirect_uri: 'https://recall.example.com/api/dropbox/callback' });
  });
});

describe('files', () => {
  it("computes Dropbox's content hash over 4 MiB blocks", async () => {
    const block = 4 * 1024 * 1024;
    const bytes = new Uint8Array(block + 10).map((_, index) => index % 251);
    const expected = createHash('sha256')
      .update(fromHex(sha(bytes.subarray(0, block)) + sha(bytes.subarray(block))))
      .digest('hex');
    expect(await contentHash(bytes)).toBe(expected);
    expect(await contentHash(new Uint8Array())).toBe(sha(new Uint8Array()));
  });

  it('writes Dropbox-API-Arg in ASCII only', () => {
    expect(apiArg({ path: '/changes/2026/10/10.jsonl', note: '中文' })).toBe('{"path":"/changes/2026/10/10.jsonl","note":"\\u4e2d\\u6587"}');
  });

  it("uploads with the content hash and refuses an answer of another hash", async () => {
    const bytes = new TextEncoder().encode('recall-archive-v1\n');
    const hash = await contentHash(bytes);
    let arg: unknown;
    const answering = (answerHash: string): Fetcher => (url, init) => {
      expect(url).toBe('https://content.dropboxapi.com/2/files/upload');
      arg = JSON.parse((init.headers as Record<string, string>)['dropbox-api-arg'] ?? '');
      return Promise.resolve(json(200, { content_hash: answerHash }));
    };
    await uploadFile(answering(hash), DROPBOX, 'sl.synthetic', { path: '/VERSION', bytes, mode: 'overwrite', contentHash: hash });
    expect(arg).toEqual({ path: '/VERSION', mode: 'overwrite', autorename: false, mute: true, strict_conflict: false, content_hash: hash });
    await expect(uploadFile(answering('0'.repeat(64)), DROPBOX, 'sl.synthetic', { path: '/VERSION', bytes, mode: 'overwrite', contentHash: hash })).rejects.toMatchObject({ code: 'dropbox_bad_response' });
  });

  it('stands in a loopback fake for Dropbox only with the loopback login bypass', () => {
    expect(dropboxEndpoints({})).toBe(DROPBOX);
    expect(dropboxEndpoints({ DEV_DROPBOX_ORIGIN: 'http://127.0.0.1:9000' })).toBe(DROPBOX);
    expect(dropboxEndpoints({ DEV_DROPBOX_ORIGIN: 'https://evil.example.com', DEV_AUTH_BYPASS: 'true' })).toBe(DROPBOX);
    expect(dropboxEndpoints({ DEV_DROPBOX_ORIGIN: 'http://127.0.0.1:9000', DEV_AUTH_BYPASS: 'true' })).toEqual({ authorize: 'http://127.0.0.1:9000', api: 'http://127.0.0.1:9000', content: 'http://127.0.0.1:9000' });
  });
});

describe('failures', () => {
  it('names each failure and keeps Retry-After', async () => {
    expect(await failure(json(429, { error_summary: 'too_many_requests/' }, { 'retry-after': '120' }))).toMatchObject({ code: 'dropbox_rate_limited', retryAfterMs: 120_000 });
    expect(await failure(json(429, { error_summary: 'too_many_write_operations/', error: { reason: { '.tag': 'too_many_write_operations' }, retry_after: 2 } }))).toMatchObject({
      code: 'dropbox_rate_limited',
      retryAfterMs: 2000,
    });
    expect(await failure(json(409, { error_summary: 'path/too_many_write_operations/' }))).toMatchObject({ code: 'dropbox_rate_limited' });
    expect(await failure(json(400, { error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' }))).toMatchObject({ code: 'dropbox_refused' });
    expect(await failure(json(401, { error_summary: 'expired_access_token/' }))).toMatchObject({ code: 'dropbox_token' });
    expect(await failure(json(403, { error_summary: 'no_permission/' }))).toMatchObject({ code: 'dropbox_permission' });
    expect(await failure(json(401, { error_summary: 'missing_scope/.', error: { '.tag': 'missing_scope', required_scope: 'files.content.read' } }))).toMatchObject({ code: 'dropbox_permission' });
    expect(await failure(json(409, { error_summary: 'path/insufficient_space/' }))).toMatchObject({ code: 'dropbox_full' });
    expect(await failure(json(409, { error_summary: 'path/conflict/file/' }))).toMatchObject({ code: 'dropbox_conflict' });
    expect(await failure(json(409, { error_summary: 'path/not_found/' }))).toMatchObject({ code: 'not_found' });
    expect(await failure(json(503, {}))).toMatchObject({ code: 'dropbox_unavailable', retryAfterMs: null });
    expect(await failure(new Response('<html>', { status: 400 }))).toMatchObject({ code: 'dropbox_bad_request' });
    expect(await failure(json(200, { token_type: 'bearer' }))).toMatchObject({ code: 'dropbox_bad_response' });
  });

  it('turns a network failure into dropbox_unavailable', async () => {
    const fetcher: Fetcher = () => Promise.reject(new TypeError('fetch failed'));
    await expect(refreshAccess(fetcher, DROPBOX, { appKey: 'syntheticappkey1', refreshToken: 'synthetic' })).rejects.toMatchObject({ code: 'dropbox_unavailable' });
  });
});
