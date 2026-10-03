/** Owner HTTP surface: authenticate first, then the shared, read-only IDL transcoder. */
import { createAccessVerifier, withPrivateHeaders, STRICT_CSP } from '@ziyixi/edge-auth';
import { FleetUiService } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import { HttpTranscoder, PreEncoded } from '@ziyixi/proto/http-transcoder';
import { RpcError, Code } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { handleReceipt } from './receipt.ts';
import { REPORT_PATH } from './report.ts';
import { OBJECT_NAME } from './state.ts';

interface OwnerContext { readonly env: Env; readonly at: number; }
const verifier = createAccessVerifier();
function error(code: Code, reason: string): RpcError {
  return new RpcError(code, reason, 'Fleet request failed.');
}

const api = new HttpTranscoder<typeof FleetUiService.method, OwnerContext>(FleetUiService, {
  getFleetStatus: async (_request, context) => {
    try {
      const stub = context.env.FLEET.get(context.env.FLEET.idFromName(OBJECT_NAME));
      return new PreEncoded(await stub.view(context.at));
    } catch {
      throw error(Code.UNAVAILABLE, 'UNAVAILABLE');
    }
  },
}, {
  domain: 'fleet.ziyixi.science',
  maxBodyBytes: 1024,
  authorize: (_request, route) => {
    // There are no owner mutations. A future mutation must add Origin and CSRF validation here first.
    if (!route.safe) throw error(Code.PERMISSION_DENIED, 'READ_ONLY');
    return Promise.resolve();
  },
});

function localRequest(request: Request, env: Env, url: URL): boolean {
  return env.DEV_AUTH_BYPASS === 'true'
    && url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !request.headers.has('cf-ray');
}

/** Only a verified local bypass may select the synthetic test clock. */
function requestTime(env: Env, local: boolean): number {
  if (local && env.DEV_NOW) return Date.parse(env.DEV_NOW);
  return Date.now();
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const local = localRequest(request, env, url);
  if (!local && (url.protocol !== 'https:' || url.host !== env.PUBLIC_HOST)) {
    return new Response('Not found', { status: 404 });
  }
  const at = requestTime(env, local);
  if (url.pathname === REPORT_PATH) {
    return withPrivateHeaders(await handleReceipt(request, env, at));
  }
  const auth = await verifier.verify(request, {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: 60,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: env.ACCESS_OWNER ?? '',
      whenNotLocal: 'refuse',
    },
  });
  if (!auth.ok) {
    const unavailable = auth.failure === 'keys_unavailable' || auth.failure === 'not_configured';
    return withPrivateHeaders(api.errorResponse(
      error(unavailable ? Code.UNAVAILABLE : Code.UNAUTHENTICATED, unavailable ? 'UNAVAILABLE' : 'UNAUTHORIZED'),
      'fleet-request', request.method === 'HEAD',
    ));
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return withPrivateHeaders(new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }));
  }
  const result = await api.handle(request, { env, at }, 'fleet-request');
  if (result) return withPrivateHeaders(result.response);
  if (url.pathname.startsWith('/api/')) {
    return withPrivateHeaders(new Response('Not found', { status: 404 }));
  }
  return withPrivateHeaders(await env.ASSETS.fetch(request), { csp: STRICT_CSP });
}
