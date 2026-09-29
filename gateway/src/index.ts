/**
 * Worker "todofy": the thin TypeScript gateway in front of todofy-core.
 *
 * On Workers Free a plain Worker invocation has 10 ms of CPU; this Worker only routes by Host,
 * checks credentials and serves assets, and hands everything that touches D1, mail payloads,
 * Gemini or Todoist to the TodofyCoordinator object (30 s per invocation). See
 * docs/gateway-contract.md.
 */
import { callCoordinator } from './coordinator.ts';
import { csv, variable, type Env } from './env.ts';
import { handleHooks } from './hooks.ts';
import { errorResponse, newRequestId, type Context } from './http.ts';
import { handleOwner } from './owner.ts';

function route(ctx: Context): Promise<Response> {
  const host = ctx.url.hostname.toLowerCase();
  if (host === variable(ctx.env, 'TODOFY_PUBLIC_HOST').toLowerCase()) return handleOwner(ctx);
  if (csv(ctx.env, 'TODOFY_HOOKS_HOSTS').includes(host)) return handleHooks(ctx);
  return Promise.resolve(errorResponse(ctx.requestId, 404, 'not_found'));
}

export default {
  async fetch(request, env): Promise<Response> {
    const ctx: Context = { request, env, url: new URL(request.url), requestId: newRequestId() };
    const response = await route(ctx);
    // An answer given on the headers alone (401, 403, 404, 413, 415, 503) leaves the upload
    // unread: discard it rather than let it arrive for nothing. `wrangler dev` even holds such an
    // answer until the body is consumed. A body handed to the core or ASSETS is locked by then.
    if (request.body !== null && !request.body.locked) await request.body.cancel();
    return response;
  },

  // A failed wake fails the cron invocation, which shows in Workers Logs; the next tick retries.
  async scheduled(_controller, env): Promise<void> {
    await callCoordinator(env, newRequestId(), '/wake', { method: 'POST' });
  },
} satisfies ExportedHandler<Env>;
