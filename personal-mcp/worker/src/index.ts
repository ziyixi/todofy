import { STORE_OBJECT, type Env } from './env.ts';
export { SubscriptionStore } from './store.ts';
export { Ops } from './ops.ts';

/** The MCP endpoint, and the owner's restore call (docs/backup.md); both behind Access and the object's own check. */
const PATHS = new Set(['/mcp', '/owner/restore']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!PATHS.has(new URL(request.url).pathname)) return new Response('Not found', { status: 404 });
    // Keep SDK parsing and JWT verification in the DO's CPU budget; the outer Worker only routes.
    return env.SUBSCRIPTIONS.get(env.SUBSCRIPTIONS.idFromName(STORE_OBJECT)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
