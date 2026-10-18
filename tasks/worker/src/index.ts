import { WorkerEntrypoint } from 'cloudflare:workers';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { api, ownerRequest, serviceRequest } from './http.ts';
import { serviceCall } from './service.ts';

interface AccessProps {
  access?: unknown;
}
/** Bindings grant read or read/write access without depending on an application's identity. */
export class TasksApi extends WorkerEntrypoint<Env, AccessProps> {
  override fetch(request: Request): Promise<Response> {
    const access = this.ctx.props.access;
    if (access !== 'read' && access !== 'read-write') return Promise.resolve(this.forbidden());
    if (access === 'read' && request.method !== 'GET') return Promise.resolve(this.forbidden());
    return serviceRequest(request, this.env);
  }

  async call(method: string, body: string): Promise<{ status: number; body: string }> {
    if (this.ctx.props.access !== 'read-write') {
      const response = this.forbidden();
      return { status: response.status, body: await response.text() };
    }
    return serviceCall(method, body, this.env);
  }

  private forbidden(): Response {
    return api.errorResponse(
      new RpcError(Code.PERMISSION_DENIED, 'FORBIDDEN', 'This Tasks service operation is not permitted'),
      'binding',
    );
  }
}
export default { fetch: ownerRequest } satisfies ExportedHandler<Env>;

export { Ops } from './ops.ts';
