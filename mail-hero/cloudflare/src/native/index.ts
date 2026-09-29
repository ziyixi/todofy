import { BACKUP_PREFIX, handleBackupAPI } from './backup';
import type { Env } from './types';
import { handleAPI } from './api';
import { emailHandler } from './ingest';
import { authenticate, HttpError, json, privateResponse } from './security';

export { MailCoordinator } from './coordinator';

export async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/health/live' && ['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    if (env.MAINTENANCE_MODE === 'true' && !['GET', 'HEAD'].includes(request.method) && path !== BACKUP_PREFIX + '/reconcile-writer') {
      return privateResponse(json({ error: { code: 'maintenance', message: '维护中，请稍后重试' } }, 503));
    }
    if (path.startsWith(BACKUP_PREFIX + '/')) return await handleBackupAPI(request, env);
    if (path.startsWith('/api/')) return await handleAPI(request, env);
    await authenticate(request, env);
    if (path === '/health/ready' && ['GET', 'HEAD'].includes(request.method)) {
      await env.DB.prepare('SELECT 1').first();
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return privateResponse(json({ error: { code: 'method_not_allowed', message: '不支持此请求方法' } }, 405));
    }
    // Authentication happens before every asset, including SPA fallback. Disabling
    // workers.dev and preview URLs is additional protection, not the auth boundary.
    return privateResponse(await env.ASSETS.fetch(request));
  } catch (error) {
    if (error instanceof HttpError) return privateResponse(json({ error: { code: error.code, message: error.message } }, error.status));
    // Provider errors can include SQL, keys, or URLs. Do not reflect or log them.
    return privateResponse(json({ error: { code: 'service_unavailable', message: '服务暂不可用，请稍后重试' } }, 503));
  }
}

export default {
  fetch: fetchHandler,
  email: emailHandler,
} satisfies ExportedHandler<Env>;
