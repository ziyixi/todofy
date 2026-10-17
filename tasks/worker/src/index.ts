import { WorkerEntrypoint } from 'cloudflare:workers';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { api, ownerRequest, serviceRequest } from './http.ts';
import { serviceCall } from './service.ts';

interface ConsumerProps {
  consumer?: unknown;
}
/** Internal consumers are provisioned explicitly; FlowDay remains a read-only mirror. */
export class TasksApi extends WorkerEntrypoint<Env, ConsumerProps> {
  override fetch(request: Request): Promise<Response> {
    const consumer = this.ctx.props.consumer;
    if (consumer !== 'todofy' && consumer !== 'flowday') return Promise.resolve(this.forbidden());
    if (consumer === 'flowday' && request.method !== 'GET') return Promise.resolve(this.forbidden());
    return serviceRequest(request, this.env);
  }

  async call(method: string, body: string): Promise<{ status: number; body: string }> {
    if (this.ctx.props.consumer !== 'todofy') {
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
