/** Owner Access and machine Bearer checks run before model request bodies are read. */
import {
  createAccessVerifier,
  verifyCsrf,
  withPrivateHeaders,
  constantTimeEqual,
} from '@ziyixi/edge-auth';
import { statusBody } from '@ziyixi/proto/rpc-status';
import { Code, RpcError } from './errors.ts';
import type { Env } from './types.ts';

const verifier = createAccessVerifier();
const machinePath =
  /^\/api\/model\/v1\/(models|generations:generate|embeddings:embed|conversations|conversations\/[0-9a-f-]+:close)$/;
export function errorResponse(error: RpcError): Response {
  return Response.json(statusBody(error, { domain: 'modelrouter.inference.v1' }), { status: error.httpStatus });
}
export async function forward(request: Request, env: Env, app: string, owner = false): Promise<Response> {
  if (env.MAINTENANCE_MODE === 'true' && request.method !== 'GET' && machinePath.test(new URL(request.url).pathname))
    return withPrivateHeaders(
      errorResponse(new RpcError(Code.UNAVAILABLE, 'MODEL_MAINTENANCE', 'Model Router is temporarily under maintenance.')),
    );
  const headers = new Headers(request.headers);
  headers.set('x-router-app', app);
  headers.set('x-router-owner', String(owner));
  const stub = env.ENGINE.get(env.ENGINE.idFromName('router-v1'));
  return stub.fetch(new Request(request, { headers }));
}
async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET')
    return Response.json({ service: 'model-router', status: 'ok', build: env.BUILD_SHA ?? 'dev' });
  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && machinePath.test(url.pathname)) {
    const key = env.MODEL_ROUTER_NEWSLETTER_TOKEN;
    if (!key || !constantTimeEqual(bearer, key))
      throw new RpcError(Code.UNAUTHENTICATED, 'MODEL_AUTH', 'Invalid model client token.');
    return forward(request, env, 'newsletter');
  }
  const auth = await verifier.verify(request, {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: 60,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: { ttlMs: 600000, refreshCooldownMs: 60000 },
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: env.ACCESS_OWNER ?? 'owner',
      whenNotLocal: 'refuse',
    },
  });
  if (!auth.ok)
    throw new RpcError(
      auth.failure === 'keys_unavailable' ? Code.UNAVAILABLE : Code.UNAUTHENTICATED,
      'OWNER_AUTH_REQUIRED',
      'Sign in to open Model Router.',
    );
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return Response.json({ csrf_token: '1' });
  }
  if (url.pathname.startsWith('/api/model/v1/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origins = [`https://${env.PUBLIC_HOST}`];
      if (auth.bypassed) origins.push(url.origin);
      if (!(await verifyCsrf(request, { allowedOrigins: origins })).ok)
        throw new RpcError(Code.PERMISSION_DENIED, 'CSRF_FAILED', 'Refresh the page and retry.');
    }
    return forward(request, env, 'console', true);
  }
  if (url.pathname.startsWith('/api/')) return new Response(null, { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  return env.ASSETS.fetch(request);
}
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    return withPrivateHeaders(await handle(request, env));
  } catch (error) {
    const rpc =
      error instanceof RpcError
        ? error
        : new RpcError(Code.INTERNAL, 'INTERNAL', 'The request could not be completed.');
    return withPrivateHeaders(errorResponse(rpc));
  }
}
