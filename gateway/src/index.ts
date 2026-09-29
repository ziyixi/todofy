/**
 * Worker "todofy": the thin TypeScript gateway in front of todofy-core.
 *
 * On Workers Free a plain Worker invocation has 10 ms of CPU; this Worker only routes by Host,
 * checks credentials and serves assets, and hands everything that touches D1, mail payloads,
 * Gemini or Todoist to the TodofyCore object (30 s per invocation). See
 * docs/gateway-contract.md.
 */
import { coordinator } from './coordinator.ts';
import { csv, variable, type Env } from './env.ts';
import { handleHooks } from './hooks.ts';
import { errorResponse, newRequestId, type Context } from './http.ts';
import { declaredBytes, recordRequest, routeOf, type HostKind } from './metrics.ts';
import { handleOwner } from './owner.ts';

export { TodofyCoordinator } from './retired.ts';

/** The public host is matched before the hooks hosts. */
function hostKind(ctx: Context): HostKind {
  const host = ctx.url.hostname.toLowerCase();
  if (host === variable(ctx.env, 'TODOFY_PUBLIC_HOST').toLowerCase()) return 'owner';
  if (csv(ctx.env, 'TODOFY_HOOKS_HOSTS').includes(host)) return 'hooks';
  return 'unknown';
}

function route(ctx: Context, kind: HostKind): Promise<Response> {
  if (kind === 'owner') return handleOwner(ctx);
  if (kind === 'hooks') return handleHooks(ctx);
  return Promise.resolve(errorResponse(ctx.requestId, 404, 'not_found'));
}

export default {
  async fetch(request, env): Promise<Response> {
    const started = Date.now();
    const ctx: Context = { request, env, url: new URL(request.url), requestId: newRequestId() };
    const kind = hostKind(ctx);
    let response: Response | undefined;
    try {
      response = await route(ctx, kind);
      // An answer given on the headers alone (401, 403, 404, 413, 415, 503) leaves the upload
      // unread: discard it rather than let it arrive for nothing. `wrangler dev` even holds such an
      // answer until the body is consumed. A body handed to the core or ASSETS is locked by then.
      if (request.body !== null && !request.body.locked) await request.body.cancel();
      return response;
    } finally {
      recordRequest(env, {
        kind,
        method: request.method,
        route: routeOf(kind, ctx.url.pathname),
        // An exception escapes as the runtime's 500.
        status: response?.status ?? 500,
        wallMs: Date.now() - started,
        requestBytes: declaredBytes(request.headers),
        responseBytes: response ? declaredBytes(response.headers) : 0,
      });
    }
  },

  // A failed wake fails the cron invocation, which shows in Workers Logs; the next tick retries.
  async scheduled(_controller, env): Promise<void> {
    const started = Date.now();
    let status = 500;
    try {
      await coordinator(env).wake();
      status = 204;
    } finally {
      const metric = { kind: 'cron', method: 'POST', route: 'wake', requestBytes: 0, responseBytes: 0 } as const;
      recordRequest(env, { ...metric, status, wallMs: Date.now() - started });
    }
  },
} satisfies ExportedHandler<Env>;
