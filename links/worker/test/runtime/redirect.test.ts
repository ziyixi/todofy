/**
 * The short-link half in workerd with real D1 (src/http.ts, resolve.ts): redirects and their headers, visibility and
 * the enumeration rule (a private key answers an anonymous request exactly like an unknown one), passthrough in each
 * mode, open-redirect attempts, previews, and the redirect's cost: no D1 write and no log line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLink, OWNER_COOKIE, startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  await createLink(h, 'pub', { target: 'https://example.com/docs', visibility: 'public' });
  await createLink(h, 'priv', { target: 'https://private.example.org/secret' });
  await createLink(h, 'gh', { target: 'https://github.com/', path_mode: 'append', visibility: 'public' });
  await createLink(h, 'q', { target: 'https://search.example.com/?q={path}', path_mode: 'template', visibility: 'public' });
  await createLink(h, 'u', { target: 'https://example.com/users/{path}/profile', path_mode: 'template', visibility: 'public' });
  await createLink(h, 'old', { target: 'https://example.com/old', visibility: 'public', expire_time: '2026-01-01T00:00:00Z' });
  const gone = await createLink(h, 'gone', { target: 'https://example.com/gone', visibility: 'public' });
  await h.mutate('DELETE', `/_/api/v1/links/gone?etag=${gone.etag ?? ''}`);
});
afterAll(async () => {
  await h.dispose();
});

const anonymous = (path: string, init: RequestInit = {}) => h.fetch(path, init);
const owner = (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, headers: { cookie: OWNER_COOKIE } });

/** Everything a client can observe of a response: status, every header and the body. */
async function observable(response: Response): Promise<string> {
  return JSON.stringify({ status: response.status, headers: [...response.headers].sort(), body: await response.text() });
}

