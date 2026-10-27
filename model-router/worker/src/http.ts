/** Owner Access and machine Bearer checks run before model request bodies are read. */
import {
  createAccessVerifier,
  importHmacKeyHex,
  issueCsrf,
  verifyCsrf,
  withPrivateHeaders,
  constantTimeEqual,
} from '@ziyixi/edge-auth';
import { statusBody } from '@ziyixi/proto/rpc-status';
import { Code, RpcError } from './errors.ts';
import type { Env } from './types.ts';

const verifier = createAccessVerifier();
const cookieName = 'model_router_csrf';
const machinePath =
  /^\/api\/model\/v1\/(models|generations:generate|embeddings:embed|conversations(?:\/[0-9a-f-]+(?::close)?)?)$/;
export function errorResponse(error: RpcError): Response {
  return Response.json(statusBody(error, { domain: 'modelrouter.inference.v1' }), { status: error.httpStatus });
}
export async function forward(request: Request, env: Env, app: string, owner = false): Promise<Response> {
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
    const key = await importHmacKeyHex(env.CSRF_SIGNING_KEY ?? '');
    if (!key)
      throw new RpcError(Code.FAILED_PRECONDITION, 'CSRF_NOT_CONFIGURED', 'The console signing key is not configured.');
    const csrf = await issueCsrf(request, auth.owner, { cookieName, key });
    return Response.json({ csrf_token: csrf.token }, { headers: { 'set-cookie': csrf.setCookie } });
  }
  if (url.pathname.startsWith('/api/model/v1/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const key = await importHmacKeyHex(env.CSRF_SIGNING_KEY ?? '');
      const origins = [`https://${env.PUBLIC_HOST}`];
      if (auth.bypassed) origins.push(url.origin);
      if (!key || !(await verifyCsrf(request, auth.owner, { cookieName, key, allowedOrigins: origins })).ok)
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
