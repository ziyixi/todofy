import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import fixture from '../../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { AT, NOW, startHarness, type Harness } from './harness.ts';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.mf.dispose();
  harness = undefined;
});
async function start(): Promise<Harness> {
  harness = await startHarness();
  return harness;
}

describe('real workerd SQLite receipt persistence', () => {
  it('never invents healthy status before a host has reported', async () => {
    const h = await start();
    expect(await h.view()).toMatchObject({ freshness: 'never_seen' });
    for (const app of ['fleet', 'newsletter'] as const) {
      expect(await h.status(app, AT)).toMatchObject({
        app, health: 'degraded', counters: {}, capabilities: [],
        signals: [{ code: 'host_never_seen', severity: 'warning' }],
      });
    }
  });
  it('persists metadata and identical duplicates do not refresh the clock', async () => {
    const h = await start();
    expect((await h.send(fixture)).status).toBe(200);
    expect(await (await h.accept(fixture, AT + 5 * 60_000)).json()).toEqual({ accepted: false, sequence: 1 });
    expect(await h.view(AT + 11 * 60_000)).toMatchObject({ receive_time: NOW, freshness: 'stale', report: { sequence: 1 } });
    expect((await h.send({ ...fixture, disk_used_percent: 22 })).status).toBe(409);
    expect((await h.send({ ...fixture, sequence: 2, receipt_id: 'f47ab98a-3b34-4dd3-8924-2a1ead4da4dc' })).status).toBe(200);
    expect((await h.send(fixture)).status).toBe(409);
  });
  it('does not reuse old business counters or paused mode after reports become stale', async () => {
    const h = await start();
    expect((await h.send({ ...fixture, newsletter: { ...fixture.newsletter, drain_state: 'frozen', queued_count: 9 } })).status).toBe(200);
    expect(await h.status('newsletter', AT + 21 * 60_000)).toMatchObject({
      health: 'degraded', signals: [{ code: 'host_missing', severity: 'critical' }],
      counters: { heartbeat_age_seconds: 1260 }, modes: { maintenance: false, deployment_paused: false },
    });
  });
  it('requires runtime evidence even when the Pod and application process look healthy', async () => {
    const h = await start();
    expect((await h.send({ ...fixture, runtime: null })).status).toBe(200);
    expect(await h.status('newsletter', AT)).toMatchObject({
      health: 'degraded', signals: [
        { code: 'newsletter_unavailable', severity: 'critical' },
        { code: 'deployment_pending', severity: 'warning' },
      ],
    });
  });
  it('keeps machine authentication independent of owner local bypass', async () => {
    const h = await start();
    expect((await h.send(fixture, '0'.repeat(64))).status).toBe(401);
    expect((await h.mf.dispatchFetch('http://127.0.0.1/api/v1/fleetStatus', { method: 'POST', body: '{}' })).status).toBe(405);
  });
  it('refuses alternate production hostname and non-local developer bypass', async () => {
    const h = await start();
    expect((await h.mf.dispatchFetch('https://alternate.example.com/api/v1/fleetStatus')).status).toBe(404);
    expect((await h.mf.dispatchFetch('https://fleet.example.com/api/v1/fleetStatus')).status).toBe(401);
  });
  it('verifies a real signed Access token before owner API or assets', async () => {
    const issuer = 'https://synthetic.cloudflareaccess.com';
    const audience = 'a'.repeat(64);
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwks = { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' }] };
    harness = await startHarness({
      bindings: { DEV_AUTH_BYPASS: 'false' },
      outbound: (request) => request.url === `${issuer}/cdn-cgi/access/certs`
        ? Response.json(jwks)
        : new Response('unexpected network', { status: 503 }),
    });
    const token = (email: string): string => {
      const seconds = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: [audience], email, sub: 'synthetic', exp: seconds + 3600, iat: seconds - 10, nbf: seconds - 10 })).toString('base64url');
      const signed = `${header}.${claims}`;
      return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), keys.privateKey).toString('base64url')}`;
    };
    const headers = { 'cf-access-jwt-assertion': token('owner@example.com') };
    const response = await harness.mf.dispatchFetch('https://fleet.example.com/api/v1/fleetStatus', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ freshness: 'never_seen' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await harness.mf.dispatchFetch('https://fleet.example.com/', { headers })).status).toBe(200);
    const other = { 'cf-access-jwt-assertion': token('another@example.com') };
    expect((await harness.mf.dispatchFetch('https://fleet.example.com/api/v1/fleetStatus', { headers: other })).status).toBe(401);
    expect((await harness.mf.dispatchFetch('https://fleet.example.com/', { headers: other })).status).toBe(401);
  });
  it('enforces the body bound before JSON decoding', async () => {
    const h = await start();
    expect((await h.send({ ...fixture, unexpected: 'x'.repeat(17000) })).status).toBe(413);
  });
});
