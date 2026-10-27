import { describe, expect, it } from 'vitest';
import { CSRF_HEADER, CSRF_MAX_TOKEN_CHARS, verifyCsrf } from '../src/index.ts';
const origin = 'https://owner.example.test';
const policy = { allowedOrigins: [origin] };
function request(headers: Record<string, string> = {}) {
  return new Request(origin + '/api/settings', { method: 'POST', headers: { Origin: origin, [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...headers }, body: '{}' });
}
describe('same-origin JSON mutation checks', () => {
  it('accepts the static header without a cookie or signing key', async () => {
    expect(await verifyCsrf(request(), policy)).toEqual({ ok: true });
    expect(await verifyCsrf(request({ 'Content-Type': 'Application/JSON; charset=utf-8' }), policy)).toEqual({ ok: true });
  });
  it('accepts a bounded old header while ignoring old cookies', async () => {
    expect(await verifyCsrf(request({ [CSRF_HEADER]: 'old.signed.header', Cookie: 'obsolete_csrf=unrelated' }), policy)).toEqual({ ok: true });
    expect(await verifyCsrf(request({ [CSRF_HEADER]: 'x'.repeat(CSRF_MAX_TOKEN_CHARS) }), policy)).toEqual({ ok: true });
  });
  it.each(['', 'null', 'https://foreign.example.test', 'https://owner.example.test.evil.test', 'http://owner.example.test', origin + '/', 'HTTPS://OWNER.EXAMPLE.TEST'])('rejects an unlisted exact Origin %s', async (value) => {
    expect(await verifyCsrf(request({ Origin: value }), policy)).toEqual({ ok: false, failure: 'origin' });
  });
  it('rejects missing Origin and an empty allowlist', async () => {
    const missing = request(); missing.headers.delete('origin');
    expect(await verifyCsrf(missing, policy)).toEqual({ ok: false, failure: 'origin' });
    expect(await verifyCsrf(request(), { allowedOrigins: [] })).toEqual({ ok: false, failure: 'origin' });
    expect(await verifyCsrf(request({ Origin: 'null' }), { allowedOrigins: ['null'] })).toEqual({ ok: false, failure: 'origin' });
  });
  it.each(['', ' ', 'x'.repeat(CSRF_MAX_TOKEN_CHARS + 1)])('rejects an empty or oversized custom header', async (value) => {
    expect(await verifyCsrf(request({ [CSRF_HEADER]: value }), policy)).toEqual({ ok: false, failure: 'token' });
  });
  it('rejects a missing custom header even with a legacy cookie', async () => {
    const missing = request({ Cookie: 'owner_csrf=legacy' }); missing.headers.delete(CSRF_HEADER);
    expect(await verifyCsrf(missing, policy)).toEqual({ ok: false, failure: 'token' });
  });
  it.each(['', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=synthetic', 'application/jsonp', 'text/json'])('rejects unsafe Content-Type %s', async (value) => {
    expect(await verifyCsrf(request({ 'Content-Type': value }), policy)).toEqual({ ok: false, failure: 'content_type' });
  });
  it('requires JSON metadata for a mutation without a body', async () => {
    const empty = new Request(origin + '/api/item', { method: 'DELETE', headers: { Origin: origin, [CSRF_HEADER]: '1' } });
    expect(await verifyCsrf(empty, policy)).toEqual({ ok: false, failure: 'content_type' });
    empty.headers.set('content-type', 'application/json');
    expect(await verifyCsrf(empty, policy)).toEqual({ ok: true });
  });
  it('does not consume a malformed body and checks Origin first', async () => {
    const bad = new Request(origin + '/api/settings', { method: 'POST', body: '{ malformed', headers: { Origin: 'null' } });
    expect(await verifyCsrf(bad, policy)).toEqual({ ok: false, failure: 'origin' });
    expect(bad.bodyUsed).toBe(false);
  });
});
