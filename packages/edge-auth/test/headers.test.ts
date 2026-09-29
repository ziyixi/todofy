import { describe, expect, it } from 'vitest';
import { privateHeaders, STRICT_CSP, withPrivateHeaders } from '../src/index.ts';

/** Todofy's PRIVATE_HEADERS CSP at bf7a769, byte for byte. */
const TODOFY_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** Mail Hero's privateResponse CSP at bf7a769, byte for byte (frames sandboxed mail HTML). */
const MAIL_HERO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const IMMUTABLE = 'private, max-age=31536000, immutable';

describe('privateHeaders', () => {
  it('uses Todofy’s strict CSP by default', () => {
    expect(STRICT_CSP).toBe(TODOFY_CSP);
    expect(privateHeaders()).toEqual({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': TODOFY_CSP,
    });
  });

  it('takes the app’s CSP and keeps the other four headers', () => {
    expect(privateHeaders(MAIL_HERO_CSP)).toEqual({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': MAIL_HERO_CSP,
    });
  });

  it('returns a frozen object with lowercase names in a fixed order', () => {
    const headers = privateHeaders();
    expect(Object.isFrozen(headers)).toBe(true);
    expect(Object.keys(headers)).toEqual(['cache-control', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'content-security-policy']);
  });
});

describe('withPrivateHeaders', () => {
  it('copies status, status text, body and other headers, and sets the five headers', async () => {
    const original = new Response('{"ok":true}', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'abc' },
    });
    const response = withPrivateHeaders(original, { csp: MAIL_HERO_CSP });
    expect(response).not.toBe(original);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(await response.text()).toBe('{"ok":true}');
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': 'abc',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': MAIL_HERO_CSP,
    });
  });

  it('replaces existing values instead of appending', () => {
    const original = new Response('x', {
      headers: { 'Cache-Control': 'public, max-age=600', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src *" },
    });
    const response = withPrivateHeaders(original);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe(TODOFY_CSP);
  });

  it('accepts an immutable response (for example from fetch or Response.redirect)', () => {
    const redirect = Response.redirect('https://mail.example.org/', 302);
    expect(() => redirect.headers.set('x-test', '1')).toThrow();
    const response = withPrivateHeaders(redirect);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://mail.example.org/');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('lets the app override Cache-Control (Todofy’s hashed assets)', () => {
    const response = withPrivateHeaders(new Response('js', { headers: { 'content-type': 'text/javascript' } }), { cacheControl: IMMUTABLE });
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(response.headers.get('content-security-policy')).toBe(TODOFY_CSP);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('matches Mail Hero’s former privateResponse and Todofy’s former withPrivateHeaders exactly', () => {
    const mailHero = (response: Response): Response => {
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      result.headers.set('X-Content-Type-Options', 'nosniff');
      result.headers.set('Referrer-Policy', 'no-referrer');
      result.headers.set('X-Frame-Options', 'DENY');
      result.headers.set('Content-Security-Policy', MAIL_HERO_CSP);
      return result;
    };
    const base = (): Response => new Response('x', { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=5' } });
    expect([...withPrivateHeaders(base(), { csp: MAIL_HERO_CSP }).headers]).toEqual([...mailHero(base()).headers]);
    expect([...withPrivateHeaders(base()).headers]).toEqual([
      ['cache-control', 'no-store'],
      ['content-security-policy', TODOFY_CSP],
      ['content-type', 'text/plain'],
      ['referrer-policy', 'no-referrer'],
      ['x-content-type-options', 'nosniff'],
      ['x-frame-options', 'DENY'],
    ]);
  });
});
