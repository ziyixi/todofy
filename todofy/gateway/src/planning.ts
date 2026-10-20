import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env.ts';
import { nativePlanning } from './plus.ts';

/** Tasks' Mail page and Plan's weekly review reach PlusService through this private binding. */
export class Planning extends WorkerEntrypoint<Env, { source?: string }> {
  override async fetch(request: Request): Promise<Response> {
    if (this.ctx.props.source !== 'tasks') return new Response(null, { status: 403 });
    return nativePlanning(request, this.env);
  }
}
