import { withBackupWrite } from './backup.ts'
import type { Env } from './types.ts'
import { HttpError, authenticate, csrfResponse, json, privateResponse, requireCSRF } from './security.ts'
import { listDeliveries, listMessages, deliveryRoute, messageRoute } from './api-messages.ts'
import { createEndpoint, endpointRoute, listEndpoints } from './api-endpoints.ts'
import { currentSettings, overview, patchSettings, previewRetention, setupStatus } from './api-settings.ts'
import { deliveryStats } from './api-delivery-stats.ts'
import { missing } from './api-common.ts'

export async function routeAPI(request: Request, env: Env, owner: string): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, ''), method = request.method
  if (path === '/api/v1/csrf' && method === 'GET') return csrfResponse(request, env, owner)
  if (path === '/api/v1/overview' && method === 'GET') return overview(env)
  if (path === '/api/v1/delivery-stats' && method === 'GET') return deliveryStats(request, env)
  if (path === '/api/v1/setup/status' && method === 'GET') return setupStatus(env)
  if (path === '/api/v1/settings') {
    if (method === 'GET') return json(await currentSettings(env))
    if (method === 'PATCH') return patchSettings(request, env, owner)
  }
  if (path === '/api/v1/settings/retention-preview' && method === 'GET') return previewRetention(request, env, owner)
  if (path === '/api/v1/messages' && method === 'GET') return listMessages(request, env)
  if (path === '/api/v1/deliveries' && method === 'GET') return listDeliveries(request, env)
  if (path === '/api/v1/endpoints') {
    if (method === 'GET') return listEndpoints(env)
    if (method === 'POST') return createEndpoint(request, env, owner)
  }
  const match = /^\/api\/v1\/(messages|deliveries|endpoints)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path)
  if (match) {
    const [, resource, rawID, sub = '', part] = match
    let id: string, partID: string | undefined
    try { id = decodeURIComponent(rawID); partID = part === undefined ? undefined : decodeURIComponent(part) }
    catch { throw new HttpError(400, 'invalid_path', '路径编码无效') }
    if (resource === 'messages') {
      if ((part !== undefined && sub !== 'attachments') || (sub === 'attachments' && !part)) return missing()
      return messageRoute(request, env, owner, id, sub, partID)
    }
    if (part !== undefined) return missing()
    if (resource === 'deliveries') return deliveryRoute(request, env, owner, id, sub)
    if (resource === 'endpoints') return endpointRoute(request, env, owner, id, sub)
  }
  return missing()
}

export async function handleAPI(request: Request, env: Env): Promise<Response> {
  try {
    const owner = await authenticate(request, env)
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (env.MAINTENANCE_MODE === 'true') throw new HttpError(503, 'maintenance', '维护模式暂不接受修改，请稍后重试')
      await requireCSRF(request, env, owner)
    }
    return privateResponse(await (['GET', 'HEAD'].includes(request.method)
      ? routeAPI(request, env, owner) : withBackupWrite(env, () => routeAPI(request, env, owner))))
  } catch (error) {
    const known = error instanceof HttpError
    return privateResponse(json({ error: { code: known ? error.code : 'service_unavailable',
      message: known ? error.message : '服务暂不可用，请稍后重试', request_id: crypto.randomUUID() } }, known ? error.status : 503))
  }
}
