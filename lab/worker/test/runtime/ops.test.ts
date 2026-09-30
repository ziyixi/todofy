/**
 * Lab's ops-v1 entrypoint over a real service binding, and Access + CSRF end to end with a test JWKS
 * (docs/design.md §8, §10). The status carries counts and codes only, never a title or the owner.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { validate } from '../../../../contracts/ops-v1/validate.mjs';
import { rssFeed, dayItems } from '../feeds.ts';
import { accessClaims, testIssuer, type TestIssuer } from '../jwt.ts';
import { contractSchema, op, startHarness, SYNTHETIC_BINDINGS, type Harness } from './harness.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

describe('Ops', () => {
  it('answers status() and setGuard() as ops-v1 declares', async () => {
    h = await startHarness();
    const schema = await contractSchema('ops-v1');
    const first = await h.ops('status');
    expect(validate(schema, 'OpsStatus', first.ok)).toEqual([]);
    expect(first.ok).toMatchObject({ app: 'lab', health: 'ok', modes: { maintenance: false, ingest_paused: false }, capabilities: ['guard'], ui_url: 'https://lab.example.com/' });

    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    // The 24 h and 7 d counters are windows over the real clock.
    await h.run(Date.now());
    const card = (await h.sql<{ paper_id: string }>('SELECT paper_id FROM deck_cards ORDER BY position LIMIT 1'))[0];
    await h.mutate('POST', '/api/decks/2026-09-30/decide', { op_id: op(), base_version: 0, paper_id: card?.paper_id, decision: 'like' });
    const after = await h.ops('status');
    expect(validate(schema, 'OpsStatus', after.ok)).toEqual([]);
    const counters = (after.ok as { counters: Record<string, number> }).counters;
    expect(counters).toMatchObject({ ingested_24h: 40, ranked_24h: 20, liked_7d: 1, decided_7d: 1, neuron_cap: 5000 });
    // Nothing but codes and numbers: no paper title, no owner address.
    const text = JSON.stringify(after.ok);
    expect(text).not.toContain('retrieval');
    expect(text).not.toContain('owner@example.com');

    const until = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const shed = await h.ops('setGuard', { level: 'shed', reason: 'd1_reads_high', until });
    expect(validate(schema, 'GuardState', shed.ok)).toEqual([]);
    // Idempotent: the same input keeps set_at.
    expect((await h.ops('setGuard', { level: 'shed', reason: 'd1_reads_high', until })).ok).toEqual(shed.ok);
    const held = await h.ops('status');
    expect((held.ok as { signals: { code: string }[] }).signals.map((s) => s.code)).toEqual(['guard_shed']);
    for (const input of [
      { level: 'shed', reason: 'x', until: new Date(Date.now() + 40 * 3_600_000).toISOString() },
      { level: 'shed', reason: 'x', until: '2020-01-01T00:00:00Z' },
      { level: 'shed', reason: 'Free Text', until },
      { level: 'normal', reason: 'x', until },
    ]) {
      expect((await h.ops('setGuard', input)).error, JSON.stringify(input)).toBe('invalid_input');
    }
    expect((await h.ops('startCanary', { run_id: 'x' })).error).toBeDefined();
  });
});

describe('Access and CSRF', () => {
  let issuer: TestIssuer;
  beforeAll(async () => {
    issuer = await testIssuer();
  });

  it('verifies the Access JWT, serves only the owner and binds CSRF to the https origin', async () => {
    const ISSUER = SYNTHETIC_BINDINGS.ACCESS_ISSUER ?? '';
    const AUDIENCE = SYNTHETIC_BINDINGS.ACCESS_AUDIENCE ?? '';
    h = await startHarness({
      bindings: { DEV_AUTH_BYPASS: 'false', ACCESS_OWNER_ALIASES: 'second@example.org' },
      routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuer.jwks)]]),
    });
    const as = async (email: string | null, path = '/api/today', init: RequestInit = {}) =>
      h?.fetch(path, email === null ? init : { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'cf-access-jwt-assertion': await issuer.sign(accessClaims(ISSUER, AUDIENCE, email)) } });
    expect((await as(null))?.status).toBe(401);
    expect((await as('someone@example.com'))?.status).toBe(401);
    for (const email of ['owner@example.com', 'OWNER@example.com', 'second@example.org']) {
      const response = await as(email);
      expect(response?.status, email).toBe(200);
      await response?.arrayBuffer();
    }
    const page = await as('owner@example.com', '/');
    expect(page?.status).toBe(200);
    expect(page?.headers.get('content-security-policy')).toContain("default-src 'self'");
    await page?.arrayBuffer();
    const health = await h.fetch('/health');
    expect(await health.json()).toEqual({ service: 'lab', status: 'ok', build: 'test' });

    const jwt = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
    const csrf = await h.fetch('/api/csrf', { headers: { 'cf-access-jwt-assertion': jwt } });
    const { token } = (await csrf.json()) as { token: string };
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const post = (origin: string) =>
      h?.fetch('/api/seeds', {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': jwt, origin, 'x-csrf-token': token, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ op_id: op(), ids: ['2601.00042'] }),
      });
    expect((await post('http://127.0.0.1'))?.status).toBe(403);
    const accepted = await post('https://lab.example.com');
    expect(accepted?.status).toBe(200);
    await accepted?.arrayBuffer();
  });
});
