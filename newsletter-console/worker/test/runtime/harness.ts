/**
 * workerd harness: bundles src/index.ts with esbuild and runs it in Miniflare as the Worker "newsletter-console" with a
 * fake ASSETS binding and an outbound handler that serves a synthetic Access issuer's keys and a fake Newsletter at
 * the configured origin, and refuses everything else. The fake answers in workerd's own outbound handler, not over a
 * loopback TCP server, whose large bodies GitHub's runners throttle. No dev bypass: every request is authenticated as
 * in production. All data is synthetic; nothing leaves the process.
 */
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { Response as MiniflareResponse } from 'miniflare';
import { resolve } from 'node:path';

export const HOST = 'news.example.test';
export const ISSUER = 'https://synthetic.cloudflareaccess.com';
export const AUDIENCE = 'a'.repeat(64);
export const UPSTREAM = 'https://runtime.example.test';
export const PAGE = '<!doctype html><title>Newsletter</title>';

/** A request that left the Worker. */
export interface Outbound {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HarnessOptions {
  /** The fake Newsletter: answers every request to UPSTREAM (default: 503). */
  readonly newsletter?: (request: Request) => Response | Promise<Response>;
  /** workerd's inspector (0: a free port), for the CPU meter. */
  readonly inspectorPort?: number;
}

export interface Harness {
  readonly mf: Miniflare;
  /** Requests that left the Worker, in order. */
  readonly outbound: Outbound[];
  fetch(path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<MiniflareResponse>;
  dispose(): Promise<void>;
}

export async function startHarness(jwks: unknown, options: HarnessOptions = {}): Promise<Harness> {
  const result = await build({
    ...(process.env.TEST_SRCDIR ? { nodePaths: [`${process.cwd()}/node_modules`] } : {}),
    entryPoints: [resolve('src/index.ts')], bundle: true, format: 'esm',
    platform: 'neutral', target: 'es2024', conditions: ['workerd', 'worker', 'import'], write: false, logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('esbuild produced no console bundle');
  const outbound: Outbound[] = [];
  const newsletter = options.newsletter ?? (() => new Response('down', { status: 503 }));
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    ...(options.inspectorPort === undefined ? {} : { inspectorPort: options.inspectorPort }),
    workers: [{
      name: 'newsletter-console', modules: true, script: output.text, compatibilityDate: '2026-09-29',
      bindings: {
        PUBLIC_HOST: HOST, ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_OWNER: 'owner@example.com',
        ACCESS_OWNER_ALIASES: ' ', NEWSLETTER_ORIGIN: UPSTREAM,
      },
      serviceBindings: { ASSETS: () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
      outboundService: (request: Request) => {
        outbound.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers) });
        if (request.url === `${ISSUER}/cdn-cgi/access/certs`) return Response.json(jwks);
        if (request.url.startsWith(`${UPSTREAM}/`)) return newsletter(request);
        return new Response('unexpected network', { status: 503 });
      },
    }],
  }));
  await mf.ready;
  return {
    mf,
    outbound,
    fetch: (path, init = {}) => mf.dispatchFetch(`https://${HOST}${path}`, init),
    dispose: () => mf.dispose(),
  };
}
