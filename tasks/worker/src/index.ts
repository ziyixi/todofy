import { env, WorkerEntrypoint } from 'cloudflare:workers';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { accountZone, type Env } from './env.ts';
import { api, ownerRequest, serviceRequest } from './http.ts';
import { warmUp } from './startup.ts';

// Once per isolate, in the global scope: TIME_ZONE is a plain var, which the global scope can read. A zone the runtime
// does not support fails the startup, so the deploy, instead of every request that reads the account's day.
void warmUp(accountZone(env as Env));

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

  private forbidden(): Response {
    return api.errorResponse(
      new RpcError(Code.PERMISSION_DENIED, 'FORBIDDEN', 'This Tasks service operation is not permitted'),
      'binding',
    );
  }
}
export default { fetch: ownerRequest } satisfies ExportedHandler<Env>;

export { Ops } from './ops.ts';
export { TaskInbox } from './inbox.ts';
export { TaskJobs } from './jobs.ts';
