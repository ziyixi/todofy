/** Private generated Watch API. Binding props grant read or read/write access; browser auth stays separate. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { withPrivateHeaders } from '@ziyixi/edge-auth';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { PRIVATE_API_HEADER, REQUEST_ID_HEADER, WATCH_OBJECT, type Env } from './env.ts';
import { newRequestId } from './http.ts';
import { errorResponse, watchError } from './reasons.ts';

interface AccessProps { access?: unknown }

export class WatchApi extends WorkerEntrypoint<Env, AccessProps> {
  override async fetch(request: Request): Promise<Response> {
    const requestId = newRequestId();
    const access = this.ctx.props.access;
    if ((access !== 'read' && access !== 'read-write') || (access === 'read' && request.method !== 'GET')) {
      return withPrivateHeaders(errorResponse(new RpcError(Code.PERMISSION_DENIED, 'FORBIDDEN', 'This Watch service operation is not permitted'), requestId));
    }
    if (!new URL(request.url).pathname.startsWith('/api/v1/')) {
      return withPrivateHeaders(errorResponse(watchError('NOT_FOUND'), requestId));
    }
    const headers = new Headers(request.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    headers.set(PRIVATE_API_HEADER, 'true');
    try {
      const stub = this.env.WATCH.get(this.env.WATCH.idFromName(WATCH_OBJECT));
      return withPrivateHeaders(await stub.fetch(new Request(request, { headers })));
    } catch {
      return withPrivateHeaders(errorResponse(watchError('UNAVAILABLE'), requestId));
    }
  }
}
