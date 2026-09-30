/**
 * Worker "home" (docs/design.md). The fetch and scheduled handlers only authenticate, route and call
 * the HomeState object over RPC (Workers Free: 10 ms CPU per invocation); HomeState does the work
 * (30 s CPU per invocation).
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';
import { HOME_OBJECT } from './state.ts';

export { HomeState } from './state.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },

  // Awaited rather than waitUntil: a cron invocation may run 15 min wall time, waitUntil only 30 s
  // after the handler returns. A failed tick fails the invocation (Workers Logs); the next one retries.
  async scheduled(controller, env): Promise<void> {
    const stub = env.HOME.get(env.HOME.idFromName(HOME_OBJECT));
    await stub.tick(controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
