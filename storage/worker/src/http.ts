import { createAccessVerifier, verifyCsrf, withPrivateHeaders } from '@ziyixi/edge-auth';
import { Code } from '@ziyixi/proto/rpc-status';
import { STATE_NAME, type Env } from './env.ts';
import { errorResponse, failure } from './errors.ts';
import { PAGE, SCRIPT } from './ui.ts';

const verifier = createAccessVerifier();

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = crypto.randomUUID();
  const local = env.DEV_AUTH_BYPASS === 'true' && url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !request.headers.has('cf-ray');
  if (!local && (url.protocol !== 'https:' || url.host !== env.PUBLIC_HOST)) return new Response('Not found', { status: 404 });
  try {
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true, build_sha: env.BUILD_SHA ?? 'dev' });
    if (!url.pathname.startsWith('/api/storage/v1/')) {
      const auth = await verifier.verify(request, {
        issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE, owner: env.ACCESS_OWNER, aliases: env.ACCESS_OWNER_ALIASES,
        emailMatch: 'case-insensitive', nbfLeewaySeconds: 60, tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
        devBypass: { enabled: env.DEV_AUTH_BYPASS === 'true', hosts: 'loopback-http', principal: env.ACCESS_OWNER ?? '', whenNotLocal: 'refuse' },
      });
      if (!auth.ok) throw failure(auth.failure === 'keys_unavailable' || auth.failure === 'not_configured' ? Code.UNAVAILABLE : Code.UNAUTHENTICATED,
        auth.failure === 'keys_unavailable' || auth.failure === 'not_configured' ? 'UNAVAILABLE' : 'UNAUTHORIZED');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const csrf = await verifyCsrf(request, { allowedOrigins: local ? [url.origin] : ['https://' + (env.PUBLIC_HOST ?? '')] });
        if (!csrf.ok) throw failure(Code.PERMISSION_DENIED, 'CSRF_FAILED');
      }
      if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return withPrivateHeaders(new Response(request.method === 'HEAD' ? null : PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
      }
      if (url.pathname === '/assets/storage.js' && (request.method === 'GET' || request.method === 'HEAD')) {
        return withPrivateHeaders(new Response(request.method === 'HEAD' ? null : SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }));
      }
    }
    const response = await env.STORAGE.get(env.STORAGE.idFromName(STATE_NAME)).fetch(request);
    return withPrivateHeaders(response);
  } catch (error) { return withPrivateHeaders(errorResponse(error, id, request.method === 'HEAD')); }
}
