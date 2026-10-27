import { WorkerEntrypoint } from 'cloudflare:workers';
import { forward, handleRequest, errorResponse } from './http.ts';
import { Store } from './store.ts';
import { Code, RpcError } from './errors.ts';
import type { Env } from './types.ts';
export { RouterEngine } from './engine.ts';
export { Ops } from './ops.ts';

/** Binding props identify the caller, never caller-supplied JSON or HTTP headers. */
export class Inference extends WorkerEntrypoint<Env, { app?: string }> {
  override async fetch(request: Request): Promise<Response> {
    const app = this.ctx.props.app;
    if (!app || !['mailsort','todofy','brief'].includes(app)) return errorResponse(new RpcError(Code.PERMISSION_DENIED, 'CALLER_NOT_CONFIGURED', 'Model client is not configured.'));
    return forward(request, this.env, app);
  }
}
export default {
  fetch: handleRequest,
  scheduled: async (_event, env) => { await new Store(env).cleanup(); },
} satisfies ExportedHandler<Env>;