describe('redirects', () => {
  it('send a public link to its target with a 302 that nothing caches or indexes', async () => {
    const response = await anonymous('/pub');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/docs');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.text()).toBe('');
  });

  it('read keys case-insensitively, also with HEAD and a trailing slash, and ignore the query string', async () => {
    for (const path of ['/PUB', '/Pub/', '/pub?utm=x']) expect((await anonymous(path)).headers.get('location'), path).toBe('https://example.com/docs');
    const head = await anonymous('/pub', { method: 'HEAD' });
    expect(head.status).toBe(302);
    expect(head.headers.get('location')).toBe('https://example.com/docs');
  });

  it('never answer 301 or 308, and refuse other methods', async () => {
    for (const path of ['/pub', '/priv', '/nope', '/', '/_', '/gh/a']) {
      const status = (await anonymous(path)).status;
      expect([301, 308]).not.toContain(status);
    }
    const post = await anonymous('/pub', { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('send the owner to a private link', async () => {
    const response = await owner('/priv');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://private.example.org/secret');
  });
});

describe('visibility and enumeration', () => {
  it('answer an anonymous request for a private key exactly as for an unknown, deleted or expired one', async () => {
    const keys = ['priv', 'nope', 'gone', 'old'];
    const answers = await Promise.all(keys.map(async (key) => observable(await anonymous(`/${key}`))));
    // Each names its own key in the location; everything else must be byte for byte the same.
    const normalized = answers.map((answer, index) => answer.replace(`"/_/k/${keys[index] ?? ''}"`, '"/_/k/KEY"'));
    expect(new Set(normalized), normalized.join('\n')).toHaveProperty('size', 1);
    expect(normalized[0]).toContain('"/_/k/KEY"');
    const response = await anonymous('/priv/a/b');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/_/k/priv/a/b');
    expect((await anonymous('/nope+')).headers.get('location')).toBe('/_/k/nope+');
  });

  it('treat a token that does not verify as anonymous on a short link (no bypass: tokens are checked)', async () => {
    // Under the dev bypass any token is the owner; ./access.test.ts runs without it.
    expect((await anonymous('/priv', { headers: { 'cf-access-jwt-assertion': '' } })).headers.get('location')).toBe('/_/k/priv');
  });

  it('send the owner to the continuation for keys that do not resolve', async () => {
    for (const key of ['nope', 'gone', 'old']) expect((await owner(`/${key}`)).headers.get('location')).toBe(`/_/k/${key}`);
  });
});

describe('passthrough', () => {
  it('APPEND adds the path, segment by segment, never the query', async () => {
    expect((await anonymous('/gh/ziyixi/todofy?tab=readme')).headers.get('location')).toBe('https://github.com/ziyixi/todofy');
    expect((await anonymous('/gh/a%20b/%E4%BD%A0')).headers.get('location')).toBe('https://github.com/a%20b/%E4%BD%A0');
  });

  it('TEMPLATE fills {path}, in a query as one value', async () => {
    expect((await anonymous('/q/hello%20world/x')).headers.get('location')).toBe('https://search.example.com/?q=hello%20world%2Fx');
    expect((await anonymous('/u/alice')).headers.get('location')).toBe('https://example.com/users/alice/profile');
  });

  it('take the rest after an encoded space too (Chrome site search: `s gh ziyixi/todofy`)', async () => {
    expect((await anonymous('/gh%20ziyixi/todofy')).headers.get('location')).toBe('https://github.com/ziyixi/todofy');
    expect((await anonymous('/q%20hello%20world')).headers.get('location')).toBe('https://search.example.com/?q=hello%20world');
    expect((await anonymous('/priv%20x')).headers.get('location')).toBe('/_/k/priv/x');
  });

  it('EXACT takes no path', async () => {
    const response = await anonymous('/pub/extra');
    expect(response.status).toBe(404);
    expect(await response.text()).toMatch(/takes no path/);
  });

  it('never redirects to another origin, whatever the path holds', async () => {
    for (const path of ['/gh/@evil.example', '/gh//evil.example', '/gh/%2F%2Fevil.example', '/gh/..%2F..%2Fevil.example', '/gh/%5Cevil.example', '/u/%2F%2Fevil.example', '/u/@evil.example', '/q/@evil.example']) {
      const response = await anonymous(path);
      const location = response.headers.get('location');
      if (response.status === 302 && location !== null) {
        const host = new URL(location).host;
        expect(['github.com', 'example.com', 'search.example.com'], `${path} -> ${location}`).toContain(host);
      } else {
        expect(response.status, path).toBe(404);
      }
    }
    // A dot segment the URL parser leaves (encoded) is refused; one it resolves never reaches the key's rest.
    expect((await anonymous('/gh/a%2F..%2Fb')).status).toBe(404);
    expect((await anonymous('/gh/x/../../pub')).headers.get('location')).toBe('https://example.com/docs');
  });
});

describe('previews', () => {
  it('show a public link to anyone, as escaped HTML without scripts', async () => {
    const response = await anonymous('/gh+/a%3Cb');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    const page = await response.text();
    expect(page).toContain('https://github.com/a%3Cb');
    expect(page).not.toContain('<script');
  });

  it('keep a private link hidden from anyone but the owner', async () => {
    expect((await anonymous('/priv+')).headers.get('location')).toBe('/_/k/priv+');
    const page = await (await owner('/priv+')).text();
    expect(page).toContain('https://private.example.org/secret');
    expect(page).toContain('Private link');
  });
});

describe('the rest of the host', () => {
  it('redirects / to the launcher, disallows robots, 404s paths without a key', async () => {
    expect((await anonymous('/')).headers.get('location')).toBe('/_/');
    expect((await anonymous('/_')).headers.get('location')).toBe('/_/');
    const robots = await anonymous('/robots.txt');
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    for (const path of ['/favicon.ico', '/api', '/search', '/s', '/v1/x', '/.well-known/security.txt', '/a_b', '/%67h', `/gh/${'a'.repeat(1100)}`]) {
      const response = await anonymous(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('never answers a short path with the launcher page (no single-page fallback)', async () => {
    h.assetRequests.length = 0;
    for (const path of ['/pub', '/nope', '/gh/x', '/priv+', '/robots.txt', '/favicon.ico']) await (await anonymous(path)).text();
    expect(h.assetRequests).toEqual([]);
  });
});

describe('the cost of a redirect', () => {
  it('writes nothing to D1 and logs nothing, for every kind of answer', async () => {
    const before = await h.snapshot();
    const lines = h.logs.length;
    for (const path of ['/pub', '/priv', '/nope', '/gone', '/old', '/gh/a', '/q/b', '/pub+', '/pub/extra']) {
      await (await anonymous(path)).text();
      await (await owner(path)).text();
    }
    expect(await h.snapshot()).toBe(before);
    expect(h.logs.slice(lines)).toEqual([]);
  });

  it('reads exactly one row', async () => {
    // The redirect's statement, run as the Worker runs it: one row read through the primary key.
    const [plan] = await h.sql<{ detail: string }>('EXPLAIN QUERY PLAN SELECT target, path_mode, visibility, description, expire_time, delete_time FROM links WHERE key = ?', 'pub');
    expect(plan?.detail).toMatch(/SEARCH links USING PRIMARY KEY \(key=\?\)/);
  });
});
