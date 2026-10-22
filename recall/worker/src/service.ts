/** Private access to Recall's page, snapshot and activity reads over its existing generated API. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { withPrivateHeaders } from '@ziyixi/edge-auth';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { RECALL_OBJECT, REQUEST_ID_HEADER, type Env } from './env.ts';
import { newRequestId } from './ids.ts';
import { errorResponse, recallError, REASONS } from './reasons.ts';

const PAGE_READ = /^\/api\/v1\/pages\/[^/]+(?:\/documents(?:\/[^/]+)?|\/visits)?$/;

export async function serviceRead(request: Request, env: Env): Promise<Response> {
  const requestId = newRequestId();
  const path = new URL(request.url).pathname;
  if (path !== '/api/v1/pages:search' && !PAGE_READ.test(path)) {
    return withPrivateHeaders(errorResponse(recallError('NOT_FOUND'), requestId));
  }
  if (request.method !== 'GET') {
    const reason = REASONS.METHOD_NOT_ALLOWED;
    return withPrivateHeaders(errorResponse(new RpcError(reason.code, 'METHOD_NOT_ALLOWED', reason.message, {
      httpStatus: 405, headers: { allow: 'GET' },
    }), requestId));
  }
  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, requestId);
  try {
    const stub = env.RECALL.get(env.RECALL.idFromName(RECALL_OBJECT));
    return withPrivateHeaders(await stub.fetch(new Request(request.url, { headers })));
  } catch {
    return withPrivateHeaders(errorResponse(recallError('UNAVAILABLE'), requestId));
  }
}

export class RecallApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return serviceRead(request, this.env);
  }
}
