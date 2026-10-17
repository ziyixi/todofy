import { WorkerEntrypoint } from 'cloudflare:workers';
import { variable, type Env } from './env.ts';
import { nativePlanning } from './plus.ts';

/** The standalone Tasks UI calls the existing planning API through this private binding. */
export class Planning extends WorkerEntrypoint<Env, { source?: string }> {
  override async fetch(request: Request): Promise<Response> {
    if (this.ctx.props.source !== 'tasks') return new Response(null, { status: 403 });
    // Until the coordinated cutover, native task IDs must never write to the old Todoist source.
    if (variable(this.env, 'TASK_SOURCE') !== 'tasks') return new Response(null, { status: 503 });
    return nativePlanning(request, this.env);
  }
}
