/**
 * Worker "home" (docs/design.md). The fetch and scheduled handlers only authenticate, route and call
 * the HomeState object over RPC (Workers Free: 10 ms CPU per invocation); HomeState does the work.
 * Scaffold only; the build step fills in the handlers.
 */
import type { Env } from './env.ts';

export { HomeState } from './state.ts';

export default {
  fetch(): Response {
    return new Response(null, { status: 503 });
  },
  scheduled(): void {},
} satisfies ExportedHandler<Env>;
