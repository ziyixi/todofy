import './startup.ts';
import { issueCsrf, STRICT_CSP, withPrivateHeaders } from '@ziyixi/edge-auth';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import { TasksUiService } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { authenticate, checkCsrf, CSRF_COOKIE, csrfKey } from './auth.ts';
import { handlers, type ApiContext } from './api.ts';
import { planningRequest } from './planning-proxy.ts';
import type { Env } from './env.ts';

export const api = new HttpTranscoder(TasksUiService, handlers, {
  domain: 'tasks.ziyixi.science',
  maxBodyBytes: 65536,
  async authorize(request, route, context) {
    if (!route.safe && !context.internal) await checkCsrf(request, context.env, context.owner, context.bypassed);
  },
});
function secure(response: Response, cacheControl = 'private, no-store'): Response {
  const result = withPrivateHeaders(response, {
    csp: STRICT_CSP,
    cacheControl,
  });
  result.headers.set('x-robots-tag', 'noindex');
  return result;
}
export async function ownerRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const auth = await authenticate(request, env);
    if (!auth.ok)
      throw new RpcError(
        auth.failure === 'missing_token' || auth.failure === 'invalid_token' ? Code.UNAUTHENTICATED : Code.UNAVAILABLE,
        'UNAUTHORIZED',
        'A valid owner session is required',
      );
    const context: ApiContext = {
      env,
      now: Date.now(),
      owner: auth.owner,
      bypassed: auth.bypassed,
      internal: false,
    };
    const path = new URL(request.url).pathname;
    if (path === '/api/tasks/csrf' && request.method === 'GET') {
      const issued = await issueCsrf(request, auth.owner, {
        cookieName: CSRF_COOKIE,
        key: await csrfKey(env),
      });
      return secure(Response.json({ token: issued.token }, { headers: { 'set-cookie': issued.setCookie } }));
    }
    if (path.startsWith('/api/plus/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        await checkCsrf(request, env, auth.owner, auth.bypassed);
      const response = await planningRequest(request, env);
      if (response) return secure(response);
    }
    if (path.startsWith('/api/')) {
      const result = await api.handle(request, context, requestId);
      return secure(
        result?.response ??
          api.errorResponse(new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Unknown API route'), requestId),
      );
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      throw new RpcError(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 'Method not allowed', { httpStatus: 405 });
    const response = await env.ASSETS.fetch(request);
    const immutable = response.status === 200 && /^\/assets\/[^/]+-[\w-]+\.(?:js|css)$/.test(path);
    return secure(response, immutable ? 'private, max-age=31536000, immutable' : 'private, no-store');
  } catch (error) {
    return secure(
      api.errorResponse(
        error instanceof RpcError ? error : new RpcError(Code.INTERNAL, 'INTERNAL', 'Unexpected Tasks error'),
        requestId,
      ),
    );
  }
}
/** Only the named Worker service binding reaches this function. Public fetch always verifies Access. */
export async function serviceRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const context: ApiContext = {
    env,
    now: Date.now(),
    owner: 'service-binding',
    bypassed: false,
    internal: true,
  };
  const result = await api.handle(request, context, requestId);
  return (
    result?.response ?? api.errorResponse(new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Unknown API route'), requestId)
  );
}
