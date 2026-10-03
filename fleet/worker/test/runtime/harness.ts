/** Real workerd/SQLite and an isolated test clock. Probe never appears in the production module. */
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { Response as MiniflareResponse } from 'miniflare';
import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';

export const NOW = '2026-10-03T00:00:00Z';
export const AT = Date.parse(NOW);
export const KEY = 'a'.repeat(64);
const PROBE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.FLEET.get(env.FLEET.idFromName('fleet-v1'));
    const now = Number(url.searchParams.get('at'));
    if (url.pathname === '/view') return new Response(await stub.view(now));
    if (url.pathname === '/status') return Response.json(await stub.status(url.searchParams.get('app'), now));
    const value = await request.json();
    return Response.json(await stub.accept(value.text, value.hash, now));
  }
};`;
export interface Harness {
  readonly mf: Miniflare;
  send(data: unknown, signature?: string): Promise<MiniflareResponse>;
  view(at?: number): Promise<Record<string, unknown>>;
  accept(data: unknown, at: number): Promise<MiniflareResponse>;
  status(app: 'fleet' | 'newsletter', at: number): Promise<Record<string, unknown>>;
}
export async function startHarness(options: { bindings?: Record<string, string>; outbound?: (request: Request) => Response } = {}): Promise<Harness> {
  const result = await build({
    entryPoints: [resolve('src/index.ts')], bundle: true, format: 'esm',
    platform: 'neutral', external: ['cloudflare:workers'], write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('esbuild produced no Fleet bundle');
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    workers: [
      {
        name: 'fleet', modules: true, script: output.text, compatibilityDate: '2026-09-29',
        durableObjects: { FLEET: { className: 'FleetState', useSQLite: true } },
        bindings: {
          PUBLIC_HOST: 'fleet.example.com', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
          ACCESS_AUDIENCE: 'a'.repeat(64), ACCESS_OWNER: 'owner@example.com',
          HOST_KEY: 'vps', HOST_EPOCH: '1', REPORT_HMAC_KEY: KEY,
          DEV_AUTH_BYPASS: 'true', DEV_NOW: NOW,
          ...options.bindings,
        },
        serviceBindings: { ASSETS: () => new Response('<title>Fleet</title>') },
        outboundService: (request: Request) => options.outbound?.(request) ?? new Response('unexpected network', { status: 503 }),
      },
      {
        name: 'probe', modules: true, script: PROBE, compatibilityDate: '2026-09-29',
        durableObjects: { FLEET: { className: 'FleetState', scriptName: 'fleet' } },
      },
    ],
  }));
  await mf.ready;
  const probe = await mf.getWorker('probe');
  return {
    mf,
    async send(data, signature) {
      const body = JSON.stringify(data);
      const signed = signature ?? createHmac('sha256', Buffer.from(KEY, 'hex')).update(body).digest('hex');
      return mf.dispatchFetch('http://127.0.0.1/api/internal/fleet/v1/receipt', {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-fleet-key-id': 'primary', 'x-fleet-signature': signed },
      });
    },
    async view(at = AT) {
      return await (await probe.fetch(`http://probe/view?at=${String(at)}`)).json() as Record<string, unknown>;
    },
    async accept(data, at) {
      const text = JSON.stringify(data);
      return probe.fetch(`http://probe/accept?at=${String(at)}`, {
        method: 'POST', body: JSON.stringify({ text, hash: createHash('sha256').update(text).digest('hex') }),
      });
    },
    async status(app, at) {
      return await (await probe.fetch(`http://probe/status?app=${app}&at=${String(at)}`)).json() as Record<string, unknown>;
    },
  };
}
