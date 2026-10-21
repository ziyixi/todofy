import type { Env } from './env.ts';
export { SubscriptionStore } from './store.ts';
export { Ops } from './ops.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    // Keep SDK parsing and JWT verification in the DO's CPU budget; the outer Worker only routes.
    return env.SUBSCRIPTIONS.get(env.SUBSCRIPTIONS.idFromName('owner')).fetch(request);
  },
} satisfies ExportedHandler<Env>;
