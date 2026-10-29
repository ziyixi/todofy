/**
 * Newsletter's golden answers (contracts/newsletter-ui-v1/fixtures, written by its real reader over a synthetic
 * database) through the Worker and back into the shared client: each one crosses the console byte for byte at its
 * method's path, and the client reads it into the method's output, which writes the same bytes again. The Worker
 * never parses an answer (PreEncoded), so this is what proves that what it passes on is what the UI expects.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { NewsletterUiService } from '@ziyixi/proto/newsletter/ui/v1/newsletter_ui_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import type { Env } from '../src/env.ts';
import { handleRequest } from '../src/http.ts';
import { accessClaims, testIssuer, type TestIssuer } from './jwt.ts';

const ISSUER = 'https://synthetic.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const HOST = 'news.example.test';
const UPSTREAM = 'https://runtime.example.test';
const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'contracts', 'newsletter-ui-v1', 'fixtures');
const RUN = 'runs/00000000-0000-4000-8000-000000002800';
const EDITION = 'editions/00000000-0000-4000-8000-000000000027';

const methods = NewsletterUiService.method;
/** Each golden answer, the call that asks for it, and the method whose output it is. */
const CALLS = {
  'overview': [methods.getOverview, { name: 'overview' }],
  'runs': [methods.listRuns, { month: '2026-10' }],
  'run-blocked-selection-timeout': [methods.getRun, { name: RUN }],
  'run-ready': [methods.getRun, { name: 'runs/00000000-0000-4000-8000-000000002700' }],
  'model-calls': [methods.listModelCalls, { parent: 'runs/00000000-0000-4000-8000-000000002700' }],
  'model-usage-30d': [methods.summarizeModelUsage, { dayCount: 30 }],
  'editions': [methods.listEditions, {}],
  'edition': [methods.getEdition, { name: EDITION }],
  'edition-rendering': [methods.getEditionRendering, { name: `${EDITION}/rendering` }],
  'source-catalog': [methods.getSourceCatalog, { name: 'sourceCatalog' }],
  'backup-status': [methods.getBackupStatus, { name: 'backupStatus' }],
} as const;

let issuer: TestIssuer;
let assertion = '';

beforeAll(async () => {
  issuer = await testIssuer();
  assertion = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
});

const env = {
  ASSETS: { fetch: () => Promise.resolve(new Response('', { status: 404 })) },
  PUBLIC_HOST: HOST,
  ACCESS_ISSUER: ISSUER,
  ACCESS_AUDIENCE: AUDIENCE,
  NEWSLETTER_ORIGIN: UPSTREAM,
  ACCESS_OWNER: 'owner@example.com',
  ACCESS_OWNER_ALIASES: ' ',
} as unknown as Env;

describe("Newsletter's golden answers through the console", () => {
  it('cross unchanged at their methods\' paths and read back into the same bytes', async () => {
    for (const [fixture, [method, request]] of Object.entries(CALLS)) {
      const golden = readFileSync(join(FIXTURES, `${fixture}.json`), 'utf8');
      const paths: string[] = [];
      vi.stubGlobal('fetch', (input: string | Request) => {
        const url = input instanceof Request ? input.url : input;
        if (url === `${ISSUER}/cdn-cgi/access/certs`) return Promise.resolve(Response.json(issuer.jwks));
        paths.push(new URL(url).pathname);
        return Promise.resolve(new Response(golden, { headers: { 'content-type': 'application/json' } }));
      });
      let passed = '';
      const client = createHttpClient(NewsletterUiService, async (call) => {
        const answer = await handleRequest(new Request(`https://${HOST}${call.url}`, {
          method: call.httpMethod, headers: { 'cf-access-jwt-assertion': assertion },
        }), env);
        passed = await answer.clone().text();
        return answer;
      });
      const call = (client as unknown as Record<string, (input: unknown) => Promise<never>>)[method.localName];
      if (call === undefined) throw new Error(`no client method for ${method.name}`);
      const message = await call(request);
      expect(passed, fixture).toBe(golden);
      expect(JSON.stringify(toWire(method.output, message)), fixture).toBe(golden);
      expect(paths, fixture).toHaveLength(1);
      expect(paths[0]?.startsWith('/api/newsletter/v1/'), fixture).toBe(true);
      vi.unstubAllGlobals();
    }
  });
});
