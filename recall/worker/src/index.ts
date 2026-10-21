/**
 * Worker "recall" (../../docs/design.md): the owner's browsing record. The fetch handler checks every caller (the
 * extension's and the archive's bearer tokens on the machine routes, the owner's Access login on everything else) and
 * hands the work to RecallState, the one SQLite Durable Object that holds everything, with the texts in the private R2
 * bucket recall-store. No cron trigger, no D1, no KV, no queue. The named entrypoint Ops answers the dashboard (ops-v1).
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export { RecallState } from './state.ts';
// ops-v1 for the dashboard's service binding (no public route).
export { Ops } from './ops.ts';
export { RecallApi } from './service.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
