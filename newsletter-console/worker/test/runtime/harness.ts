/**
 * workerd harness: bundles src/index.ts with esbuild and runs it in Miniflare as the Worker "newsletter-console" with a
 * fake ASSETS binding and an outbound handler that serves a synthetic Access issuer's keys and refuses everything
 * else. No dev bypass: every request is authenticated as in production. All data is synthetic; nothing leaves the
 * process.
 */
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { Response as MiniflareResponse } from 'miniflare';
import { resolve } from 'node:path';

export const HOST = 'news.example.test';
export const ISSUER = 'https://synthetic.cloudflareaccess.com';
export const AUDIENCE = 'a'.repeat(64);
export const PAGE = '<!doctype html><title>Newsletter</title>';

export interface Harness {
  /** Requests that left the Worker, by URL. */
  readonly outbound: string[];
  fetch(path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<MiniflareResponse>;
  dispose(): Promise<void>;
}

export async function startHarness(jwks: unknown): Promise<Harness> {
  const result = await build({
    entryPoints: [resolve('src/index.ts')], bundle: true, format: 'esm',
    platform: 'neutral', target: 'es2024', conditions: ['workerd', 'worker', 'import'], write: false, logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('esbuild produced no console bundle');
  const outbound: string[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    workers: [{
      name: 'newsletter-console', modules: true, script: output.text, compatibilityDate: '2026-09-29',
      bindings: {
        PUBLIC_HOST: HOST, ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_OWNER: 'owner@example.com',
        ACCESS_OWNER_ALIASES: ' ', NEWSLETTER_ORIGIN: 'https://runtime.example.test',
      },
      serviceBindings: { ASSETS: () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
      outboundService: (request: Request) => {
        outbound.push(request.url);
        return request.url === `${ISSUER}/cdn-cgi/access/certs` ? Response.json(jwks) : new Response('unexpected network', { status: 503 });
      },
    }],
  }));
  await mf.ready;
  return {
    outbound,
    fetch: (path, init = {}) => mf.dispatchFetch(`https://${HOST}${path}`, init),
    dispose: () => mf.dispose(),
  };
}
